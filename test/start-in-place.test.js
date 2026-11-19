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

// what a control request names: a load's or unload's name, a reload's names
// (the module form, #413 section 7.3)
const named = (m) => (m.name != null ? m.name : (Array.isArray(m.names) ? m.names.join(',') : undefined));
const editRecord = (...a) => require('./store-helpers').editHome(...a);
const ACCESS = '@countinghouse/ch-access-github';
const GH_ORIGIN = 'https://api.githubcopilot.com';
// a test home's stored value (no real token's shape)
const STORED = 'test-stored-value-1';
const bindAccess = (home, source = 'stored') => require('../lib/credential-store').bind(home, ACCESS, 'COUNTINGHOUSE_GITHUB_TOKEN',
  source === 'gh' ? {origin: GH_ORIGIN, source: 'gh'} : {origin: GH_ORIGIN, source: 'stored', value: STORED});
const TRIAGE_LOADED = {'@countinghouse/ch-pack-ci-failure-triage': '0.1.0', '@countinghouse/ch-access-github': '0.1.0', '@countinghouse/ch-step-redact': '0.1.0'};
const until = async (cond, ms = 10000) => {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 20))) if (cond()) return;
  throw new Error('timed out waiting');
};

// A running start over an installed home, with a runtime that answers each
// control request with `answer(msg)` (default ok) and runs until end().
// env: start's environment (no credential: a credential is a module's own,
// in the store, #413 section 6.9)
// bound: ch-access-github's stored credential: 'stored' (a test value, the
// default), 'gh' (its source gh: ghToken answers), or null (none)
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
  env = {}, bound = 'stored', clientAncestry = Promise.resolve({lines: null, policyPresent: false}), release: running_release = null} = {}) {
  const home = reuse != null ? reuse : tmp('ch-home-');
  const r = reuse != null ? null : release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  if (reuse == null) assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  if (reuse == null && bound != null) bindAccess(home, bound);
  if (beforeStart != null) beforeStart(home);
  const f = fakeIo({env: {COUNTINGHOUSE_HOME: home, ...env}, homedir: '/nowhere'});
  Object.assign(f, {pid: 4242, hostname: 'box-1', cwd: home, alive: () => true, trapSignals: () => () => {}, exit: () => {}, controlTimeoutMs: timeoutMs, loadPackAnswerMs, clientAncestry});
  // the running ch-local is the one the home holds (the npm stub's 0.2.0); a
  // test makes this process stale by giving it another (lib/packs.js
  // recordRelease)
  f.selfVersion = '0.2.0';
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
  // where every module loaded, at start or in place, may be (#413 section
  // 7.2): the module store only, never the app, which holds the runtime
  const roots = s.args().flatMap((a, i) => (s.args()[i - 1] === '--modulesRoot' ? [a] : []));
  assert.deepStrictEqual(roots, [path.join(s.home, 'module-store')]);
  assert.ok(!s.args().includes('--packsRoot'));
  s.end();
  assert.strictEqual(await s.done, 0);
});

// No pack can load (no GitHub token: gh not logged in, none in the
// environment): the runtime still starts, serving ch-local's own tools, and
// the session is told which packs are not loaded and why, so the agent can
// say what to do. Per-session start and the daemon's runtime alike (#54's
// diagnosis: the daemon's runtime ended before it listened).
test('no pack has its credential: the runtime starts with no pack, and the client is told which and why', async () => {
  const s = await running({bound: null});
  try {
    assert.ok(!s.args().includes('--loadModule'), `no pack loaded: ${s.args().join(' ')}`);
    await until(() => [/not loading ch-pack-ci-failure-triage/, /no module is loaded this start/].every((re) => notices(s).some(([, t]) => re.test(t))));
    const told = notices(s).map(([, t]) => t);
    const why = told.find((t) => /not loading ch-pack-ci-failure-triage/.test(t));
    assert.match(why, /it calls ch-access-github, which needs a credential: run `ch-local credentials add ch-access-github`/);
    assert.doesNotMatch(why, /\(above\)/, 'self-contained: the client never saw a line above');
    assert.ok(told.some((t) => /no module is loaded this start/.test(t)), told.join(' | '));
  } finally {
    s.end();
    assert.strictEqual(await s.done, 0);
  }
});

test('add-pack while running: one load request in the module form, each module by its store directory, with its notice; history and run.json follow', async () => {
  const s = await running();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.requests.length === 1);
  const [load] = s.requests;
  assert.strictEqual(load.type, 'load');
  // the runtime knows a pack by its scenario's package name (countinghouse #205)
  assert.strictEqual(load.name, '@countinghouse/ch-pack-other');
  assert.strictEqual(load.notice, 'ch-pack-other added 0.3.0');
  // the module form (#413 section 7.3): no scenario path, pack, global or
  // credentials file; each module's store directory
  assert.deepStrictEqual(Object.keys(load.dirs).sort(), ['@countinghouse/ch-pack-other', '@countinghouse/ch-step-other', '@countinghouse/ch-step-redact']);
  assert.strictEqual(load.dirs['@countinghouse/ch-pack-other'], path.join(s.home, 'module-store', '@countinghouse', 'ch-pack-other', '0.3.0'));
  for (const f of ['scenario', 'pack', 'global', 'remoteCredentials']) assert.ok(!(f in load), f);
  assert.ok(!('deviceConfigDir' in load), 'the runtime uses its own --deviceConfigPath');
  await until(() => s.history().length === 1);
  assert.deepStrictEqual((({module, change, notice, by}) => ({module, change, notice, by}))(s.history()[0]), {module: '@countinghouse/ch-pack-other', change: 'added', notice: 'ch-pack-other added 0.3.0', by: 'start'});
  assert.ok(!JSON.stringify(s.history()).includes('secret'), 'never a value');
  // run.json names every module version this runtime holds
  const run = JSON.parse(fs.readFileSync(path.join(s.runDir(), 'run.json'), 'utf8'));
  assert.deepStrictEqual(run.loaded, {'@countinghouse/ch-pack-ci-failure-triage': '0.1.0', '@countinghouse/ch-access-github': '0.1.0', '@countinghouse/ch-step-redact': '0.1.0',
    '@countinghouse/ch-pack-other': '0.3.0', '@countinghouse/ch-step-other': '0.2.0'});
  assert.match(s.f.err, /ch-pack-other added 0\.3\.0/);
  s.end();
  await s.done;
});

test('remove-pack while running: one unload request; reinstalling a changed release reloads', async () => {
  const s = await running();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.requests.length === 1);
  assert.strictEqual(await removePack({pack: 'other'}, s.cmd()), 0);
  await until(() => s.requests.length === 2);
  assert.deepStrictEqual([s.requests[1].type, s.requests[1].name, s.requests[1].notice], ['unload', '@countinghouse/ch-pack-other', 'ch-pack-other removed']);
  const r2 = release({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
  await until(() => s.requests.length === 3);
  assert.deepStrictEqual([s.requests[2].type, named(s.requests[2]), s.requests[2].notice], ['reload', '@countinghouse/ch-pack-ci-failure-triage', 'ch-pack-ci-failure-triage updated 0.1.0 → 0.1.0']);
  s.end();
  await s.done;
});

test('a refused request is recorded and said, and nothing is marked loaded; a runtime that never answers is a restart', async () => {
  const s = await running({answer: (m) => (m.name === '@countinghouse/ch-pack-other' ? {ok: false, code: 'PART_VERSION_CONFLICT', message: 'two versions'} : {ok: true})});
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.history().length === 1);
  assert.match(s.history()[0].problem, /^PART_VERSION_CONFLICT/);
  assert.match(s.f.err, /ch-pack-other added 0\.3\.0: not applied in place \(PART_VERSION_CONFLICT\); restart your client/);
  const run = JSON.parse(fs.readFileSync(path.join(s.runDir(), 'run.json'), 'utf8'));
  assert.deepStrictEqual(run.loaded, TRIAGE_LOADED);
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
  assert.deepStrictEqual(run.loaded, TRIAGE_LOADED);
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
    if (!held.has(named(m))) { refusals++; return {ok: false, code: 'CONTROL_FAILED', message: `${named(m)} is not loaded`}; }
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
  assert.deepStrictEqual(s.requests.filter((m) => m.type !== 'set').map((m) => `${m.type} ${named(m)}`),
    ['load @countinghouse/ch-pack-other', 'unload @countinghouse/ch-pack-other', 'reload @countinghouse/ch-pack-ci-failure-triage']);
  assert.strictEqual(refusals, 0);
  await until(() => s.history().length === 3);
  assert.deepStrictEqual(s.history().map((h) => [h.module, h.problem]), [['@countinghouse/ch-pack-other', undefined], ['@countinghouse/ch-pack-other', undefined], ['@countinghouse/ch-pack-ci-failure-triage', undefined]],
    'the history names the module (L2a: by module)');
  s.end();
  await s.done;
});

// A pack the record names whose modules are not in the module store (a
// record edited by hand, an install cut short) is not loaded in place, and
// the user is told to run ch-local install, which places them.
test('a pack whose modules are not in the module store is not loaded in place: said and recorded, "run ch-local install"', async () => {
  const s = await running();
  const rec = JSON.parse(fs.readFileSync(path.join(s.home, 'modules.json'), 'utf8'));
  const {writeModulesRecord} = require('../lib/module-record');
  const {roleOf} = require('./store-helpers');
  writeModulesRecord({modulesRecord: path.join(s.home, 'modules.json')}, {...rec, packs: {...rec.packs, other: {from: {release: '0.2.0'}, modules: {'@countinghouse/ch-pack-other': '0.3.0'}}}},
    {roleOf: roleOf(s.home), release: {packs: {'ci-failure-triage': {packages: Object.keys(TRIAGE_LOADED)}, other: {packages: ['@countinghouse/ch-pack-other']}}}});
  await until(() => s.history().some((h) => h.module === '@countinghouse/ch-pack-other' && h.problem != null));
  assert.deepStrictEqual(s.requests.filter((m) => m.type !== 'set' && m.type !== 'notice').map((m) => m.type), [], 'nothing loaded: the sessions are told why');
  assert.match(s.history().find((h) => h.problem != null).problem, /its files are missing; run `ch-local install` again/);
  assert.match(s.f.err, /not loading ch-pack-other: its files are missing; run `ch-local install` again/);
  s.end();
  await s.done;
});

test('a change that cannot be applied in place is said, never fatal: start runs on', async () => {
  const s = await running();
  // the record replaced by one that cannot be read
  fs.writeFileSync(path.join(s.home, 'modules.json'), '{');
  await until(() => /the home cannot be read .*nothing applied/.test(s.f.err));
  assert.deepStrictEqual(s.requests.filter((m) => m.type !== 'set'), []);
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
  ceilingReader(s.home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 12 * 1024 * 1024, forbid: [], modules: [], conversation: true}});
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
    ceilingReader(home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {maxOutputBytes: 12 * 1024 * 1024, forbid: [], conversation: true}});
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
    const h = s.history().filter((e) => e.module === '@countinghouse/ch-pack-other').pop();
    assert.deepStrictEqual([h.change, h.by], ['turned on this start (confirmed in the client)', 'start']);
    await until(() => s.requests.some((m) => m.type === 'notice' && /ch-pack-other turned on for this start 0\.3\.0/.test(m.text)));
    // the watcher fires (another setting changed): this start's pack stays
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.other': false, locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.strictEqual(count('unload'), 1, 'not unloaded by the next apply');
    // a ceiling that stops allowing it: unloaded
    ceilingReader(s.home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], modules: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', '@countinghouse/ch-step-redact'], conversation: true}});
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
// From the module store every load, reload and unload is in the module form
// (#413 section 7.3), which carries none of the pack form's fields.
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
// The module form's own vectors (countinghouse's moduleMessages, copied):
// what the runtime refuses, by reason token
const MODULE_V = require('./vectors/module-messages.json').moduleMessages;
const OLD_FIELDS = ['scenario', 'pack', 'global', 'remoteCredentials'];
function moduleMessageProblem(m) {
  const pkg = (n) => typeof n === 'string' && new RegExp(MODULE_V.packagePattern).test(n);
  const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
  if (m.type === 'reload') {
    if (!Array.isArray(m.names) || m.names.length === 0 || !m.names.every(pkg) || new Set(m.names).size !== m.names.length) return 'names';
  } else if (['load', 'unload'].includes(m.type)) {
    if (!pkg(m.name)) return 'name';
  } else {
    return null;
  }
  if (OLD_FIELDS.some((f) => f in m)) return 'old-field';
  if (m.type === 'unload') return null;
  const tops = m.type === 'reload' ? m.names : [m.name];
  if (!isObj(m.dirs) || Object.keys(m.dirs).length === 0 || Object.keys(m.dirs).length > 64) return 'dirs';
  if (!Object.entries(m.dirs).every(([n, d]) => pkg(n) && typeof d === 'string' && path.isAbsolute(d)) || !tops.every((t) => t in m.dirs)) return 'dirs';
  if (m.credentials !== undefined) {
    if (!isObj(m.credentials)) return 'credentials';
    for (const [n, e] of Object.entries(m.credentials)) {
      if (!(n in m.dirs) || !isObj(e) || !Object.values(e).every((v) => isObj(v) && Object.values(v).every((slot) => new RegExp(MODULE_V.slotPattern).test(slot)))) return 'credentials';
    }
  }
  return null;
}
const holdsToTheVectors = (requests) => {
  for (const m of requests) {
    if (['load', 'reload', 'unload'].includes(m.type)) assert.strictEqual(moduleMessageProblem(m), null, JSON.stringify(m));
    else assert.strictEqual(packMessageProblem(m), null, JSON.stringify(m));
  }
};

test('the module messages\' vectors: each accepted load, reload and unload passes, each refused one fails for its reason', () => {
  const kinds = new Set(['load', 'reload', 'unload']);
  for (const {why, message} of MODULE_V.accepted.filter((e) => kinds.has(e.message.type))) {
    // an absolute directory as the platform reads one (the vectors' are POSIX)
    const m = message.dirs != null ? {...message, dirs: Object.fromEntries(Object.entries(message.dirs).map(([n, d]) => [n, path.resolve(d)]))} : message;
    assert.strictEqual(moduleMessageProblem(m), null, why);
  }
  for (const {why, reason, message} of MODULE_V.refused.filter((e) => kinds.has(e.message.type))) assert.strictEqual(moduleMessageProblem(message), reason, why);
});

test('B3: the pack messages\' vectors: each accepted one passes, each refused one fails for its reason', () => {
  for (const {why, message} of PACK_V.accepted) assert.strictEqual(packMessageProblem(message), null, why);
  for (const {why, reason, message} of PACK_V.refused) assert.strictEqual(packMessageProblem(message), reason, why);
});

// countinghouse's shared runtime, B3, from the module store: a load and an
// unload are in the module form, which names no pack and carries no global
// (a shared runtime's module form is for everyone); a notice about a pack
// names it
test('B3: a load and an unload from the settings are in the module form; the unload carries its notice', async () => {
  const {s} = await withOtherOff();
  try {
    const load = s.requests.find((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other');
    assert.ok(load.dirs != null && !('pack' in load) && !('global' in load), JSON.stringify(load));
    const unload = s.requests.find((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other');
    assert.ok(!('pack' in unload) && !('global' in unload));
    // its notice rides on the unload, which the runtime tells before the pack
    // goes; no separate notice tagged with the pack follows it
    assert.strictEqual(unload.notice, 'ch-pack-other turned off');
    assert.ok(!s.requests.some((m) => m.type === 'notice' && m.pack === 'other' && /turned off|removed/.test(m.text)), JSON.stringify(s.requests.filter((m) => m.type === 'notice')));
    holdsToTheVectors(s.requests);
  } finally {
    s.end();
    await s.done;
  }
});

// a session's own pack on a shared runtime (the Reviewer, 11-18, L1a Q1):
// the module form is global there, and one session must never turn a pack
// on for everyone, so it is refused and the session told how to turn it on
// for every session; the terminal's on loads it, for everyone
test('B3: on a shared runtime a session\'s load-pack is refused and the session told to turn it on for every session; the terminal\'s on loads it', async () => {
  const {s, where, count, reply} = await sharedWithCiOff();
  try {
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'ci-failure-triage', version: '0.1.0'}), {id: 'r1', ok: false, code: 'CONTROL_PACK_NOT_ALLOWED'});
    await until(() => notices(s).some(([, t]) => t === 'ci-failure-triage is turned on for every session: `ch-local settings set pack.ci-failure-triage on`'));
    assert.strictEqual(count('load'), 0, 'nothing loaded for the session');
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.ci-failure-triage': true}}));
    await until(() => count('load') === 1);
    assert.ok(!s.requests.some((m) => m.type === 'set' && /^pack\./.test(m.name)), 'no set pack.<n>: the load is everyone\'s');
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
    await until(() => s.requests.some((m) => m.type === 'notice' && /ch-pack-other turned on for this start 0\.3\.0/.test(m.text)));
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {'pack.other': true, locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.ok(!s.requests.some((m) => m.type === 'set' && m.name === 'pack.other'));
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
    ceilingReader(s.home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], modules: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', '@countinghouse/ch-step-redact'], conversation: true}});
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
    ceilingReader(s.home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], conversation: false}});
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r1', ok: false, code: 'CONTROL_CONVERSATION_OFF'});
    ceilingReader(s.home, {state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'p'});
    assert.deepStrictEqual(await reply({id: 'r2', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r2', ok: false, code: 'CONTROL_CEILING_UNTRUSTED'});
    ceilingReader(s.home, {state: 'none'});
    assert.deepStrictEqual(await reply({id: 'r3', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r3', ok: true});
    ceilingReader(s.home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], modules: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', '@countinghouse/ch-step-redact'], conversation: true}});
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

test('load-pack review: the version loaded is the one confirmed; a pack whose record holds no ch-pack is refused; one not started within 10 s is refused unloaded', async () => {
  const {s, count, reply} = await withOtherOff();
  try {
    // the record's `other` no longer holds its ch-pack package
    editRecord(s.home, (r) => {
      const {'@countinghouse/ch-pack-other': _drop, ...rest} = r.packs.other.modules;
      void _drop;
      return {...r, packs: {...r.packs, other: {...r.packs.other, modules: rest}}};
    });
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
    assert.ok(!s.requests.some((m) => m.type === 'notice' && /ch-pack-other turned on for this start/.test(m.text)), 'never told as turned on');
    assert.ok(s.history().some((h) => h.module === '@countinghouse/ch-pack-other' && h.change === 'not turned on (answered too late)'));
  } finally {
    s.end();
    await s.done;
  }
});

// Withdrawn packs (maintainer's decision, 2026-11-17): installed, but not in the
// running release's allowlist: never started; told once, on stderr and to
// the client; nothing of it removed. An unreleased install is exempt (its
// record is marked only by --unreleased-pins, which needs CH_LOCAL_DEV=1),
// and says so at every start; a released one never is, whatever its env.
const withdrawnRelease = () => ({...require('../lib/allowlist').ALLOWLIST, packs: {}});
const LINE = 'module ch-pack-ci-failure-triage was withdrawn in this release and was not started; `ch-local remove-pack ci-failure-triage` removes it';
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
  out['modules.json'] = require('node:crypto').createHash('sha256').update(fs.readFileSync(where.modulesRecord)).digest('hex');
  for (const d of [where.app, where.moduleStore, path.join(home, 'module_data')]) if (d != null) walk(d);
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
  const s = await running({release: withdrawnRelease(), env: {CH_LOCAL_DEV: '1'}});
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
  const unreleased = (home) => editRecord(home, (r) => ({...r, unreleased: true}));
  const dev = await running({release: withdrawnRelease(), beforeStart: unreleased, env: {CH_LOCAL_DEV: '1'}});
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

// Withdrawn by the record (#413 section 9.7): an upgrade to a release that
// no longer lists a pack writes its modules into the record's withdrawn
// list, which a start of the release before reads. Nothing of it is removed.
function withdrawHeld(home, name) {
  editRecord(home, (r) => r, {release: {packs: Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(home, 'modules.json'), 'utf8')).packs)
    .filter(([p]) => p !== name).map(([p, e]) => [p, {packages: Object.keys(e.modules)}]))}});
}

test('a running start stops serving a pack an upgrade withdraws: unloaded, and the client told why', async () => {
  const s = await running();
  try {
    assert.strictEqual(loadsPack(s), true);
    withdrawHeld(s.home, 'ci-failure-triage');
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-ci-failure-triage'));
    const now = 'module ch-pack-ci-failure-triage was withdrawn in this release and is no longer served; `ch-local remove-pack ci-failure-triage` removes it';
    await until(() => s.requests.some((m) => (m.type === 'unload' && m.notice === now) || (m.type === 'notice' && m.text === now)));
  } finally {
    s.end();
    await s.done;
  }
});

test('load-pack for a pack held as withdrawn is refused CONTROL_PACK_NOT_ALLOWED, and the session is told why', async () => {
  const {s, count, reply} = await withOtherOff();
  try {
    withdrawHeld(s.home, 'other');
    await new Promise((r) => setTimeout(r, 500));   // the watcher's apply has run
    const line = 'module ch-pack-other was withdrawn in this release and was not started; `ch-local remove-pack other` removes it';
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r1', ok: false, code: 'CONTROL_PACK_NOT_ALLOWED'});
    await until(() => notices(s).some(([, t]) => t === line));
    assert.strictEqual(count('load'), 1, 'nothing loaded');
  } finally {
    s.end();
    await s.done;
  }
});

test('a withdrawn pack whose unload is refused is tried once more, then the client is told to restart', async () => {
  const s = await running({answer: (m) => (m.type === 'unload' ? {ok: false, code: 'CONTROL_FAILED'} : {ok: true})});
  try {
    withdrawHeld(s.home, 'ci-failure-triage');
    const unloads = () => s.requests.filter((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-ci-failure-triage').length;
    await until(() => notices(s).some(([, t]) => /could not be stopped in place: restart your client now/.test(t)));
    assert.strictEqual(unloads(), 2, 'tried twice');
  } finally {
    s.end();
    await s.done;
  }
});

// the medium review of L1a-2, 6: on a shared runtime a session's load-pack is
// refused only after every other check: a withdrawn pack is told as such,
// and one already on answers as before
test('on a shared runtime a withdrawn pack\'s load-pack is told it is withdrawn, not the settings line; one already on answers {}', async () => {
  const {s, reply} = await sharedWithCiOff();
  try {
    withdrawHeld(s.home, 'ci-failure-triage');
    await new Promise((r) => setTimeout(r, 500));   // the watcher's apply has run
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'ci-failure-triage', version: '0.1.0'}), {id: 'r1', ok: false, code: 'CONTROL_PACK_NOT_ALLOWED'});
    await until(() => notices(s).some(([, t]) => /ci-failure-triage was withdrawn in this release/.test(t)));
    assert.ok(!notices(s).some(([, t]) => /is turned on for every session/.test(t)), 'not the settings line');
  } finally {
    s.end();
    await s.done;
  }
  const on = await running({shared: true, env: {}, ghToken: `t${require('node:crypto').randomBytes(12).toString('hex')}`});
  try {
    const reply = async (msg) => { on.ask(msg); await until(() => on.requests.some((m) => m.id === msg.id)); return on.requests.find((m) => m.id === msg.id); };
    assert.deepStrictEqual(await reply({id: 'r2', type: 'load-pack', name: 'ci-failure-triage', version: '0.1.0'}), {id: 'r2', ok: true}, 'on already');
  } finally {
    on.end();
    await on.done;
  }
});

// #83's high review, 1: a part two loaded packs share moves in ONE reload
// naming both (countinghouse refuses a part's version change unless every
// top-level module holding it is named)
test('an upgrade of a part two loaded packs share is one reload naming both packs', async () => {
  const s = await running();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
  const r2 = release({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
  await until(() => s.requests.some((m) => m.type === 'reload'));
  await new Promise((r) => setTimeout(r, 300));
  const reloads = s.requests.filter((m) => m.type === 'reload');
  assert.strictEqual(reloads.length, 1, JSON.stringify(reloads));
  assert.deepStrictEqual(reloads[0].names.slice().sort(), ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-pack-other']);
  assert.strictEqual(reloads[0].dirs['@countinghouse/ch-step-redact'], path.join(s.home, 'module-store', '@countinghouse', 'ch-step-redact', '0.2.0'));
  holdsToTheVectors(s.requests);
  await until(() => s.history().filter((h) => h.change === 'updated').length === 2);
  s.end();
  await s.done;
});

// the medium review of #83's fixes, 4: the reload goes before a new pack's
// load, so a pack added at a shared part's new version meets it there
test('an install that moves a shared part and adds a pack reloads first, then loads the new pack', async () => {
  const s = await running();
  const r2 = release({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
  assert.strictEqual(await install({pack: 'other', from: r2.from}, s.cmd(), r2.allow), 0);
  await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
  const order = s.requests.filter((m) => ['load', 'reload'].includes(m.type)).map((m) => m.type);
  assert.deepStrictEqual(order, ['reload', 'load']);
  s.end();
  await s.done;
});

// the Reviewer's check of #83's fixes, 6: each reload group is its own
// request; packs that share nothing never fail together
test('two packs whose moved modules do not overlap are reloaded apart: one refused, the other still applied', async () => {
  const s = await running({answer: (m) => (m.type === 'reload' && m.names.includes('@countinghouse/ch-pack-ci-failure-triage') ? {ok: false, code: 'CONTROL_FAILED'} : {ok: true})});
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
  // ch-access-github is ci-failure-triage's only, ch-step-other the other's only
  const r2 = release({versions: {'@countinghouse/ch-access-github': '0.1.1', '@countinghouse/ch-step-other': '0.2.1'}});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
  await until(() => s.requests.filter((m) => m.type === 'reload').length === 2);
  const reloads = s.requests.filter((m) => m.type === 'reload').map((m) => m.names);
  assert.deepStrictEqual(reloads.map((n) => n.length), [1, 1], JSON.stringify(reloads));
  await until(() => s.history().some((h) => h.module === '@countinghouse/ch-pack-other' && h.change === 'updated' && h.problem == null));
  assert.ok(s.history().some((h) => h.module === '@countinghouse/ch-pack-ci-failure-triage' && h.problem != null), 'ci-failure-triage refused alone');
  s.end();
  await s.done;
});

// the medium review of the Reviewer's round on #83
test('a pack that drops a module another pack moves reloads in the same group as it (1)', async () => {
  const s = await running();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
  // ci-failure-triage moves ch-step-redact to 0.2.0; other no longer takes it
  const r2 = release({versions: {'@countinghouse/ch-step-redact': '0.2.0', '@countinghouse/ch-step-other': '0.2.1'}});
  r2.allow.packs.other = {...r2.allow.packs.other, packages: r2.allow.packs.other.packages.filter((n) => n !== '@countinghouse/ch-step-redact')};
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
  await until(() => s.requests.some((m) => m.type === 'reload'));
  await new Promise((r) => setTimeout(r, 300));
  const reloads = s.requests.filter((m) => m.type === 'reload');
  assert.strictEqual(reloads.length, 1, JSON.stringify(reloads.map((m) => m.names)));
  assert.deepStrictEqual(reloads[0].names.slice().sort(), ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-pack-other']);
  s.end();
  await s.done;
});

test('a new pack taking a module at a version a refused reload could not move is held back with it (2)', async () => {
  const s = await running({answer: (m) => (m.type === 'reload' ? {ok: false, code: 'CONTROL_FAILED'} : {ok: true})});
  // a release where other also takes ch-access-github, now at 0.1.1: its
  // scenario calls it (by module, the closure is what the manifest calls)
  const r2 = release({versions: {'@countinghouse/ch-access-github': '0.1.1'}, extra: {'@countinghouse/ch-pack-other': {countinghouse: {role: 'scenario', calls: ['ch-step-redact/redactService.redact', 'ch-step-other/otherService.go', 'ch-access-github/githubService.listRuns']}}}});
  r2.allow.packs.other = {...r2.allow.packs.other, packages: [...r2.allow.packs.other.packages, '@countinghouse/ch-access-github']};
  assert.strictEqual(await install({pack: 'other', from: r2.from}, s.cmd(), r2.allow), 0);
  await until(() => s.history().some((h) => h.module === '@countinghouse/ch-pack-other' && h.problem != null));
  assert.match(s.history().find((h) => h.module === '@countinghouse/ch-pack-other').problem, /takes @countinghouse\/ch-access-github 0\.1\.1, which ch-pack-ci-failure-triage keeps at 0\.1\.0 for now/);
  assert.ok(!s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'), 'never loaded beside the old version');
  s.end();
  await s.done;
});

// module-stopped (#413 section 7.3; L2a): the runtime stopped a top-level
// module for good. Out of what is loaded and of run.json's loaded, recorded
// as stopped, told once, never loaded again in this start unless its active
// version changes; a fresh start tries it again (the Reviewer on L2a).
const SCENARIO = '@countinghouse/ch-pack-ci-failure-triage';
// every apply started before it has finished, loads included (never a
// fixed delay). Applies run one at a time, and an apply sends its settings
// before its loads, so a marker's own apply may still be loading when its
// set is seen: a second marker's set comes only after the first apply has
// ended. values: the settings to keep.
let settledCount = 0;
async function settled(s, values = {}) {
  for (let i = 0; i < 2; i++) {
    // a tighter requestTimeout each time (ms in settings.json, seconds
    // sent): a tightening is applied at once, whatever the ceiling
    const secs = 28 - ((++settledCount) % 20);
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {...values, requestTimeout: secs * 1000}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'requestTimeout' && m.value === secs));
  }
}
const STOPPED = 'ch-pack-ci-failure-triage stopped (MODULE_SUSPENDED); restart your client';
test('module-stopped: dropped, recorded in run.json, told once; not loaded again until its version changes', async () => {
  const s = await running();
  try {
    s.ask({type: 'module-stopped', name: SCENARIO, code: 'MODULE_SUSPENDED', when: 'restart'});
    await until(() => notices(s).some(([, t]) => t === STOPPED));
    const run = () => JSON.parse(fs.readFileSync(path.join(s.runDir(), 'run.json'), 'utf8'));
    assert.deepStrictEqual(run().stopped, {[SCENARIO]: 'MODULE_SUSPENDED'});
    assert.deepStrictEqual(run().loaded, {});
    assert.ok(s.history().some((h) => h.module === SCENARIO && h.change === 'stopped' && h.when === 'restart'));
    // told again: said once only
    s.ask({type: 'module-stopped', name: SCENARIO, code: 'MODULE_SUSPENDED', when: 'restart'});
    // another change: not loaded again at the same version
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.ok(!s.requests.some((m) => m.type === 'load' && m.name === SCENARIO), 'not loaded again');
    assert.strictEqual(notices(s).filter(([, t]) => t === STOPPED).length, 1);
    // a new version of it: loaded again, and no longer stopped
    const r2 = release({versions: {[SCENARIO]: '0.1.1'}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'load' && m.name === SCENARIO));
    // run.json is written once the load is answered: wait on that write
    // (the stopped entry goes in an earlier one; CI's macOS and Windows
    // legs read between the two)
    await until(() => run().loaded[SCENARIO] === '0.1.1');
    assert.deepStrictEqual(run().stopped, {});
  } finally {
    s.end();
    await s.done;
  }
});

test('module-stopped at start (its plan refused): never loaded in place; a fresh start tries it again', async () => {
  const s = await running();
  s.ask({type: 'module-stopped', name: SCENARIO, code: 'TOOL_NAME_TAKEN', when: 'start'});
  await until(() => notices(s).some(([, t]) => t === 'ch-pack-ci-failure-triage stopped (TOOL_NAME_TAKEN); restart your client'));
  assert.ok(s.history().some((h) => h.module === SCENARIO && h.change === 'stopped' && h.when === 'start'));
  fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
  await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
  assert.ok(!s.requests.some((m) => m.type === 'load'), 'not loaded in place');
  s.end();
  await s.done;
  // the client restarts: a fresh start, nothing stopped, the module loaded
  const again = await running({home: s.home});
  try {
    const loads = again.args().flatMap((a, i) => (again.args()[i - 1] === '--loadModule' ? [JSON.parse(fs.readFileSync(path.join(a, 'package.json'), 'utf8')).name] : []));
    assert.deepStrictEqual(loads, [SCENARIO]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(again.runDir(), 'run.json'), 'utf8')).stopped, {});
  } finally {
    again.end();
    await again.done;
  }
});

// A record of another release (#413 section 9.8; L2a): a start running from
// the release before judges nothing by its own pins. It keeps what it
// loaded; unloads what the record withdrew or moved back, with the modules
// that call it; still unloads what is turned off or removed; loads and
// reloads nothing, and says so once.
// the home upgraded under this process: the process is made older than
// the home's ch-local (0.2.0), and the record is the new release's
const otherRelease = (opts) => { const r = release(opts); r.allow = {...r.allow, release: {version: '9.9.9', security: null}}; return r; };
const stale = (s) => { s.f.selfVersion = '0.1.9'; };
const UPGRADED = 'ch-local in this home is now 0.2.0 (upgraded); restart your client to use it';
test('another release\'s record: a module moved up is not reloaded, a new one not loaded; said once', async () => {
  const s = await running();
  try {
    stale(s);
    const r2 = otherRelease({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.f.err.includes(UPGRADED));
    assert.strictEqual(await addPack({pack: 'other', from: r2.from}, s.cmd(), r2.allow), 0);
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.deepStrictEqual(s.requests.filter((m) => ['load', 'reload', 'unload'].includes(m.type)), [], 'nothing loaded or reloaded');
    assert.strictEqual(s.f.err.split(UPGRADED).length - 1, 1, 'said once');
    assert.ok(s.history().some((h) => h.change === 'release changed' && h.notice === UPGRADED));
  } finally {
    s.end();
    await s.done;
  }
});

test('another release\'s record: a module moved back is stopped with its callers; one turned off is still unloaded', async () => {
  const s = await running();
  try {
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
    // the release just installed pins ch-access-github lower than this start loaded
    stale(s);
    const r2 = otherRelease({versions: {'@countinghouse/ch-access-github': '0.0.9'}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
    const back = 'ch-access-github was moved back to 0.0.9 by the release just installed; it is stopped here until this client restarts; ch-pack-ci-failure-triage calls it and is stopped with it';
    // the notice rides on the unload, once (the high review of L2a, 7)
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === SCENARIO && m.notice === back));
    assert.ok(!notices(s).some(([, t]) => t === back), 'not told a second time');
    // ch-pack-other does not call it: kept
    assert.ok(!s.requests.some((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other'));
    // turned off: still unloaded under the other release's record
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {'pack.other': false}}));
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other' && m.notice === 'ch-pack-other turned off'));
    assert.ok(!s.requests.some((m) => m.type === 'load' && m.name === SCENARIO), 'the older version waits for the next start');
  } finally {
    s.end();
    await s.done;
  }
});

// the medium review of L2a, 3: a module without its credential is told in
// start's words, once, by start and the applier together (L5a: the
// credential is the called module's own, in the store)
test('a pack whose module has no credential stored is told once, in start\'s words, through a later change', async () => {
  const s = await running({bound: null});
  try {
    const line = 'not loading ch-pack-ci-failure-triage: it calls ch-access-github, which needs a credential: run `ch-local credentials add ch-access-github`';
    await until(() => notices(s).some(([, t]) => t === line));
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.strictEqual(notices(s).filter(([, t]) => /^not loading ch-pack-ci-failure-triage/.test(t)).length, 1, JSON.stringify(notices(s)));
  } finally {
    s.end();
    await s.done;
  }
});

// the high review of L2a, 5, and its medium review, 7: a stop of a module
// this start never asked to run is kept at the version the record names
// then; with the record unreadable, until its content changes (an install
// after the stop), never by a timestamp's tick
test('module-stopped for a module never asked to run: kept out at the record\'s version until another is installed', async () => {
  const s = await running();
  try {
    const settings = path.join(s.home, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({version: 1, values: {'pack.other': false}}));
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    s.ask({type: 'module-stopped', name: '@countinghouse/ch-pack-other', code: 'MODULE_SUSPENDED', when: 'restart'});
    await until(() => s.history().some((h) => h.module === '@countinghouse/ch-pack-other' && h.change === 'stopped'));
    // turned on: still out at 0.3.0
    await settled(s, {locale: 'zh'});
    assert.ok(!s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'), 'kept out');
    // another version installed: loads
    const r2 = release({versions: {'@countinghouse/ch-pack-other': '0.3.1'}});
    assert.strictEqual(await install({pack: 'other', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
  } finally {
    s.end();
    await s.done;
  }
});

test('module-stopped while the record cannot be read: kept out at the last record read; a rewrite leaving it as it was keeps it out; another version loads', async () => {
  const s = await running();
  try {
    const settings = path.join(s.home, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({version: 1, values: {'pack.other': false}}));
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    // the apply after add-pack has read the record (other at 0.3.0)
    await settled(s, {'pack.other': false});
    const file = path.join(s.home, 'modules.json');
    const good = fs.readFileSync(file);
    fs.writeFileSync(file, '{');
    s.ask({type: 'module-stopped', name: '@countinghouse/ch-pack-other', code: 'MODULE_SUSPENDED', when: 'restart'});
    await until(() => s.history().some((h) => h.module === '@countinghouse/ch-pack-other' && h.change === 'stopped'));
    // a failed read, then the record rewritten as it was, other turned on:
    // still out (the high review of L2a's medium round, 7)
    fs.writeFileSync(file, good);
    await settled(s);
    assert.ok(!s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'), 'kept out');
    // another version installed: loads
    const r2 = release({versions: {'@countinghouse/ch-pack-other': '0.3.1'}});
    assert.strictEqual(await install({pack: 'other', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
  } finally {
    s.end();
    await s.done;
  }
});

// the high review of L2a, 2: under another release's record a withdrawn
// module is unloaded as any withdrawn one is: tried twice, then "restart
// now", told once
test('another release\'s record: a withdrawn module refused twice is told "restart now" once', async () => {
  const s = await running({answer: (m) => (m.type === 'unload' ? {ok: false, code: 'CONTROL_BUSY'} : {ok: true})});
  try {
    stale(s);
    editRecord(s.home, (r) => ({...r, release: {version: '9.9.9', security: null}}), {release: {packs: {}}});
    await until(() => s.requests.filter((m) => m.type === 'unload' && m.name === SCENARIO).length === 2);
    await until(() => notices(s).some(([, t]) => /could not be stopped in place: restart your client now/.test(t)));
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    await until(() => s.requests.filter((m) => m.type === 'unload' && m.name === SCENARIO).length >= 4);
    assert.strictEqual(notices(s).filter(([, t]) => /could not be stopped in place/.test(t)).length, 1);
    assert.ok(s.requests.some((m) => m.type === 'unload' && m.notice === 'module ch-pack-ci-failure-triage was withdrawn in the release just installed and is no longer served'));
  } finally {
    s.end();
    await s.done;
  }
});

// the high review of L2a, 6: a module still installed but no longer a
// pack's top-level module is never said to be removed
test('a loaded module that is no longer a pack\'s top-level module is unloaded as such, not as removed', async () => {
  const s = await running();
  try {
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
    editRecord(s.home, (r) => {
      const {other, ...packs} = r.packs;
      return {...r, packs: {...packs, 'ci-failure-triage': {...packs['ci-failure-triage'], modules: {...packs['ci-failure-triage'].modules, ...other.modules}}}};
    });
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other'));
    const un = s.requests.find((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other');
    assert.strictEqual(un.notice, 'ch-pack-other unloaded: it is no longer a pack\'s top-level module');
  } finally {
    s.end();
    await s.done;
  }
});

// the high review of L2a, 4: a module stopped after a reload it crashed on
// is recorded at what it was asked to run, so it is never loaded again at
// that version in this start (no crash loop)
test('module-stopped after a refused reload: kept out at the version it was asked to run', async () => {
  const s = await running({answer: (m) => (m.type === 'reload' ? {ok: false, code: 'CONTROL_FAILED'} : {ok: true})});
  try {
    const r2 = release({versions: {[SCENARIO]: '0.1.1'}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'reload' && m.names.includes(SCENARIO)));
    s.ask({type: 'module-stopped', name: SCENARIO, code: 'MODULE_SUSPENDED', when: 'restart'});
    await until(() => notices(s).some(([, t]) => t === STOPPED));
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await settled(s, {locale: 'zh'});
    assert.ok(!s.requests.some((m) => m.type === 'load' && m.name === SCENARIO), 'not loaded again at 0.1.1');
  } finally {
    s.end();
    await s.done;
  }
});

// the medium review of the high round, 2: a reload the channel refused
// (busy) never ran, so a later stop of the old version is recorded at the
// old closure, and the new one loads at the next apply
test('module-stopped after a reload the channel refused: recorded at what ran, and the new version loads', async () => {
  let busy = true;
  const s = await running({answer: (m) => (m.type === 'reload' && busy ? {ok: false, code: 'CONTROL_BUSY'} : {ok: true})});
  try {
    const r2 = release({versions: {[SCENARIO]: '0.1.1'}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'reload' && m.names.includes(SCENARIO)));
    busy = false;
    s.ask({type: 'module-stopped', name: SCENARIO, code: 'MODULE_SUSPENDED', when: 'restart'});
    await until(() => notices(s).some(([, t]) => t === STOPPED));
    await settled(s);
    await until(() => s.requests.some((m) => m.type === 'load' && m.name === SCENARIO && m.dirs[SCENARIO].endsWith('0.1.1')));
  } finally {
    s.end();
    await s.done;
  }
});

// the medium review of the high round, 4: under another release's record,
// a module no longer a pack's top-level module is still unloaded
test('another release\'s record: a module no longer a pack\'s top-level module is unloaded', async () => {
  const s = await running();
  try {
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
    stale(s);
    editRecord(s.home, (r) => {
      const {other, ...packs} = r.packs;
      return {...r, release: {version: '9.9.9', security: null}, packs: {...packs, 'ci-failure-triage': {...packs['ci-failure-triage'], modules: {...packs['ci-failure-triage'].modules, ...other.modules}}}};
    });
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other' && m.notice === 'ch-pack-other unloaded: it is no longer a pack\'s top-level module'));
  } finally {
    s.end();
    await s.done;
  }
});

// the medium review of the high round, 5: a caller stopped with a withdrawn
// part names the part and the release that withdrew it
test('another release\'s record: a caller of a withdrawn part refused twice names the part and the release just installed', async () => {
  const s = await running({answer: (m) => (m.type === 'unload' ? {ok: false, code: 'CONTROL_BUSY'} : {ok: true})});
  try {
    stale(s);
    editRecord(s.home, (r) => ({...r, release: {version: '9.9.9', security: null}}),
      {release: {packs: {'ci-failure-triage': {packages: [SCENARIO, '@countinghouse/ch-step-redact']}}}});
    await until(() => notices(s).some(([, t]) => /could not be stopped in place/.test(t)));
    assert.ok(notices(s).some(([, t]) => t === 'module ch-access-github was withdrawn in the release just installed, and ch-pack-ci-failure-triage, which calls it, could not be stopped in place: restart your client now to stop it'), JSON.stringify(notices(s)));
  } finally {
    s.end();
    await s.done;
  }
});

// the high review of L2a's medium round, 1: no answer (or a runtime gone)
// may follow a reload the runtime took and runs, so the new closure stands
test('module-stopped after a reload that got no answer: kept out at the new closure', async () => {
  const s = await running({answer: (m) => (m.type === 'reload' ? {ok: false, code: 'CONTROL_NO_ANSWER'} : {ok: true})});
  try {
    const r2 = release({versions: {[SCENARIO]: '0.1.1'}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'reload' && m.names.includes(SCENARIO)));
    s.ask({type: 'module-stopped', name: SCENARIO, code: 'MODULE_SUSPENDED', when: 'restart'});
    await until(() => notices(s).some(([, t]) => t === STOPPED));
    await settled(s);
    assert.ok(!s.requests.some((m) => m.type === 'load' && m.name === SCENARIO), 'not loaded again at 0.1.1');
  } finally {
    s.end();
    await s.done;
  }
});

// the high review of L2a's medium round, 4 and 5: an older record is judged
// by this ch-local's pins and "run ch-local install" is said once, never
// "rolled back" or "restart"
test('a record older than this ch-local, while running: judged by this release, "run ch-local install" said once', async () => {
  const s = await running();
  try {
    editRecord(s.home, (r) => ({...r, release: {version: '0.0.1', security: null}}));
    const line = `this home's record is not this ch-local's release; run \`ch-local install\` to bring the home to ${require('../lib/allowlist').ALLOWLIST.release.version}`;
    await until(() => notices(s).some(([, t]) => t === line));
    // not frozen: a pack added loads
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
    assert.strictEqual(notices(s).filter(([, t]) => t === line).length, 1);
    assert.ok(!/rolled back|upgraded to/.test(s.f.err), s.f.err);
  } finally {
    s.end();
    await s.done;
  }
});

// the high review of L2a's medium round, 6: under a newer record, a caller
// whose callee went for a reason no pins decide is unloaded with it
test('another release\'s record: a caller whose callee is turned off is unloaded too', async () => {
  const home = tmp('ch-home-');
  const r = release({extra: {[SCENARIO]: {countinghouse: {role: 'scenario', calls: ['ch-access-github/githubService.listRuns', 'ch-step-redact/redactService.redact', 'ch-pack-other/otherService.go']}}}});
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  assert.strictEqual(await addPack({pack: 'other', from: r.from}, cmd(), r.allow), 0);
  bindAccess(home);
  const s = await running({home});
  try {
    assert.ok(loadsPack(s), 'ci-failure-triage loads with other installed');
    stale(s);
    editRecord(home, (rec) => ({...rec, release: {version: '9.9.9', security: null}}));
    await settled(s, {'pack.other': false});
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other'));
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === SCENARIO));
  } finally {
    s.end();
    await s.done;
  }
});

// the medium review of the high round, 1: under a newer record, a caller
// whose callee is no longer installed goes with it (the callee removed)
test('another release\'s record: a caller whose callee is no longer installed is unloaded too', async () => {
  const home = tmp('ch-home-');
  const r = release({extra: {[SCENARIO]: {countinghouse: {role: 'scenario', calls: ['ch-access-github/githubService.listRuns', 'ch-step-redact/redactService.redact', 'ch-pack-other/otherService.go']}}}});
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  assert.strictEqual(await addPack({pack: 'other', from: r.from}, cmd(), r.allow), 0);
  bindAccess(home);
  const s = await running({home});
  try {
    assert.ok(loadsPack(s));
    stale(s);
    editRecord(home, (rec) => { const {other, ...packs} = rec.packs; return {...rec, release: {version: '9.9.9', security: null}, packs}; });
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other'));
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === SCENARIO));
  } finally {
    s.end();
    await s.done;
  }
});

// the medium review of the high round, 2: a module unloaded with its reason
// is never told that reason again once it is no longer loaded
test('a module unloaded for a reason is not told it again at the next apply', async () => {
  const s = await running();
  try {
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
    // its files go missing: unloaded, with the reason on the unload
    fs.rmSync(path.join(s.home, 'module-store', '@countinghouse', 'ch-pack-other', '0.3.0.json'));
    await settled(s);
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other' && /its files are missing/.test(m.notice)));
    await settled(s);
    assert.ok(!notices(s).some(([, t]) => /^not loading ch-pack-other/.test(t)), JSON.stringify(notices(s)));
  } finally {
    s.end();
    await s.done;
  }
});

// the medium review of the high round, 5: one ordering in the notices too,
// prereleases included
test('a reload to a prerelease of the version loaded says "rolled back"', async () => {
  const s = await running();
  try {
    const r2 = release({versions: {[SCENARIO]: '0.1.0-rc.1'}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'reload' && m.notice === 'ch-pack-ci-failure-triage rolled back 0.1.0 → 0.1.0-rc.1'));
  } finally {
    s.end();
    await s.done;
  }
});

// the Reviewer on L2a: a release rollback under a running process makes it
// stale; frozen, it says so once and never unloads what the rollback
// brought back as pin mismatches
test('a home rolled back under a running start: "ch-local in this home is now <v> (rolled back)", once; nothing unloaded as a pin mismatch', async () => {
  const s = await running();
  try {
    // this process is the later release; the home's ch-local is the earlier
    s.f.selfVersion = '0.2.1';
    editRecord(s.home, (r) => ({...r, release: {version: '0.0.1', security: null}}));
    const line = 'ch-local in this home is now 0.2.0 (rolled back); restart your client to use it';
    await until(() => notices(s).some(([, t]) => t === line));
    await settled(s);
    assert.strictEqual(notices(s).filter(([, t]) => t === line).length, 1);
    assert.ok(!s.requests.some((m) => m.type === 'unload'), JSON.stringify(s.requests.filter((m) => m.type === 'unload')));
    assert.ok(!notices(s).some(([, t]) => /this release pins|run `ch-local install`/.test(t)));
  } finally {
    s.end();
    await s.done;
  }
});

// the medium review of the refinement, 4 and 9: a rollback under a running
// start stops the modules it moved back, naming the rollback, not an install
test('a home rolled back under a running start: a module moved back is stopped "by the rollback just made"', async () => {
  const s = await running();
  try {
    s.f.selfVersion = '0.2.1';
    editRecord(s.home, (r) => ({...r, release: {version: '0.0.1', security: null},
      packs: {...r.packs, 'ci-failure-triage': {...r.packs['ci-failure-triage'], modules: {...r.packs['ci-failure-triage'].modules, '@countinghouse/ch-step-redact': '0.0.9'}}}}));
    const back = 'ch-step-redact was moved back to 0.0.9 by the rollback just made; it is stopped here until this client restarts; ch-pack-ci-failure-triage calls it and is stopped with it';
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === SCENARIO && m.notice === back));
  } finally {
    s.end();
    await s.done;
  }
});

// #413 section 6.4; the /code-review medium on L5a, 5: a binding removed
// while running unloads its module and its callers, told in the state's own
// words, once
test('a credential removed while running unloads the callers of its module, said as removed, once', async () => {
  const s = await running();
  try {
    await until(() => s.args() != null);
    require('../lib/credential-store').unbind(s.home, ACCESS);
    const line = 'ch-pack-ci-failure-triage unloaded: it calls ch-access-github, which has had its credential removed: add it again, or restart your client';
    await until(() => s.requests.some((m) => m.type === 'unload' && named(m) === '@countinghouse/ch-pack-ci-failure-triage' && m.notice === line));
    // a later change sends no second unload
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.strictEqual(s.requests.filter((m) => m.type === 'unload').length, 1, JSON.stringify(s.requests));
    assert.strictEqual(s.history().filter((h) => h.notice === line).length, 1);
  } finally {
    s.end();
    await s.done;
  }
});

// the Reviewer's high review of L5a, 3: a store that cannot be read for a
// moment decides nothing; only a read that succeeds and differs unloads
// (a read that fails, EACCES here; a file read and found wrong is a read,
// and decides)
test('a credential store that cannot be read keeps what is loaded, says so once, and is read again', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const s = await running();
  try {
    await until(() => s.args() != null);
    const file = path.join(s.home, 'credentials', 'credentials.json');
    fs.chmodSync(file, 0o000);
    await until(() => /the stored credentials could not be read/.test(s.f.err));
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.ok(!s.requests.some((m) => m.type === 'unload'), JSON.stringify(s.requests));
    fs.chmodSync(file, 0o600);
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!s.requests.some((m) => m.type === 'unload'), 'the good read matches: nothing unloaded');
    assert.strictEqual(s.f.err.split('the stored credentials could not be read').length - 1, 1, s.f.err);
  } finally {
    s.end();
    await s.done;
  }
});

// the Fable pass on L5a, F3: a binding present at start that got no slot
// (gh gave nothing) keeps start's reason; it is never told "restart your
// client" as if it were added since
test('a gh binding gh gave no token for at start is not told to restart on a later change; it says how to provide it', async () => {
  const s = await running({bound: 'gh'});
  try {
    await until(() => notices(s).some(([, t]) => /has no token from your gh login/.test(t)));
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!notices(s).some(([, t]) => /was not started with/.test(t)), JSON.stringify(notices(s)));
    assert.ok(!/was not started with/.test(s.f.err), s.f.err);
  } finally {
    s.end();
    await s.done;
  }
});

// the Fable pass on L5a, F4: a credential unload the runtime refuses is
// retried, then the sessions are told to restart now; never silent
test('a credential unload the runtime refuses is retried, then told: restart your client now', async () => {
  const s = await running({answer: (m) => (m.type === 'unload' ? {ok: false, code: 'BUSY'} : {ok: true})});
  try {
    await until(() => s.args() != null);
    require('../lib/credential-store').unbind(s.home, ACCESS);
    await until(() => s.requests.filter((m) => m.type === 'unload').length >= 2);
    await until(() => notices(s).some(([, t]) => /could not be stopped in place after a credential was removed or changed: restart your client now to stop it/.test(t)));
  } finally {
    s.end();
    await s.done;
  }
});

// A home with both packs installed, ch-step-other (in other's closure)
// declaring a credential of its own, and both modules' keys stored.
const OTHER_STEP = '@countinghouse/ch-step-other';
const OTHER_ORIGIN = 'https://api.other.example';
async function twoCredentialed({otherOff = false} = {}) {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  assert.strictEqual(await addPack({pack: 'other', from: r.from}, cmd(), r.allow), 0);
  const where = require('../lib/home').layout({COUNTINGHOUSE_HOME: home}, () => '/nowhere');
  const record = require('../lib/module-record').readModulesRecord(where);
  const manifestOf = (m) => path.join(require('../lib/store-paths').versionDir(where, m, record.modules[m].version), 'package.json');
  const edit = (m, fn) => { const f = manifestOf(m); const p = JSON.parse(fs.readFileSync(f, 'utf8')); fn(p); fs.writeFileSync(f, JSON.stringify(p)); };
  edit(OTHER_STEP, (p) => { p.countinghouse.remotes = [{name: 'o', url: `${OTHER_ORIGIN}/mcp/`, credential: 'OTHER_TOKEN'}]; });
  bindAccess(home);
  require('../lib/credential-store').bind(home, OTHER_STEP, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value: 'test-stored-value-2'});
  if (otherOff) fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {'pack.other': false}}));
  return {home, r, edit};
}

// the Reviewer's high review of L5a's round 2: while the store cannot be
// read, a module whose declaration is unchanged keeps its key; one whose
// declaration changed meanwhile is not usable (the medium on the high
// round, 2)
test('an unreadable store: an unchanged declaration keeps its key, a changed one is unloaded with its callers', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const t = await twoCredentialed();
  const s = await running({home: t.home});
  try {
    await until(() => s.args() != null);
    assert.ok(s.args().filter((a) => a === '--loadModule').length === 2, s.args().join(' '));
    fs.chmodSync(path.join(t.home, 'credentials', 'credentials.json'), 0o000);
    // ch-access-github now names another variable: its last good state no
    // longer stands; ch-step-other's declaration is untouched
    t.edit(ACCESS, (p) => { p.countinghouse.remotes[0].credential = {env: 'RENAMED_TOKEN', header: 'Authorization', scheme: 'Bearer'}; });
    fs.writeFileSync(path.join(t.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'unload' && named(m) === SCENARIO));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.ok(!s.requests.some((m) => m.type === 'unload' && named(m) === '@countinghouse/ch-pack-other'), JSON.stringify(s.requests));
    const why = s.requests.find((m) => m.type === 'unload' && named(m) === SCENARIO).notice;
    assert.match(why, /the stored credentials are not used \(.*could not be read/);
  } finally {
    fs.chmodSync(path.join(t.home, 'credentials', 'credentials.json'), 0o600);
    s.end();
    await s.done;
  }
});

// the medium on the high round, 5: a module loaded after start gets its
// "sends" line when its key first goes, once
test('a module turned on while running says where its key goes, once, when it loads', async () => {
  const t = await twoCredentialed({otherOff: true});
  const s = await running({home: t.home});
  try {
    await until(() => s.args() != null);
    const line = 'sends OTHER_TOKEN to https://api.other.example for ch-step-other';
    assert.ok(!s.f.err.includes(line), 'not said at start: it does not load');
    assert.match(s.f.err, /sends COUNTINGHOUSE_GITHUB_TOKEN to https:\/\/api\.githubcopilot\.com for ch-access-github/);
    fs.writeFileSync(path.join(t.home, 'settings.json'), JSON.stringify({version: 1, values: {'pack.other': true}}));
    await until(() => s.requests.some((m) => m.type === 'load' && named(m) === '@countinghouse/ch-pack-other'));
    const load = s.requests.find((m) => m.type === 'load' && named(m) === '@countinghouse/ch-pack-other');
    assert.deepStrictEqual(load.credentials, {[OTHER_STEP]: {[OTHER_ORIGIN]: {OTHER_TOKEN: 'COUNTINGHOUSE_CREDENTIAL_2'}}});
    await until(() => s.f.err.includes(line));
    // a later change says it no more
    fs.writeFileSync(path.join(t.home, 'settings.json'), JSON.stringify({version: 1, values: {'pack.other': true, locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.strictEqual(s.f.err.split(line).length - 1, 1, s.f.err);
  } finally {
    s.end();
    await s.done;
  }
});
