'use strict';
// C4b: ch-local daemon --home <abs> (countinghouse's shared-runtime design,
// #236, section 6, "Starting"): the native shim spawns it with the home as
// its working directory and releases start.lock at once. The daemon takes
// start.lock itself as its first act, checks daemon.json again under it (a
// live pid whose socket proves the secret means another daemon runs: exit),
// starts the runtime on its session socket, writes daemon.json once that
// socket proves the secret, releases the lock while the runtime runs, and
// removes daemon.json when the runtime ends. It ignores SIGHUP.
//
// The runtime is a fake here: a socket that answers HELLO with PROVE under
// the secret it writes, as countinghouse's session listener does.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const {fakeIo} = require('./fake-io');
const {daemon, probe} = require('../lib/daemon');

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
function daemonIo(home) {
  const io = fakeIo({env: {PATH: '/usr/bin:/bin', HOME: os.tmpdir()}, homedir: os.tmpdir});
  io.cwd = home;
  io.pid = process.pid;
  io.alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  io.hostname = os.hostname();
  io.ignored = [];
  io.ignoreSignal = (s) => io.ignored.push(s);
  io.daemonReadyMs = 3000;
  return io;
}
const runDirOf = (home) => path.join(home, 'run', 'daemon');
const readDaemonJson = (home) => JSON.parse(fs.readFileSync(path.join(runDirOf(home), 'daemon.json'), 'utf8'));

test('no daemon yet: it starts the runtime, writes daemon.json once the socket proves the secret, frees start.lock, and cleans up at the end', {skip: process.platform === 'win32'}, async() => {
  const home = tmpHome();
  let runtime = null;
  let finish = null;
  let lockWhileRunning = null;
  let given = null;
  const run = async(opts) => {
    given = opts;
    runtime = await fakeRuntime(runDirOf(home), opts.socket);
    opts.onListening({type: 'listening', socket: opts.socket});
    return new Promise((resolve) => { finish = resolve; });
  };
  try {
    const io = daemonIo(home);
    const done = daemon({home}, io, {run});
    const until = Date.now() + 5000;
    while (!fs.existsSync(path.join(runDirOf(home), 'daemon.json')) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    const info = readDaemonJson(home);
    assert.strictEqual(info.pid, process.pid);
    assert.strictEqual(info.socket, path.join(runDirOf(home), 'sessions.sock'));
    assert.strictEqual(typeof info.runtimeVersion, 'string');
    assert.strictEqual(typeof info.daemonVersion, 'string');
    assert.strictEqual(fs.statSync(path.join(runDirOf(home), 'daemon.json')).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(runDirOf(home)).mode & 0o777, 0o700);
    lockWhileRunning = fs.existsSync(path.join(runDirOf(home), 'start.lock'));
    assert.strictEqual(lockWhileRunning, false, 'start.lock is released while the runtime runs');
    assert.deepStrictEqual(io.ignored, ['SIGHUP']);
    assert.strictEqual(given.home, home, 'the runtime is given the home');
    assert.ok(given.signal != null, 'and a signal to stop it');
    await runtime.close();
    finish(0);
    assert.strictEqual(await done, 0);
    assert.ok(!fs.existsSync(path.join(runDirOf(home), 'daemon.json')), 'daemon.json goes with the runtime');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a live daemon already in daemon.json, whose socket proves the secret: this one exits 0 and starts nothing', {skip: process.platform === 'win32'}, async() => {
  const home = tmpHome();
  const runDir = runDirOf(home);
  fs.mkdirSync(runDir, {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  const socket = path.join(runDir, 'sessions.sock');
  const live = await fakeRuntime(runDir, socket);
  fs.writeFileSync(path.join(runDir, 'daemon.json'), JSON.stringify({pid: process.pid, socket, runtimeVersion: 'x', daemonVersion: 'y', started: new Date().toISOString()}), {mode: 0o600});
  let started = false;
  try {
    assert.strictEqual(await daemon({home}, daemonIo(home), {run: async() => { started = true; return 0; }}), 0);
    assert.strictEqual(started, false);
    assert.strictEqual(readDaemonJson(home).daemonVersion, 'y', 'left as it was');
  } finally {
    await live.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a daemon.json whose pid is dead, or whose socket does not prove the secret, is stale: a runtime is started', {skip: process.platform === 'win32'}, async() => {
  for (const kind of ['dead pid', 'wrong proof']) {
    const home = tmpHome();
    const runDir = runDirOf(home);
    fs.mkdirSync(runDir, {recursive: true, mode: 0o700});
    fs.chmodSync(path.join(home, 'run'), 0o700);
    const socket = path.join(runDir, 'sessions.sock');
    const squatter = kind === 'wrong proof' ? await fakeRuntime(runDir, socket, {wrongSecret: true}) : null;
    fs.writeFileSync(path.join(runDir, 'daemon.json'), JSON.stringify({pid: kind === 'dead pid' ? 2147483646 : process.pid, socket, runtimeVersion: 'x', daemonVersion: 'y', started: 'z'}), {mode: 0o600});
    let started = false;
    try {
      if (squatter != null) await squatter.close();
      const code = await daemon({home}, daemonIo(home), {run: async() => { started = true; return 3; }});
      assert.strictEqual(started, true, kind);
      assert.notStrictEqual(code, 0, `${kind}: the runtime never listened, so the start failed`);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  }
});

test('a runtime that never proves the secret within the bound: exit 1, no daemon.json', {skip: process.platform === 'win32'}, async() => {
  const home = tmpHome();
  try {
    const io = daemonIo(home);
    io.daemonReadyMs = 300;
    let aborted = false;
    const code = await daemon({home}, io, {run: (opts) => new Promise((resolve) => { opts.signal.addEventListener('abort', () => { aborted = true; resolve(143); }); })});
    assert.strictEqual(code, 1);
    assert.ok(!fs.existsSync(path.join(runDirOf(home), 'daemon.json')));
    assert.strictEqual(aborted, true, 'the runtime that never listened is stopped, and awaited');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('--home and the working directory must agree; --home is required and absolute', async() => {
  const home = tmpHome();
  const other = tmpHome();
  try {
    const io = daemonIo(home);
    io.cwd = other;
    assert.strictEqual(await daemon({home}, io, {run: async() => 0}), 2);
    assert.match(io.err, /working directory/);
    const {main} = require('../bin/ch-local');
    assert.strictEqual(await main(['daemon'], daemonIo(home)), 2);
    assert.strictEqual(await main(['daemon', '--home', 'relative'], daemonIo(home)), 2);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(other, {recursive: true, force: true});
  }
});

test('probe: true only for a socket that proves the secret', {skip: process.platform === 'win32'}, async() => {
  const home = tmpHome();
  const runDir = runDirOf(home);
  fs.mkdirSync(runDir, {recursive: true, mode: 0o700});
  const socket = path.join(runDir, 's');
  const good = await fakeRuntime(runDir, socket);
  try {
    assert.strictEqual(await probe(socket, good.secret, 1000), true);
    assert.strictEqual(await probe(socket, crypto.randomBytes(32), 1000), false);
    assert.strictEqual(await probe(path.join(runDir, 'nothing'), good.secret, 1000), false);
  } finally {
    await good.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// C4b's review ---------------------------------------------------------------

test('ready needs both the runtime\'s own listening tell and a PROVE on that socket: a proving socket alone is never adopted', {skip: process.platform === 'win32'}, async() => {
  const home = tmpHome();
  let aborted = false;
  let other = null;
  try {
    const io = daemonIo(home);
    io.daemonReadyMs = 600;
    // another, older runtime proves on the expected socket, but ours never tells
    const code = await daemon({home}, io, {run: async(opts) => {
      other = await fakeRuntime(runDirOf(home), opts.socket);
      return new Promise((resolve) => { opts.signal.addEventListener('abort', () => { aborted = true; resolve(143); }); });
    }});
    assert.strictEqual(code, 1);
    assert.strictEqual(aborted, true, 'the runtime that never told is stopped');
    assert.ok(!fs.existsSync(path.join(runDirOf(home), 'daemon.json')), 'nothing adopted');
  } finally {
    if (other != null) await other.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a listening tell naming another socket is not ours', {skip: process.platform === 'win32'}, async() => {
  const home = tmpHome();
  try {
    const io = daemonIo(home);
    io.daemonReadyMs = 400;
    const code = await daemon({home}, io, {run: async(opts) => {
      opts.onListening({type: 'listening', socket: path.join(home, 'elsewhere.sock')});
      return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(143)));
    }});
    assert.strictEqual(code, 1);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a daemon.json naming another socket is stale, whatever answers there', {skip: process.platform === 'win32'}, async() => {
  const home = tmpHome();
  const runDir = runDirOf(home);
  fs.mkdirSync(runDir, {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(home, 'run'), 0o700);
  const elsewhere = path.join(runDir, 'other.sock');
  const live = await fakeRuntime(runDir, elsewhere);
  fs.writeFileSync(path.join(runDir, 'daemon.json'), JSON.stringify({pid: process.pid, socket: elsewhere, runtimeVersion: 'x', daemonVersion: 'y', started: 'z'}), {mode: 0o600});
  let started = false;
  try {
    const io = daemonIo(home);
    io.daemonReadyMs = 300;
    await daemon({home}, io, {run: async(opts) => { started = true; return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(143))); }});
    assert.strictEqual(started, true);
  } finally {
    await live.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('on Windows the daemon is refused for now (the shim then runs one runtime per session)', async() => {
  const home = tmpHome();
  try {
    const io = daemonIo(home);
    io.platform = 'win32';
    assert.strictEqual(await daemon({home}, io, {run: async() => 0}), 2);
    assert.match(io.err, /Windows/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a runtime that does not end when stopped does not hold start.lock: the daemon returns after its bound', {skip: process.platform === 'win32'}, async() => {
  const home = tmpHome();
  try {
    const io = daemonIo(home);
    io.daemonReadyMs = 300;
    io.daemonStopMs = 300;
    const t0 = Date.now();
    const code = await daemon({home}, io, {run: () => new Promise(() => {})});   // never ends, whatever it is told
    assert.strictEqual(code, 1);
    assert.ok(Date.now() - t0 < 5000, 'bounded');
    assert.ok(!fs.existsSync(path.join(runDirOf(home), 'start.lock')), 'the lock released');
    assert.match(io.err, /did not end/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('daemon --home must be owned by this user and not group- or world-writable', {skip: process.platform === 'win32'}, async() => {
  const home = tmpHome();
  try {
    fs.chmodSync(home, 0o775);
    const io = daemonIo(home);
    assert.strictEqual(await daemon({home}, io, {run: async() => 0}), 2);
    assert.match(io.err, /writable/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});
