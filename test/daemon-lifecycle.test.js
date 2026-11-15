'use strict';
// C3a: ch-local daemon's lifecycle (countinghouse's shared-runtime design,
// #236, section 6): the session table handed to each runtime it starts; a
// crashed runtime restarted at once, then after 1, 5 and 30 s, and after 5
// failures in 10 minutes, failed.json (#257) and an exit; a first runtime
// that never listens is failed.json too; the idle stop.
// The runtime is scripted: a fake that proves its secret, tells what the test
// says, answers control requests as the test says, and ends when told.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {daemon} = require('../lib/daemon');
const {fakeRuntime, daemonIo, tmpHome, runDirOf} = require('./daemon-fakes');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ID = (n) => n.toString(16).padStart(32, '0');
const HASH = 'f'.repeat(64);

// the runtimes a daemon starts, in order
function scripted(home) {
  const r = {calls: []};
  r.run = async(opts) => {
    // a stale socket file (POSIX); a pipe leaves none
    if (!require('../lib/session-socket').isPipeName(opts.socket)) fs.rmSync(opts.socket, {force: true});
    const rt = await fakeRuntime(runDirOf(home), opts.socket);
    let end = null;
    const exited = new Promise((res) => { end = res; });
    const call = {opts, restore: opts.restore(), requests: [], answers: {}, ended: false};
    call.exit = async(code) => { if (call.ended) return; call.ended = true; await rt.close(); end(code); };
    call.tell = (m) => opts.onTold(m);
    opts.onControl((msg) => {
      call.requests.push(msg);
      const a = call.answers[msg.type];
      return Promise.resolve(a != null ? a(msg) : {ok: true});
    });
    opts.signal.addEventListener('abort', () => { call.exit(143); });
    r.calls.push(call);
    if (r.listens !== false) opts.onListening({type: 'listening', socket: opts.socket});
    return exited;
  };
  r.nth = async(n, ms = 5000) => {
    const until = Date.now() + ms;
    while (r.calls.length <= n && Date.now() < until) await tick();
    assert.ok(r.calls.length > n, `runtime ${n + 1} never started: ${r.io != null ? r.io.err : ''}`);
    return r.calls[n];
  };
  return r;
}
const fast = (home) => {
  const io = daemonIo(home);
  io.daemonBackoffMs = [0, 20, 40, 60];
  io.daemonIdleMs = 100;
  io.daemonStopMs = 2000;
  return io;
};
// the daemon has adopted its first runtime (daemon.json written)
const adopted = async(home) => {
  const until = Date.now() + 5000;
  while (!fs.existsSync(path.join(runDirOf(home), 'daemon.json')) && Date.now() < until) await tick();
  assert.ok(fs.existsSync(path.join(runDirOf(home), 'daemon.json')), 'adopted');
};
const failedJson = (home) => path.join(runDirOf(home), 'failed.json');
const daemonJson = (home) => path.join(runDirOf(home), 'daemon.json');

test('each runtime is handed the table: empty first, then what the crashed one told', async() => {
  const home = tmpHome();
  try {
    const io = fast(home);
    const s = scripted(home);
    s.io = io;
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    assert.deepStrictEqual(one.restore, {type: 'restore', sessions: [], declines: [], reset: []});
    one.tell({type: 'session-resume', session: ID(1), hash: HASH});
    one.tell({type: 'decline', kind: 'pack', at: Date.now()});
    await one.exit(1);   // a crash
    const two = await s.nth(1);
    assert.deepStrictEqual(two.restore.sessions, [{session: ID(1), resume: HASH, state: {overrides: [], locks: [], formsLeft: 3}}]);
    assert.strictEqual(two.restore.declines.length, 1);
    assert.ok(fs.existsSync(daemonJson(home)), 'daemon.json kept across the restart');
    two.tell({type: 'idle'});
    assert.strictEqual(await done, 0, io.err);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('5 failures in 10 minutes: failed.json (its exact form, 0600), daemon.json removed, exit 1; restarts were backed off', async() => {
  const home = tmpHome();
  try {
    const io = fast(home);
    const s = scripted(home);
    s.io = io;
    const done = daemon({home}, io, {run: s.run});
    const at = [];
    for (let i = 0; i < 5; i++) {
      const c = await s.nth(i);
      if (i === 0) await adopted(home);
      at.push(Date.now());
      await c.exit(i === 4 ? 7 : 1);
    }
    assert.strictEqual(await done, 1);
    assert.strictEqual(s.calls.length, 5, 'no sixth runtime');
    assert.ok(at[2] - at[1] >= 15 && at[3] - at[2] >= 35, `backed off: ${at.map((t) => t - at[0])}`);
    const f = JSON.parse(fs.readFileSync(failedJson(home), 'utf8'));
    assert.deepStrictEqual(Object.keys(f).sort(), ['at', 'exit', 'reason', 'signal', 'v']);
    assert.deepStrictEqual([f.v, f.exit, f.signal, f.reason], [1, 7, null, 'restarts-exhausted']);
    assert.ok(Number.isSafeInteger(f.at) && Math.abs(Date.now() - f.at) < 60000);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(failedJson(home)).mode & 0o777, 0o600);
    else { const w = require('../lib/win-acl'); assert.strictEqual(w.privateProblem('failed.json', w.fileAcl(failedJson(home))), null); }
    assert.ok(!fs.existsSync(daemonJson(home)), 'daemon.json removed');
    assert.match(io.err, /5 times in 10 minutes/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a first runtime that never listens: failed.json, reason never-listened; a later success removes it', async() => {
  const home = tmpHome();
  try {
    const io = fast(home);
    io.daemonReadyMs = 300;
    const s = scripted(home);
    s.listens = false;
    assert.strictEqual(await daemon({home}, io, {run: s.run}), 1);
    const f = JSON.parse(fs.readFileSync(failedJson(home), 'utf8'));
    assert.strictEqual(f.reason, 'never-listened');
    assert.strictEqual(f.exit, 143, 'the stopped runtime\'s exit');
    // the next daemon's runtime listens: failed.json goes once daemon.json is written
    const t = scripted(home);
    const done = daemon({home}, fast(home), {run: t.run});
    const one = await t.nth(0);
    const until = Date.now() + 3000;
    while (!fs.existsSync(daemonJson(home)) && Date.now() < until) await tick();
    assert.ok(!fs.existsSync(failedJson(home)), 'failed.json cleared');
    one.tell({type: 'idle'});
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('the idle stop: not while busy; idle for the bound, then idle-stop, daemon.json removed, the runtime stopped, exit 0', async() => {
  const home = tmpHome();
  try {
    const io = fast(home);
    const s = scripted(home);
    s.io = io;
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    one.tell({type: 'busy'});
    await tick(250);
    assert.deepStrictEqual(one.requests.filter((m) => m.type === 'idle-stop'), [], 'never while busy');
    one.tell({type: 'idle'});
    await tick(40);
    one.tell({type: 'busy'});   // a session came back within the bound
    await tick(250);
    assert.deepStrictEqual(one.requests.filter((m) => m.type === 'idle-stop'), [], 'the bound restarts');
    one.tell({type: 'idle'});
    assert.strictEqual(await done, 0, io.err);
    assert.strictEqual(one.requests.filter((m) => m.type === 'idle-stop').length, 1);
    assert.strictEqual(one.ended, true, 'the runtime stopped');
    assert.ok(!fs.existsSync(daemonJson(home)));
    assert.ok(!fs.existsSync(path.join(runDirOf(home), 'start.lock')), 'the lock released');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('an idle-stop the runtime refuses (a session or a handshake arrived) keeps the daemon, until the next idle', async() => {
  const home = tmpHome();
  try {
    const io = fast(home);
    const s = scripted(home);
    s.io = io;
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    let refuse = true;
    one.answers['idle-stop'] = () => (refuse ? {ok: false, code: 'CONTROL_BUSY'} : {ok: true});
    one.tell({type: 'idle'});
    const until = Date.now() + 3000;
    while (one.requests.length === 0 && Date.now() < until) await tick();
    await tick(100);
    assert.ok(fs.existsSync(daemonJson(home)), 'still running');
    assert.strictEqual(one.ended, false);
    refuse = false;
    one.tell({type: 'busy'});
    one.tell({type: 'idle'});
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('the failed.json the daemon writes has exactly the vectors\' form, and is fresh by their rule (#257)', async() => {
  const V = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'shim', 'tests', 'vectors', 'contract-2.json'), 'utf8')).failedJson;
  const home = tmpHome();
  try {
    const io = fast(home);
    io.daemonReadyMs = 200;
    const s = scripted(home);
    s.listens = false;
    assert.strictEqual(await daemon({home}, io, {run: s.run}), 1);
    const f = JSON.parse(fs.readFileSync(failedJson(home), 'utf8'));
    assert.deepStrictEqual(Object.keys(f).sort(), Object.keys(V.accepted[0].value).concat('at').sort());
    assert.strictEqual(f.v, 1);
    assert.ok(Number.isSafeInteger(f.at) && f.at > 0);
    assert.ok(Date.now() - V.freshPastMs <= f.at && f.at <= Date.now() + V.freshFutureMs, 'fresh');
    assert.ok(f.signal === null || /^SIG[A-Z0-9]+$/.test(f.signal));
    assert.ok(['restarts-exhausted', 'never-listened'].includes(f.reason));
    assert.ok(fs.statSync(failedJson(home)).size <= 512);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// the review of #34 ------------------------------------------------------------

test('(1) start.lock is held from a crash until the restarted runtime is ready: a second daemon meanwhile waits, then finds this one and starts nothing', async() => {
  const home = tmpHome();
  try {
    const io = fast(home);
    io.daemonBackoffMs = [400];
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    await one.exit(1);   // a crash: the restart waits 400 ms
    await tick(100);
    assert.ok(fs.existsSync(path.join(runDirOf(home), 'start.lock')), 'held through the backoff');
    // a shim's daemon arrives in the gap
    const other = scripted(home);
    const second = daemon({home}, fast(home), {run: other.run});
    const two = await s.nth(1);
    assert.strictEqual(await second, 0, 'it found the live daemon once the lock was free');
    assert.strictEqual(other.calls.length, 0, 'and started no runtime');
    assert.ok(fs.existsSync(daemonJson(home)), 'this daemon\'s daemon.json kept');
    assert.ok(!fs.existsSync(path.join(runDirOf(home), 'start.lock')), 'released once ready');
    two.tell({type: 'idle'});
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('(2) an idle-stop answered anything but CONTROL_BUSY (no answer, a failure) stops the runtime anyway', async() => {
  const home = tmpHome();
  try {
    const io = fast(home);
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    one.answers['idle-stop'] = () => ({ok: false, code: 'CONTROL_NO_ANSWER'});
    one.tell({type: 'idle'});
    assert.strictEqual(await done, 0, io.err);
    assert.strictEqual(one.ended, true);
    assert.ok(!fs.existsSync(daemonJson(home)));
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('(4) a CONTROL_BUSY with no busy told after it (a handshake in pre-auth) re-arms the idle timer', async() => {
  const home = tmpHome();
  try {
    const io = fast(home);
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    let n = 0;
    one.answers['idle-stop'] = () => ((n += 1) === 1 ? {ok: false, code: 'CONTROL_BUSY'} : {ok: true});
    one.tell({type: 'idle'});
    assert.strictEqual(await done, 0);
    assert.strictEqual(one.requests.filter((m) => m.type === 'idle-stop').length, 2, 'asked again, with no new idle');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('(5) a SIGTERM during the first start, or during a backoff, is a stop: no failed.json, no restart', async() => {
  const home = tmpHome();
  try {
    const io = fast(home);
    io.daemonReadyMs = 2000;
    const s = scripted(home);
    s.listens = false;
    const done = daemon({home}, io, {run: s.run});
    await s.nth(0);
    io.signal('SIGTERM');
    assert.strictEqual(await done, 0);
    assert.ok(!fs.existsSync(failedJson(home)), 'no failed.json for a stop');
    const io2 = fast(home);
    io2.daemonBackoffMs = [5000];
    const t = scripted(home);
    const done2 = daemon({home}, io2, {run: t.run});
    const one = await t.nth(0);
    await adopted(home);
    await one.exit(1);
    await tick(100);
    const t0 = Date.now();
    io2.signal('SIGTERM');
    assert.strictEqual(await done2, 0);
    assert.ok(Date.now() - t0 < 2000, 'the backoff sleep was interrupted');
    assert.strictEqual(t.calls.length, 1, 'no restart');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('(6) a refusal reported for a runtime that is no longer current never clears the table', async() => {
  const home = tmpHome();
  try {
    const io = fast(home);
    const s = scripted(home);
    const done = daemon({home}, io, {run: s.run});
    const one = await s.nth(0);
    await adopted(home);
    one.tell({type: 'session-resume', session: ID(1), hash: HASH});
    await one.exit(1);
    const two = await s.nth(1);
    one.opts.onRestoreRefused();   // late, from the crashed one
    await two.exit(1);
    const three = await s.nth(2);
    assert.deepStrictEqual(three.restore.sessions.map((r) => r.session), [ID(1)], 'the table kept');
    two.opts.onRestoreRefused();   // and the current one's own refusal still clears it... once it is current
    three.opts.onRestoreRefused();
    await three.exit(1);
    const four = await s.nth(3);
    assert.deepStrictEqual(four.restore.sessions, [], 'cleared by the current runtime\'s refusal');
    four.tell({type: 'idle'});
    assert.strictEqual(await done, 0);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});
