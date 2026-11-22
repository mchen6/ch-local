'use strict';
require('./tmp-dirs');
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

const {ADOPT_MS, fakeRuntime, daemonIo, tmpHome, runDirOf, socketIn, makeRunDir, hmac, frame, stopLeftDaemons} = require('./daemon-fakes');
// a test that fails before it stops its daemon leaves none running
test.afterEach(() => stopLeftDaemons());
const {isPipeName} = require('../lib/session-socket');
const WIN = process.platform === 'win32';
// owner-only: 0600 and 0700 on POSIX; on Windows the DACL (privateProblem)
const assertPrivate = (p, mode) => {
  if (!WIN) return assert.strictEqual(fs.statSync(p).mode & 0o777, mode, p);
  const winAcl = require('../lib/win-acl');
  return assert.strictEqual(winAcl.privateProblem(p, winAcl.fileAcl(p), {directory: fs.statSync(p).isDirectory()}), null, p);
};
const readDaemonJson = (home) => JSON.parse(fs.readFileSync(path.join(runDirOf(home), 'daemon.json'), 'utf8'));

test('no daemon yet: it starts the runtime, writes daemon.json once the socket proves the secret, frees start.lock, and cleans up when stopped', async() => {
  const home = tmpHome();
  let runtime = null;
  let finish = null;
  let lockWhileRunning = null;
  let given = null;
  const run = async(opts) => {
    given = opts;
    runtime = await fakeRuntime(runDirOf(home), opts.socket);
    opts.onListening({type: 'listening', socket: opts.socket});
    return new Promise((resolve) => { finish = resolve; opts.signal.addEventListener('abort', () => resolve(143)); });
  };
  try {
    const io = daemonIo(home);
    const done = daemon({home}, io, {run});
    const until = Date.now() + ADOPT_MS;
    while (!fs.existsSync(path.join(runDirOf(home), 'daemon.json')) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(path.join(runDirOf(home), 'daemon.json')), `daemon.json never appeared within ${ADOPT_MS / 1000} s`);
    const info = readDaemonJson(home);
    assert.strictEqual(info.pid, process.pid);
    // on Windows a pipe of the form (C4c), on POSIX the run directory's socket
    if (WIN) assert.ok(isPipeName(info.socket), info.socket);
    else assert.strictEqual(info.socket, path.join(runDirOf(home), 'sessions.sock'));
    assert.strictEqual(info.socket, given.socket, 'the socket the runtime was given');
    assert.strictEqual(given.sessionDir, runDirOf(home), 'and its run directory, as --sessionDir');
    assert.strictEqual(typeof info.runtimeVersion, 'string');
    assert.strictEqual(typeof info.daemonVersion, 'string');
    assertPrivate(path.join(runDirOf(home), 'daemon.json'), 0o600);
    assertPrivate(runDirOf(home), 0o700);
    lockWhileRunning = fs.existsSync(path.join(runDirOf(home), 'start.lock'));
    assert.strictEqual(lockWhileRunning, false, 'start.lock is released while the runtime runs');
    assert.deepStrictEqual(io.ignored, ['SIGHUP']);
    assert.strictEqual(given.home, home, 'the runtime is given the home');
    assert.ok(given.signal != null, 'and a signal to stop it');
    // a SIGTERM to the daemon stops it (and its runtime), not a restart
    assert.deepStrictEqual(io.trapped, ['SIGINT', 'SIGTERM']);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
    await runtime.close();
    void finish;
    assert.ok(!fs.existsSync(path.join(runDirOf(home), 'daemon.json')), 'daemon.json goes with the daemon');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a live daemon already in daemon.json, whose socket proves the secret: this one exits 0 and starts nothing', async() => {
  const home = tmpHome();
  const runDir = makeRunDir(home);
  const socket = socketIn(runDir);
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

test('a daemon.json whose pid is dead, or whose socket does not prove the secret, is stale: a runtime is started', async() => {
  for (const kind of ['dead pid', 'wrong proof']) {
    const home = tmpHome();
    const runDir = makeRunDir(home);
    const socket = socketIn(runDir);
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

test('a runtime that never proves the secret within the bound: exit 1, no daemon.json', async() => {
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

test('probe: true only for a socket that proves the secret', async() => {
  const home = tmpHome();
  const runDir = makeRunDir(home);
  const socket = socketIn(runDir, 's');
  const good = await fakeRuntime(runDir, socket);
  try {
    assert.strictEqual(await probe(socket, good.secret, 1000), true);
    assert.strictEqual(await probe(socket, crypto.randomBytes(32), 1000), false);
    assert.strictEqual(await probe(socketIn(runDir, 'nothing'), good.secret, 1000), false);
    assert.strictEqual(await probe('relative.sock', good.secret, 1000), false, 'never a relative path');
  } finally {
    await good.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// C4b's review ---------------------------------------------------------------

test('ready needs both the runtime\'s own listening tell and a PROVE on that socket: a proving socket alone is never adopted', async() => {
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

test('a listening tell naming another socket is not ours', async() => {
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

test('a daemon.json naming a socket this home\'s daemon would not choose is stale, whatever answers there', async() => {
  const home = tmpHome();
  const runDir = makeRunDir(home);
  // POSIX: another socket in the run directory; Windows: a pipe not of the
  // form (every pipe of the form is one a daemon may have chosen)
  const elsewhere = WIN ? `\\\\.\\pipe\\other-${crypto.randomBytes(16).toString('hex')}` : path.join(runDir, 'other.sock');
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

// C4c, Windows's wiring with the platform and the DACL calls injected, so it
// runs everywhere (the real calls run in test/win-acl.test.js on Windows)
const PRIVATE = () => ({user: 'S-1-5-21-1-2-3-1001', owner: 'S-1-5-21-1-2-3-1001', otherAces: false, rules: []});
const winAclFake = (acl = PRIVATE, homeAcl = PRIVATE) => {
  const calls = [];
  return {calls, privateProblem: require('../lib/win-acl').privateProblem, fileAcl: (p) => { calls.push({fileAcl: p}); return homeAcl(p); },
    makePrivateDirs: (dirs, read) => { calls.push({dirs, read}); for (const d of dirs) fs.mkdirSync(d, {recursive: true}); return read.map(acl); }};
};
const OPEN = () => ({user: 'S-1-5-21-1-2-3-1001', owner: 'S-1-5-21-1-2-3-1001', otherAces: false, rules: [{sid: 'S-1-1-0', rights: 1179817, type: 'Allow', inheritOnly: false}]});

test('Windows (injected): the run directories made private first; each runtime start a new pipe of the form, with --sessionDir the run directory', async() => {
  const home = tmpHome();
  try {
    const io = daemonIo(home);
    io.platform = 'win32';
    io.winAcl = winAclFake();
    io.daemonReadyMs = 300;
    const given = [];
    const code = await daemon({home}, io, {run: (opts) => { given.push(opts); return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(143))); }});
    assert.strictEqual(code, 1, 'the fake never listens');
    // the home's ACL first, then the run directories made private and read back
    assert.deepStrictEqual(io.winAcl.calls, [{fileAcl: home}, {dirs: [path.join(home, 'run'), runDirOf(home)], read: [path.join(home, 'run'), runDirOf(home)]}]);
    assert.strictEqual(given.length, 1);
    assert.ok(isPipeName(given[0].socket), given[0].socket);
    assert.strictEqual(given[0].sessionDir, runDirOf(home));
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('Windows (injected): a home or run directory that is not private refuses the start, naming it', async() => {
  const home = tmpHome();
  try {
    const io = daemonIo(home);
    io.platform = 'win32';
    io.winAcl = winAclFake(PRIVATE, OPEN);
    let started = false;
    assert.strictEqual(await daemon({home}, io, {run: async() => { started = true; return 0; }}), 2);
    assert.match(io.err, /--home .*: it is accessible by S-1-1-0/);
    assert.strictEqual(started, false);
    assert.ok(!io.winAcl.calls.some((c) => c.dirs != null), 'no DACL set under a home that fails');
    const runOpen = daemonIo(home);
    runOpen.platform = 'win32';
    runOpen.winAcl = winAclFake(OPEN);
    assert.strictEqual(await daemon({home}, runOpen, {run: async() => { started = true; return 0; }}), 2);
    assert.match(runOpen.err, /its run directory .* is accessible by S-1-1-0/);
    const failing = daemonIo(home);
    failing.platform = 'win32';
    failing.winAcl = {privateProblem: () => null, fileAcl: PRIVATE, makePrivateDirs: () => { throw Object.assign(new Error('timed out'), {code: 'ETIMEDOUT'}); }};
    assert.strictEqual(await daemon({home}, failing, {run: async() => 0}), 2);
    assert.match(failing.err, /could not be made private \(ETIMEDOUT\)/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('Windows (injected): a run directory that is a link (a junction reads as one) is refused before any DACL is set (the review of #39)', {skip: WIN && 'symlinks need a privilege on Windows: the logic runs elsewhere'}, async() => {
  const home = tmpHome();
  const target = tmpHome();
  try {
    fs.symlinkSync(target, path.join(home, 'run'));
    const io = daemonIo(home);
    io.platform = 'win32';
    io.winAcl = winAclFake();
    assert.strictEqual(await daemon({home}, io, {run: async() => 0}), 2);
    assert.match(io.err, /its run directory .*run is not a directory \(a link or a junction is refused\)/);
    assert.ok(!io.winAcl.calls.some((c) => c.dirs != null), 'its target\'s DACL never rewritten');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(target, {recursive: true, force: true});
  }
});

test('Windows (injected): a daemon.json\'s pipe is probed as the shim would (pipe-probe), never by Node\'s connect', async() => {
  for (const verdict of [true, false]) {
    const home = tmpHome();
    try {
      const runDir = makeRunDir(home);
      const pipe = require('../lib/session-socket').newPipeName();
      fs.writeFileSync(path.join(runDir, 'secret'), `${crypto.randomBytes(32).toString('hex')}\n`, {mode: 0o600});
      fs.writeFileSync(path.join(runDir, 'daemon.json'), JSON.stringify({pid: process.pid, socket: pipe, runtimeVersion: 'x', daemonVersion: 'y', started: 'z'}), {mode: 0o600});
      const io = daemonIo(home);
      io.platform = 'win32';
      io.winAcl = winAclFake();
      io.daemonReadyMs = 200;
      const probed = [];
      io.probePipe = async(socket, secret) => { probed.push({socket, secret: secret.length}); return verdict; };
      let started = false;
      const code = await daemon({home}, io, {run: (opts) => { started = true; return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(143))); }});
      assert.deepStrictEqual(probed, [{socket: pipe, secret: 32}]);
      if (verdict) { assert.strictEqual(code, 0); assert.strictEqual(started, false); assert.match(io.err, /another daemon/); }
      else assert.strictEqual(started, true, 'not proven: stale, a runtime is started');
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  }
});

test('the home on Windows (injected): its owner and DACL as a directory, an unreadable ACL refused', () => {
  const {homeOwnershipProblem} = require('../lib/home');
  const home = tmpHome();
  try {
    assert.strictEqual(homeOwnershipProblem(home, 'win32', {fileAcl: PRIVATE}), null);
    assert.match(String(homeOwnershipProblem(home, 'win32', {fileAcl: OPEN})), /accessible by S-1-1-0/);
    const flows = PRIVATE();
    flows.rules.push({sid: 'S-1-1-0', rights: 2032127, type: 'Allow', inheritOnly: true});
    assert.match(String(homeOwnershipProblem(home, 'win32', {fileAcl: () => flows})), /inherit-only rule for S-1-1-0/);
    // a profile's usual "CREATOR OWNER (IO) Full" is admitted; CREATOR
    // GROUP's, a grant to the creator's primary group, and another user's
    // inherit-only rule still fail (the Reviewer)
    const profile = PRIVATE();
    profile.rules.push({sid: 'S-1-3-0', rights: 2032127, type: 'Allow', inheritOnly: true});
    assert.strictEqual(homeOwnershipProblem(home, 'win32', {fileAcl: () => profile}), null);
    const group = PRIVATE();
    group.rules.push({sid: 'S-1-3-1', rights: 2032127, type: 'Allow', inheritOnly: true});
    assert.match(String(homeOwnershipProblem(home, 'win32', {fileAcl: () => group})), /inherit-only rule for S-1-3-1/);
    const another = PRIVATE();
    another.rules.push({sid: 'S-1-5-21-1-2-3-1002', rights: 2032127, type: 'Allow', inheritOnly: true});
    assert.match(String(homeOwnershipProblem(home, 'win32', {fileAcl: () => another})), /inherit-only rule for S-1-5-21-1-2-3-1002/);
    assert.match(String(homeOwnershipProblem(home, 'win32', {fileAcl: () => { throw new Error('denied'); }})), /ACL could not be read/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a home too long for a socket path: the runtime listens in $TMPDIR/ch-<uid>/ (made 0700), recorded in daemon.json, the secret still in the run directory', {skip: WIN && 'POSIX only: Windows has no socket path'}, async() => {
  const base = tmpHome();
  const home = path.join(base, 'h'.repeat(120));
  fs.mkdirSync(home, {mode: 0o700});
  fs.chmodSync(home, 0o700);
  const tmpdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-t-')));
  let runtime = null;
  try {
    const io = daemonIo(home);
    io.env.TMPDIR = tmpdir;
    const uid = process.geteuid();
    const want = path.join(tmpdir, `ch-${uid}`, 'sessions.sock');
    let given = null;
    const done = daemon({home}, io, {run: async(opts) => {
      given = opts;
      runtime = await fakeRuntime(runDirOf(home), opts.socket);
      opts.onListening({type: 'listening', socket: opts.socket});
      return new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(143)));
    }});
    const until = Date.now() + ADOPT_MS;
    while (!fs.existsSync(path.join(runDirOf(home), 'daemon.json')) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(path.join(runDirOf(home), 'daemon.json')), `daemon.json never appeared within ${ADOPT_MS / 1000} s`);
    assert.strictEqual(given.socket, want);
    assert.strictEqual(given.sessionDir, runDirOf(home));
    assert.strictEqual(readDaemonJson(home).socket, want);
    assert.strictEqual(fs.statSync(path.dirname(want)).mode & 0o777, 0o700);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    if (runtime != null) await runtime.close();
    fs.rmSync(base, {recursive: true, force: true});
    fs.rmSync(tmpdir, {recursive: true, force: true});
  }
});

test('a fallback directory that is not the user\'s own directory refuses the start', {skip: WIN && 'POSIX only'}, async() => {
  const base = tmpHome();
  const home = path.join(base, 'h'.repeat(120));
  fs.mkdirSync(home, {mode: 0o700});
  fs.chmodSync(home, 0o700);
  const tmpdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-t-')));
  try {
    fs.symlinkSync(base, path.join(tmpdir, `ch-${process.geteuid()}`));
    const io = daemonIo(home);
    io.env.TMPDIR = tmpdir;
    let started = false;
    assert.strictEqual(await daemon({home}, io, {run: async() => { started = true; return 0; }}), 2);
    assert.match(io.err, /socket directory .* is not a directory/);
    assert.strictEqual(started, false);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
    fs.rmSync(tmpdir, {recursive: true, force: true});
  }
});

test('a runtime that does not end when stopped does not hold start.lock: the daemon returns after its bound', async() => {
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

test('daemon --home must be owned by this user and not group- or world-writable', {skip: WIN && 'POSIX modes; Windows: the DACL test above'}, async() => {
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
