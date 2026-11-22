'use strict';
// The daemon tests' fakes (test/daemon.test.js, test/daemon-lifecycle.test.js):
// a runtime that proves its secret, and the shim's cleared environment.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {fakeIo} = require('./fake-io');

const tmpHome = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-d-')));
const hmac = (secret, ...parts) => crypto.createHmac('sha256', secret).update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const frame = (kind, obj) => { const b = Buffer.from(JSON.stringify(obj)); const h = Buffer.alloc(5); h.write(kind, 0, 'ascii'); h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); };

// a fake runtime: writes the secret (0600) in run/daemon, listens on socket,
// answers each HELLO with a PROVE under that secret -> {close, secret}
async function fakeRuntime(runDir, socket, {wrongSecret = false} = {}) {
  const secret = crypto.randomBytes(32);
  fs.writeFileSync(path.join(runDir, 'secret'), `${secret.toString('hex')}\n`, {mode: 0o600});
  const key = wrongSecret ? crypto.randomBytes(32) : secret;
  const server = net.createServer((c) => {
    let buf = Buffer.alloc(0);
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 5) return;
      const n = buf.readUInt32BE(1);
      if (buf.length < 5 + n) return;
      const hello = JSON.parse(buf.subarray(5, 5 + n).toString('utf8'));
      const nc = Buffer.from(hello.nc, 'base64');
      const ns = crypto.randomBytes(32);
      c.write(frame('P', {ns: ns.toString('base64'), ms: hmac(key, 'ch-server', Buffer.from([1]), nc, ns).toString('base64')}));
    });
    c.on('error', () => {});
  });
  await new Promise((r) => server.listen(socket, r));
  return {secret, close: () => new Promise((r) => server.close(r))};
}

// the shim's cleared environment: only shim.json's allowlist, never
// COUNTINGHOUSE_HOME
// every daemon io made, so a test that fails before it stops its daemon
// leaves none running (a daemon's poller would hold the process open until
// the job's timeout): stopLeftDaemons() after each test
const made = new Set();
function stopLeftDaemons() {
  for (const io of made) {
    if (typeof io.signal === 'function') { try { io.signal('SIGTERM'); } catch (e) { /* it was ending */ } }
  }
  made.clear();
}
function daemonIo(home) {
  const io = fakeIo({env: {PATH: '/usr/bin:/bin', HOME: os.tmpdir()}, homedir: os.tmpdir});
  made.add(io);
  io.cwd = home;
  io.pid = process.pid;
  io.alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  io.hostname = os.hostname();
  io.ignored = [];
  io.ignoreSignal = (s) => io.ignored.push(s);
  // the daemon's own SIGINT/SIGTERM trap: io.signal('SIGTERM') delivers one
  io.trapSignals = (handler, signals) => { io.trapped = signals; io.signal = handler; return () => { io.signal = null; }; };
  io.daemonReadyMs = 3000;
  // (the runtime log is off unless a test turns it on: test/runtime-log.test.js,
  // and the daemon's own cases there)
  io.runtimeLog = false;
  return io;
}
const runDirOf = (home) => path.join(home, 'run', 'daemon');
// a socket a daemon of this home would choose (C4c): on Windows a new pipe
// name of the form, on POSIX the run directory's (name: another one there)
const socketIn = (runDir, name = 'sessions.sock') => (process.platform === 'win32' ? require('../lib/session-socket').newPipeName() : path.join(runDir, name));
// the run directory, as a test makes it ahead of the daemon (POSIX 0700)
const makeRunDir = (home) => {
  const runDir = runDirOf(home);
  fs.mkdirSync(runDir, {recursive: true, mode: 0o700});
  if (process.platform !== 'win32') fs.chmodSync(path.join(home, 'run'), 0o700);
  return runDir;
};

// How long a test waits on something a daemon makes observable (daemon.json
// written, a runtime started): on Windows adoption runs PowerShell ACL checks
// first (the home, run/, run/daemon, daemon.json's own), 1 to 10 s each on a
// runner, so 5 s is not enough there (#142's Windows leg). A bound on an
// observable wait, never a sleep.
const ADOPT_MS = process.platform === 'win32' ? 60000 : 5000;

module.exports = {ADOPT_MS, fakeRuntime, daemonIo, stopLeftDaemons, tmpHome, runDirOf, socketIn, makeRunDir, hmac, frame};
