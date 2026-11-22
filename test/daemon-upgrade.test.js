'use strict';
require('./tmp-dirs');
// C3b: ch-local daemon's upgrades (#236 section 6, "Upgrade"). It watches
// <home>/run/daemon/requests. On an upgrade request:
// - the runtime changed: drain, stop it, start the new one with the table
//   (no failure counted);
// - ch-local changed: drain; under start.lock remove daemon.json, stop the
//   runtime, and start a new daemon handed the table over a pipe (fd 3),
//   never argv or env; exit once the new daemon has written daemon.json;
// - nothing changed: nothing happens.
// A daemon started with a handoff seeds its table from it; a bad one starts
// empty.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {daemon, encodeHandoff} = require('../lib/daemon');
const {requestUpgrade, requestRestart} = require('../lib/daemon-requests');
const {fakeRuntime, daemonIo, tmpHome, runDirOf, stopLeftDaemons} = require('./daemon-fakes');
// a test that fails before it stops its daemon leaves none running
test.afterEach(() => stopLeftDaemons());

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ID = (n) => n.toString(16).padStart(32, '0');
const HASH = 'f'.repeat(64);

function scripted(home) {
  const r = {calls: []};
  r.run = async(opts) => {
    // a stale socket file (POSIX); a pipe leaves none
    if (!require('../lib/session-socket').isPipeName(opts.socket)) fs.rmSync(opts.socket, {force: true});
    const rt = await fakeRuntime(runDirOf(home), opts.socket);
    let end = null;
    const exited = new Promise((res) => { end = res; });
    const call = {opts, restore: opts.restore(), requests: [], ended: false};
    call.exit = async(code) => { if (call.ended) return; call.ended = true; await rt.close(); if (typeof r.onEnd === 'function') r.onEnd(call); end(code); };
    call.tell = (m) => opts.onTold(m);
    opts.onControl((msg) => { call.requests.push(msg); return Promise.resolve({ok: true}); });
    opts.signal.addEventListener('abort', () => { call.exit(143); });
    r.calls.push(call);
    // r.delay: this runtime is slow to listen (ms)
    const delay = typeof r.delay === 'function' ? r.delay(r.calls.length) : 0;
    const listen = () => { call.listenedAt = Date.now(); opts.onListening({type: 'listening', socket: opts.socket}); };
    if (delay > 0) setTimeout(() => { if (!call.ended) listen(); }, delay);
    else listen();
    return exited;
  };
  r.nth = async(n, ms = 5000) => {
    const until = Date.now() + ms;
    while (r.calls.length <= n && Date.now() < until) await tick();
    assert.ok(r.calls.length > n, `runtime ${n + 1} never started`);
    return r.calls[n];
  };
  return r;
}
const daemonJson = (home) => path.join(runDirOf(home), 'daemon.json');
const adopted = async(home) => {
  const until = Date.now() + 5000;
  while (!fs.existsSync(daemonJson(home)) && Date.now() < until) await tick();
  assert.ok(fs.existsSync(daemonJson(home)), 'adopted');
};
// a home with an installed runtime and a ch-local package.json of known versions
function setup() {
  const home = tmpHome();
  const rt = path.join(home, 'app', 'node_modules', 'countinghouse');
  fs.mkdirSync(rt, {recursive: true});
  fs.writeFileSync(path.join(rt, 'package.json'), JSON.stringify({name: 'countinghouse', version: '8.0.0'}));
  const self = path.join(home, 'self-package.json');
  fs.writeFileSync(self, JSON.stringify({name: '@countinghouse/ch-local', version: '1.0.0'}));
  const io = daemonIo(home);
  io.daemonPackage = self;
  io.daemonPollMs = 30;
  io.daemonDrainMs = 60;
  io.daemonBackoffMs = [0, 20, 40, 60];
  io.daemonIdleMs = 60000;
  const set = (file, version) => { const p = JSON.parse(fs.readFileSync(file, 'utf8')); p.version = version; fs.writeFileSync(file, JSON.stringify(p)); };
  return {home, io, runtimePkg: path.join(rt, 'package.json'), self, set};
}

test('the runtime changed: drained, stopped, and the new one started with the table; daemon.json names its version', async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    one.tell({type: 'session-resume', session: ID(1), hash: HASH});
    set(runtimePkg, '8.1.0');
    await requestUpgrade(home);
    const two = await s.nth(1);
    assert.ok(one.requests.some((m) => m.type === 'drain'), 'drained first');
    assert.strictEqual(one.ended, true);
    assert.deepStrictEqual(two.restore.sessions.map((r) => r.session), [ID(1)], 'handed the table');
    const until = Date.now() + 3000;
    while (JSON.parse(fs.readFileSync(daemonJson(home), 'utf8')).runtimeVersion !== '8.1.0' && Date.now() < until) await tick();
    assert.strictEqual(JSON.parse(fs.readFileSync(daemonJson(home), 'utf8')).runtimeVersion, '8.1.0');
    assert.ok(!fs.existsSync(path.join(runDirOf(home), 'failed.json')));
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// A9 (the medium on its round, 2): a daemon waiting on start.lock while an
// uninstall removes the run directory starts nothing, and makes no home again
test('A9: a daemon whose run directory goes while it waits on start.lock starts nothing, and makes no run directory again', async() => {
  const {home, io} = setup();
  try {
    const {withLockFile} = require('../lib/lock');
    const dir = runDirOf(home);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    let release = null;
    const held = withLockFile(path.join(dir, 'start.lock'), dir, io, () => new Promise((r) => { release = r; }), {wait: true});
    while (release == null) await tick();
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    await tick(200);
    fs.rmSync(path.join(home, 'run'), {recursive: true, force: true});
    release(0);
    await held;
    assert.strictEqual(await done, 0);
    assert.strictEqual(s.calls.length, 0, 'no runtime started');
    assert.match(io.err, /the home's run directory was removed \(an uninstall\): not starting/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('an upgrade request with nothing changed does nothing', async() => {
  const {home, io} = setup();
  try {
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    await requestUpgrade(home);
    await tick(300);
    assert.strictEqual(s.calls.length, 1);
    assert.deepStrictEqual(one.requests.filter((m) => m.type === 'drain'), []);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// a credential stored or removed (ch-local credentials): the runtime takes
// the token at its start, so it is drained and started again, even when an
// upgrade request with nothing changed came in the same read
test('a restart request (a credential changed): drained and started again, also beside an upgrade request that changed nothing', async() => {
  for (const withUpgrade of [false, true]) {
    const {home, io} = setup();
    try {
      const s = scripted(home);
      const done = daemon({home}, io, {run: s.run});
      const one = await s.nth(0);
      await adopted(home);
      if (withUpgrade) await requestUpgrade(home);
      await requestRestart(home);
      await s.nth(1);
      assert.ok(one.requests.some((m) => m.type === 'drain'), 'drained first');
      assert.strictEqual(s.calls.length, 2, `withUpgrade ${withUpgrade}`);
      assert.match(io.err, /a stored credential changed: draining, then restarting the runtime/);
      io.signal('SIGTERM');
      assert.strictEqual(await done, 0);
    } finally {
      fs.rmSync(home, {recursive: true, force: true});
    }
  }
});

test('ch-local changed: a new daemon is started with the table on its handoff pipe, never in argv or env; this one exits once it runs', async() => {
  const {home, io, self, set} = setup();
  try {
    const s = scripted(home);
    let spawned = null;
    io.spawnDaemon = (args, {handoff, env}) => {
      spawned = {args, handoff, env, daemonJsonThen: fs.existsSync(daemonJson(home))};
      // the new daemon takes over: its daemon.json, its own pid
      setTimeout(() => fs.writeFileSync(daemonJson(home), JSON.stringify({pid: 999999, socket: 'x', runtimeVersion: 'y', daemonVersion: '2.0.0', started: 'z'}), {mode: 0o600}), 100);
      return true;
    };
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    one.tell({type: 'session-resume', session: ID(7), hash: HASH});
    set(self, '2.0.0');
    await requestUpgrade(home);
    assert.strictEqual(await done, 0, io.err);
    assert.ok(one.requests.some((m) => m.type === 'drain'), 'drained first');
    assert.strictEqual(one.ended, true, 'its runtime stopped before the new daemon starts');
    assert.deepStrictEqual(spawned.args, ['daemon', '--home', home, '--handoff']);
    assert.strictEqual(spawned.daemonJsonThen, false, 'daemon.json removed before the spawn');
    const n = spawned.handoff.readUInt32BE(0);
    const body = JSON.parse(spawned.handoff.subarray(4, 4 + n).toString('utf8'));
    assert.strictEqual(body.v, 1);
    assert.deepStrictEqual(body.sessions.map((r) => [r.session, r.resume]), [[ID(7), HASH]]);
    const outside = JSON.stringify(spawned.args) + JSON.stringify(spawned.env || {});
    assert.ok(!outside.includes(HASH) && !outside.includes(ID(7)), 'the table never in argv or env');
    assert.strictEqual(JSON.parse(fs.readFileSync(daemonJson(home), 'utf8')).pid, 999999, 'the new daemon\'s daemon.json is left alone');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a daemon started with a handoff seeds its table from it; a bad handoff starts empty, saying so', async() => {
  const {home, io} = setup();
  try {
    const s = scripted(home);
    const handoff = encodeHandoff({type: 'restore', sessions: [{session: ID(3), resume: HASH, state: {overrides: [], locks: ['pack'], formsLeft: 1}}], declines: [{kind: 'pack', at: Date.now()}]});
    const done = daemon({home, handoff}, io, {run: s.run});
    const one = await s.nth(0);
    // (the kind pack stays pack until M5b: the runtime refuses any other)
    assert.deepStrictEqual(one.restore.sessions, [{session: ID(3), resume: HASH, state: {overrides: [], locks: ['pack'], formsLeft: 1}}]);
    assert.strictEqual(one.restore.declines.length, 1);
    // stopped while it was still starting: a stop, not a failure
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
    assert.ok(!fs.existsSync(path.join(runDirOf(home), 'failed.json')), 'no failed.json for a stop');
    const io2 = setup().io;
    io2.cwd = home;
    const t = scripted(home);
    const done2 = daemon({home, handoff: Buffer.from('not a handoff')}, io2, {run: t.run});
    const first = await t.nth(0);
    assert.deepStrictEqual(first.restore.sessions, []);
    assert.match(io2.err, /handoff/);
    io2.signal('SIGTERM');
    assert.strictEqual(await done2, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('the CLI: daemon --handoff reads the table from fd 3 (io.readHandoff), and without it reads nothing', async() => {
  const {main} = require('../bin/ch-local');
  const seen = [];
  const io = daemonIo(tmpHome());
  // a --home that is not the working directory: the daemon returns 2 at
  // once, so only the CLI's reading is under test
  const other = tmpHome();
  io.readHandoff = async() => { seen.push('read'); return Buffer.alloc(0); };
  assert.strictEqual(await main(['daemon', '--home', other, '--handoff'], io), 2);
  assert.deepStrictEqual(seen, ['read']);
  assert.strictEqual(await main(['daemon', '--home', other], io), 2);
  assert.deepStrictEqual(seen, ['read'], 'no --handoff: fd 3 is not read');
  fs.rmSync(io.cwd, {recursive: true, force: true});
  fs.rmSync(other, {recursive: true, force: true});
});

// the review of #35 --------------------------------------------------------------

test('(1) a runtime upgrade holds start.lock from the stop until the new runtime is ready: a daemon spawned meanwhile finds this one', async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    const s = scripted(home);
    s.delay = (n) => (n === 2 ? 600 : 0);   // the upgraded runtime is slow to listen
    const done = daemon({home}, io, {run: s.run});
    await s.nth(0);
    await adopted(home);
    set(runtimePkg, '8.1.0');
    // a shim's daemon arrives the moment the old runtime has ended, before the
    // upgraded one starts
    const other = scripted(home);
    let second = null;
    s.onEnd = (c) => {
      if (c !== s.calls[0] || second != null) return;
      const io2 = daemonIo(home);
      io2.daemonPackage = io.daemonPackage;
      second = daemon({home}, io2, {run: other.run}).then((code) => ({code, at: Date.now()}));
    };
    await requestUpgrade(home);
    const two = await s.nth(1);
    const until2 = Date.now() + 5000;
    while (second == null && Date.now() < until2) await tick();
    const got = await second;
    assert.strictEqual(got.code, 0, 'it waited on the lock, then found this daemon');
    assert.ok(two.listenedAt != null && got.at >= two.listenedAt, 'still waiting until the upgraded runtime listened');
    assert.strictEqual(other.calls.length, 0, 'and started no runtime');
    assert.strictEqual(JSON.parse(fs.readFileSync(daemonJson(home), 'utf8')).pid, process.pid, 'this daemon\'s daemon.json kept');
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('(2) a crash during a runtime upgrade\'s drain: the crash\'s restart stands, no second restart, and the next crash still counts', async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    io.daemonDrainMs = 400;
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    set(runtimePkg, '8.1.0');
    await requestUpgrade(home);
    const until = Date.now() + 3000;
    while (!one.requests.some((m) => m.type === 'drain') && Date.now() < until) await tick();
    await one.exit(1);   // it crashes while draining
    const two = await s.nth(1);
    // the upgrade's restart finds the crash's runtime already on the new
    // files and writes its version once it holds start.lock: polled, since
    // on Windows the lock's ACL work takes PowerShell's time (#39's first
    // Windows run read it after a fixed 800 ms, too soon)
    const versionBy = Date.now() + 10000;
    while (JSON.parse(fs.readFileSync(daemonJson(home), 'utf8')).runtimeVersion !== '8.1.0' && Date.now() < versionBy) await tick();
    assert.strictEqual(JSON.parse(fs.readFileSync(daemonJson(home), 'utf8')).runtimeVersion, '8.1.0');
    await tick(400);
    assert.strictEqual(s.calls.length, 2, 'the upgrade did not stop the restarted runtime too');
    assert.strictEqual(two.ended, false);
    await two.exit(1);   // a real crash: counted, restarted after the backoff
    await s.nth(2);
    assert.strictEqual((io.err.match(/the shared runtime ended \(exit 1\)/g) || []).length, 2, 'both crashes counted');
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('(2) a crash during a ch-local upgrade\'s drain: the runtime running then is the one stopped before the new daemon starts', async() => {
  const {home, io, self, set} = setup();
  try {
    io.daemonDrainMs = 400;
    const s = scripted(home);
    let runningAtSpawn = null;
    io.spawnDaemon = () => {
      runningAtSpawn = s.calls.filter((c) => !c.ended).length;
      setTimeout(() => fs.writeFileSync(daemonJson(home), JSON.stringify({pid: 999999, socket: 'x', runtimeVersion: 'y', daemonVersion: '2.0.0', started: 'z'}), {mode: 0o600}), 100);
      return true;
    };
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    set(self, '2.0.0');
    await requestUpgrade(home);
    const until = Date.now() + 3000;
    while (!one.requests.some((m) => m.type === 'drain') && Date.now() < until) await tick();
    await one.exit(1);
    const two = await s.nth(1);
    assert.strictEqual(await done, 0, io.err);
    assert.strictEqual(two.ended, true, 'the restarted runtime was stopped');
    assert.strictEqual(runningAtSpawn, 0, 'no runtime of this daemon\'s left when the new daemon starts');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('(3) a handoff never restores a loosening: confirmed loosenings are dropped; stale pack.* overrides handed on for the runtime to drop and tell; tightenings, locks (the kind pack as it is, until M5b) and forms left are kept', async() => {
  const {home, io} = setup();
  try {
    const s = scripted(home);
    const state = {overrides: [
      {name: 'requestTimeout', value: 120000, loosening: true, over: 30000, version: null},
      {name: 'maxOutputBytes', value: 1048576, loosening: false, over: null, version: null},
      {name: 'pack.extra', value: true, loosening: true, over: null, version: '1.0.0'},
      {name: 'pack.hidden', value: false, loosening: false, over: null, version: '1.0.0'}
    ], locks: ['pack'], formsLeft: 1};
    const handoff = encodeHandoff({type: 'restore', sessions: [{session: ID(5), resume: HASH, state}], declines: []});
    const done = daemon({home, handoff}, io, {run: s.run});
    const one = await s.nth(0);
    // (L3, #413 section 10: the kind pack stays pack until M5b; a pack override of the
    // pack form's shape, on or off, is handed on: the runtime drops it at the
    // restore, never applying it, and tells the session naming the packs)
    assert.deepStrictEqual(one.restore.sessions[0].state, {overrides: [state.overrides[1], state.overrides[2], state.overrides[3]], locks: ['pack'], formsLeft: 1});
    assert.match(io.err, /1 session\(s\) lost loosenings/);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('(5) the requests file is emptied once read, under start.lock, and a request written meanwhile is never lost', async() => {
  const {home, io} = setup();
  try {
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    await s.nth(0);
    await adopted(home);
    await requestUpgrade(home);
    const file = path.join(runDirOf(home), 'requests');
    const until = Date.now() + 3000;
    while (fs.statSync(file).size > 0 && Date.now() < until) await tick();
    assert.strictEqual(fs.statSync(file).size, 0, 'emptied');
    await requestUpgrade(home);
    const until2 = Date.now() + 3000;
    while (!/nothing changed[\s\S]*nothing changed/.test(io.err) && Date.now() < until2) await tick();
    assert.match(io.err, /nothing changed[\s\S]*nothing changed/, 'the second request was read too');
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('(2b) a crash at the drain itself: still one restart, never a second runtime over the first (the re-check of #35)', async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    io.daemonDrainMs = 200;
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    // the drain is the runtime's last act: it crashes as it is asked
    const answered = one.requests.push.bind(one.requests);
    one.requests.push = (m) => { answered(m); if (m.type === 'drain') setTimeout(() => one.exit(1), 0); return one.requests.length; };
    set(runtimePkg, '8.1.0');
    await requestUpgrade(home);
    await s.nth(1);
    await tick(1200);
    assert.strictEqual(s.calls.length, 2, 'one runtime after the crash, not two');
    assert.strictEqual(s.calls.filter((c) => !c.ended).length, 1, 'and exactly one running');
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});
