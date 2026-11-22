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
// Where it listens (C4c, lib/session-socket.js): on Windows a named pipe,
// its name random per runtime start, so daemon.json is rewritten at each
// restart; on POSIX <home>/run/daemon/sessions.sock, or the long-home
// fallback. The run directory is passed as --sessionDir (countinghouse C2).
// On Windows the home, <home>/run and <home>/run/daemon pass win-acl.js
// privateProblem, the two run directories made private by DACL first, and
// daemon.json and failed.json are created with an owner-only DACL.
//
// 7. Upgrades (C3b): <home>/run/daemon/requests (lib/daemon-requests.js),
//    which an install appends to. A runtime that changed is drained, and
//    restarted with the table under start.lock. A ch-local that changed is
//    drained; then, under start.lock, daemon.json goes, the runtime stops,
//    and a new daemon is started with the table on its fd 3 (never in argv
//    or env; the secret is never in it). This daemon exits once the new one
//    has written daemon.json. A failed handoff starts the new one empty.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {withLockFile} = require('./lock');
const {readPrivateIn} = require('./private-file');
const {createSessionTable} = require('./session-table');
const {readRequests, emptyRequests} = require('./daemon-requests');
const {SOCKET, isPipeName, socketFor, socketDirProblem, socketOk} = require('./session-socket');

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
// the requests file's poll, and a drain's wait for in-flight calls (the
// runtime's default --requestTimeout) unless it says drained first
const POLL_MS = 1000;
const DRAIN_MS = 30000;
const PROBE_MS = 2000;
const SECRET_FORM = /^[0-9a-f]{64}\n?$/;

const hmac = (secret, ...parts) => crypto.createHmac('sha256', secret).update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const frame = (kind, obj) => { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(5); h.write(kind, 0, 'ascii'); h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); };

// Whether the socket proves the secret (contract 2's HELLO and PROVE; AUTH is
// never sent, so no session opens) -> Promise<boolean>
// Used on a socket this daemon's own runtime has just told it listens on;
// a daemon.json's, read from disk, goes through probeRecorded.
function probe(socket, secret, ms = PROBE_MS, {platform = process.platform} = {}) {
  // its own runtime's unix socket, by absolute path, or on Windows its named
  // pipe and nothing else: never a host and port
  const ok = platform === 'win32' ? isPipeName(socket) : (typeof socket === 'string' && path.isAbsolute(socket));
  if (!ok) return Promise.resolve(false);
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

// A daemon.json's socket, which may be stale and on Windows taken by anyone:
// there, PowerShell's probe (lib/pipe-probe.js: Identification only, the
// pipe's owner this user, SYSTEM or Administrators, then the PROVE); on
// POSIX the socket is in the private run directory, and probe() serves.
const probeRecorded = (socket, secret, {platform = process.platform, probePipe = null} = {}) => (platform === 'win32'
  ? (probePipe || require('./pipe-probe').probePipe)(socket, secret, PROBE_MS)
  : probe(socket, secret, PROBE_MS, {platform}));

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

// <home>/run and <home>/run/daemon, made 0700 if missing. On Windows (C4c)
// neither may be a link or a junction; both get a protected DACL (this user
// and SYSTEM, inherited by what is made in them), and must then pass
// privateProblem, checked as directories (an inherit-only rule for anyone
// else flows into the files), in one PowerShell run. -> {runDir} or {problem}
function ensureRunDir(home, {platform = process.platform, winAcl = null} = {}) {
  const run = path.join(home, 'run');
  const runDir = path.join(run, 'daemon');
  if (platform !== 'win32') {
    // (each made on its own, never the home: one an uninstall removed is not
    // made again -- the medium on A9's round, 2)
    for (const d of [run, runDir]) {
      try { fs.mkdirSync(d, {mode: 0o700}); } catch (e) { if (e.code !== 'EEXIST') return {problem: `its run directory ${d} could not be made (${e.code || e.message})`}; }
      fs.chmodSync(d, 0o700);
    }
    return {runDir};
  }
  // a directory there already must be one, not a link or a junction (both
  // read as links), before its DACL is set: a junction's target would have
  // its DACL rewritten (the review of #39). The home was checked before this.
  for (const d of [run, runDir]) {
    let st = null;
    try { st = fs.lstatSync(d); } catch (e) { if (e.code !== 'ENOENT') return {problem: `its run directory ${d} could not be read (${e.code || e.message})`}; }
    if (st != null && (st.isSymbolicLink() || !st.isDirectory())) return {problem: `its run directory ${d} is not a directory (a link or a junction is refused)`};
  }
  const acl = winAcl || require('./win-acl');
  let read;
  try {
    read = acl.makePrivateDirs([run, runDir], [run, runDir]);
  } catch (e) {
    return {problem: `its run directory could not be made private (${e.code || e.message})`};
  }
  const names = [`its run directory ${run}`, `its run directory ${runDir}`];
  for (let i = 0; i < names.length; i++) {
    const why = acl.privateProblem(names[i], read[i], {directory: true});
    if (why != null) return {problem: why};
  }
  return {runDir};
}

// (writePrivate: lib/private-write.js, shared with start's held-back file)
const {writePrivate} = require('./private-write');
const {preloadForSwap} = require('./swap-preload');

const version = (file) => { try { return String(JSON.parse(fs.readFileSync(file, 'utf8')).version); } catch (e) { return 'unknown'; } };

// the runtime, in start's session mode -> Promise<exit code>.
// opts: {socket, sessionDir, home, signal (abort stops the runtime), onListening(msg)}
// The re-exec handoff (C3b): the table, as one frame on the new daemon's fd
// 3, a 4-byte big-endian length and {v: 1, sessions, declines}. It never
// goes in argv or env, and the secret is never in it.
const MAX_HANDOFF = 32 * 1024 * 1024;
function encodeHandoff(restore) {
  const body = Buffer.from(JSON.stringify({v: 1, sessions: restore.sessions, declines: restore.declines}));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}
// -> {sessions, declines} or null
function decodeHandoff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
  const n = buf.readUInt32BE(0);
  if (n > MAX_HANDOFF || buf.length !== 4 + n) return null;
  try {
    const t = JSON.parse(buf.subarray(4).toString('utf8'));
    return t != null && t.v === 1 && Array.isArray(t.sessions) && Array.isArray(t.declines) ? t : null;
  } catch (e) {
    return null;
  }
}

function defaultRun({socket, sessionDir, home, signal, onListening, onTold, onControl, restore, onRestoreRefused}, io) {
  return require('./start').start({passThrough: [], session: {socket, sessionDir, home, signal, onListening, onTold, onControl, restore, onRestoreRefused}}, io);
}

// {home, handoff?} -> exit code. handoff: the bytes read from fd 3 when
// started with --handoff (C3b). run: the runtime's start, for the tests.
async function daemon({home, handoff = null}, io, {run = defaultRun} = {}) {
  if (typeof io.ignoreSignal === 'function') io.ignoreSignal('SIGHUP');
  const fail = (s, code = 1) => { io.stderr.write(`ch-local daemon: ${s}\n`); return code; };
  const say = (s) => io.stderr.write(`ch-local daemon: ${s}\n`);
  const platform = io.platform || process.platform;
  let cwdReal = null;
  let homeReal = null;
  try {
    cwdReal = fs.realpathSync(io.cwd);
    homeReal = fs.realpathSync(home);
  } catch (e) {
    return fail(`the home ${home} could not be read (${e.code || e.message})`, 2);
  }
  if (cwdReal !== homeReal) return fail(`--home ${home} is not the working directory`, 2);
  const owned = require('./home').homeOwnershipProblem(homeReal, platform, {fileAcl: io.winAcl != null ? io.winAcl.fileAcl : undefined});
  if (owned != null) return fail(`--home ${home}: ${owned}`, 2);
  const made = ensureRunDir(home, {platform, winAcl: io.winAcl || null});
  if (made.problem != null) return fail(`--home ${home}: ${made.problem}`, 2);
  const runDir = made.runDir;
  // (it outlives an install's swap of <home>/app: every module it may
  // require later is loaded from this release now, lib/swap-preload.js)
  try { preloadForSwap(); } catch (err) { return fail(`this ch-local could not be loaded whole (${err.code || err.message})`); }
  // the socket for one runtime start: on Windows a new pipe name each time;
  // on POSIX always the same path, its fallback directory checked once here
  const env = io.env || process.env;
  const pickSocket = () => socketFor(runDir, {platform, env}).socket;
  if (platform !== 'win32') {
    const {fallback} = socketFor(runDir, {platform, env});
    const why = fallback != null ? socketDirProblem(fallback) : null;
    if (why != null) return fail(`--home ${home}: ${why}`, 2);
  }
  const lockFile = path.join(runDir, 'start.lock');
  const readyMs = Number.isInteger(io.daemonReadyMs) ? io.daemonReadyMs : READY_MS;
  const stopMs = Number.isInteger(io.daemonStopMs) ? io.daemonStopMs : STOP_MS;
  const idleMs = Number.isInteger(io.daemonIdleMs) ? io.daemonIdleMs : IDLE_MS;
  const backoff = Array.isArray(io.daemonBackoffMs) ? io.daemonBackoffMs : BACKOFF_MS;

  // the session table, in memory only, across this daemon's runtimes, and
  // across a re-exec through the handoff
  const table = createSessionTable({warn: say});
  if (handoff != null) {
    const t = decodeHandoff(handoff);
    if (t == null) say('the handoff from the previous daemon could not be read: starting with an empty session table');
    else {
      const {kept, loosened} = table.seed(t);
      say(`the previous daemon handed over ${kept} session(s)${loosened > 0 ? `; ${loosened} session(s) lost loosenings, which a handover never carries` : ''}`);
    }
  }
  const pollMs = Number.isInteger(io.daemonPollMs) ? io.daemonPollMs : POLL_MS;
  const drainMs = Number.isInteger(io.daemonDrainMs) ? io.daemonDrainMs : DRAIN_MS;
  const selfPackage = typeof io.daemonPackage === 'string' ? io.daemonPackage : path.join(__dirname, '..', 'package.json');
  const runtimePackage = path.join(home, 'app', 'node_modules', 'countinghouse', 'package.json');
  let drained = null;       // resolves the wait after a drain
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
    if (m.type === 'drained') { if (drained != null) drained(); return; }
    if (m.type === 'busy') { isIdle = false; clearTimeout(idleTimer); idleTimer = null; return; }
    if (m.type === 'idle') { isIdle = true; armIdle(); return; }
    table.told(m);
  };

  // one runtime, in start's session mode -> its handle
  const startRuntime = () => {
    const h = {ended: null, told: false, request: null, stop: new AbortController(), socket: pickSocket()};
    const onListening = (m) => { if (m != null && m.type === 'listening' && m.socket === h.socket) h.told = true; };
    h.exited = Promise.resolve()
      .then(() => run({socket: h.socket, sessionDir: runDir, home, signal: h.stop.signal, onListening, onTold, onControl: (fn) => { h.request = fn; }, restore: () => table.restore(),
        // only the runtime still current: a late word from one that has been
        // replaced (it crashed during its restore) never clears the table
        onRestoreRefused: () => { if (current !== h) return; say('the runtime refused the session table: starting it over'); table.clear(); }}, io))
      .then((c) => { h.ended = {code: c}; return c; }, (err) => { h.ended = {code: 1, err}; return 1; });
    // ready: our own runtime told us it listens on this socket (an older
    // runtime's socket can prove a secret too), AND the socket proves it
    h.ready = async() => {
      const until = Date.now() + readyMs;
      while (h.ended == null && Date.now() < until) {
        if (h.told) {
          const secret = readSecret(runDir);
          if (secret != null && await probe(h.socket, secret, 500)) return true;
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
  // (a run directory removed while this waited -- an uninstall -- ends this
  // daemon, never a start without the lock: the medium on A9's round, 2)
  const first = await withLockFile(lockFile, runDir, io, async(release) => {
    const info = readDaemonJson(runDir);
    // another daemon: a live pid, on a socket a daemon of this home would
    // have chosen (on POSIX this one, no other; on Windows a pipe of the
    // form), proving the secret
    if (info != null && Number.isInteger(info.pid) && io.alive(info.pid) && socketOk(info.socket, runDir, {platform, env})) {
      const secret = readSecret(runDir);
      if (secret != null && await probeRecorded(info.socket, secret, {platform, probePipe: io.probePipe || null})) {
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
    const body = {pid: io.pid, socket: current.socket, runtimeVersion: version(runtimePackage),
      daemonVersion: version(selfPackage), started: new Date().toISOString(), runtimeStarted: new Date().toISOString()};
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
  }, {wait: true, what: 'to finish starting the shared runtime', missing: () => { io.stderr.write('ch-local daemon: the home\'s run directory was removed (an uninstall): not starting\n'); return 0; }});
  if (first !== null) return first;

  // Supervised: a runtime that ends unasked is restarted at once, then after
  // 1, 5 and 30 s, each handed the table. After 5 failures in 10 minutes the
  // daemon gives up: failed.json, daemon.json removed, exit 1.
  // Upgrades (#236 section 6): <home>/run/daemon/requests is read from where
  // it stood at adoption. A runtime that changed is drained and restarted
  // with the table; a ch-local that changed re-execs this daemon.
  let offset = readRequests(home, 0).offset;
  let seen = null;
  let upgrading = false;
  let replacing = null;     // a runtime upgrade swapping `current`: the loop waits for it
  let exitCode = 0;
  // drain, and wait for the in-flight calls: until the runtime says drained,
  // or the bound
  const drainWait = async(h) => {
    if (typeof h.request !== 'function') return;
    const waited = new Promise((r) => { drained = r; setTimeout(r, drainMs); });
    await h.request({type: 'drain'});
    await waited;
    drained = null;
  };
  // daemon.json after a restart: the runtime's version, and its socket (on
  // Windows a new pipe name at each start)
  const writeMine = (fields) => {
    mine = Object.assign({}, mine, fields);
    try { writePrivate(runDir, 'daemon.json', `${JSON.stringify(mine)}\n`); } catch (e) { say(`daemon.json could not be rewritten (${e.code || e.message})`); }
  };
  // (runtimeStarted: when this runtime began listening, so `ch-local
  // restart` sees a restart happen -- A5)
  const writeVersion = () => writeMine({socket: current.socket, runtimeVersion: version(runtimePackage), runtimeStarted: new Date().toISOString()});
  // a runtime that ended, until its successor listens: daemon.json names no
  // socket, so nothing probes a name that is free for anyone to take (the
  // review of #39)
  const clearSocket = () => { if (mine != null && mine.socket != null) writeMine({socket: null}); };
  // the runtime drained, then stopped and started again on what is installed
  // and stored (an upgrade of the runtime; a credential added or removed:
  // the new runtime takes the token then), in one hold of start.lock
  const restartRuntime = async(why, what = 'the restarted runtime') => {
    say(`${why}: draining, then restarting the runtime`);
    const h = current;
    await drainWait(h);
    // the stop and the restart in one hold of start.lock, as any restart:
    // a shim's daemon spawned meanwhile waits, then finds this daemon
    await withLockFile(lockFile, runDir, io, async() => {
      if (stopping) return 0;
      // it crashed during the drain, and the loop restarted it onto the
      // installed files already: nothing more to stop or start
      if (current !== h) { if (current.ended == null) writeVersion(); return 0; }
      let done = null;
      replacing = new Promise((r) => { done = r; });
      try {
        await h.abandon();
        clearSocket();
        current = startRuntime();
        if (await current.ready()) writeVersion();
        else {
          if (current.ended == null) await current.abandon();
          if (!stopping) say(`${what} did not listen`);
        }
      } finally {
        replacing = null;
        done();
      }
      return 0;
    }, {wait: true, what: `to finish restarting ${what}`});
  };
  const takeUpInstalled = async() => {
    const runtimeNow = version(runtimePackage);
    const selfNow = version(selfPackage);
    if (selfNow !== mine.daemonVersion) {
      say(`ch-local ${mine.daemonVersion} -> ${selfNow}: draining, then handing over to a new daemon`);
      await drainWait(current);
      await withLockFile(lockFile, runDir, io, async() => {
        stopping = true;
        removeMine();
        // whichever runtime is running now: one that crashed during the drain
        // has been replaced by the loop
        await current.abandon();
        const started = typeof io.spawnDaemon === 'function'
          ? io.spawnDaemon(['daemon', '--home', home, '--handoff'], {handoff: encodeHandoff(table.restore())})
          : false;
        if (!started) { exitCode = 1; say('the new daemon could not be started; the next session starts one, with an empty table'); }
        return 0;
      }, {wait: true, what: 'to hand over to the new daemon'});
      if (exitCode !== 0) return 'handed over';
      // this daemon goes once the new one has written its daemon.json
      const until = Date.now() + READY_MS + stopMs;
      for (;;) {
        const now = readDaemonJson(runDir);
        if (now != null && now.pid !== mine.pid) return 'handed over';
        if (Date.now() > until) { say('the new daemon did not write daemon.json in time; leaving'); return 'handed over'; }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (runtimeNow !== mine.runtimeVersion) {
      await restartRuntime(`countinghouse ${mine.runtimeVersion} -> ${runtimeNow}`, 'the upgraded runtime');
      return 'restarted';
    }
    say('an upgrade request, and nothing changed');
    return 'nothing';
  };
  const poller = setInterval(() => {
    if (upgrading || stopping) return;
    const r = readRequests(home, offset, seen);
    // (a read that made no progress -- refused, or a partial line -- isn't
    // made again until the size changes; one that did forgets it, since the
    // next request line is likely the same length -- A2)
    seen = r.offset === offset ? r.size : null;
    if (r.offset === offset) return;
    offset = r.offset;
    upgrading = true;
    (async() => {
      // every whole line read: the file is emptied under start.lock, which an
      // appender takes too, so nothing written meanwhile is lost
      await withLockFile(lockFile, runDir, io, async() => {
        if (emptyRequests(home, offset)) offset = 0;
        return 0;
      }, {wait: true, what: 'to finish reading its requests'});
      // -> 'restarted' | 'handed over' | 'nothing'
      const upgraded = r.requests.some((q) => q.op === 'upgrade') ? await takeUpInstalled() : 'nothing';
      // a credential stored or removed (ch-local credentials): the runtime
      // takes the token only at its start, so it restarts, unless the
      // upgrade just did (or handed over to a new daemon, which starts one)
      if (r.requests.some((q) => q.op === 'restart') && upgraded === 'nothing' && !stopping) await restartRuntime('a stored credential changed');
    })().catch((e) => say(`the upgrade failed (${e.message})`)).finally(() => { upgrading = false; });
  }, pollMs);
  if (typeof poller.unref === 'function') poller.unref();

  const failures = [];
  for (;;) {
    const watched = current;
    const code = await watched.exited;
    if (stopping) break;
    // the upgrade already swapped in a successor: watch that one
    if (replacing == null && current !== watched) continue;
    // a runtime upgrade stopped it on purpose, and is starting its successor
    if (replacing != null) { await replacing; if (stopping) break; continue; }
    // start.lock from the unasked end until the restarted runtime is ready,
    // or the daemon gives up: a shim that reattaches meanwhile, or the daemon
    // it would spawn, waits on the lock and then finds this daemon, never a
    // second one beside it, and never a failed.json written behind its back
    const gaveUp = await withLockFile(lockFile, runDir, io, async() => {
      // an upgrade may have swapped in a runtime while this waited on the
      // lock: that one runs, and nothing is restarted over it
      if (stopping || current !== watched) return null;
      clearSocket();
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
      if (await current.ready()) {
        writeVersion();
      } else {
        if (current.ended == null) await current.abandon();
        if (!stopping) say('the restarted runtime did not listen');
      }
      return null;
    }, {wait: true, what: 'to finish restarting the shared runtime'});
    if (gaveUp != null) { clearTimeout(idleTimer); clearInterval(poller); return gaveUp; }
    if (stopping) break;
  }
  clearTimeout(idleTimer);
  clearInterval(poller);
  // an upgrade's handover in progress: it finishes, then this daemon goes
  while (upgrading) await new Promise((r) => setTimeout(r, 50));
  // stopped: daemon.json goes if it is still this daemon's (the idle stop
  // and the handover have removed it already), under start.lock
  await withLockFile(lockFile, runDir, io, async() => { removeMine(); return 0; }, {wait: true, what: 'to finish stopping the shared runtime'});
  return exitCode;
}

// Whether a daemon may be serving this home now, for uninstall (A9), under
// start.lock. Failing closed: the socket daemon.json names proves the
// secret, OR daemon.json's pid is alive -- a daemon draining for an upgrade,
// or between a crash and its restart, answers no handshake but lives (the
// medium on A9's round, 1). A live pid only ever adds a refusal; it never
// permits a removal, so a reused one costs a refusal (with the way out),
// never a home. Only a daemon.json whose pid is gone is stale: no clock is
// read, since a clock stepped after boot would call a live daemon stale
// (the final medium on A9, 1).
// ({platform, probePipe, alive}) -> Promise<{serving, pid}>
async function daemonServing(home, {platform = process.platform, probePipe = null, alive = pidAlive} = {}) {
  const runDir = path.join(home, 'run', 'daemon');
  if (!fs.existsSync(path.join(runDir, 'daemon.json'))) return {serving: false, pid: null};
  const recorded = readDaemonJson(runDir);
  // (there but not readable: a check that can't be made, said as such)
  if (recorded == null) return {serving: true, pid: null, by: 'unreadable'};
  const pid = Number.isSafeInteger(recorded.pid) && recorded.pid > 0 ? recorded.pid : null;
  const secret = readSecret(runDir);
  if (secret != null && typeof recorded.socket === 'string' && await probeRecorded(recorded.socket, secret, {platform, probePipe})) return {serving: true, pid, by: 'socket'};
  return pid != null && alive(pid) ? {serving: true, pid, by: 'pid'} : {serving: false, pid};
}
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

module.exports = {daemon, probe, daemonServing, ensureRunDir, encodeHandoff, decodeHandoff, READY_MS, SOCKET, DRAIN_MS, BACKOFF_MS, STOP_MS};
