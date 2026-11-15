'use strict';
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
const {requestUpgrade} = require('../lib/daemon-requests');
const {fakeRuntime, daemonIo, tmpHome, runDirOf} = require('./daemon-fakes');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ID = (n) => n.toString(16).padStart(32, '0');
const HASH = 'f'.repeat(64);

function scripted(home) {
  const r = {calls: []};
  r.run = async(opts) => {
    fs.rmSync(opts.socket, {force: true});
    const rt = await fakeRuntime(runDirOf(home), opts.socket);
    let end = null;
    const exited = new Promise((res) => { end = res; });
    const call = {opts, restore: opts.restore(), requests: [], ended: false};
    call.exit = async(code) => { if (call.ended) return; call.ended = true; await rt.close(); end(code); };
    call.tell = (m) => opts.onTold(m);
    opts.onControl((msg) => { call.requests.push(msg); return Promise.resolve({ok: true}); });
    opts.signal.addEventListener('abort', () => { call.exit(143); });
    r.calls.push(call);
    opts.onListening({type: 'listening', socket: opts.socket});
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

test('the runtime changed: drained, stopped, and the new one started with the table; daemon.json names its version', {skip: process.platform === 'win32'}, async() => {
  const {home, io, runtimePkg, set} = setup();
  try {
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    one.tell({type: 'session-resume', session: ID(1), hash: HASH});
    set(runtimePkg, '8.1.0');
    requestUpgrade(home);
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

test('an upgrade request with nothing changed does nothing', {skip: process.platform === 'win32'}, async() => {
  const {home, io} = setup();
  try {
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    requestUpgrade(home);
    await tick(300);
    assert.strictEqual(s.calls.length, 1);
    assert.deepStrictEqual(one.requests.filter((m) => m.type === 'drain'), []);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('ch-local changed: a new daemon is started with the table on its handoff pipe, never in argv or env; this one exits once it runs', {skip: process.platform === 'win32'}, async() => {
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
    requestUpgrade(home);
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

test('a daemon started with a handoff seeds its table from it; a bad handoff starts empty, saying so', {skip: process.platform === 'win32'}, async() => {
  const {home, io} = setup();
  try {
    const s = scripted(home);
    const handoff = encodeHandoff({type: 'restore', sessions: [{session: ID(3), resume: HASH, state: {overrides: [], locks: ['pack'], formsLeft: 1}}], declines: [{kind: 'pack', at: Date.now()}]});
    const done = daemon({home, handoff}, io, {run: s.run});
    const one = await s.nth(0);
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
  io.platform = 'win32';   // the daemon returns at once (C4c): only the CLI's reading is under test
  io.readHandoff = async() => { seen.push('read'); return Buffer.alloc(0); };
  assert.strictEqual(await main(['daemon', '--home', io.cwd, '--handoff'], io), 2);
  assert.deepStrictEqual(seen, ['read']);
  assert.strictEqual(await main(['daemon', '--home', io.cwd], io), 2);
  assert.deepStrictEqual(seen, ['read'], 'no --handoff: fd 3 is not read');
  fs.rmSync(io.cwd, {recursive: true, force: true});
});
