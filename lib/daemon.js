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
// 6. Supervised (C3a): a runtime that ends unasked is restarted, under
//    start.lock, at once and then after 1, 5 and 30 s, each one handed the
//    session table; after 5 failures in 10 minutes, failed.json and an exit.
//    The idle stop, and a SIGINT or SIGTERM, stop it; then daemon.json goes,
//    under start.lock, if it is still this daemon's. failed.json's `signal`
//    is null: start's spawn reports a signal death as exit 1.
// Not on Windows yet (C4c): exit 2, and the shim runs its own runtime.
//
// Upgrades and the re-exec handoff are C3b's.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {withLockFile} = require('./lock');
const {readPrivateIn} = require('./private-file');
const {createSessionTable} = require('./session-table');

const READY_MS = 20000;
// a stopped runtime's end, awaited at most this long: start's SIGKILL comes
// at 10 s
const STOP_MS = 15000;
// after the last session leaves (#236 section 6, daemonIdleMinutes)
const IDLE_MS = 10 * 60 * 1000;
// restarts: at once, then 1, 5 and 30 s; 5 failures in 10 minutes give up
const BACKOFF_MS = [0, 1000, 5000, 30000];
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const PROBE_MS = 2000;
const SOCKET = 'sessions.sock';
const SECRET_FORM = /^[0-9a-f]{64}\n?$/;

const hmac = (secret, ...parts) => crypto.createHmac('sha256', secret).update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const frame = (kind, obj) => { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(5); h.write(kind, 0, 'ascii'); h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); };

// Whether the socket proves the secret (contract 2's HELLO and PROVE; AUTH is
// never sent, so no session opens) -> Promise<boolean>
function probe(socket, secret, ms = PROBE_MS) {
  // its own runtime's unix socket, by absolute path: never a host and port
  if (typeof socket !== 'string' || !path.isAbsolute(socket)) return Promise.resolve(false);
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
function defaultRun({socket, home, signal, onListening, onTold, onControl, restore, onRestoreRefused}, io) {
  return require('./start').start({passThrough: [], session: {socket, home, signal, onListening, onTold, onControl, restore, onRestoreRefused}}, io);
}

// {home} -> exit code. run: the runtime's start, for the tests.
async function daemon({home}, io, {run = defaultRun} = {}) {
  if (typeof io.ignoreSignal === 'function') io.ignoreSignal('SIGHUP');
  const fail = (s, code = 1) => { io.stderr.write(`ch-local daemon: ${s}\n`); return code; };
  const say = (s) => io.stderr.write(`ch-local daemon: ${s}\n`);
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
  const owned = require('./home').homeOwnershipProblem(homeReal);
  if (owned != null) return fail(`--home ${home}: ${owned}`, 2);
  const runDir = ensureRunDir(home);
  const socket = path.join(runDir, SOCKET);
  const lockFile = path.join(runDir, 'start.lock');
  const readyMs = Number.isInteger(io.daemonReadyMs) ? io.daemonReadyMs : READY_MS;
  const stopMs = Number.isInteger(io.daemonStopMs) ? io.daemonStopMs : STOP_MS;
  const idleMs = Number.isInteger(io.daemonIdleMs) ? io.daemonIdleMs : IDLE_MS;
  const backoff = Array.isArray(io.daemonBackoffMs) ? io.daemonBackoffMs : BACKOFF_MS;

  // the session table, in memory only, across this daemon's runtimes
  const table = createSessionTable({warn: say});
  let current = null;       // the runtime now running
  let stopping = false;     // an idle stop or a signal: its end is no failure
  let idleTimer = null;
  let isIdle = false;       // the runtime's last word: idle, or busy
  const armIdle = () => {
    if (idleTimer != null || stopping) return;
    idleTimer = setTimeout(() => { idleTimer = null; idleStop().catch((e) => say(`the idle stop failed (${e.message})`)); }, idleMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };
  const onTold = (m) => {
    if (m.type === 'busy') { isIdle = false; clearTimeout(idleTimer); idleTimer = null; return; }
    if (m.type === 'idle') { isIdle = true; armIdle(); return; }
    table.told(m);
  };

  // one runtime, in start's session mode -> its handle
  const startRuntime = () => {
    const h = {ended: null, told: false, request: null, stop: new AbortController()};
    const onListening = (m) => { if (m != null && m.type === 'listening' && m.socket === socket) h.told = true; };
    h.exited = Promise.resolve()
      .then(() => run({socket, home, signal: h.stop.signal, onListening, onTold, onControl: (fn) => { h.request = fn; }, restore: () => table.restore(),
        onRestoreRefused: () => { say('the runtime refused the session table: starting it over'); table.clear(); }}, io))
      .then((c) => { h.ended = {code: c}; return c; }, (err) => { h.ended = {code: 1, err}; return 1; });
    // ready: our own runtime told us it listens on this socket (an older
    // runtime's socket can prove a secret too), AND the socket proves it
    h.ready = async() => {
      const until = Date.now() + readyMs;
      while (h.ended == null && Date.now() < until) {
        if (h.told) {
          const secret = readSecret(runDir);
          if (secret != null && await probe(socket, secret, 500)) return true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    // stopped (SIGTERM, then start's SIGKILL), and its end awaited within a
    // bound, so a hung one never holds start.lock -> whether it ended
    h.abandon = async() => {
      h.stop.abort();
      let timer = null;
      const gone = await Promise.race([h.exited.then(() => true), new Promise((r) => { timer = setTimeout(() => r(false), stopMs); })]);
      clearTimeout(timer);
      return gone;
    };
    return h;
  };
  const exitOf = (h) => (h.ended != null && Number.isSafeInteger(h.ended.code) ? h.ended.code : null);
  // failed.json (#236 section 6): the shims fall back to their own runtimes
  // for 10 minutes instead of starting daemon after daemon
  const writeFailed = (reason, exit) => {
    try {
      writePrivate(runDir, 'failed.json', `${JSON.stringify({v: 1, at: Date.now(), exit: Number.isSafeInteger(exit) ? exit : null, signal: null, reason})}\n`);
    } catch (e) {
      say(`failed.json could not be written (${e.code || e.message})`);
    }
  };
  let mine = null;
  let wake = null;          // ends a backoff's sleep at a stop signal
  const removeMine = () => {
    const now = readDaemonJson(runDir);
    if (mine != null && now != null && now.pid === mine.pid && now.started === mine.started) fs.rmSync(path.join(runDir, 'daemon.json'), {force: true});
  };
  // a SIGINT or SIGTERM to the daemon stops it, not a restart
  if (typeof io.trapSignals === 'function') {
    io.trapSignals(() => { stopping = true; if (current != null) current.stop.abort(); if (wake != null) wake(); }, ['SIGINT', 'SIGTERM']);
  }

  // The idle stop (#236 section 6): under start.lock, the runtime is asked
  // to drain only if no session is held and no handshake is under way, which
  // it checks in one step; then daemon.json goes and the runtime stops. A
  // shim arriving meanwhile is refused SHUTTING_DOWN, or waits on the lock,
  // and finds no daemon.json: it starts a new daemon.
  const idleStop = () => withLockFile(lockFile, runDir, io, async() => {
    const h = current;
    if (h == null || stopping || typeof h.request !== 'function') return 0;
    const reply = await h.request({type: 'idle-stop'});
    // a session or a handshake came: not idle. With no 'busy' after it (a
    // handshake in pre-auth that went away), the timer is armed again.
    if (reply != null && reply.code === 'CONTROL_BUSY') { if (isIdle) armIdle(); return 0; }
    // ok, or no answer or a failure: the runtime may drain later and refuse
    // every handshake, so it stops either way
    if (reply == null || reply.ok !== true) say(`the idle stop was answered ${reply != null ? reply.code : 'nothing'}: stopping anyway`);
    stopping = true;
    removeMine();
    say(`idle for ${idleMs / 1000} s: stopping`);
    await h.abandon();
    return 0;
  }, {wait: true, what: 'to finish the idle stop'});

  // The first runtime, under start.lock, from the shim's release on.
  const first = await withLockFile(lockFile, runDir, io, async(release) => {
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
    current = startRuntime();
    if (!(await current.ready())) {
      // a SIGINT or SIGTERM while it started: a stop, not a failure
      if (stopping) { if (current.ended == null) await current.abandon(); say('stopped while starting'); return 0; }
      const ended = current.ended != null;
      const gone = ended || await current.abandon();
      writeFailed('never-listened', exitOf(current));
      if (ended) return fail(`the runtime ended before it listened (exit ${current.ended.code})`);
      return fail(gone ? `the runtime did not listen within ${readyMs / 1000} s; it was stopped` : `the runtime did not listen within ${readyMs / 1000} s; it was stopped, and did not end within ${stopMs / 1000} s`);
    }
    const body = {pid: io.pid, socket, runtimeVersion: version(path.join(home, 'app', 'node_modules', 'countinghouse', 'package.json')),
      daemonVersion: version(path.join(__dirname, '..', 'package.json')), started: new Date().toISOString()};
    try {
      writePrivate(runDir, 'daemon.json', `${JSON.stringify(body)}\n`);
    } catch (e) {
      const gone = await current.abandon();
      return fail(`daemon.json could not be written (${e.code || e.message}); the runtime was stopped${gone ? '' : `, and did not end within ${stopMs / 1000} s`}`);
    }
    mine = body;
    // the shared mode works again: the shims' fallback ends
    fs.rmSync(path.join(runDir, 'failed.json'), {force: true});
    release();
    return null;
  }, {wait: true, what: 'to finish starting the shared runtime'});
  if (first !== null) return first;

  // Supervised: a runtime that ends unasked is restarted at once, then after
  // 1, 5 and 30 s, each handed the table. After 5 failures in 10 minutes the
  // daemon gives up: failed.json, daemon.json removed, exit 1.
  const failures = [];
  for (;;) {
    const code = await current.exited;
    if (stopping) break;
    // start.lock from the unasked end until the restarted runtime is ready,
    // or the daemon gives up: a shim that reattaches meanwhile, or the daemon
    // it would spawn, waits on the lock and then finds this daemon, never a
    // second one beside it, and never a failed.json written behind its back
    const gaveUp = await withLockFile(lockFile, runDir, io, async() => {
      const now = Date.now();
      while (failures.length > 0 && now - failures[0] > FAILURE_WINDOW_MS) failures.shift();
      failures.push(now);
      if (failures.length >= MAX_FAILURES) {
        writeFailed('restarts-exhausted', code);
        removeMine();
        return fail(`the shared runtime failed ${MAX_FAILURES} times in 10 minutes (last exit ${code}); the sessions run their own runtimes for now`);
      }
      const wait = backoff[Math.min(failures.length - 1, backoff.length - 1)];
      say(`the shared runtime ended (exit ${code}); restarting${wait > 0 ? ` in ${wait / 1000} s` : ''}`);
      if (wait > 0) await new Promise((r) => { wake = r; setTimeout(r, wait); });
      wake = null;
      if (stopping) return null;
      current = startRuntime();
      if (!(await current.ready())) {
        if (current.ended == null) await current.abandon();
        if (!stopping) say('the restarted runtime did not listen');
      }
      return null;
    }, {wait: true, what: 'to finish restarting the shared runtime'});
    if (gaveUp != null) { clearTimeout(idleTimer); return gaveUp; }
    if (stopping) break;
  }
  clearTimeout(idleTimer);
  // stopped: daemon.json goes if it is still this daemon's (the idle stop
  // has removed it already), under start.lock
  await withLockFile(lockFile, runDir, io, async() => { removeMine(); return 0; }, {wait: true, what: 'to finish stopping the shared runtime'});
  return 0;
}

module.exports = {daemon, probe, READY_MS, SOCKET};
