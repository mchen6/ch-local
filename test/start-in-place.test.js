'use strict';
// Packs in place (part 2, plan Task B3): a running start watches the home and
// applies each pack change to its runtime over the control channel: load,
// unload, reload, one at a time, each with its notice; every change in
// <home>/history.jsonl; run.json kept to what is loaded.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {addPack, removePack} = require('../lib/packs-command');
const {start} = require('../lib/start');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm} = require('./install-helpers');

const until = async (cond, ms = 10000) => {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 20))) if (cond()) return;
  throw new Error('timed out waiting');
};

// A running start over an installed home, with a runtime that answers each
// control request with `answer(msg)` (default ok) and runs until end().
async function running({answer = () => ({ok: true}), timeoutMs, passThrough = [], duringSpawn = null, beforeStart = null} = {}) {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  if (beforeStart != null) beforeStart(home);
  const f = fakeIo({env: {COUNTINGHOUSE_HOME: home, GITHUB_TOKEN: 'secret', OTHER_TOKEN: 'other-secret'}, homedir: '/nowhere'});
  Object.assign(f, {pid: 4242, hostname: 'box-1', cwd: home, alive: () => true, trapSignals: () => () => {}, exit: () => {}, controlTimeoutMs: timeoutMs});
  const requests = [];
  let end = null;
  let listener = null;
  let spawnedArgs = null;
  f.spawn = (c, args) => {
    spawnedArgs = args;
    if (duringSpawn != null) duringSpawn(home);
    return {
      kill: () => {},
      exited: new Promise((resolve) => { end = resolve; }),
      send: (msg) => {
        requests.push(msg);
        const reply = answer(msg);
        if (reply != null) setImmediate(() => listener({id: msg.id, ...reply}));
      },
      // as the runtime does once it listens (countinghouse #210)
      onMessage: (fn) => { listener = fn; setImmediate(() => fn({type: 'ready'})); }
    };
  };
  const done = start({passThrough}, f);
  await until(() => end != null);
  const runDir = () => path.join(home, 'run', fs.readdirSync(path.join(home, 'run'))[0]);
  return {home, r, f, requests, cmd, done, args: () => spawnedArgs, end: () => end(0), runDir, ask: (m) => listener(m),
    history: () => (fs.existsSync(path.join(home, 'history.jsonl')) ? fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])};
}

test('start spawns its runtime with the control channel', async () => {
  const s = await running();
  assert.deepStrictEqual(s.args().slice(s.args().indexOf('--controlChannel'), s.args().indexOf('--controlChannel') + 2), ['--controlChannel', 'ipc']);
  // where a pack loaded in place may be (countinghouse #205): the pack trees
  // only, never the app, which holds the runtime and its dependencies
  const roots = s.args().flatMap((a, i) => (s.args()[i - 1] === '--packsRoot' ? [a] : []));
  assert.deepStrictEqual(roots, [path.join(s.home, 'packs')]);
  s.end();
  assert.strictEqual(await s.done, 0);
});

test('add-pack while running: one load request with the pack\'s own tree, credentials file and notice; history and run.json follow', async () => {
  const s = await running();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.requests.length === 1);
  const [load] = s.requests;
  assert.strictEqual(load.type, 'load');
  // the runtime knows a pack by its scenario's package name (countinghouse #205)
  assert.strictEqual(load.name, '@countinghouse/ch-pack-other');
  assert.strictEqual(load.notice, 'other added 0.3.0');
  assert.ok(load.scenario.startsWith(path.join(s.home, 'packs', 'other')), load.scenario);
  assert.ok(fs.existsSync(load.remoteCredentials));
  assert.ok(!('deviceConfigDir' in load), 'the runtime uses its own --deviceConfigPath');
  await until(() => s.history().length === 1);
  assert.deepStrictEqual((({pack, change, notice, by}) => ({pack, change, notice, by}))(s.history()[0]), {pack: 'other', change: 'added', notice: 'other added 0.3.0', by: 'start'});
  assert.ok(!JSON.stringify(s.history()).includes('secret'), 'never a value');
  const run = JSON.parse(fs.readFileSync(path.join(s.runDir(), 'run.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(run.loaded).sort(), ['ci-failure-triage', 'other']);
  assert.match(s.f.err, /other added 0\.3\.0/);
  s.end();
  await s.done;
});

test('remove-pack while running: one unload request; reinstalling a changed release reloads', async () => {
  const s = await running();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.requests.length === 1);
  assert.strictEqual(await removePack({pack: 'other'}, s.cmd()), 0);
  await until(() => s.requests.length === 2);
  assert.deepStrictEqual([s.requests[1].type, s.requests[1].name, s.requests[1].notice], ['unload', '@countinghouse/ch-pack-other', 'other removed']);
  const r2 = release({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
  await until(() => s.requests.length === 3);
  assert.deepStrictEqual([s.requests[2].type, s.requests[2].name, s.requests[2].notice], ['reload', '@countinghouse/ch-pack-ci-failure-triage', 'ci-failure-triage updated 0.1.0 → 0.1.0']);
  s.end();
  await s.done;
});

test('a refused request is recorded and said, and nothing is marked loaded; a runtime that never answers is a restart', async () => {
  const s = await running({answer: (m) => (m.name === '@countinghouse/ch-pack-other' ? {ok: false, code: 'PART_VERSION_CONFLICT', message: 'two versions'} : {ok: true})});
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.history().length === 1);
  assert.match(s.history()[0].problem, /^PART_VERSION_CONFLICT/);
  assert.match(s.f.err, /other added 0\.3\.0: not applied in place \(PART_VERSION_CONFLICT\); restart your client/);
  const run = JSON.parse(fs.readFileSync(path.join(s.runDir(), 'run.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(run.loaded), ['ci-failure-triage']);
  s.end();
  await s.done;

  const silent = await running({answer: () => null, timeoutMs: 200});
  assert.strictEqual(await addPack({pack: 'other', from: silent.r.from}, silent.cmd(), silent.r.allow), 0);
  await until(() => silent.history().length === 1);
  assert.match(silent.f.err, /not applied in place \(CONTROL_NO_ANSWER\); restart your client/);
  silent.end();
  await silent.done;
});

test('two changes in quick succession are applied one at a time, in order; the last state is what is loaded', async () => {
  const s = await running();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  assert.strictEqual(await removePack({pack: 'other'}, s.cmd()), 0);
  await new Promise((r) => setTimeout(r, 2500));   // past the poll, whatever the watch saw
  const kinds = s.requests.map((m) => `${m.type} ${m.name}`);
  // either both seen (load then unload) or only the final state (nothing to do)
  assert.ok(JSON.stringify(kinds) === JSON.stringify(['load @countinghouse/ch-pack-other', 'unload @countinghouse/ch-pack-other']) || kinds.length === 0, JSON.stringify(kinds));
  const run = JSON.parse(fs.readFileSync(path.join(s.runDir(), 'run.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(run.loaded), ['ci-failure-triage']);
  s.end();
  await s.done;
});

// countinghouse #205: the runtime keys the packs it holds by their scenario's
// package name, those given at start (--loadModule) and those loaded in place
// alike, and refuses a name it does not hold. A stub runtime that does the
// same: every change is applied, and a removed pack (gone from packs.json)
// is still unloaded by its scenario's name.
test('the runtime is sent each pack\'s scenario package name: loaded at start, added, removed, reloaded', async () => {
  const held = new Set();
  let refusals = 0;
  const s = await running({answer: (m) => {
    if (!['load', 'unload', 'reload'].includes(m.type)) return {ok: true};
    if (m.type === 'load') { if (held.has(m.name)) { refusals++; return {ok: false, code: 'CONTROL_FAILED'}; } held.add(m.name); return {ok: true}; }
    if (!held.has(m.name)) { refusals++; return {ok: false, code: 'CONTROL_FAILED', message: `${m.name} is not loaded`}; }
    if (m.type === 'unload') held.delete(m.name);
    return {ok: true};
  }});
  // what start loaded, as the runtime names it: each --loadModule's package name
  const args = s.args();
  args.forEach((a, i) => { if (args[i - 1] === '--loadModule') held.add(JSON.parse(fs.readFileSync(path.join(a, 'package.json'), 'utf8')).name); });
  assert.ok(held.has('@countinghouse/ch-pack-ci-failure-triage'), JSON.stringify([...held]));
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.requests.filter((m) => m.type !== 'set').length === 1);
  assert.strictEqual(await removePack({pack: 'other'}, s.cmd()), 0);
  await until(() => s.requests.filter((m) => m.type !== 'set').length === 2);
  const r2 = release({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
  await until(() => s.requests.filter((m) => m.type !== 'set').length === 3);
  assert.deepStrictEqual(s.requests.filter((m) => m.type !== 'set').map((m) => `${m.type} ${m.name}`),
    ['load @countinghouse/ch-pack-other', 'unload @countinghouse/ch-pack-other', 'reload @countinghouse/ch-pack-ci-failure-triage']);
  assert.strictEqual(refusals, 0);
  await until(() => s.history().length === 3);
  assert.deepStrictEqual(s.history().map((h) => [h.pack, h.problem]), [['other', undefined], ['other', undefined], ['ci-failure-triage', undefined]],
    'the history and notices still name the pack');
  s.end();
  await s.done;
});

// A pack found only in the flat layout an earlier ch-local made (its tree
// gone) is outside --packsRoot: it is not loaded in place, and the user is
// told to run ch-local install, which places its tree.
test('a pack only in the flat layout is not loaded in place: said and recorded, "run ch-local install"', async () => {
  const s = await running();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.requests.filter((m) => m.type !== 'set').length === 1);
  fs.rmSync(path.join(s.home, 'packs', 'other'), {recursive: true, force: true});
  const record = path.join(s.home, 'packs.json');
  fs.writeFileSync(record, fs.readFileSync(record));   // the same record, written again: start looks
  await until(() => s.history().some((h) => h.pack === 'other' && h.problem != null));
  assert.deepStrictEqual(s.requests.filter((m) => m.type !== 'set').map((m) => m.type), ['load'], 'nothing sent for the flat one');
  assert.match(s.history().find((h) => h.problem != null).problem, /ch-local install/);
  assert.match(s.f.err, /other not loaded in place: .*run `ch-local install`/);
  s.end();
  await s.done;
});

test('a change that cannot be applied in place is said, never fatal: start runs on', async () => {
  const s = await running();
  // its run directory replaced by a file: nothing can be written in it now
  const dir = s.runDir();
  fs.rmSync(dir, {recursive: true, force: true});
  fs.writeFileSync(dir, 'not a directory');
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => /could not be applied in place|not applied in place/.test(s.f.err));
  s.end();
  assert.strictEqual(await s.done, 0);
});

test('a setting changed between start reading the home and watching it is still applied; one the client passes itself stands', async () => {
  const {setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = await running({passThrough: ['--locale', 'en'],
    duringSpawn: (home) => setSetting(layout({COUNTINGHOUSE_HOME: home}), 'maxOutputBytes', '4MiB', {by: 'cli'})});
  await until(() => s.requests.some((m) => m.type === 'set'));
  assert.deepStrictEqual(s.requests.filter((m) => m.type === 'set').map((m) => [m.name, m.value]), [['maxOutputBytes', 4 * 1024 * 1024]]);
  setSetting(layout({COUNTINGHOUSE_HOME: s.home}), 'locale', 'zh', {by: 'cli'});
  await until(() => /locale set to zh: your client passes --locale itself/.test(s.f.err));
  assert.ok(!s.requests.some((m) => m.type === 'set' && m.name === 'locale'), 'never sent');
  s.end();
  await s.done;
});

test('after a runtime update, packs are not loaded or reloaded into the old runtime: said once, and recorded', async () => {
  const s = await running();
  const r2 = release({versions: {'@countinghouse/ch-step-redact': '0.2.0', countinghouse: '8.0.1'}});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
  await until(() => /a runtime update applies at the next start/.test(s.f.err));
  await new Promise((r) => setTimeout(r, 2500));
  assert.deepStrictEqual(s.requests.filter((m) => m.type === 'reload' || m.type === 'load'), []);
  assert.strictEqual(s.history().filter((e) => e.change === 'runtime update').length, 1);
  s.end();
  await s.done;
});

test('a live requestTimeout change is sent in the runtime\'s unit, seconds', async () => {
  const {setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = await running();
  setSetting(layout({COUNTINGHOUSE_HOME: s.home}), 'requestTimeout', '20s', {by: 'cli'});
  await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'requestTimeout'));
  assert.deepStrictEqual(s.requests.filter((m) => m.type === 'set').map((m) => [m.name, m.value]), [['requestTimeout', 20]]);
  s.end();
  await s.done;
});

test('a live locale change is sent as the runtime\'s locale', async () => {
  const {setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = await running();
  setSetting(layout({COUNTINGHOUSE_HOME: s.home}), 'locale', 'zh', {by: 'cli'});
  await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
  assert.deepStrictEqual(s.requests.filter((m) => m.type === 'set').map((m) => [m.name, m.value]), [['locale', 'zh-CN']]);
  s.end();
  await s.done;
});

// countinghouse part 3 while start runs (P4)
const ceilingReader = (home, ceiling) => {
  const dir = path.join(home, 'app', 'node_modules', 'countinghouse', 'lib');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'settings-ceiling.js'), `module.exports = {readCeiling: () => (${JSON.stringify(ceiling)})};\n`);
};

test('while running: an outside edit is said and recorded once; a raise is sent clamped to the ceiling; a pack it forbids is not turned on', async () => {
  const {layout} = require('../lib/home');
  const s = await running();
  try {
  const where = layout({COUNTINGHOUSE_HOME: s.home});
  assert.strictEqual(where.app, path.join(s.home, 'app'), 'the reader where the runtime is installed');
  ceilingReader(s.home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 6 * 1024 * 1024, forbid: [], packs: [], conversation: true}});
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 16 * 1024 * 1024, 'pack.ci-failure-triage': false}}));
  await until(() => s.requests.some((m) => m.type === 'unload'));
  await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'maxOutputBytes'));
  assert.deepStrictEqual(s.requests.filter((m) => m.type === 'set').map((m) => [m.name, m.value]), [['maxOutputBytes', 6 * 1024 * 1024]]);
  assert.match(s.f.err, /maxOutputBytes was changed outside ch-local: 8MiB -> 16MiB \(this loosens a guarding setting\)/);
  assert.match(s.f.err, /maxOutputBytes 16MiB is above the operator's ceiling: the runtime gets 6MiB/);
  const outside = s.history().filter((h) => h.change === 'changed outside ch-local').map((h) => h.setting).sort();
  assert.deepStrictEqual(outside, ['maxOutputBytes', 'pack.ci-failure-triage']);
  // turned back on by hand: the ceiling forbids turning a pack on, so it stays off
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 16 * 1024 * 1024, 'pack.ci-failure-triage': true}}));
  await until(() => /pack\.ci-failure-triage was changed outside ch-local: off -> on \(this loosens a guarding setting\); not applied: pack\.ci-failure-triage cannot be changed to on on this machine: its operator's ceiling forbids it/.test(s.f.err));
  assert.ok(!s.requests.some((m) => m.type === 'load'), 'not loaded');
  } finally {
    s.end();
    await s.done;
  }
});

test('while running, under a ceiling that cannot be trusted: a change that loosens keeps the settings in effect, and says so', async () => {
  const {layout} = require('../lib/home');
  const s = await running();
  const where = layout({COUNTINGHOUSE_HOME: s.home});
  try {
    ceilingReader(s.home, {state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'it is a symbolic link'});
    // a raise and a tightening together: the raise is kept back, the tightening applies (the review of P4)
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {requestTimeout: 120000, maxOutputBytes: 2 * 1024 * 1024}}));
    await until(() => /requestTimeout not loosened, the values in effect kept: the operator's ceiling file \/etc\/countinghouse\/ceiling\.json cannot be trusted \(it is a symbolic link\)/.test(s.f.err));
    await until(() => s.requests.some((m) => m.type === 'set'));
    assert.deepStrictEqual(s.requests.filter((m) => m.type === 'set').map((m) => [m.name, m.value]), [['maxOutputBytes', 2 * 1024 * 1024]]);
  } finally {
    s.end();
    await s.done;
  }
});

// countinghouse part 3, section 5 (P5): never silent. What start and the
// in-place applier say about the settings reaches the client as notices.
const notices = (s) => s.requests.filter((m) => m.type === 'notice').map((m) => [m.module, m.text]);

test('never silent: an outside edit found at start reaches the client once the runtime is up', async () => {
  const {setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = await running({beforeStart: (home) => {
    const where = layout({COUNTINGHOUSE_HOME: home});
    setSetting(where, 'maxOutputBytes', '4MiB', {by: 'cli'});
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 32 * 1024 * 1024}}));
  }});
  try {
    await until(() => notices(s).length > 0);
    assert.deepStrictEqual(notices(s), [[null, 'maxOutputBytes was changed outside ch-local: 4MiB -> 32MiB (this loosens a guarding setting)']]);
    assert.match(s.f.err, /maxOutputBytes was changed outside ch-local: 4MiB -> 32MiB/, 'and on stderr');
  } finally {
    s.end();
    await s.done;
  }
});

test('never silent: a loosening applied while running is told to the client; a tightening is not', async () => {
  const {setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = await running();
  try {
    const where = layout({COUNTINGHOUSE_HOME: s.home});
    setSetting(where, 'maxOutputBytes', '16MiB', {by: 'cli', mayLoosen: true});
    await until(() => notices(s).length > 0);
    assert.deepStrictEqual(notices(s), [[null, 'maxOutputBytes loosened from 8MiB to 16MiB']]);
    setSetting(where, 'requestTimeout', '10s', {by: 'cli'});
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'requestTimeout'));
    setSetting(where, 'autoUpgrade', 'on', {by: 'cli', mayLoosen: true});
    await until(() => notices(s).length > 1);
    assert.deepStrictEqual(notices(s).slice(1), [[null, 'autoUpgrade loosened from off to on, at the next start']]);
    // an outside edit while running, of any setting: told too (spec section 5)
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 16 * 1024 * 1024, requestTimeout: 10000, autoUpgrade: true, locale: 'zh'}}));
    await until(() => notices(s).some(([, t]) => /locale/.test(t)));
    assert.deepStrictEqual(notices(s).filter(([, t]) => /locale/.test(t)), [[null, 'locale was changed outside ch-local: en -> zh']]);
  } finally {
    s.end();
    await s.done;
  }
});

test('never silent, told once: a clamp start found is not told again by the applier\'s first look', async () => {
  const {layout} = require('../lib/home');
  const s = await running({beforeStart: (home) => {
    const where = layout({COUNTINGHOUSE_HOME: home});
    ceilingReader(home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 6 * 1024 * 1024, forbid: [], packs: null, conversation: true}});
    require('../lib/settings').setSetting(where, 'maxOutputBytes', '16MiB', {by: 'cli', mayLoosen: true});
  }});
  try {
    await until(() => notices(s).length > 0);
    await new Promise((r) => setTimeout(r, 300));   // the applier's first look has run
    assert.deepStrictEqual(notices(s), [[null, 'maxOutputBytes 16MiB is above the operator\'s ceiling: the runtime gets 6MiB']]);
  } finally {
    s.end();
    await s.done;
  }
});

test('never silent: a runtime whose control request fails does not end start; what was not told is said', async () => {
  const {setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  // the runtime's reply to a notice: a failure
  const s = await running({answer: (m) => (m.type === 'notice' ? {ok: false, code: 'CONTROL_FAILED'} : {ok: true})});
  try {
    setSetting(layout({COUNTINGHOUSE_HOME: s.home}), 'maxOutputBytes', '16MiB', {by: 'cli', mayLoosen: true});
    await until(() => /the client was not told: maxOutputBytes loosened from 8MiB to 16MiB \(CONTROL_FAILED\)/.test(s.f.err));
    // start runs on: a later change is still applied
    setSetting(layout({COUNTINGHOUSE_HOME: s.home}), 'locale', 'zh', {by: 'cli'});
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
  } finally {
    s.end();
    await s.done;
  }
});

test('start answers the runtime\'s may-elicit (countinghouse part 3 P2, Task 4): from the client\'s conditions, by its r-id', async () => {
  const s = await running({answer: (m) => (m.type === undefined ? null : {ok: true})});
  s.ask({id: 'r1', type: 'may-elicit', client: {name: 'claude-code', version: '2.1.323'}});
  s.ask({id: 'r2', type: 'may-elicit', client: {name: 'other', version: '1.0.0'}});
  await until(() => s.requests.filter((m) => /^r/.test(String(m.id))).length === 2);
  const replies = s.requests.filter((m) => /^r/.test(String(m.id)));
  // this start's env is no interactive Claude Code session's
  assert.deepStrictEqual(replies, [{id: 'r1', ok: true, mayElicit: false, why: 'not an interactive session'}, {id: 'r2', ok: true, mayElicit: false, why: 'no conditions known'}]);
  s.end();
  await s.done;
});
