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
const {ADOPT_MS, fakeRuntime, daemonIo, tmpHome, runDirOf, stopLeftDaemons} = require('./daemon-fakes');
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
    // (r.hangDrain: this runtime never answers a drain request; r.drainReply:
    // what it answers one with)
    opts.onControl((msg) => {
      call.requests.push(msg);
      if (msg.type === 'drain' && r.hangDrain) return new Promise(() => {});
      if (msg.type === 'drain' && r.drainReply != null) return Promise.resolve(r.drainReply);
      // (r.drainHold: a drain answered once this promise settles)
      if (msg.type === 'drain' && r.drainHold != null) return r.drainHold.then(() => ({ok: true}));
      return Promise.resolve({ok: true});
    });
    opts.signal.addEventListener('abort', () => { call.exit(143); });
    r.calls.push(call);
    // r.delay: this runtime is slow to listen (ms)
    const delay = typeof r.delay === 'function' ? r.delay(r.calls.length) : 0;
    const listen = () => { call.listenedAt = Date.now(); opts.onListening({type: 'listening', socket: opts.socket}); };
    if (delay > 0) setTimeout(() => { if (!call.ended) listen(); }, delay);
    else listen();
    return exited;
  };
  r.nth = async(n, ms = ADOPT_MS) => {
    const until = Date.now() + ms;
    while (r.calls.length <= n && Date.now() < until) await tick();
    assert.ok(r.calls.length > n, `runtime ${n + 1} never started`);
    return r.calls[n];
  };
  return r;
}
const daemonJson = (home) => path.join(runDirOf(home), 'daemon.json');
const adopted = async(home) => {
  const until = Date.now() + ADOPT_MS;
  while (!fs.existsSync(daemonJson(home)) && Date.now() < until) await tick();
  assert.ok(fs.existsSync(daemonJson(home)), `adopted: daemon.json never appeared in ${runDirOf(home)} within ${ADOPT_MS / 1000} s`);
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
    assert.ok(!fs.existsSync(path.join(home, 'run')), 'no run directory made again');
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
      assert.match(io.err, /a restart was asked for \(a stored credential changed, or the restart command\): draining, then restarting the runtime/);
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
    const until2 = Date.now() + ADOPT_MS;
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

// A13: a drain waits as long as a call may still be inside its own timeout --
// the requestTimeout setting's largest value, 120 s, whatever is stored now,
// and 2 s for the answer's way back; it ends once the runtime says drained
// (its timer cleared), once the runtime ends, or at the bound even when the
// drain request is never answered; and a drain holds no start.lock (the stop
// and the restart take it after).
const {drainBoundMs} = require('../lib/daemon');
const storeTimeout = (home, ms) => fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {requestTimeout: ms}}));
// the drain's timers, counted, and never firing by themselves
const heldTimers = () => {
  const c = {set: [], cleared: 0, fired: 0};
  c.setTimeout = (fn, ms) => { const t = {ms, fn}; c.set.push(t); return t; };
  c.clearTimeout = (t) => { if (c.set.includes(t)) c.cleared++; };
  return c;
};
const drainSeen = async(call) => {
  const until = Date.now() + 5000;
  while (!call.requests.some((m) => m.type === 'drain') && Date.now() < until) await tick();
  assert.ok(call.requests.some((m) => m.type === 'drain'), 'asked to drain');
};

test('A13: the drain bound is the longest requestTimeout and 2 s, whatever is stored', () => {
  assert.strictEqual(drainBoundMs(), 122000);
});

test('A13: an upgrade waiting on its drain when the loop gives up restarts nothing', async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    io.daemonDrainMs = 60000;
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    let call = await s.nth(0);
    await adopted(home);
    // four ends counted, each restarted
    for (let i = 1; i <= 4; i++) { await call.exit(1); call = await s.nth(i); }
    // (the last restart has written its version: the upgrade is one)
    const by = Date.now() + 5000;
    while (JSON.parse(fs.readFileSync(daemonJson(home), 'utf8')).socket !== call.opts.socket && Date.now() < by) await tick();
    set(runtimePkg, '8.1.0');
    await requestUpgrade(home);
    await drainSeen(call);
    await call.exit(1);   // the fifth, during the drain: given up
    assert.strictEqual(await done, 1);
    await tick(300);
    assert.strictEqual(s.calls.length, 5, 'nothing started after giving up');
    assert.ok(fs.existsSync(path.join(runDirOf(home), 'failed.json')));
    assert.strictEqual(fs.existsSync(daemonJson(home)), false, 'no daemon.json written after giving up');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('A13: a restart\'s drain waits up to the bound, with a low timeout stored; ends when the runtime says drained, its timer cleared', async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    delete io.daemonDrainMs;
    const timers = heldTimers();
    io.daemonDrainTimers = timers;
    // (a stored value the runtime may not run with: not the bound)
    storeTimeout(home, 5000);
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    set(runtimePkg, '8.1.0');
    await requestUpgrade(home);
    await drainSeen(one);
    await tick(100);
    assert.strictEqual(s.calls.length, 1, 'still draining: its bound has not passed');
    one.tell({type: 'drained'});
    await s.nth(1);
    assert.deepStrictEqual(timers.set.map((x) => x.ms), [122000], 'one drain timer, the bound');
    assert.strictEqual(timers.cleared, 1, 'cleared: the restart came from drained, the timer never fired');
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// (the drain also waits for the loop to take that end before its caller
// goes on; in one process the loop, waiting on the same end first, always
// takes it first, so that order is guaranteed there, not tested here)
test('A13: a runtime that ends during the drain ends the wait; that end counted once, and restarted once', async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    delete io.daemonDrainMs;
    const timers = heldTimers();
    io.daemonDrainTimers = timers;
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    set(runtimePkg, '8.1.0');
    await requestUpgrade(home);
    await drainSeen(one);
    await one.exit(1);
    await s.nth(1);
    const until = Date.now() + 10000;
    while (JSON.parse(fs.readFileSync(daemonJson(home), 'utf8')).runtimeVersion !== '8.1.0' && Date.now() < until) await tick();
    // (the wait ended on the runtime's end: its bound cleared, never fired)
    assert.strictEqual(timers.cleared, 1, 'the drain\'s wait ended');
    assert.strictEqual((io.err.match(/the shared runtime ended \(exit 1\)/g) || []).length, 1, 'the end counted by the loop');
    await tick(300);
    assert.strictEqual(s.calls.length, 2, 'restarted once: the upgrade found the loop\'s restart');
    // (and the daemon reads requests again: the upgrade ended)
    set(runtimePkg, '8.2.0');
    await requestUpgrade(home);
    const two = s.calls[1];
    await drainSeen(two);
    two.tell({type: 'drained'});
    await s.nth(2);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('A13: a loop that does not take a runtime\'s end during the drain: the wait for it is bounded, said, and one runtime follows', async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    delete io.daemonDrainMs;
    const timers = heldTimers();
    io.daemonDrainTimers = timers;
    // (the loop holds start.lock through a long backoff before it replaces
    // the ended runtime: it has not taken the end when the bound fires)
    io.daemonBackoffMs = [3000, 3000, 3000, 3000];
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    set(runtimePkg, '8.1.0');
    await requestUpgrade(home);
    await drainSeen(one);
    await one.exit(1);
    const by = Date.now() + 3000;
    while (timers.set.length < 2 && Date.now() < by) await tick();
    assert.strictEqual(timers.set.length, 2, 'the wait for the loop is bounded');
    assert.strictEqual(timers.set[1].ms, 15000 + 3000, 'a stop and the longest backoff');
    timers.set[1].fn();   // the bound passes, the loop still in its backoff
    const said = Date.now() + 3000;
    while (!/the supervisor has not taken that end/.test(io.err) && Date.now() < said) await tick();
    assert.match(io.err, /the runtime ended during the drain and the supervisor has not taken that end; going on without it/);
    await s.nth(1, 10000);
    await tick(500);
    assert.strictEqual(s.calls.length, 2, 'one runtime after the end, never two');
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('A13: a drain the runtime answers refused waits the bound, never cut short: how long its calls run is not known', async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    delete io.daemonDrainMs;
    const timers = heldTimers();
    io.daemonDrainTimers = timers;
    const s = scripted(home);
    s.drainReply = {ok: false, code: 'CONTROL_NO_ANSWER'};
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    set(runtimePkg, '8.1.0');
    await requestUpgrade(home);
    await drainSeen(one);
    await tick(300);
    assert.strictEqual(s.calls.length, 1, 'still waiting after the refusal');
    assert.deepStrictEqual(timers.set.map((x) => x.ms), [122000], 'the bound, and no other timer');
    timers.set[0].fn();   // the bound passes
    await s.nth(1);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('A13: a daemon stopped during a ch-local upgrade\'s drain stays stopped: nothing handed over', async() => {
  const {home, io, self, set} = setup();
  try {
    delete io.daemonDrainMs;
    io.daemonDrainTimers = heldTimers();
    let spawned = 0;
    io.spawnDaemon = () => { spawned++; return true; };
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    set(self, '1.1.0');
    await requestUpgrade(home);
    await drainSeen(one);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
    assert.strictEqual(spawned, 0, 'no new daemon');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('A13: a drain request never answered still ends at the bound', async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    io.daemonDrainMs = 300;
    const s = scripted(home);
    s.hangDrain = true;
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    set(runtimePkg, '8.1.0');
    await requestUpgrade(home);
    await drainSeen(one);
    await s.nth(1);
    assert.strictEqual(one.ended, true);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('A13: a drain holds no start.lock: the lock is taken for the stop and the restart after it', async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    io.daemonDrainMs = 600;
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    set(runtimePkg, '8.1.0');
    await requestUpgrade(home);
    await drainSeen(one);
    // (inside the drain's 600 ms, the runtime not having said drained)
    await tick(100);
    assert.strictEqual(fs.existsSync(path.join(runDirOf(home), 'start.lock')), false, 'no start.lock while it drains');
    assert.strictEqual(s.calls.length, 1, 'still draining');
    await s.nth(1);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// A6 (the final pass): the daemon's version is the code it runs, read once at
// its start, never the disk's later. An install that swaps app/ between the
// daemon's start and its adoption recorded the NEW version for OLD code, so
// it never handed over
test('A6: daemon.json names the version the daemon runs, not one installed after it started; it hands over on the next upgrade', async() => {
  const {home, io, self, set} = setup();
  try {
    const s = scripted(home);
    // (slow to listen: the install lands while it starts)
    s.delay = (n) => (n === 1 ? 400 : 0);
    let spawned = null;
    io.spawnDaemon = (args) => {
      spawned = args;
      setTimeout(() => fs.writeFileSync(daemonJson(home), JSON.stringify({pid: 999999, socket: 'x', runtimeVersion: 'y', daemonVersion: '2.0.0', started: 'z'}), {mode: 0o600}), 100);
      return true;
    };
    const done = daemon({home}, io, {run: s.run});
    await s.nth(0);
    set(self, '2.0.0');
    await adopted(home);
    assert.strictEqual(JSON.parse(fs.readFileSync(daemonJson(home), 'utf8')).daemonVersion, '1.0.0', 'the version it runs');
    await requestUpgrade(home);
    assert.strictEqual(await done, 0, io.err);
    assert.deepStrictEqual(spawned && spawned.slice(0, 1), ['daemon'], 'handed over to the new ch-local');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// A7 (the final pass): a daemon never rewrites another daemon's daemon.json
// -- a successor's, or a second one's -- whatever its own state
test('A7: a running daemon meeting another daemon\'s daemon.json never rewrites it, and says so once', async() => {
  const {home, io} = setup();
  try {
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    await s.nth(0);
    await adopted(home);
    const theirs = {pid: 999999, socket: 'x', runtimeVersion: 'y', daemonVersion: '9.9.9', started: 'z'};
    fs.writeFileSync(daemonJson(home), JSON.stringify(theirs), {mode: 0o600});
    // (a restart's writeVersion, from a daemon that is not stopping)
    await requestRestart(home);
    await s.nth(1);
    for (let i = 0; i < 100 && !/another daemon's now/.test(io.err); i++) await tick();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(daemonJson(home), 'utf8')), theirs, 'never rewritten');
    assert.strictEqual(io.err.split("daemon.json is another daemon's now: not rewritten; this daemon stops").length - 1, 1, 'said once');
    // (and it stops: it can no longer be found -- the medium, 2)
    assert.strictEqual(await done, 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(daemonJson(home), 'utf8')), theirs, 'and its own stop leaves the other\'s file');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// A5 (the final pass): `ch-local restart` makes the shared runtime take what
// is stored, its sessions resuming. Said only once seen: daemon.json's
// runtimeStarted changed AND its socket proving the secret
test('A5: ch-local restart restarts the shared runtime over its requests, and says so only once the new one answers', async() => {
  const {home, io} = setup();
  try {
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    const {fakeIo} = require('./fake-io');
    const {restart} = require('../lib/restart-command');
    const r = fakeIo({env: {COUNTINGHOUSE_HOME: home}});
    const code = restart({}, r);
    const two = await s.nth(1);
    assert.strictEqual(await code, 0, r.err);
    assert.match(r.out, /^the shared runtime restarted; its sessions are asked to resume$/m);
    assert.ok(one.requests.some((m) => m.type === 'drain'), 'drained first');
    assert.ok(two != null, 'a new runtime');
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('A5: ch-local restart with no shared runtime, or one that does not restart in time, says so and exits 1', async(t) => {
  const {fakeIo} = require('./fake-io');
  const {restart} = require('../lib/restart-command');
  const {home} = setup();
  try {
    const none = fakeIo({env: {COUNTINGHOUSE_HOME: home}});
    assert.strictEqual(await restart({}, none), 1);
    assert.match(none.out, /^no shared runtime runs here: restart your client, whose own runtime takes the change at its start$/m);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
  const w = setup();
  try {
    const s = scripted(w.home);
    const done = daemon({home: w.home}, w.io, {run: s.run});
    await s.nth(0);
    await adopted(w.home);
    // (a restart asked for that never happens: never said as one)
    t.mock.method(require('../lib/daemon-requests'), 'requestRestart', async(h, o) => { o.underLock(); return true; });
    const r = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: w.home}}), {restartWaitMs: 400});
    // (asked and written, not yet seen: said as standing, never "run it again" -- R1)
    assert.strictEqual(await restart({}, r), 0);
    assert.match(r.out, /^the restart is asked for and hasn't happened yet after 0\.4 s; it will once its calls finish$/m);
    assert.doesNotMatch(r.out + r.err, /again in a minute|go on as before/);
    assert.doesNotMatch(r.out, /restarted/);
    t.mock.restoreAll();
    w.io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(w.home, {recursive: true, force: true});
  }
});

test('A5: ch-local restart said only as seen: asked of an earlier ch-local\'s daemon; failed, stopped, still restarting and not-restarted each as such; a pid-only daemon asked; never restarted without the proving socket', async(t) => {
  const {fakeIo} = require('./fake-io');
  const {restart} = require('../lib/restart-command');
  const d = require('../lib/daemon');
  const rq = require('../lib/daemon-requests');
  const {home} = setup();
  try {
    const dir = runDirOf(home);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const file = path.join(dir, 'daemon.json');
    const plant = (extra = {}) => fs.writeFileSync(file, JSON.stringify({pid: process.pid, socket: path.join(dir, 'sessions.sock'), started: 's', runtimeStarted: 'r0', ...extra}), {mode: 0o600});
    const run = async(wait = 600) => { const r = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}}), {restartWaitMs: wait}); return {code: await restart({}, r), r}; };
    let serving = {serving: true, pid: process.pid, by: 'socket'};
    t.mock.method(d, 'daemonServing', async() => serving);
    let then = () => {};
    t.mock.method(rq, 'requestRestart', async(h, o) => { o.underLock(); then(); return true; });
    // (an earlier ch-local's daemon: no runtimeStarted -- asked, never "restarted")
    plant({runtimeStarted: undefined});
    let x = await run();
    assert.strictEqual(x.code, 0);
    assert.match(x.r.out, /the restart is asked for; whether the shared runtime has restarted can't be seen here/);
    assert.doesNotMatch(x.r.out, /restarted;/);
    // (a pid-only daemon, draining: asked too, and a restart seen with the proving socket)
    plant();
    serving = {serving: true, pid: process.pid, by: 'pid'};
    then = () => setTimeout(() => { plant({runtimeStarted: 'r1'}); serving = {serving: true, pid: process.pid, by: 'socket'}; }, 100);
    x = await run(3000);
    assert.strictEqual(x.code, 0, x.r.err);
    assert.match(x.r.out, /^the shared runtime restarted; its sessions are asked to resume$/m);
    // (a changed stamp without the proving socket is no restart)
    plant();
    serving = {serving: true, pid: process.pid, by: 'socket'};
    then = () => { plant({runtimeStarted: 'r2'}); serving = {serving: true, pid: process.pid, by: 'pid'}; };
    x = await run(500);
    assert.strictEqual(x.code, 0);
    assert.match(x.r.out, /the restart is asked for and hasn't happened yet after 0\.5 s/);
    assert.doesNotMatch(x.r.out, /restarted;/);
    // (still restarting at the bound: daemon.json names no socket -- never "as before")
    plant();
    serving = {serving: true, pid: process.pid, by: 'socket'};
    then = () => plant({socket: null});
    x = await run(500);
    assert.strictEqual(x.code, 1);
    assert.match(x.r.err, /is still restarting after 0\.5 s \(.*daemon\.json names no socket yet\); it serves again once its runtime listens$/m);
    assert.doesNotMatch(x.r.err, /`[^`]*status`/, 'status reads neither file: not named -- R2');
    // (failed: daemon.json gone, failed.json there -- exit 1, never "stopped")
    plant();
    then = () => { fs.rmSync(file); fs.writeFileSync(path.join(dir, 'failed.json'), JSON.stringify({v: 1, at: Date.now(), exit: 1, signal: null, reason: 'restarts-exhausted'}), {mode: 0o600}); };
    x = await run(500);
    assert.strictEqual(x.code, 1);
    assert.match(x.r.err, /could not start again \(it failed 5 times in 10 minutes\), so the sessions run their own runtimes for now; .*failed\.json records it$/m);
    // (a reason the daemon never writes: a fixed word, never printed -- N5)
    plant();
    then = () => { fs.rmSync(file); fs.writeFileSync(path.join(dir, 'failed.json'), JSON.stringify({v: 1, at: Date.now(), exit: 1, signal: null, reason: '\u001b[31mplanted'}), {mode: 0o600}); };
    x = await run(500);
    assert.match(x.r.err, /could not start again \(it failed\)/);
    assert.doesNotMatch(x.r.err, /planted/);
    fs.rmSync(path.join(dir, 'failed.json'));
    // (stopped: gone, no failed.json, no successor within the bound)
    plant();
    then = () => fs.rmSync(file);
    x = await run(500);
    assert.strictEqual(x.code, 0);
    assert.match(x.r.out, /the shared runtime stopped; waiting up to 45 s for its successor/);
    assert.match(x.r.out, /the shared runtime stopped and has not started again; the next session starts it, with what is stored/);
    // (an idle stop waits only a daemon's start for a successor, not the
    // whole bound -- N1; and a successor seen after "gone" is a restart -- L5)
    plant();
    then = () => { fs.rmSync(file); setTimeout(() => plant({runtimeStarted: 'r3'}), 150); };
    let t0 = Date.now();
    x = await (async() => { const r = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}}), {restartWaitMs: 5000, successorWaitMs: 1000}); return {code: await restart({}, r), r}; })();
    assert.strictEqual(x.code, 0, x.r.err);
    assert.match(x.r.out, /^the shared runtime restarted; its sessions are asked to resume$/m);
    plant();
    then = () => fs.rmSync(file);
    t0 = Date.now();
    x = await (async() => { const r = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}}), {restartWaitMs: 60000, successorWaitMs: 300}); return {code: await restart({}, r), r}; })();
    assert.match(x.r.out, /stopped and has not started again/);
    assert.ok(Date.now() - t0 < 30000, 'answered within the successor wait, not the bound');
    // (a daemon.json that can't be read just after the request: asked, and
    // said as what it is -- N2)
    plant();
    t.mock.method(d, 'readDaemonJson', () => null);
    then = () => {};
    x = await run();
    assert.strictEqual(x.code, 0);
    assert.match(x.r.out, /can't be seen here \(.*daemon\.json couldn't be read just now\)/);
    assert.doesNotMatch(x.r.out, /earlier ch-local/);
    d.readDaemonJson.mock.restore();
    // (a daemon.json that can't be read: nothing asked)
    serving = {serving: true, pid: null, by: 'unreadable'};
    let asked = 0;
    then = () => { asked += 1; };
    x = await run();
    assert.strictEqual(x.code, 1);
    assert.match(x.r.err, /whether the shared runtime runs can't be told .*; nothing changed/);
    assert.strictEqual(asked, 0);
    // (a settings file a start refuses: nothing asked -- M1)
    serving = {serving: true, pid: process.pid, by: 'socket'};
    plant();
    fs.writeFileSync(path.join(home, 'settings.json'), '{not json');
    x = await run();
    assert.strictEqual(x.code, 1);
    assert.match(x.r.err, /a restart would not start; fix it first/);
    assert.strictEqual(asked, 0);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// the reviewer's high on #147, R3: a restart asked during another's drain
// is served by the start that follows (it reads what is stored after the
// request), never repeated after "restarted" was said
test('A5: a restart asked during another restart\'s drain is served by that restart, never a second one', async() => {
  const {home, io} = setup();
  try {
    const s = scripted(home);
    let release = null;
    s.drainHold = new Promise((r) => { release = r; });
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    await requestRestart(home);
    const until = Date.now() + ADOPT_MS;
    while (!one.requests.some((m) => m.type === 'drain') && Date.now() < until) await tick();
    assert.ok(one.requests.some((m) => m.type === 'drain'), 'draining');
    await requestRestart(home);
    s.drainHold = null;
    release();
    await s.nth(1);
    // (a request after it, read once the second restart's has been handled)
    await requestUpgrade(home);
    const file = path.join(runDirOf(home), 'requests');
    const until2 = Date.now() + ADOPT_MS;
    while (fs.existsSync(file) && fs.statSync(file).size > 0 && Date.now() < until2) await tick();
    assert.strictEqual(fs.statSync(file).size, 0, 'every request read');
    await tick(300);
    assert.strictEqual(s.calls.length, 2, 'one restart, never a second');
    assert.strictEqual((io.err.match(/a restart was asked for/g) || []).length, 1);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// N4: a version that can't be read is never a change
test('A5: an upgrade request while the runtime\'s version can\'t be read restarts nothing', async() => {
  const {home, io, runtimePkg} = setup();
  try {
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    fs.writeFileSync(runtimePkg, '{half');
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

// L1 (L5's test): a restart op with ch-local changed hands over to the new
// one, never restarts the runtime under the old ch-local
test('A5: a restart request with ch-local changed hands over to the new ch-local', async() => {
  const {home, io, self, set} = setup();
  try {
    const s = scripted(home);
    let spawned = null;
    io.spawnDaemon = (args) => {
      spawned = args;
      setTimeout(() => fs.writeFileSync(daemonJson(home), JSON.stringify({pid: 999999, socket: 'x', runtimeVersion: 'y', daemonVersion: '2.0.0', started: 'z'}), {mode: 0o600}), 100);
      return true;
    };
    const done = daemon({home}, io, {run: s.run});
    await s.nth(0);
    await adopted(home);
    set(self, '2.0.0');
    await requestRestart(home);
    assert.strictEqual(await done, 0, io.err);
    assert.deepStrictEqual(spawned, ['daemon', '--home', home, '--handoff']);
    assert.strictEqual(s.calls.length, 1, 'no runtime restarted under the old ch-local');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// L5: the lock wait is bounded -- another start holding start.lock past the
// bound refuses, nothing written
test('A5: ch-local restart while another start holds start.lock past its bound: refused, nothing asked', async() => {
  const {fakeIo} = require('./fake-io');
  const {restart} = require('../lib/restart-command');
  const {withLockFile} = require('../lib/lock');
  const {home, io} = setup();
  try {
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    await s.nth(0);
    await adopted(home);
    const dir = runDirOf(home);
    let free = null;
    const held = new Promise((r) => { free = r; });
    let inside = false;
    const holding = withLockFile(path.join(dir, 'start.lock'), dir, io, async() => { inside = true; await held; });
    while (!inside) await tick();
    const r = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}}), {restartWaitMs: 500});
    assert.strictEqual(await restart({}, r), 1);
    assert.match(r.err, /the restart could not be asked for \(.*another start held it past 0\.5 s\); nothing changed/);
    free();
    await holding;
    assert.strictEqual(s.calls.length, 1);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// the medium on #147's last round, 4: a version unreadable at the daemon's
// start and readable now is a change, so an upgrade is taken up
test('A5: a runtime version unreadable at the daemon\'s start and readable at the upgrade restarts onto it', async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    fs.writeFileSync(runtimePkg, '{half');
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    await s.nth(0);
    await adopted(home);
    fs.writeFileSync(runtimePkg, JSON.stringify({name: 'countinghouse', version: '8.1.0'}));
    await requestUpgrade(home);
    await s.nth(1);
    assert.match(io.err, /countinghouse unknown -> 8\.1\.0/);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// the medium on #147's last round, 5 and 7: a daemon killed with its
// daemon.json left, and one gone before the request, are never a promise
test('A5: ch-local restart with the daemon gone at the bound, or before the request, promises nothing', async(t) => {
  const {fakeIo} = require('./fake-io');
  const {restart} = require('../lib/restart-command');
  const d = require('../lib/daemon');
  const rq = require('../lib/daemon-requests');
  const {home} = setup();
  try {
    const dir = runDirOf(home);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    const file = path.join(dir, 'daemon.json');
    fs.writeFileSync(file, JSON.stringify({pid: process.pid, socket: path.join(dir, 'sessions.sock'), started: 's', runtimeStarted: 'r0'}), {mode: 0o600});
    let serving = {serving: true, pid: process.pid, by: 'socket'};
    t.mock.method(d, 'daemonServing', async() => serving);
    let then = () => {};
    t.mock.method(rq, 'requestRestart', async(h, o) => { then(); o.underLock(); return true; });
    // (killed: daemon.json left, nothing serves at the bound. Set as the
    // request is written, never by a timer: on Windows each private read is
    // a synchronous PowerShell run, the bound can pass before the loop
    // first yields, and a timer would not have run by the last check)
    then = () => { serving = {serving: false, pid: null, by: 'pid'}; };
    let r = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}}), {restartWaitMs: 400});
    assert.strictEqual(await restart({}, r), 1, r.out + r.err);
    assert.match(r.err, /the shared runtime's daemon has gone without restarting it; the next session starts it/);
    assert.doesNotMatch(r.out, /it will once its calls finish/);
    // (gone between the check and the request)
    serving = {serving: true, pid: process.pid, by: 'socket'};
    then = () => fs.rmSync(file);
    r = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}}), {restartWaitMs: 400});
    assert.strictEqual(await restart({}, r), 0, r.out + r.err);
    assert.match(r.out, /^the shared runtime stopped before the restart was asked for; the next session starts it, with what is stored$/m);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// C-daemon-log: the daemon's own lines go to <run>/runtime.log as well as
// where they went; a hand-over's daemon and a later start append to the same
// file (rotation is by size only). On Windows the log alone gets a fake ACL:
// the daemon's home and run directories are judged by the real one
const logAcl = () => (process.platform === 'win32' ? {acl: {createPrivate: (f, d) => fs.writeFileSync(f, d), fileAcl: () => ({}), privateProblem: () => null}} : {});
test('C-daemon-log: the daemon\'s own lines land in runtime.log; a handed-over daemon and a later start go on in it', async() => {
  const {home, io} = setup();
  try {
    io.runtimeLog = true;
    io.runtimeLogOptions = logAcl();
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    await one.exit(1);   // a crash: the daemon says so
    await s.nth(1);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
    const file = path.join(runDirOf(home), 'runtime.log');
    const first = fs.readFileSync(file, 'utf8');
    assert.match(first, /^\d{4}-[^ ]+ ch-local daemon: the shared runtime ended \(exit 1\)/m, 'its own lines, stamped');
    assert.ok(io.err.includes('ch-local daemon: '), 'and still where they went');
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    // a hand-over's daemon: the same file
    const s2 = scripted(home);
    const two = daemon({home, handoff: encodeHandoff([])}, io, {run: s2.run});
    await s2.nth(0);
    io.signal('SIGTERM');
    assert.strictEqual(await two, 0);
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(first), 'appended to, not started anew');
    assert.strictEqual(fs.existsSync(`${file}.1`), false);
    // a later start: the same file still (by size only)
    const s3 = scripted(home);
    const three = daemon({home}, io, {run: s3.run});
    await s3.nth(0);
    io.signal('SIGTERM');
    assert.strictEqual(await three, 0);
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(first), 'appended to');
    assert.strictEqual(fs.existsSync(`${file}.1`), false, 'nothing rotated at a start');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('C-daemon-log: a second daemon that finds one serving leaves its log as it is; the daemon\'s run is handed the log', async() => {
  const {home, io} = setup();
  try {
    io.runtimeLog = true;
    io.runtimeLogOptions = logAcl();
    const s = scripted(home);
    let handed = null;
    const done = daemon({home}, io, {run: (opts, runIo) => { handed = runIo.runtimeOutput; return s.run(opts, runIo); }});
    const one = await s.nth(0);
    await adopted(home);
    assert.ok(handed != null && typeof handed.forward === 'function' && handed.file === path.join(runDirOf(home), 'runtime.log'), 'the run gets the log');
    await one.exit(1);   // a line in the serving daemon's log
    await s.nth(1);
    const file = path.join(runDirOf(home), 'runtime.log');
    const before = fs.readFileSync(file, 'utf8');
    // a second daemon on the same home: another one serves, it goes
    const io2 = daemonIo(home);
    io2.runtimeLog = true;
    io2.runtimeLogOptions = logAcl();
    assert.strictEqual(await daemon({home}, io2, {run: scripted(home).run}), 0);
    assert.match(io2.err, /another daemon \(pid \d+\) is running/);
    assert.strictEqual(fs.existsSync(`${file}.1`), false, 'not rotated by the second daemon');
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(before), 'the serving daemon\'s log as it was');
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('C-daemon-log: an error that ends the daemon reaches its log before it goes', async() => {
  const {home, io} = setup();
  try {
    io.runtimeLog = true;
    io.runtimeLogOptions = logAcl();
    const boom = Object.assign(new Error('a failure no one said'), {code: 'EBOOM'});
    // (a read the daemon makes once its log is open throws)
    Object.defineProperty(io, 'daemonPollMs', {get() { throw boom; }, configurable: true});
    await assert.rejects(daemon({home}, io, {run: scripted(home).run}), /a failure no one said/);
    assert.match(fs.readFileSync(path.join(runDirOf(home), 'runtime.log'), 'utf8'), /ch-local daemon: ended by an error: Error: a failure no one said/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});
