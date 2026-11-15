'use strict';
// ch-local daemon --home <abs> (countinghouse's shared-runtime design, #236,
// section 6, "Starting"): the one runtime this user's sessions share. The
// native shim spawns it with the home as its working directory and a cleared
// environment (shim.json's), and releases start.lock at once.
//
// 1. SIGHUP is ignored from the first line, so the daemon outlives the shim's
//    parent ending.
// 2. --home must be absolute and name the working directory.
// 3. start.lock (<home>/run/daemon/start.lock, lib/lock.js's protocol) is
//    taken as the first act, waiting behind the shim's release.
// 4. daemon.json is checked again under the lock: a live pid whose socket
//    proves the secret is another daemon, and this one exits 0 at once.
//    Anything else there is stale.
// 5. The runtime starts on its session socket (start's session mode: the
//    home given, its environment shim.json's allowlist, its own process
//    group), and daemon.json ({pid, socket, runtimeVersion, daemonVersion,
//    started}, 0600) is written once the runtime has told this daemon it
//    listens on that socket AND the socket proves the secret, within
//    READY_MS. Then the lock is released, and the runtime runs on. A runtime
//    not adopted (no tell, a timeout, daemon.json not written) is stopped,
//    and its end awaited.
// 6. When the runtime ends, daemon.json goes, under start.lock, if it is
//    still this daemon's.
// Not on Windows yet (C4c): exit 2, and the shim runs its own runtime.
//
// The idle stop, upgrades and the session table across a runtime restart
// are C3's.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {withLockFile} = require('./lock');
const {readPrivateIn} = require('./private-file');

const READY_MS = 20000;
const PROBE_MS = 2000;
const SOCKET = 'sessions.sock';
const SECRET_FORM = /^[0-9a-f]{64}\n?$/;

const hmac = (secret, ...parts) => crypto.createHmac('sha256', secret).update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const frame = (kind, obj) => { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(5); h.write(kind, 0, 'ascii'); h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); };

// Whether the socket proves the secret (contract 2's HELLO and PROVE; AUTH is
// never sent, so no session opens) -> Promise<boolean>
function probe(socket, secret, ms = PROBE_MS) {
  return new Promise((resolve) => {
    let done = false;
    let buf = Buffer.alloc(0);
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); c.destroy(); resolve(v); } };
    const nc = crypto.randomBytes(32);
    const c = net.createConnection(socket);
    const timer = setTimeout(() => finish(false), ms);
    c.on('connect', () => c.write(frame('H', {protocol: 1, nc: nc.toString('base64')})));
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 5) return;
      if (String.fromCharCode(buf[0]) !== 'P') return finish(false);
      const n = buf.readUInt32BE(1);
      if (n > 4096) return finish(false);
      if (buf.length < 5 + n) return;
      try {
        const prove = JSON.parse(buf.subarray(5, 5 + n).toString('utf8'));
        const ns = Buffer.from(String(prove.ns), 'base64');
        const ms2 = Buffer.from(String(prove.ms), 'base64');
        const want = hmac(secret, 'ch-server', Buffer.from([1]), nc, ns);
        return finish(ns.length === 32 && ms2.length === want.length && crypto.timingSafeEqual(ms2, want));
      } catch (e) {
        return finish(false);
      }
    });
    c.on('error', () => finish(false));
    c.on('close', () => finish(false));
  });
}

const readSecret = (runDir) => {
  try {
    const text = readPrivateIn(runDir, 'secret', 80).toString('utf8');
    return SECRET_FORM.test(text) ? Buffer.from(text.slice(0, 64), 'hex') : null;
  } catch (e) {
    return null;
  }
};
const readDaemonJson = (runDir) => {
  try {
    return JSON.parse(readPrivateIn(runDir, 'daemon.json', 4096).toString('utf8'));
  } catch (e) {
    return null;
  }
};

// <home>/run and <home>/run/daemon, made 0700 if missing
function ensureRunDir(home) {
  for (const d of [path.join(home, 'run'), path.join(home, 'run', 'daemon')]) {
    fs.mkdirSync(d, {recursive: true, mode: 0o700});
    if (process.platform !== 'win32') fs.chmodSync(d, 0o700);
  }
  return path.join(home, 'run', 'daemon');
}

function writePrivate(dir, name, text) {
  const file = path.join(dir, name);
  const temp = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  let placed = false;
  try {
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    placed = true;
  } finally {
    if (!placed) { try { fs.unlinkSync(temp); } catch (e) { /* gone */ } }
  }
}

const version = (file) => { try { return String(JSON.parse(fs.readFileSync(file, 'utf8')).version); } catch (e) { return 'unknown'; } };

// the runtime, in start's session mode -> Promise<exit code>.
// opts: {socket, home, signal (abort stops the runtime), onListening(msg)}
function defaultRun({socket, home, signal, onListening}, io) {
  return require('./start').start({passThrough: [], session: {socket, home, signal, onListening}}, io);
}

// {home} -> exit code. run: the runtime's start, for the tests.
async function daemon({home}, io, {run = defaultRun} = {}) {
  if (typeof io.ignoreSignal === 'function') io.ignoreSignal('SIGHUP');
  const fail = (s, code = 1) => { io.stderr.write(`ch-local daemon: ${s}\n`); return code; };
  // the Windows daemon (an owner-only DACL, a \\.\pipe\ name) is C4c; until
  // then the shim runs one runtime per session there
  if ((io.platform || process.platform) === 'win32') return fail('the shared runtime does not run on Windows yet; each session runs its own', 2);
  let cwdReal = null;
  let homeReal = null;
  try {
    cwdReal = fs.realpathSync(io.cwd);
    homeReal = fs.realpathSync(home);
  } catch (e) {
    return fail(`the home ${home} could not be read (${e.code || e.message})`, 2);
  }
  if (cwdReal !== homeReal) return fail(`--home ${home} is not the working directory`, 2);
  const runDir = ensureRunDir(home);
  const socket = path.join(runDir, SOCKET);
  const lockFile = path.join(runDir, 'start.lock');
  const readyMs = Number.isInteger(io.daemonReadyMs) ? io.daemonReadyMs : READY_MS;
  let mine = null;
  const code = await withLockFile(lockFile, runDir, io, async(release) => {
    const info = readDaemonJson(runDir);
    // another daemon: a live pid, on this socket (no other), proving the secret
    if (info != null && Number.isInteger(info.pid) && io.alive(info.pid) && info.socket === socket) {
      const secret = readSecret(runDir);
      if (secret != null && await probe(socket, secret)) {
        io.stderr.write(`ch-local daemon: another daemon (pid ${info.pid}) is running\n`);
        return 0;
      }
    }
    fs.rmSync(path.join(runDir, 'daemon.json'), {force: true});
    let ended = null;
    let told = false;
    const stop = new AbortController();
    const onListening = (m) => { if (m != null && m.type === 'listening' && m.socket === socket) told = true; };
    const exited = Promise.resolve().then(() => run({socket, home, signal: stop.signal, onListening}, io))
      .then((c) => { ended = {code: c}; return c; }, (err) => { ended = {code: 1, err}; return 1; });
    // a runtime that will not be adopted: stopped, and its end awaited
    const abandon = async(why) => { stop.abort(); await exited; return fail(why); };
    // ready: our own runtime told us it listens on this socket (an older
    // runtime's socket can prove a secret too), AND the socket proves it
    const until = Date.now() + readyMs;
    let ready = false;
    while (!ready && ended == null && Date.now() < until) {
      if (told) {
        const secret = readSecret(runDir);
        if (secret != null) ready = await probe(socket, secret, 500);
      }
      if (!ready) await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) {
      if (ended != null) return fail(`the runtime ended before it listened (exit ${ended.code})`);
      return abandon(`the runtime did not listen within ${readyMs / 1000} s; it was stopped`);
    }
    const body = {pid: io.pid, socket, runtimeVersion: version(path.join(home, 'app', 'node_modules', 'countinghouse', 'package.json')),
      daemonVersion: version(path.join(__dirname, '..', 'package.json')), started: new Date().toISOString()};
    try {
      writePrivate(runDir, 'daemon.json', `${JSON.stringify(body)}\n`);
    } catch (e) {
      return abandon(`daemon.json could not be written (${e.code || e.message}); the runtime was stopped`);
    }
    mine = body;
    release();
    return exited;
  }, {wait: true, what: 'to finish starting the shared runtime'});
  // the runtime has ended: daemon.json goes if it is still this daemon's,
  // read and removed under start.lock, so a new daemon's is never removed
  if (mine != null) {
    await withLockFile(lockFile, runDir, io, async() => {
      const now = readDaemonJson(runDir);
      if (now != null && now.pid === mine.pid && now.started === mine.started) fs.rmSync(path.join(runDir, 'daemon.json'), {force: true});
      return 0;
    }, {wait: true, what: 'to finish stopping the shared runtime'});
  }
  return code;
}

module.exports = {daemon, probe, READY_MS, SOCKET};
