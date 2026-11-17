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
// env: start's credentials (a GitHub token and another by default)
// shared: as ch-local daemon runs the shared runtime (a session with the home)
// ghToken: what gh auth token answers (a shared runtime's GitHub token comes
// from gh only), else gh is not logged in
// home: start again on a home a running() made (a runtime restart), without installing
// release: the running release's allowlist (a withdrawn pack's tests), else the shipped one
// clientAncestry: what start's may-elicit reads of the client's ancestry. Read
// for real it can take more than check()'s 3 s on a loaded Windows runner,
// which answers "client settings unreadable" (fail closed, as it should), so
// the tests here are given it read already (ch-local's intermittent
// may-elicit failure on main ed73a358); lib/client-conditions' own tests
// cover the read and the wait.
async function running({answer = () => ({ok: true}), timeoutMs, passThrough = [], duringSpawn = null, beforeStart = null, loadPackAnswerMs, shared = false, ghToken = null, home: reuse = null,
  env = {GITHUB_TOKEN: 'secret', OTHER_TOKEN: 'other-secret'}, clientAncestry = Promise.resolve({lines: null, policyPresent: false}), release: running_release = null} = {}) {
  const home = reuse != null ? reuse : tmp('ch-home-');
  const r = reuse != null ? null : release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  if (reuse == null) assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  if (beforeStart != null) beforeStart(home);
  const f = fakeIo({env: {COUNTINGHOUSE_HOME: home, ...env}, homedir: '/nowhere'});
  Object.assign(f, {pid: 4242, hostname: 'box-1', cwd: home, alive: () => true, trapSignals: () => () => {}, exit: () => {}, controlTimeoutMs: timeoutMs, loadPackAnswerMs, clientAncestry});
  // release: the running release's allowlist, for a withdrawn pack's tests (else the shipped one)
  // (by default fakeIo's: the packs the home holds are listed)
  if (running_release != null) f.release = running_release;
  if (ghToken != null) f.exec = async (c) => (c === 'gh' ? {status: 0, stdout: `${ghToken}\n`, stderr: ''} : {status: 0, stdout: '', stderr: ''});
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
        // delayMs: the runtime answers that much later
        if (reply != null) {
          const {delayMs, ...fields} = reply;
          setTimeout(() => listener({id: msg.id, ...fields}), delayMs || 0);
        }
      },
      // as the runtime does once it listens (countinghouse #210)
      onMessage: (fn) => { listener = fn; setImmediate(() => fn({type: 'ready'})); }
    };
  };
  const done = start({passThrough, session: shared ? {home, socket: path.join(home, 'run', 'daemon', 's')} : null}, f);
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

// No pack can load (no GitHub token: gh not logged in, none in the
// environment): the runtime still starts, serving ch-local's own tools, and
// the session is told which packs are not loaded and why, so the agent can
// say what to do. Per-session start and the daemon's runtime alike (#54's
// diagnosis: the daemon's runtime ended before it listened).
test('no pack has its credential: the runtime starts with no pack, and the client is told which and why', async () => {
  const s = await running({env: {}});
  try {
    assert.ok(!s.args().includes('--loadModule'), `no pack loaded: ${s.args().join(' ')}`);
    await until(() => [/not loading ci-failure-triage/, /no pack is loaded this start/].every((re) => notices(s).some(([, t]) => re.test(t))));
    const told = notices(s).map(([, t]) => t);
    const why = told.find((t) => /not loading ci-failure-triage/.test(t));
    assert.match(why, /needs the GitHub token: store a read-only one with `ch-local credentials add github`, or run `gh auth login`, or for headless or CI use set COUNTINGHOUSE_GITHUB_TOKEN/);
    assert.doesNotMatch(why, /\(above\)/, 'self-contained: the client never saw a line above');
    assert.ok(told.some((t) => /no pack is loaded this start/.test(t)), told.join(' | '));
  } finally {
    s.end();
    assert.strictEqual(await s.done, 0);
  }
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
    duringSpawn: (home) => setSetting(layout({COUNTINGHOUSE_HOME: home}), 'maxOutputBytes', '8MiB', {by: 'cli'})});
  await until(() => s.requests.some((m) => m.type === 'set'));
  assert.deepStrictEqual(s.requests.filter((m) => m.type === 'set').map((m) => [m.name, m.value]), [['maxOutputBytes', 8 * 1024 * 1024]]);
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
  ceilingReader(s.home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 12 * 1024 * 1024, forbid: [], packs: [], conversation: true}});
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 32 * 1024 * 1024, 'pack.ci-failure-triage': false}}));
  await until(() => s.requests.some((m) => m.type === 'unload'));
  await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'maxOutputBytes'));
  assert.deepStrictEqual(s.requests.filter((m) => m.type === 'set').map((m) => [m.name, m.value]), [['maxOutputBytes', 12 * 1024 * 1024]]);
  assert.match(s.f.err, /maxOutputBytes was changed outside ch-local: 16MiB -> 32MiB \(this loosens a guarding setting\)/);
  assert.match(s.f.err, /maxOutputBytes 32MiB is above the operator's ceiling: the runtime gets 12MiB/);
  const outside = s.history().filter((h) => h.change === 'changed outside ch-local').map((h) => h.setting).sort();
  assert.deepStrictEqual(outside, ['maxOutputBytes', 'pack.ci-failure-triage']);
  // turned back on by hand: the ceiling forbids turning a pack on, so it stays off
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 32 * 1024 * 1024, 'pack.ci-failure-triage': true}}));
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
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {requestTimeout: 120000, maxOutputBytes: 4 * 1024 * 1024}}));
    await until(() => /requestTimeout not loosened, the values in effect kept: the operator's ceiling file \/etc\/countinghouse\/ceiling\.json cannot be trusted \(it is a symbolic link\)/.test(s.f.err));
    await until(() => s.requests.some((m) => m.type === 'set'));
    assert.deepStrictEqual(s.requests.filter((m) => m.type === 'set').map((m) => [m.name, m.value]), [['maxOutputBytes', 4 * 1024 * 1024]]);
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
    setSetting(where, 'maxOutputBytes', '8MiB', {by: 'cli'});
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 64 * 1024 * 1024}}));
  }});
  try {
    await until(() => notices(s).length > 0);
    assert.deepStrictEqual(notices(s), [[null, 'maxOutputBytes was changed outside ch-local: 8MiB -> 64MiB (this loosens a guarding setting)']]);
    assert.match(s.f.err, /maxOutputBytes was changed outside ch-local: 8MiB -> 64MiB/, 'and on stderr');
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
    setSetting(where, 'maxOutputBytes', '32MiB', {by: 'cli', mayLoosen: true});
    await until(() => notices(s).length > 0);
    assert.deepStrictEqual(notices(s), [[null, 'maxOutputBytes loosened from 16MiB to 32MiB']]);
    setSetting(where, 'requestTimeout', '10s', {by: 'cli'});
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'requestTimeout'));
    setSetting(where, 'autoUpgrade', 'on', {by: 'cli', mayLoosen: true});
    await until(() => notices(s).length > 1);
    assert.deepStrictEqual(notices(s).slice(1), [[null, 'autoUpgrade loosened from off to on, at the next start']]);
    // an outside edit while running, of any setting: told too (spec section 5)
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 32 * 1024 * 1024, requestTimeout: 10000, autoUpgrade: true, locale: 'zh'}}));
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
    ceilingReader(home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 12 * 1024 * 1024, forbid: [], packs: null, conversation: true}});
    require('../lib/settings').setSetting(where, 'maxOutputBytes', '32MiB', {by: 'cli', mayLoosen: true});
  }});
  try {
    await until(() => notices(s).length > 0);
    await new Promise((r) => setTimeout(r, 300));   // the applier's first look has run
    assert.deepStrictEqual(notices(s), [[null, 'maxOutputBytes 32MiB is above the operator\'s ceiling: the runtime gets 12MiB']]);
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
    setSetting(layout({COUNTINGHOUSE_HOME: s.home}), 'maxOutputBytes', '32MiB', {by: 'cli', mayLoosen: true});
    await until(() => /the client was not told: maxOutputBytes loosened from 16MiB to 32MiB \(CONTROL_FAILED\)/.test(s.f.err));
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

// countinghouse part 3 P2, Task 5: a pack turned on in the client's dialog
// for this start only (control load-pack / unload-pack from the runtime).
// Start loads ci-failure-triage; `other` is added while running and turned
// off, so it is installed and off when the dialog asks for it.
async function withOtherOff(opts = {}) {
  const {layout} = require('../lib/home');
  const s = await running(opts);
  const where = layout({COUNTINGHOUSE_HOME: s.home});
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.other': false}}));
  await until(() => s.requests.some((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other'));
  const count = (type) => s.requests.filter((m) => m.type === type && m.name === '@countinghouse/ch-pack-other').length;
  const reply = async (msg) => { s.ask(msg); await until(() => s.requests.some((m) => m.id === msg.id)); return s.requests.find((m) => m.id === msg.id); };
  return {s, where, count, reply};
}

test('load-pack: an installed pack, off, allowed, at the version the form showed, is loaded this start; settings.json untouched; recorded and told', async () => {
  const {s, where, count, reply} = await withOtherOff();
  try {
    const before = fs.readFileSync(where.settings, 'utf8');
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r1', ok: true});
    assert.strictEqual(count('load'), 2, 'loaded again');
    assert.strictEqual(fs.readFileSync(where.settings, 'utf8'), before, 'settings.json unchanged');
    const h = s.history().filter((e) => e.pack === 'other').pop();
    assert.deepStrictEqual([h.change, h.by], ['turned on this start (confirmed in the client)', 'start']);
    await until(() => s.requests.some((m) => m.type === 'notice' && /other turned on for this start 0\.3\.0/.test(m.text)));
    // the watcher fires (another setting changed): this start's pack stays
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.other': false, locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.strictEqual(count('unload'), 1, 'not unloaded by the next apply');
    // a ceiling that stops allowing it: unloaded
    ceilingReader(s.home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], packs: ['ci-failure-triage'], conversation: true}});
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.other': false, locale: 'en'}}));
    await until(() => count('unload') === 2);
  } finally {
    s.end();
    await s.done;
  }
});

// A shared runtime (as ch-local daemon runs it), its GitHub token from gh
// (its environment holds no other credential), with ci-failure-triage
// turned off by the terminal after it loaded at spawn
const CI = '@countinghouse/ch-pack-ci-failure-triage';
async function sharedWithCiOff(opts = {}) {
  const {layout} = require('../lib/home');
  const s = await running({shared: true, env: {}, ghToken: `t${require('node:crypto').randomBytes(12).toString('hex')}`, ...opts});
  const where = layout({COUNTINGHOUSE_HOME: s.home});
  assert.ok(s.args().some((a) => a.includes('ch-pack-ci-failure-triage')), `loaded at spawn: ${s.args().join(' ')}`);
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.ci-failure-triage': false}}));
  await until(() => s.requests.some((m) => m.type === 'unload' && m.name === CI));
  const count = (type) => s.requests.filter((m) => m.type === type && m.name === CI).length;
  const reply = async (msg) => { s.ask(msg); await until(() => s.requests.some((m) => m.id === msg.id)); return s.requests.find((m) => m.id === msg.id); };
  return {s, where, count, reply};
}

// The shared contract for these messages (countinghouse's shared-runtime-wire
// vectors, packMessages, copied): what the runtime refuses, by reason token.
const PACK_V = require('./vectors/pack-messages.json').packMessages;
function packMessageProblem(m) {
  const packOk = (p) => typeof p === 'string' && new RegExp(PACK_V.packPattern).test(p);
  if (m.type === 'set') return (typeof m.name === 'string' && m.name.startsWith('pack.') && m.value !== true) ? 'set-false' : null;
  if (m.type === 'load' || m.type === 'reload') {
    if (typeof m.global !== 'boolean') return 'global';
    return packOk(m.pack) ? null : 'pack';
  }
  if (m.type === 'unload') return packOk(m.pack) ? null : 'pack';
  if (m.type === 'notice') return (m.pack === undefined || packOk(m.pack)) ? null : 'pack';
  return null;
}
const holdsToTheVectors = (requests) => {
  for (const m of requests) assert.strictEqual(packMessageProblem(m), null, JSON.stringify(m));
};

test('B3: the pack messages\' vectors: each accepted one passes, each refused one fails for its reason', () => {
  for (const {why, message} of PACK_V.accepted) assert.strictEqual(packMessageProblem(message), null, why);
  for (const {why, reason, message} of PACK_V.refused) assert.strictEqual(packMessageProblem(message), reason, why);
});

// countinghouse's shared runtime, B3 "For C": every load, reload and unload
// names its pack beside the scenario, a load or reload says whether it is for
// everyone (global), and a notice about a pack names it
test('B3: a load from the settings is global; an unload and a told notice name the pack', async () => {
  const {s} = await withOtherOff();
  try {
    const load = s.requests.find((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other');
    assert.deepStrictEqual([load.pack, load.global], ['other', true]);
    const unload = s.requests.find((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other');
    assert.strictEqual(unload.pack, 'other');
    assert.ok(!('global' in unload), 'an unload is for everyone that lists it');
    // its notice rides on the unload, which the runtime tells before the pack
    // goes; no separate notice tagged with the pack follows it (by then no
    // session lists it, and it would reach nobody)
    assert.strictEqual(unload.notice, 'other turned off');
    assert.ok(!s.requests.some((m) => m.type === 'notice' && m.pack === 'other' && /turned off|removed/.test(m.text)), JSON.stringify(s.requests.filter((m) => m.type === 'notice')));
    holdsToTheVectors(s.requests);
  } finally {
    s.end();
    await s.done;
  }
});

test('B3: a pack a session turned on loads with global false; in a shared runtime its notice names the pack and says "for this session"', async () => {
  const {s, reply} = await sharedWithCiOff();
  try {
    assert.strictEqual(s.requests.find((m) => m.type === 'unload' && m.name === CI).pack, 'ci-failure-triage');
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'ci-failure-triage', version: '0.1.0'}), {id: 'r1', ok: true});
    const load = s.requests.find((m) => m.type === 'load' && m.name === CI);
    assert.deepStrictEqual([load.pack, load.global], ['ci-failure-triage', false]);
    await until(() => s.requests.some((m) => m.type === 'notice' && /ci-failure-triage turned on for this session 0\.1\.0/.test(m.text)));
    const notice = s.requests.find((m) => m.type === 'notice' && /turned on for this session/.test(m.text));
    assert.strictEqual(notice.pack, 'ci-failure-triage');
    assert.ok(!s.requests.some((m) => m.type === 'notice' && /turned on for this start/.test(m.text)));
    assert.strictEqual(s.history().filter((e) => e.pack === 'ci-failure-triage').pop().change, 'turned on for this session (confirmed in the client)');
    // a notice about no pack carries no pack key
    assert.ok(s.requests.filter((m) => m.type === 'notice' && /changed outside ch-local/.test(m.text)).every((m) => !('pack' in m)));
    holdsToTheVectors(s.requests);
  } finally {
    s.end();
    await s.done;
  }
});

test('B3: the terminal turning on a session\'s pack is set pack.<n> true and no load; the terminal\'s off is an unload naming it, never a set to false', async () => {
  const {s, where, count, reply} = await sharedWithCiOff();
  try {
    await reply({id: 'r1', type: 'load-pack', name: 'ci-failure-triage', version: '0.1.0'});
    const loads = count('load');
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.ci-failure-triage': true}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'pack.ci-failure-triage'));
    assert.deepStrictEqual(s.requests.filter((m) => m.type === 'set' && m.name === 'pack.ci-failure-triage').map((m) => m.value), [true]);
    assert.strictEqual(count('load'), loads, 'loaded already: no load follows');
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.ci-failure-triage': false}}));
    await until(() => count('unload') === 2);
    assert.strictEqual(s.requests.filter((m) => m.type === 'unload').pop().pack, 'ci-failure-triage');
    assert.ok(!s.requests.some((m) => m.type === 'set' && /^pack\./.test(m.name) && m.value !== true), 'never a set to false');
    holdsToTheVectors(s.requests);
  } finally {
    s.end();
    await s.done;
  }
});

test('B3: outside a shared runtime the terminal\'s on sends no set, and the notice still says "for this start"', async () => {
  const {s, where, reply} = await withOtherOff();
  try {
    await reply({id: 'r1', type: 'load-pack', name: 'other', version: '0.3.0'});
    await until(() => s.requests.some((m) => m.type === 'notice' && /other turned on for this start 0\.3\.0/.test(m.text)));
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.other': true, locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.ok(!s.requests.some((m) => m.type === 'set' && m.name === 'pack.other'));
  } finally {
    s.end();
    await s.done;
  }
});

test('B3: a runtime restart starts with the global packs only: a pack a session turned on is not loaded again', async () => {
  const {s, reply} = await sharedWithCiOff();
  let home;
  try {
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'ci-failure-triage', version: '0.1.0'}), {id: 'r1', ok: true});
    assert.ok(s.requests.some((m) => m.type === 'load' && m.name === CI), 'loaded for the session');
    home = s.home;
  } finally {
    s.end();
    await s.done;
  }
  // the daemon restarts its runtime: a new start on the same home
  const again = await running({shared: true, env: {}, ghToken: `t${require('node:crypto').randomBytes(12).toString('hex')}`, home});
  try {
    assert.ok(!again.args().some((a) => a.includes('ch-pack-ci-failure-triage')), `not at spawn: ${again.args().join(' ')}`);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!again.requests.some((m) => m.type === 'load' && m.name === CI), 'and not loaded in place');
  } finally {
    again.end();
    await again.done;
  }
});

test('B3: a set pack.<n> true the runtime refuses is said, and the rest of that change is still applied', async () => {
  const {s, where, reply} = await sharedWithCiOff({answer: (m) => (m.type === 'set' && m.name === 'pack.ci-failure-triage' ? {ok: false, code: 'CONTROL_NOT_LIVE'} : {ok: true})});
  try {
    await reply({id: 'r1', type: 'load-pack', name: 'ci-failure-triage', version: '0.1.0'});
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.ci-failure-triage': true, locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    await until(() => /ci-failure-triage turned on for everyone \(it was on for a session\): not applied in place \(CONTROL_NOT_LIVE\)/.test(s.f.err));
    const h = s.history().filter((e) => e.pack === 'ci-failure-triage').pop();
    assert.strictEqual(h.problem, 'CONTROL_NOT_LIVE');
  } finally {
    s.end();
    await s.done;
  }
});

test('load-pack refused: another version than the form showed, a pack the ceiling does not list, one not installed; unload-pack turns this start\'s off', async () => {
  const {s, count, reply} = await withOtherOff();
  try {
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'other', version: '0.2.0'}), {id: 'r1', ok: false, code: 'CONTROL_VERSION_CHANGED'});
    assert.deepStrictEqual(await reply({id: 'r2', type: 'load-pack', name: 'nope', version: '1.0.0'}), {id: 'r2', ok: false, code: 'CONTROL_NOT_INSTALLED'});
    ceilingReader(s.home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], packs: ['ci-failure-triage'], conversation: true}});
    assert.deepStrictEqual(await reply({id: 'r3', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r3', ok: false, code: 'CONTROL_PACK_NOT_ALLOWED'});
    assert.strictEqual(count('load'), 1, 'nothing loaded');
    ceilingReader(s.home, {state: 'none'});
    assert.deepStrictEqual(await reply({id: 'r4', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r4', ok: true});
    assert.deepStrictEqual(await reply({id: 'r5', type: 'unload-pack', name: 'other'}), {id: 'r5', ok: true});
    assert.strictEqual(count('unload'), 2);
    assert.deepStrictEqual(await reply({id: 'r6', type: 'unload-pack', name: 'ci-failure-triage'}), {id: 'r6', ok: false, code: 'CONTROL_NOT_THIS_START'});
  } finally {
    s.end();
    await s.done;
  }
});

test('load-pack review: the ceiling turned against conversation, or untrusted: refused; a ceiling that unloads a this-start pack ends it (re-allowed, it stays off)', async () => {
  const {s, where, count, reply} = await withOtherOff();
  try {
    ceilingReader(s.home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], packs: null, conversation: false}});
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r1', ok: false, code: 'CONTROL_CONVERSATION_OFF'});
    ceilingReader(s.home, {state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'p'});
    assert.deepStrictEqual(await reply({id: 'r2', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r2', ok: false, code: 'CONTROL_CEILING_UNTRUSTED'});
    ceilingReader(s.home, {state: 'none'});
    assert.deepStrictEqual(await reply({id: 'r3', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r3', ok: true});
    ceilingReader(s.home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], packs: ['ci-failure-triage'], conversation: true}});
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.other': false, locale: 'zh'}}));
    await until(() => count('unload') === 2);
    ceilingReader(s.home, {state: 'none'});
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.other': false, locale: 'en'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale' && m.value === 'en-US'));
    assert.strictEqual(count('load'), 2, 'not reloaded without a new confirmation');
  } finally {
    s.end();
    await s.done;
  }
});

test('load-pack review: settings.json\'s value for the pack changing ends this start\'s turn-on (the file governs)', async () => {
  const {s, where, count, reply} = await withOtherOff();
  try {
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r1', ok: true});
    // turned on in the file, then off in the file: off
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.other': true}}));
    await new Promise((r) => setTimeout(r, 600));
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.other': false, locale: 'zh'}}));
    await until(() => count('unload') === 2);
  } finally {
    s.end();
    await s.done;
  }
});

test('load-pack review: the version loaded is the one confirmed; a pack whose first package is not its ch-pack is refused; one not started within 10 s is refused unloaded', async () => {
  const {s, count, reply} = await withOtherOff();
  try {
    // packs.json lists another package first for `other`
    const file = path.join(s.home, 'packs.json');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pk = rec.packs.other.packages;
    rec.packs.other.packages = Object.fromEntries([['@countinghouse/ch-step-other', pk['@countinghouse/ch-step-other']], ...Object.entries(pk).filter(([k]) => k !== '@countinghouse/ch-step-other')]);
    fs.writeFileSync(file, JSON.stringify(rec));
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r1', ok: false, code: 'CONTROL_VERSION_CHANGED'});
    assert.strictEqual(count('load'), 1);
  } finally {
    s.end();
    await s.done;
  }
  // a request that waited past its start window on the applier's chain
  const {loadPackDeadlineMs} = require('../lib/in-place');
  assert.strictEqual(loadPackDeadlineMs, 10000, 'started within 10 s, loaded within 30 s more: under the runtime\'s 45 s');
});

test('load-pack follow-ups: a this-start pack upgraded in place is turned off, not reloaded at a version nobody confirmed', async () => {
  const {s, count, reply} = await withOtherOff();
  try {
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r1', ok: true});
    const r2 = release({versions: {'@countinghouse/ch-pack-other': '0.4.0'}});
    assert.strictEqual(await install({pack: 'other', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => count('unload') === 2);
    assert.strictEqual(s.requests.filter((m) => m.type === 'reload' && m.name === '@countinghouse/ch-pack-other').length, 0, 'never reloaded');
  } finally {
    s.end();
    await s.done;
  }
});

test('load-pack follow-ups: a confirmed load answered past the runtime\'s wait is unloaded and refused, never told as turned on', async () => {
  // the runtime's load answer arrives 300 ms late; the answer window is 200 ms
  const {s, count, reply} = await withOtherOff({loadPackAnswerMs: 200, answer: (m) => (m.type === 'load' && m.name === '@countinghouse/ch-pack-other' ? {ok: true, delayMs: 300} : m.type === undefined ? null : {ok: true})});
  try {
    const before = count('load');
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r1', ok: false, code: 'CONTROL_BUSY'});
    assert.strictEqual(count('load'), before + 1);
    await until(() => count('unload') === 2);
    assert.ok(!s.requests.some((m) => m.type === 'notice' && /other turned on for this start/.test(m.text)), 'never told as turned on');
    assert.ok(s.history().some((h) => h.pack === 'other' && h.change === 'not turned on (answered too late)'));
  } finally {
    s.end();
    await s.done;
  }
});

// Withdrawn packs (Matt, 2026-11-17, option 1): installed, but not in the
// running release's allowlist: never started; told once, on stderr and to
// the client; nothing of it removed. An unreleased install is exempt (its
// record is marked only by --unreleased-pins, which needs CH_LOCAL_DEV=1),
// and says so at every start; a released one never is, whatever its env.
const withdrawnRelease = () => ({...require('../lib/allowlist').ALLOWLIST, packs: {}});
const LINE = 'pack ci-failure-triage was withdrawn in this release and was not started; `ch-local remove-pack ci-failure-triage` removes it';
// every file of the home a start must leave as it was: the record, and the pack's tree and data
function packFiles(home) {
  const out = {};
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d, {withFileTypes: true}); } catch (e) { return; }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p); else if (n.isFile()) out[path.relative(home, p)] = require('node:crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  const {layout} = require('../lib/home');
  const where = layout({COUNTINGHOUSE_HOME: home});
  out['packs.json'] = require('node:crypto').createHash('sha256').update(fs.readFileSync(where.packs)).digest('hex');
  for (const d of [where.app, where.packsDir, path.join(home, 'module_data')]) if (d != null) walk(d);
  return out;
}
const loadsPack = (s) => (s.args() || []).some((a, i, all) => all[i - 1] === '--loadModule' && /ch-pack-ci-failure-triage/.test(String(a)));

test('a withdrawn pack is not started: told once (stderr and the client), its record, files and data untouched', async () => {
  let before = null;
  const s = await running({release: withdrawnRelease(), beforeStart: (home) => {
    fs.mkdirSync(path.join(home, 'module_data', 'ch-pack-ci-failure-triage', 'data'), {recursive: true});
    fs.writeFileSync(path.join(home, 'module_data', 'ch-pack-ci-failure-triage', 'data', 'kept.txt'), 'the user\'s data');
    before = packFiles(home);
  }});
  try {
    await until(() => notices(s).length > 0);
    assert.strictEqual(loadsPack(s), false, JSON.stringify(s.args()));
    assert.deepStrictEqual(notices(s).filter(([, t]) => /withdrawn/.test(t)), [[null, LINE]], 'once, to the client');
    assert.strictEqual(s.f.err.split('\n').filter((l) => l.includes(LINE)).length, 1, s.f.err);
    assert.ok(!/\/|\\\\/.test(LINE.replace(/`[^`]*`/g, '')), 'no path in the notice');
  } finally {
    s.end();
    await s.done;
  }
  assert.deepStrictEqual(packFiles(s.home), before, 'nothing removed or changed');
});

test('a released install started with CH_LOCAL_DEV=1 is still refused its withdrawn pack', async () => {
  const s = await running({release: withdrawnRelease(), env: {GITHUB_TOKEN: 'secret', CH_LOCAL_DEV: '1'}});
  try {
    await until(() => notices(s).length > 0);
    assert.strictEqual(loadsPack(s), false);
    assert.ok(notices(s).some(([, t]) => t === LINE));
  } finally {
    s.end();
    await s.done;
  }
});

test('an unreleased install is exempt, with CH_LOCAL_DEV=1 or without (the shared daemon never has it): the pack starts, the unreleased line said each time', async () => {
  const unreleased = (home) => {
    const f = path.join(home, 'packs.json');
    fs.writeFileSync(f, JSON.stringify({...JSON.parse(fs.readFileSync(f, 'utf8')), unreleased: true}, null, 2));
  };
  const dev = await running({release: withdrawnRelease(), beforeStart: unreleased, env: {GITHUB_TOKEN: 'secret', CH_LOCAL_DEV: '1'}});
  try {
    await until(() => dev.args() != null);
    assert.strictEqual(loadsPack(dev), true, JSON.stringify(dev.args()));
    assert.ok(!notices(dev).some(([, t]) => /withdrawn/.test(t)));
  } finally {
    dev.end();
    await dev.done;
  }
  const plain = await running({release: withdrawnRelease(), beforeStart: unreleased});
  try {
    await until(() => plain.args() != null);
    assert.strictEqual(loadsPack(plain), true, JSON.stringify(plain.args()));
    assert.ok(!notices(plain).some(([, t]) => /withdrawn/.test(t)));
    for (const s of [dev, plain]) assert.ok(s.f.err.includes(require('../lib/pins').UNRELEASED_LINE), 'never silent: the unreleased line');
  } finally {
    plain.end();
    await plain.done;
  }
});

test('load-pack for a withdrawn pack is refused CONTROL_PACK_NOT_ALLOWED, and nothing is loaded', async () => {
  const {s, count, reply} = await withOtherOff();
  try {
    // a release that no longer lists `other`: it is withdrawn
    const release = require('./fake-io').installedRelease(s.home);
    const {other, ...kept} = release.packs;
    assert.ok(other != null, 'the release listed other');
    s.f.release = {...release, packs: kept};
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r1', ok: false, code: 'CONTROL_PACK_NOT_ALLOWED'});
    assert.strictEqual(count('load'), 1, 'nothing loaded');
    // listed again, the same request loads it: the release was the refusal
    s.f.release = release;
    assert.deepStrictEqual(await reply({id: 'r2', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r2', ok: true});
    assert.strictEqual(count('load'), 2);
  } finally {
    s.end();
    await s.done;
  }
});
