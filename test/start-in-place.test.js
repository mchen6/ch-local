'use strict';
require('./tmp-dirs');
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
const {chLocal} = require('../lib/command-line');
const {layout} = require('../lib/home');
// a command as the home names it once an install wrote its launcher
// (lib/command-line.js); cmd: the same, as a regular expression's source
const said = (home, args) => chLocal(layout({COUNTINGHOUSE_HOME: home}), args);
const cmd = (home, args) => said(home, args).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// what a control request names: a load's or unload's name, a reload's names
// (the module form, #413 section 7.3)
const named = (m) => (m.name != null ? m.name : (Array.isArray(m.names) ? m.names.join(',') : undefined));
const editRecord = (...a) => require('./store-helpers').editHome(...a);
const ACCESS = '@countinghouse/ch-access-github';
const GH_ORIGIN = 'https://api.githubcopilot.com';
// a test home's stored value (no real token's shape)
const STORED = 'test-stored-value-1';
const bindAccess = (home, source = 'stored') => require('../lib/credential-store').bind(home, ACCESS, 'GITHUB_TOKEN',
  source === 'gh' ? {origin: GH_ORIGIN, source: 'gh'} : {origin: GH_ORIGIN, source: 'stored', value: STORED}, {held: require('./store-helpers').FIXTURE_HELD});
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
async function running({answer = () => ({ok: true}), timeoutMs, passThrough = [], duringSpawn = null, beforeStart = null, shared = false, ghToken = null, home: reuse = null, deep = false,
  env = {}, bound = 'stored', clientAncestry = Promise.resolve({lines: null, policyPresent: false}), release: running_release = null, heldRetryMs = null} = {}) {
  // (deep: a home whose launcher path is as long as a user's, or longer:
  // the notices' 200 characters are measured with it -- #147's M3)
  const home = reuse != null ? reuse : deep ? (() => { const d = path.join(tmp('ch-home-'), 'alexandra'); fs.mkdirSync(d, {mode: 0o700}); return path.join(d, '.countinghouse'); })() : tmp('ch-home-');
  const r = reuse != null ? null : release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  if (reuse == null) assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  if (reuse == null && bound != null) bindAccess(home, bound);
  if (beforeStart != null) beforeStart(home);
  const f = fakeIo({env: {COUNTINGHOUSE_HOME: home, ...env}, homedir: '/nowhere'});
  Object.assign(f, {pid: 4242, hostname: 'box-1', cwd: home, alive: () => true, trapSignals: () => () => {}, exit: () => {}, controlTimeoutMs: timeoutMs, clientAncestry});
  // the running ch-local is the one the home holds (the npm stub's 0.2.0); a
  // test makes this process stale by giving it another (lib/packs.js
  // recordRelease)
  f.selfVersion = '0.2.0';
  if (heldRetryMs != null) f.heldRetryMs = heldRetryMs;
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
  // 7.2): the module store and the user's own modules' copies (B-own-add),
  // never the app, which holds the runtime
  const roots = s.args().flatMap((a, i) => (s.args()[i - 1] === '--modulesRoot' ? [a] : []));
  assert.deepStrictEqual(roots, [path.join(s.home, 'module-store'), path.join(s.home, 'own')]);
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
    assert.match(why, new RegExp(`it calls ch-access-github, which needs a credential: run \`${cmd(s.home, 'credentials add ch-access-github')}\``));
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
  // (nothing loaded; the held-back list re-read, now naming the pack as
  // missing: A-firstrun d1; the reread follows the history line, so it is
  // waited for)
  await until(() => s.requests.some((m) => m.type === 'reread' && m.what === 'held-back'));
  assert.deepStrictEqual(s.requests.filter((m) => m.type !== 'set' && m.type !== 'notice').map((m) => m.type + (m.what ? ` ${m.what}` : '')), ['reread held-back'], 'nothing loaded: the sessions are told why');
  const held = JSON.parse(fs.readFileSync(s.args()[s.args().indexOf('--heldBackFile') + 1], 'utf8')).modules;
  assert.ok(held.some((e) => e.name === '@countinghouse/ch-pack-other' && e.reason === 'missing'), JSON.stringify(held));
  assert.match(s.history().find((h) => h.problem != null).problem, new RegExp(`its files are missing; run \`${cmd(s.home, 'install')}\` again`));
  assert.match(s.f.err, new RegExp(`not loading ch-pack-other: its files are missing; run \`${cmd(s.home, 'install')}\` again`));
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

// A5 (the final pass): in shared mode a client's restart only attaches to
// the same runtime again, so what "applies at the next start" says the way
// that restarts it: `ch-local restart`, the sessions resuming
test('A5: in shared mode, what applies at the next start names `ch-local restart`, never a client\'s restart', async () => {
  const {setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = await running({shared: true});
  try {
    const where = layout({COUNTINGHOUSE_HOME: s.home});
    setSetting(where, 'autoUpgrade', 'on', {by: 'cli', mayLoosen: true});
    await until(() => notices(s).some(([, t]) => /autoUpgrade loosened/.test(t)));
    const line = notices(s).find(([, t]) => /autoUpgrade loosened/.test(t))[1];
    // (a loosening hands the model no command: applying it stays the
    // user's own act -- the reviewer's high on #147, M5)
    assert.strictEqual(line, 'autoUpgrade loosened from off to on, when the shared runtime restarts');
  } finally {
    s.end();
    await s.done;
  }
});

// (and a line the user must act on goes out as a notice in shared mode,
// whose stderr is the daemon's: the reviewer's high on #147, L2, L5)
test('A5: in shared mode a setting the runtime could not take in place is told, naming `ch-local restart`', async () => {
  const {setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = await running({shared: true, deep: true, answer: (m) => (m.type === 'set' ? {ok: false, code: 'NOT_NOW'} : {ok: true})});
  try {
    setSetting(layout({COUNTINGHOUSE_HOME: s.home}), 'requestTimeout', '10s', {by: 'cli'});
    await until(() => notices(s).some(([, t]) => /requestTimeout set to/.test(t)));
    const line = notices(s).find(([, t]) => /requestTimeout set to/.test(t))[1];
    assert.match(line, /^requestTimeout set to 10s: applies when the shared runtime restarts \(`[^`]+ restart`\) \(NOT_NOW\)$/);
    assert.ok(require('./notice-length').atRealisticHome(line) <= 200, line);
  } finally {
    s.end();
    await s.done;
  }
});

// business's condition on #147: a loosening is never told with the restart
// that applies it. A setting loosened is line 14 (no command); a change not
// applied in place -- which may carry one, a pack turned on -- names no
// command in shared mode either
test('A5: in shared mode no loosening is told with a restart command: a setting loosened, a sandbox loosened, a pack added and refused', async () => {
  const {setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = await running({shared: true, deep: true, answer: (m) => (m.name === '@countinghouse/ch-pack-other' || m.type === 'set' ? {ok: false, code: 'NOT_NOW'} : {ok: true})});
  try {
    const where = layout({COUNTINGHOUSE_HOME: s.home});
    setSetting(where, 'maxOutputBytes', '32MiB', {by: 'cli', mayLoosen: true});
    setSetting(where, 'moduleSandbox', 'audit', {by: 'cli', mayLoosen: true});
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    await until(() => notices(s).some(([, t]) => /maxOutputBytes loosened/.test(t)) && notices(s).some(([, t]) => /moduleSandbox loosened/.test(t)) && notices(s).some(([, t]) => /ch-pack-other added/.test(t)));
    const told = notices(s).map(([, t]) => t);
    assert.ok(told.some((t) => /^maxOutputBytes loosened from 16MiB to 32MiB, when the shared runtime restarts \(NOT_NOW\)$/.test(t)), told.join(' | '));
    assert.ok(told.some((t) => /^moduleSandbox loosened from enforce to audit, when the shared runtime restarts$/.test(t)), told.join(' | '));
    assert.ok(told.some((t) => /^ch-pack-other added 0\.3\.0: not applied in place \(NOT_NOW\); it applies when the shared runtime restarts$/.test(t)), told.join(' | '));
    for (const t of told.filter((x) => /loosened|added/.test(x))) assert.doesNotMatch(t, / restart`/, t);
    // (every notice within the runtime's 200, with a launcher path as long as a user's)
    assert.ok(require('../lib/command-line').chLocal(require('../lib/home').layout({COUNTINGHOUSE_HOME: s.home}), 'restart').length >= 'node "/home/alexandra/.countinghouse/bin/ch-local.js" restart'.length);
    for (const t of told) assert.ok(require('./notice-length').atRealisticHome(t) <= 200, `${t.length}: ${t}`);
  } finally {
    s.end();
    await s.done;
  }
});

// N3 (#147): in shared mode a setting applied in place is said, never told
// to every session; only what needs action is a notice
test('A5: in shared mode an applied tightening is said, not told', async () => {
  const {setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = await running({shared: true});
  try {
    setSetting(layout({COUNTINGHOUSE_HOME: s.home}), 'maxOutputBytes', '8MiB', {by: 'cli'});
    await until(() => /maxOutputBytes set to 8MiB/.test(s.f.err));
    assert.ok(!notices(s).some(([, t]) => /maxOutputBytes/.test(t)), 'not a notice');
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

// Start loads ci-failure-triage; `other` is added while running and turned
// off, so it is installed and off.
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
// vectors, moduleMessages, copied): what the runtime refuses, by reason
// token. Every message is in the module form (#413 section 7.3), which
// carries none of the pack form's fields; packMessages went with M6 (#455).
// A set has no vector of its own: its one rule here is that a pack.*
// setting is never sent (M5a, #438).
const setProblem = (m) => ((typeof m.name === 'string' && m.name.startsWith('pack.')) ? 'set' : null);
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
  } else if (m.type === 'notice') {
    // (notice: module a package name or null, and text; no pack-form field)
    if (OLD_FIELDS.some((f) => f in m)) return 'old-field';
    return (m.module === null || pkg(m.module)) && typeof m.text === 'string' ? null : 'name';
  } else if (m.type === 'reread') {
    // (the vectors' rule: reread's what is one an accepted vector has --
    // module-settings, and held-back since countinghouse #490 -- and nothing
    // else is in it)
    const whats = new Set(MODULE_V.accepted.filter((e) => e.message.type === 'reread').map((e) => e.message.what));
    return whats.has(m.what) && Object.keys(m).every((k) => ['id', 'type', 'what'].includes(k)) ? null : 'name';
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
// (an unload has exactly the keys of an accepted unload vector: id 5, 9
// "off" or 10 "calls" with because; A-reason)
const keysOf = (m) => Object.keys(m).filter((k) => k !== 'id').sort().join(',');
// what ch-local sends the runtime: the module form's own types; set (a
// setting the runtime takes at once); and the session layer's own, each
// with rules of its own (restore: the restoreRows vectors; drain and
// idle-stop: the daemon's)
const SENT_TYPES = new Set([...new Set(MODULE_V.accepted.map((e) => e.message.type))].filter((t) => t !== 'module-stopped').concat('set', 'restore', 'drain', 'idle-stop'));
const UNLOAD_SHAPES = new Set(MODULE_V.accepted.filter((e) => e.message.type === 'unload').map((e) => keysOf(e.message)));
const holdsToTheVectors = (requests) => {
  for (const m of requests) {
    // (an answer to the runtime's own ask carries no type: not a message
    // ch-local sends of itself)
    if (m.type === undefined && typeof m.id === 'string' && typeof m.ok === 'boolean') continue;
    // (a type the vectors don't define is never sent: the medium on L6, 4)
    assert.ok(SENT_TYPES.has(m.type), `a message of a type the vectors define: ${JSON.stringify(m)}`);
    if (m.type === 'set') assert.strictEqual(setProblem(m), null, JSON.stringify(m));
    else assert.strictEqual(moduleMessageProblem(m), null, JSON.stringify(m));
    if (m.type === 'unload') {
      assert.ok(UNLOAD_SHAPES.has(keysOf(m)), `an unload shaped as a vector: ${JSON.stringify(m)}`);
      if ('reason' in m) assert.ok(m.reason === 'off' || (m.reason === 'calls' && typeof m.because === 'string'), JSON.stringify(m));
    }
  }
};

test('the module messages\' vectors: each accepted load, reload, unload, notice and reread passes, each refused one fails for its reason', () => {
  const kinds = new Set(['load', 'reload', 'unload', 'notice', 'reread']);
  for (const {why, message} of MODULE_V.accepted.filter((e) => kinds.has(e.message.type))) {
    // an absolute directory as the platform reads one (the vectors' are POSIX)
    const m = message.dirs != null ? {...message, dirs: Object.fromEntries(Object.entries(message.dirs).map(([n, d]) => [n, path.resolve(d)]))} : message;
    assert.strictEqual(moduleMessageProblem(m), null, why);
  }
  for (const {why, reason, message} of MODULE_V.refused.filter((e) => kinds.has(e.message.type))) assert.strictEqual(moduleMessageProblem(message), reason, why);
});

// (M6, #455: the pack form is gone; a notice carrying one of its fields is
// refused, id 20; a set of pack.* is never sent)
test('M6: no message carries the pack form: a notice with a pack field is refused, and a set of pack.* is never sent', () => {
  const twenty = MODULE_V.refused.find((e) => e.message.id === 20);
  assert.ok(twenty != null && twenty.message.type === 'notice' && 'pack' in twenty.message, 'the vectors pin it');
  assert.strictEqual(moduleMessageProblem(twenty.message), 'old-field');
  assert.strictEqual(setProblem({type: 'set', name: 'pack.other', value: false}), 'set');
  assert.strictEqual(setProblem({type: 'set', name: 'requestTimeout', value: 61}), null);
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
    // goes; no separate notice tagged with the pack follows it. The wording
    // is a contract: countinghouse's module-control (#449, M5b, storedOff)
    // builds the all-sessions off notice from an unload with reason "off"
    // while the settings have the module off, and tells this notice as given
    // anywhere else (a runtime not serving the settings tool); kept exactly
    // "<short name> turned off"
    assert.strictEqual(unload.notice, 'ch-pack-other turned off');
    // (A-reason: the runtime tells every session its own off text: #449 id 9)
    assert.strictEqual(unload.reason, 'off');
    assert.ok(!('because' in unload));
    assert.ok(!s.requests.some((m) => m.type === 'notice' && m.pack === 'other' && /turned off|removed/.test(m.text)), JSON.stringify(s.requests.filter((m) => m.type === 'notice')));
    holdsToTheVectors(s.requests);
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
const LINE = (home) => `module ch-pack-ci-failure-triage was withdrawn in this release and was not started; \`${said(home, 'remove-pack ci-failure-triage')}\` removes it`;
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
    assert.deepStrictEqual(notices(s).filter(([, t]) => /withdrawn/.test(t)), [[null, LINE(s.home)]], 'once, to the client');
    assert.strictEqual(s.f.err.split('\n').filter((l) => l.includes(LINE(s.home))).length, 1, s.f.err);
    assert.ok(!/\/|\\\\/.test(LINE(s.home).replace(/`[^`]*`/g, '')), 'no path in the notice');
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
    assert.ok(notices(s).some(([, t]) => t === LINE(s.home)));
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
    const now = `module ch-pack-ci-failure-triage was withdrawn in this release and is no longer served; \`${said(s.home, 'remove-pack ci-failure-triage')}\` removes it`;
    await until(() => s.requests.some((m) => (m.type === 'unload' && m.notice === now) || (m.type === 'notice' && m.text === now)));
  } finally {
    s.end();
    await s.done;
  }
});

test('a withdrawn pack whose unload is refused is tried once more, then the client is told to restart', async () => {
  const s = await running({answer: (m) => (m.type === 'unload' ? {ok: false, code: 'CONTROL_FAILED'} : {ok: true})});
  try {
    withdrawHeld(s.home, 'ci-failure-triage');
    const isUnload = (m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-ci-failure-triage';
    const isStuck = (m) => m.type === 'notice' && /could not be stopped in place: restart your client now/.test(m.text);
    await until(() => s.requests.some(isStuck));
    // (counted in the one ordered log, up to the restart notice: tried twice,
    // then told. A later pass may try again, as it should, without telling
    // again: never counted on a clock, which a slower runner outran, main's
    // Windows push run 44950229590)
    const told = s.requests.findIndex(isStuck);
    assert.strictEqual(s.requests.slice(0, told).filter(isUnload).length, 2, 'tried twice before the restart notice');
    assert.strictEqual(s.requests.filter(isStuck).length, 1, 'told once');
  } finally {
    s.end();
    await s.done;
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
  r2.allow.packs.other = {...r2.allow.packs.other, modules: r2.allow.packs.other.modules.filter((n) => n !== '@countinghouse/ch-step-redact')};
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
  r2.allow.packs.other = {...r2.allow.packs.other, modules: [...r2.allow.packs.other.modules, '@countinghouse/ch-access-github']};
  assert.strictEqual(await install({pack: 'other', from: r2.from}, s.cmd(), r2.allow), 0);
  await until(() => s.history().some((h) => h.module === '@countinghouse/ch-pack-other' && h.problem != null));
  assert.match(s.history().find((h) => h.module === '@countinghouse/ch-pack-other').problem, /takes @countinghouse\/ch-access-github 0\.1\.1, which ch-pack-ci-failure-triage keeps at 0\.1\.0 for now/);
  assert.ok(!s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'), 'never loaded beside the old version');
  // (named restart while it waits: the reviewer's high on #106, 4)
  const file = s.args()[s.args().indexOf('--heldBackFile') + 1];
  await until(() => JSON.parse(fs.readFileSync(file, 'utf8')).modules.some((e) => e.name === '@countinghouse/ch-pack-other'));
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).modules.some((e) => e.name === '@countinghouse/ch-pack-other' && e.reason === 'restart'));
  // (said once per change: turned off and on again, the same clash is said
  // again: the medium on #106's round 1, 3)
  const clashes = () => s.history().filter((h) => h.module === '@countinghouse/ch-pack-other' && h.problem != null && /keeps at/.test(h.problem)).length;
  assert.strictEqual(clashes(), 1);
  fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {'pack.other': false}}));
  await until(() => JSON.parse(fs.readFileSync(file, 'utf8')).modules.some((e) => e.name === '@countinghouse/ch-pack-other' && e.reason === 'off'));
  fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {'pack.other': true}}));
  await until(() => clashes() === 2);
  s.end();
  await s.done;
});

// the medium on #147's last round, 1 and 3: in shared mode a clash names no
// command (a pack turned on may be a loosening), and one that clears and
// comes back is told again
test('A5: in shared mode a clash is told with no command, and told again when it comes back', async () => {
  const s = await running({shared: true, deep: true, answer: (m) => (m.type === 'reload' ? {ok: false, code: 'CONTROL_FAILED'} : {ok: true})});
  try {
    const r2 = release({versions: {'@countinghouse/ch-access-github': '0.1.1'}, extra: {'@countinghouse/ch-pack-other': {countinghouse: {role: 'scenario', calls: ['ch-step-redact/redactService.redact', 'ch-step-other/otherService.go', 'ch-access-github/githubService.listRuns']}}}});
    r2.allow.packs.other = {...r2.allow.packs.other, modules: [...r2.allow.packs.other.modules, '@countinghouse/ch-access-github']};
    assert.strictEqual(await install({pack: 'other', from: r2.from}, s.cmd(), r2.allow), 0);
    const clash = () => notices(s).map(([, t]) => t).filter((t) => /^ch-pack-other not loaded in place: /.test(t));
    await until(() => clash().length === 1);
    assert.match(clash()[0], /^ch-pack-other not loaded in place: @countinghouse\/ch-access-github 0\.1\.1 is kept at 0\.1\.0 by ch-pack-ci-failure-triage; it applies when the shared runtime restarts$/);
    assert.doesNotMatch(clash()[0], /`/);
    const file = s.args()[s.args().indexOf('--heldBackFile') + 1];
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {'pack.other': false}}));
    await until(() => JSON.parse(fs.readFileSync(file, 'utf8')).modules.some((e) => e.name === '@countinghouse/ch-pack-other' && e.reason === 'off'));
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {'pack.other': true}}));
    await until(() => clash().length === 2);
  } finally {
    s.end();
    await s.done;
  }
});

// the medium on #147's last round, 2: a moved-back unload refused in shared
// mode at a deep home never cuts a command in half
test('A5: in shared mode a refused moved-back unload is told whole, its command never cut', async () => {
  // (a short code: the failure line's tail is shorter than the command's,
  // where a second cut of a notice that ends in a command split it)
  const s = await running({shared: true, deep: true, answer: (m) => (m.type === 'unload' ? {ok: false, code: 'NO'} : {ok: true})});
  try {
    s.f.selfVersion = '0.2.1';
    editRecord(s.home, (r) => ({...r, release: {version: '0.0.1', security: null},
      packs: {...r.packs, 'ci-failure-triage': {...r.packs['ci-failure-triage'], modules: {...r.packs['ci-failure-triage'].modules, '@countinghouse/ch-step-redact': '0.0.9'}}}}));
    await until(() => notices(s).some(([, t]) => /was moved back to 0\.0\.9 .*not applied in place \(NO\)/.test(t)));
    for (const [, t] of notices(s)) {
      assert.ok(require('./notice-length').atRealisticHome(t) <= 200, `${[...t].length}: ${t}`);
      assert.strictEqual((t.match(/`/g) || []).length % 2, 0, `a command cut: ${t}`);
      if (/not applied in place/.test(t)) assert.doesNotMatch(t, /stopped until|\?node/, `a command cut: ${t}`);
    }
    // (the failure line is built on the explanation alone, never on the
    // notice that already ends in a command)
    assert.ok(notices(s).some(([, t]) => /^ch-step-redact was moved back to 0\.0\.9 by the rollback just made; [^`]*: not applied in place \(NO\); it applies when the shared runtime restarts$/.test(t)), JSON.stringify(notices(s)));
    // (found by its command: at a home so long the command leaves no room,
    // the command goes alone)
    const sent = s.requests.find((m) => m.type === 'unload' && /stopped until `/.test(m.notice || ''));
    assert.match(sent.notice, /(?:^|; )stopped until `[^`]+ restart` is run$/, 'the unload\'s own notice keeps its command whole');
  } finally {
    s.end();
    await s.done;
  }
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
const {restartEither: either} = require('../lib/command-line');
const eitherIn = (h) => either(require('../lib/home').layout({COUNTINGHOUSE_HOME: h}));
// (a running runtime takes it at a restart: the client's, or the shared one's: A5)
const UPGRADED = () => 'ch-local in this home is now 0.2.0 (upgraded); restart your client to use it';
test('another release\'s record: a module moved up is not reloaded, a new one not loaded; said once', async () => {
  const s = await running();
  try {
    stale(s);
    const r2 = otherRelease({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.f.err.includes(UPGRADED(s.home)));
    assert.strictEqual(await addPack({pack: 'other', from: r2.from}, s.cmd(), r2.allow), 0);
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.deepStrictEqual(s.requests.filter((m) => ['load', 'reload', 'unload'].includes(m.type)), [], 'nothing loaded or reloaded');
    assert.strictEqual(s.f.err.split(UPGRADED(s.home)).length - 1, 1, 'said once');
    assert.ok(s.history().some((h) => h.change === 'release changed' && h.notice === UPGRADED(s.home)));
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

// the reviewer's high on #106, 4: under another release's record, a pack
// turned off is still unloaded, and the held-back file says so (it followed
// the unloads only outside a frozen home before)
test('another release\'s record: a pack turned off is unloaded, and the held-back file names it', async () => {
  const s = await running();
  try {
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
    stale(s);
    const r2 = otherRelease({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.f.err.includes(UPGRADED(s.home)));
    const file = s.args()[s.args().indexOf('--heldBackFile') + 1];
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {'pack.other': false}}));
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other'));
    await until(() => s.requests.some((m) => m.type === 'reread' && m.what === 'held-back'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).modules, [{name: '@countinghouse/ch-pack-other', reason: 'off'}]);
  } finally {
    s.end();
    await s.done;
  }
});

// the reviewer's high on #106, 4: the file follows what ended up loaded. A
// module the runtime stopped is named stopped until another version loads;
// a pack wanted but not loaded in place (here: added under another
// release's record) is named restart
test('the held-back file names a stopped module stopped, until a new version loads', async () => {
  const s = await running();
  try {
    await until(() => s.args() != null);
    const file = s.args()[s.args().indexOf('--heldBackFile') + 1];
    const held = () => JSON.parse(fs.readFileSync(file, 'utf8')).modules;
    s.ask({type: 'module-stopped', name: SCENARIO, code: 'MODULE_SUSPENDED', when: 'restart'});
    await until(() => s.requests.some((m) => m.type === 'reread' && m.what === 'held-back'));
    assert.deepStrictEqual(held(), [{name: SCENARIO, reason: 'stopped'}]);
    const r2 = release({versions: {[SCENARIO]: '0.1.1'}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.requests.filter((m) => m.type === 'reread' && m.what === 'held-back').length === 2);
    assert.deepStrictEqual(held(), []);
  } finally {
    s.end();
    await s.done;
  }
});

test('another release\'s record: a pack added is not loaded in place, and the held-back file names it restart', async () => {
  const s = await running();
  try {
    stale(s);
    const r2 = otherRelease({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.f.err.includes(UPGRADED(s.home)));
    assert.strictEqual(await addPack({pack: 'other', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'reread' && m.what === 'held-back'));
    const file = s.args()[s.args().indexOf('--heldBackFile') + 1];
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).modules, [{name: '@countinghouse/ch-pack-other', reason: 'restart'}]);
    assert.ok(!s.requests.some((m) => m.type === 'load'), 'nothing loaded');
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
    const line = `not loading ch-pack-ci-failure-triage: it calls ch-access-github, which needs a credential: run \`${said(s.home, 'credentials add ch-access-github')}\``;
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
    const line = `this home's record is not this ch-local's release; run \`${said(s.home, 'install --pack ci-failure-triage')}\` to bring the home to ${require('../lib/allowlist').ALLOWLIST.release.version}`;
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
  // a call into a pack not installed is refused, naming what to install
  // first (the Reviewer's ruling on L5b: release 1 needs the callee's pack
  // installed; the description check reads no tarball it does not place)
  const refused = cmd();
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, refused, r.allow), 1);
  assert.match(refused.err, /@countinghouse\/ch-pack-ci-failure-triage calls @countinghouse\/ch-pack-other, from pack other, which isn't installed; install other first; nothing was installed/);
  assert.ok(!/does not match/.test(refused.err), refused.err);
  // (other first: the scenario calls ch-pack-other)
  assert.strictEqual(await install({pack: 'other', from: r.from}, cmd(), r.allow), 0);
  assert.strictEqual(await addPack({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
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
  // (other first: the scenario calls ch-pack-other)
  assert.strictEqual(await install({pack: 'other', from: r.from}, cmd(), r.allow), 0);
  assert.strictEqual(await addPack({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
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
    assert.ok(!notices(s).some(([, t]) => new RegExp(`this release pins|run \`${cmd(s.home, 'install')}\``).test(t)));
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
    require('../lib/credential-store').unbind(s.home, ACCESS, {held: require('./store-helpers').FIXTURE_HELD});
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

// A-firstrun d1 (countinghouse #490): what is held back changes while
// running; the file is rewritten and the runtime asked to read it again,
// once per change, so its overview says what start would now
test('a credential removed while running: the held-back file names the pack and why, and the runtime is asked to read it again, once', async () => {
  const s = await running();
  try {
    await until(() => s.args() != null);
    const file = s.args()[s.args().indexOf('--heldBackFile') + 1];
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).modules, [], 'everything loaded at start');
    require('../lib/credential-store').unbind(s.home, ACCESS, {held: require('./store-helpers').FIXTURE_HELD});
    await until(() => s.requests.some((m) => m.type === 'reread' && m.what === 'held-back'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).modules,
      [{name: '@countinghouse/ch-pack-ci-failure-triage', reason: 'calls', root: 'credential', via: '@countinghouse/ch-access-github'}]);
    // a later change that holds back nothing new sends no second reread
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.strictEqual(s.requests.filter((m) => m.type === 'reread' && m.what === 'held-back').length, 1, JSON.stringify(s.requests));
  } finally {
    s.end();
    await s.done;
  }
});

// the reviewer's high on #106, 1: an applier ends with its start. A held-back
// reread that keeps failing leaves a retry armed; after start ends nothing
// is applied again (no request, no history line, nothing said)
test('the applier ends with start: a pending held-back retry never runs after it', async () => {
  const busy = (m) => (m.type === 'reread' && m.what === 'held-back' ? {ok: false, code: 'CONTROL_BUSY'} : {ok: true});
  const s = await running({answer: busy});
  await until(() => s.args() != null);
  require('../lib/credential-store').unbind(s.home, ACCESS, {held: require('./store-helpers').FIXTURE_HELD});
  await until(() => s.requests.some((m) => m.type === 'reread' && m.what === 'held-back'));
  s.end();
  await s.done;
  const [requests, history, said] = [s.requests.length, s.history().length, s.f.err.length];
  // (a stop the runtime reports as it ends is not recorded or said either:
  // the medium on round 1, 2)
  s.ask({type: 'module-stopped', name: SCENARIO, code: 'MODULE_SUSPENDED', when: 'restart'});
  await new Promise((r) => setTimeout(r, 1500));
  assert.deepStrictEqual([s.requests.length, s.history().length, s.f.err.length], [requests, history, said], 'nothing after start ended');
});

// the medium on #106's round 1, 1: CONTROL_FAILED is any failed read (a
// passing one on Windows too), so it is tried again
test('a held-back list whose read failed is sent again, and taken', async () => {
  let failed = 0;
  const once = (m) => (m.type === 'reread' && m.what === 'held-back' && failed++ === 0 ? {ok: false, code: 'CONTROL_FAILED'} : {ok: true});
  const s = await running({answer: once});
  try {
    await until(() => s.args() != null);
    require('../lib/credential-store').unbind(s.home, ACCESS, {held: require('./store-helpers').FIXTURE_HELD});
    await until(() => s.requests.filter((m) => m.type === 'reread' && m.what === 'held-back').length === 2);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(s.requests.filter((m) => m.type === 'reread' && m.what === 'held-back').length, 2, 'taken the second time: no third');
  } finally {
    s.end();
    await s.done;
  }
});

// the reviewer's round 2 on #106, 1 and 2: a retry sends only the reread
// (never a whole apply, which would send a refused load again and say it
// again), and a reread that keeps failing is given up after 5 tries, said
// once, until what is held back changes
test('a failing held-back reread is retried alone, 5 times at most, then given up until the list changes', async () => {
  const s = await running({heldRetryMs: 20, answer: (m) => (m.type === 'reread' && m.what === 'held-back' ? {ok: false, code: 'CONTROL_FAILED'} : m.type === 'load' ? {ok: false, code: 'MODULE_INVALID'} : {ok: true})});
  try {
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    await until(() => s.history().some((h) => h.module === '@countinghouse/ch-pack-other' && h.problem != null));
    require('../lib/credential-store').unbind(s.home, ACCESS, {held: require('./store-helpers').FIXTURE_HELD});
    const rereads = () => s.requests.filter((m) => m.type === 'reread' && m.what === 'held-back').length;
    // (any apply sends the pending load again, as every change does, and a
    // file watcher may fire twice for one change -- Windows did, a third
    // load in CI. A retry that ran an apply, as round 1's did, would send
    // one per retry: four. So the loads after the first reread are fewer
    // than the retries.)
    await until(() => rereads() >= 1);
    const loads = s.requests.filter((m) => m.type === 'load').length;
    const lines = s.history().filter((h) => h.module === '@countinghouse/ch-pack-other' && h.problem != null).length;
    await until(() => s.f.err.includes('the runtime did not take the held-back list after 5 tries (CONTROL_FAILED)'));
    // (given up: a later apply finds the text given up and sends no reread,
    // so the count is final whenever it is read)
    assert.strictEqual(rereads(), 5, 'five tries');
    const retries = rereads() - 1;
    assert.ok(s.requests.filter((m) => m.type === 'load').length - loads < retries, 'the refused load is not sent again by each retry');
    assert.ok(s.history().filter((h) => h.module === '@countinghouse/ch-pack-other' && h.problem != null).length - lines < retries, 'nor recorded again by each');
    assert.strictEqual(s.f.err.split('\n').filter((l) => l.includes('did not take the held-back list')).length, 1, 'said once');
  } finally {
    s.end();
    await s.done;
  }
});

// the medium on round 2, 1: a reread that reached the runtime and failed
// leaves its list empty, so after a give-up the list it once took is sent
// again when what is held back returns to it
test('after a held-back list is given up, a return to the list the runtime once took is sent again', async () => {
  let failing = false;
  const s = await running({heldRetryMs: 20, answer: (m) => (m.type === 'reread' && m.what === 'held-back' && failing ? {ok: false, code: 'CONTROL_FAILED'} : {ok: true})});
  try {
    await until(() => s.args() != null);
    const rereads = () => s.requests.filter((m) => m.type === 'reread' && m.what === 'held-back').length;
    failing = true;
    require('../lib/credential-store').unbind(s.home, ACCESS, {held: require('./store-helpers').FIXTURE_HELD});
    await until(() => s.f.err.includes('the runtime did not take the held-back list after 5 tries (CONTROL_FAILED)'));
    assert.strictEqual(rereads(), 5);
    failing = false;
    bindAccess(s.home);
    await until(() => rereads() === 6);
    const file = s.args()[s.args().indexOf('--heldBackFile') + 1];
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).modules, [], 'the list it took at start, sent again');
  } finally {
    s.end();
    await s.done;
  }
});

// the medium on round 2, 4: a pack whose load the runtime refused, then not
// sent a load at all (here: another release's record), is named again
test('a refused pack not sent a load in a later apply is named restart again', async () => {
  const s = await running({answer: (m) => (m.type === 'load' ? {ok: false, code: 'MODULE_INVALID'} : {ok: true})});
  try {
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    await until(() => s.history().some((h) => h.module === '@countinghouse/ch-pack-other' && h.problem != null));
    const file = s.args()[s.args().indexOf('--heldBackFile') + 1];
    stale(s);
    const r2 = otherRelease({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
    await until(() => JSON.parse(fs.readFileSync(file, 'utf8')).modules.some((e) => e.name === '@countinghouse/ch-pack-other'));
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).modules.some((e) => e.name === '@countinghouse/ch-pack-other' && e.reason === 'restart'));
  } finally {
    s.end();
    await s.done;
  }
});

// round 2, 3: a load that never reached the runtime (CONTROL_BUSY) left it
// unloaded: named restart
test('a pack whose load never reached the runtime is named restart', async () => {
  const s = await running({answer: (m) => (m.type === 'load' ? {ok: false, code: 'CONTROL_BUSY'} : {ok: true})});
  try {
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    const file = s.args()[s.args().indexOf('--heldBackFile') + 1];
    await until(() => JSON.parse(fs.readFileSync(file, 'utf8')).modules.some((e) => e.name === '@countinghouse/ch-pack-other'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).modules, [{name: '@countinghouse/ch-pack-other', reason: 'restart'}]);
  } finally {
    s.end();
    await s.done;
  }
});

// the medium on #106's round 1, 5: a load the runtime refused is not named
// restart (whether a restart loads it is not known)
test('a pack whose load the runtime refused is not named restart in the held-back file', async () => {
  const s = await running({answer: (m) => (m.type === 'load' ? {ok: false, code: 'MODULE_INVALID'} : {ok: true})});
  try {
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    await until(() => s.history().some((h) => h.module === '@countinghouse/ch-pack-other' && h.problem != null));
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    const file = s.args()[s.args().indexOf('--heldBackFile') + 1];
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).modules, []);
  } finally {
    s.end();
    await s.done;
  }
});

// the reviewer's high on #106, 2: a refusal that won't change is not sent
// again until the list changes; a busy one is retried, backing off
test('a held-back list the runtime refuses for good is not sent again until it changes', async () => {
  const refused = (m) => (m.type === 'reread' && m.what === 'held-back' ? {ok: false, code: 'CONTROL_UNKNOWN'} : {ok: true});
  const s = await running({answer: refused});
  try {
    await until(() => s.args() != null);
    require('../lib/credential-store').unbind(s.home, ACCESS, {held: require('./store-helpers').FIXTURE_HELD});
    await until(() => s.requests.some((m) => m.type === 'reread' && m.what === 'held-back'));
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(s.requests.filter((m) => m.type === 'reread' && m.what === 'held-back').length, 1, 'not retried');
    // (final at its first try: one line, the give-up's: the medium on round 2, 10)
    assert.strictEqual(s.f.err.split('\n').filter((l) => l.includes('the runtime did not take the held-back list after 1 try (CONTROL_UNKNOWN)')).length, 1, 'said once');
    assert.ok(!s.f.err.includes('the overview may not say which modules are held back'), 'not said as passing');
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
    await until(() => notices(s).some(([, t]) => /has no gh token: run `[^`]+credentials add ch-access-github`/.test(t)));
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
    require('../lib/credential-store').unbind(s.home, ACCESS, {held: require('./store-helpers').FIXTURE_HELD});
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
  require('../lib/credential-store').bind(home, OTHER_STEP, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value: 'test-stored-value-2'}, {held: require('./store-helpers').FIXTURE_HELD});
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
    assert.match(s.f.err, /sends GITHUB_TOKEN to https:\/\/api\.githubcopilot\.com for ch-access-github/);
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

// L3 (#413 section 4.3): a module's setting changed while running (a
// terminal set writes module.<package>.<setting>) has the runtime read them
// again; a change to anything else sends no reread
test('a module setting changed while running sends the runtime one reread; another change sends none', async () => {
  const s = await running();
  try {
    await until(() => s.args() != null);
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh'}}));
    await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'locale'));
    assert.ok(!s.requests.some((m) => m.type === 'reread'), 'no module setting changed');
    fs.writeFileSync(path.join(s.home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh', 'module.@countinghouse/ch-pack-ci-failure-triage.units': 'imperial'}}));
    await until(() => s.requests.some((m) => m.type === 'reread'));
    assert.deepStrictEqual(s.requests.filter((m) => m.type === 'reread').map((m) => ({type: m.type, what: m.what})), [{type: 'reread', what: 'module-settings'}]);
    const problem = moduleMessageProblem(s.requests.find((m) => m.type === 'reread'));
    assert.strictEqual(problem, null, problem);
  } finally {
    s.end();
    await s.done;
  }
});

// M5b and M6 (#455): the runtime sends no load-pack or unload-pack ask any
// more, and the applier answers none (L6): one that came would be the control
// channel's unknown request, said to no one, and nothing loaded or unloaded
test('L6: a load-pack or unload-pack is no request the applier answers: CONTROL_UNKNOWN, nothing said, nothing loaded or unloaded', async () => {
  const {s, reply} = await withOtherOff();
  try {
    const before = s.requests.length;
    const said = notices(s).length;
    assert.deepStrictEqual(await reply({id: 'r1', type: 'load-pack', name: 'other', version: '0.3.0'}), {id: 'r1', ok: false, code: 'CONTROL_UNKNOWN'});
    assert.deepStrictEqual(await reply({id: 'r2', type: 'unload-pack', name: 'ci-failure-triage'}), {id: 'r2', ok: false, code: 'CONTROL_UNKNOWN'});
    // (ordered, never timed: an apply after the asks, its request awaited;
    // anything the asks set going would have come before it: the medium on
    // L6, 2)
    await settled(s, {'pack.other': false});
    assert.ok(!s.requests.slice(before).some((m) => m.type === 'load' || m.type === 'unload'), JSON.stringify(s.requests.slice(before)));
    assert.ok(!notices(s).slice(said).some(([, t]) => /turned (on|off)|cannot be turned on|enabled\./.test(t)), JSON.stringify(notices(s).slice(said)));
    holdsToTheVectors(s.requests);
  } finally {
    s.end();
    await s.done;
  }
});

// A-reason (#449's moduleMessages id 10): a caller unloaded with the module
// turned off that it calls carries reason calls and because, that module
test('a caller of a module turned off: its unload carries reason calls and because, the module turned off', async () => {
  const home = tmp('ch-home-');
  const r = release({extra: {[SCENARIO]: {countinghouse: {role: 'scenario', calls: ['ch-access-github/githubService.listRuns', 'ch-step-redact/redactService.redact', 'ch-pack-other/otherService.go']}}}});
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  // (other first: the scenario calls ch-pack-other)
  assert.strictEqual(await install({pack: 'other', from: r.from}, cmd(), r.allow), 0);
  assert.strictEqual(await addPack({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  bindAccess(home);
  const s = await running({home});
  try {
    assert.ok(loadsPack(s));
    await settled(s, {'pack.other': false});
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === SCENARIO));
    const caller = s.requests.find((m) => m.type === 'unload' && m.name === SCENARIO);
    assert.strictEqual(caller.reason, 'calls');
    assert.strictEqual(caller.because, '@countinghouse/ch-pack-other');
    assert.match(caller.notice, /^ch-pack-ci-failure-triage unloaded: it calls ch-pack-other, which is not available \(it is turned off/);
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other'));
    assert.strictEqual(s.requests.find((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other').reason, 'off');
    holdsToTheVectors(s.requests);
  } finally {
    s.end();
    await s.done;
  }
});

// A-reason, the Reviewer: a module the operator's ceiling refuses sends no
// reason (it may still be turned on), and its notice says why it can't
// simply be turned back on
test('a module the ceiling refuses: its unload carries no reason, and says the operator\'s settings don\'t allow it', async () => {
  const s = await running();
  try {
    assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
    await until(() => s.requests.some((m) => m.type === 'load' && m.name === '@countinghouse/ch-pack-other'));
    const {layout} = require('../lib/home');
    const where = layout({COUNTINGHOUSE_HOME: s.home});
    // the operator's list: the triage pack's modules only
    ceilingReader(s.home, {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], conversation: true,
      modules: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', '@countinghouse/ch-step-redact']}});
    fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {requestTimeout: 61000}}));
    await until(() => s.requests.some((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other'));
    const unload = s.requests.find((m) => m.type === 'unload' && m.name === '@countinghouse/ch-pack-other');
    assert.strictEqual(unload.notice, 'ch-pack-other turned off: the operator\'s settings don\'t allow it');
    assert.ok(!('reason' in unload) && !('because' in unload), JSON.stringify(unload));
    holdsToTheVectors(s.requests);
  } finally {
    s.end();
    await s.done;
  }
});

// The Reviewer's cut on #98's round 3: a key stored under GitHub's earlier
// name is read under the declared one, said once a start, and never
// rewritten at start (only `credentials add` changes the stored name)
test('a key stored under COUNTINGHOUSE_GITHUB_TOKEN: the pack loads, the start says it once, and the store keeps it as it was', async () => {
  const s = await running({bound: null, beforeStart: (home) => require('../lib/credential-store').bind(home, ACCESS, 'COUNTINGHOUSE_GITHUB_TOKEN', {origin: GH_ORIGIN, source: 'stored', value: STORED}, {held: require('./store-helpers').FIXTURE_HELD})});
  try {
    assert.ok(loadsPack(s), 'loaded with the key read under GITHUB_TOKEN');
    const line = `ch-access-github's key is read from its earlier name; \`${said(s.home, 'credentials add ch-access-github')}\` stores it again under GITHUB_TOKEN`;
    assert.strictEqual(s.f.err.split('\n').filter((l) => l.includes(line)).length, 1, s.f.err);
    assert.deepStrictEqual([...require('../lib/credential-store').readStore(s.home).modules.get(ACCESS).keys()], ['COUNTINGHOUSE_GITHUB_TOKEN'], 'never rewritten');
  } finally {
    s.end();
    await s.done;
  }
});

// B-own-add: the user's own modules in place (the own-modules design §2.2).
// own.json is watched: one added is loaded from its copy with its callees'
// dirs; one re-added with changed code is unloaded, then loaded (the
// runtime's reload switches a module only when its version changes, and an
// own module's may not); one removed is unloaded; an own.json that can't be
// read unloads them all, said once.
const ownTree = require('../lib/own-tree');
const {writeOwnRecord} = require('../lib/own-record');
function placeOwn(home, name, {calls = [], body = ''} = {}) {
  const where = layout({COUNTINGHOUSE_HOME: home});
  const src = path.join(fs.realpathSync.native(tmp('ch-ownsrc-')), name);
  fs.mkdirSync(path.join(src, 'handlers', 'toolService'), {recursive: true});
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({name, version: '1.0.0', countinghouse: {role: 'scenario', calls}}));
  fs.writeFileSync(path.join(src, 'api.json'), JSON.stringify({device: {friendlyName: name, serviceList: {'urn:countinghouse-test:serviceID:toolService': {actionList: [{name: 'run'}]}}}}));
  fs.writeFileSync(path.join(src, 'handlers', 'toolService', 'run.js'), `module.exports = async () => ({output: {}});\n${body}`);
  const c = ownTree.checkFolder(src, home);
  assert.strictEqual(c.problems, undefined, JSON.stringify(c.problems));
  const tree = ownTree.treeHash(c.real, c.entries);
  ownTree.placeCopy(where, name, c.real, c.entries, tree);
  return {where, tree, entry: {tree, version: '1.0.0', friendlyName: name, addedAt: new Date(0).toISOString(), from: c.real, calls}};
}
const ownAsks = (s, name = 'my-tool') => s.requests.filter((m) => ['load', 'unload', 'reload'].includes(m.type) && named(m) === name);
const OWN_SKIP = process.platform === 'win32' && 'own modules run only under enforce (Windows: countinghouse#195)';

test('an own module added while start runs loads from its copy; changed code: unloaded, then loaded; removed: unloaded', {skip: OWN_SKIP}, async () => {
  const s = await running();
  const a = placeOwn(s.home, 'my-tool', {calls: ['ch-access-github/githubService.listRuns']});
  writeOwnRecord(a.where, {v: 1, modules: {'my-tool': a.entry}});
  await until(() => ownAsks(s).length === 1);
  const load = ownAsks(s)[0];
  assert.strictEqual(load.type, 'load');
  assert.strictEqual(load.dirs['my-tool'], ownTree.copyDir(a.where, 'my-tool', a.tree));
  assert.ok(typeof load.dirs[ACCESS] === 'string' && load.dirs[ACCESS].startsWith(path.join(s.home, 'module-store')), JSON.stringify(load.dirs));
  assert.strictEqual(load.notice, `my-tool added (own, ${a.tree.slice(0, 12)})`);
  // re-added with changed code
  const b = placeOwn(s.home, 'my-tool', {calls: ['ch-access-github/githubService.listRuns'], body: '// edited\n'});
  writeOwnRecord(a.where, {v: 1, modules: {'my-tool': b.entry}});
  await until(() => ownAsks(s).length === 3);
  assert.deepStrictEqual(ownAsks(s).map((m) => m.type), ['load', 'unload', 'load']);
  assert.strictEqual(ownAsks(s)[1].notice, 'my-tool unloaded: its code changed; loading the new code');
  assert.strictEqual(ownAsks(s)[2].dirs['my-tool'], ownTree.copyDir(a.where, 'my-tool', b.tree));
  // removed
  writeOwnRecord(a.where, {v: 1, modules: {}});
  await until(() => ownAsks(s).length === 4);
  assert.deepStrictEqual([ownAsks(s)[3].type, ownAsks(s)[3].notice], ['unload', 'my-tool removed']);
  s.end();
  await s.done;
});

// F9 (the feature audit): an own module this release's runtime refuses to
// load is held back with its own reason, refused, and the runtime's code;
// its notice says it is the user's own and where to look, never the generic
// "stopped (<CODE>)".
test('an own module the runtime refuses: held back as refused with its code, its own notice; a pack\'s stays stopped', {skip: OWN_SKIP}, async () => {
  const s = await running();
  try {
    await until(() => s.args() != null);
    const file = s.args()[s.args().indexOf('--heldBackFile') + 1];
    const held = () => JSON.parse(fs.readFileSync(file, 'utf8')).modules;
    const a = placeOwn(s.home, 'my-tool');
    writeOwnRecord(a.where, {v: 1, modules: {'my-tool': a.entry}});
    await until(() => ownAsks(s).length === 1);
    // (a stop at a restart is a stop like any other's)
    s.ask({type: 'module-stopped', name: 'my-tool', code: 'MODULE_SUSPENDED', when: 'restart'});
    await until(() => notices(s).some(([, t]) => t === 'my-tool stopped (MODULE_SUSPENDED); restart your client'));
    await until(() => held().some((m) => m.name === 'my-tool'));
    assert.deepStrictEqual(held().find((m) => m.name === 'my-tool'), {name: 'my-tool', reason: 'stopped'});
    // (refused as it was started: this release's runtime refuses it)
    const b = placeOwn(s.home, 'my-tool', {body: '// another copy\n'});
    writeOwnRecord(a.where, {v: 1, modules: {'my-tool': b.entry}});
    await until(() => ownAsks(s).filter((m) => m.type === 'load').length === 2);
    s.ask({type: 'module-stopped', name: 'my-tool', code: 'MODULE_INVALID', when: 'start'});
    const said = `my-tool, your own module, is not loaded: this release's runtime refuses it (MODULE_INVALID); \`${chLocal(layout({COUNTINGHOUSE_HOME: s.home}), 'status')}\` says why, \`${chLocal(layout({COUNTINGHOUSE_HOME: s.home}), 'remove-module my-tool')}\` removes it`;
    await until(() => notices(s).some(([, t]) => t === said));
    await until(() => held().some((m) => m.name === 'my-tool'));
    assert.deepStrictEqual(held().find((m) => m.name === 'my-tool'), {name: 'my-tool', reason: 'refused', code: 'MODULE_INVALID'});
    assert.ok(s.history().some((h) => h.module === 'my-tool' && h.change === 'stopped' && h.notice === said));
    const run = JSON.parse(fs.readFileSync(path.join(s.runDir(), 'run.json'), 'utf8'));
    assert.deepStrictEqual(run.refused, {'my-tool': {code: 'MODULE_INVALID', tree: b.tree}});
  } finally {
    s.end();
    await s.done;
  }
});

test('the held-back writer: refused only with a code it can name, else stopped', () => {
  const where = layout({COUNTINGHOUSE_HOME: tmp('ch-held-')});
  const text = require('../lib/held-back').contentOf(where, new Map([['my-a', {kind: 'refused', code: 'MODULE_INVALID'}], ['my-b', {kind: 'refused', code: 'not a code'}], ['my-c', {kind: 'refused'}]]));
  assert.deepStrictEqual(JSON.parse(text).modules, [{name: 'my-a', reason: 'refused', code: 'MODULE_INVALID'}, {name: 'my-b', reason: 'stopped'}, {name: 'my-c', reason: 'stopped'}]);
});

test('an own.json that can\'t be read while start runs: its modules unloaded, said once; the pack stays', {skip: OWN_SKIP}, async () => {
  const s = await running();
  const a = placeOwn(s.home, 'my-tool');
  writeOwnRecord(a.where, {v: 1, modules: {'my-tool': a.entry}});
  await until(() => ownAsks(s).length === 1);
  fs.writeFileSync(a.where.ownRecord, '{');
  await until(() => ownAsks(s).length === 2);
  assert.strictEqual(ownAsks(s)[1].type, 'unload');
  assert.ok(!s.requests.some((m) => m.type === 'unload' && /ch-pack-ci-failure-triage/.test(String(m.name))), 'the pack stays');
  await until(() => s.history().some((h) => /your own modules are not loaded: /.test(String(h.notice))));
  assert.strictEqual(s.history().filter((h) => /your own modules are not loaded: /.test(String(h.notice))).length, 1);
  s.end();
  await s.done;
});

// the reviewer's high on #113, 5: own A calls own B; B's code changes. A is
// never left calling B's old code: A is unloaded before B's swap and loaded
// after it, callers out first, callees in first.
test('an own module whose own callee\'s code changed is unloaded around the callee\'s swap, and loaded after it', {skip: OWN_SKIP}, async () => {
  const s = await running();
  const b = placeOwn(s.home, 'my-b');
  const a = placeOwn(s.home, 'my-a', {calls: ['my-b/toolService.run']});
  writeOwnRecord(b.where, {v: 1, modules: {'my-b': b.entry, 'my-a': a.entry}});
  await until(() => ownAsks(s, 'my-a').length === 1 && ownAsks(s, 'my-b').length === 1);
  const b2 = placeOwn(s.home, 'my-b', {body: '// edited\n'});
  const at = s.requests.length;
  writeOwnRecord(b.where, {v: 1, modules: {'my-b': b2.entry, 'my-a': a.entry}});
  await until(() => s.requests.slice(at).filter((m) => ['load', 'unload', 'reload'].includes(m.type)).length === 4);
  const seq = s.requests.slice(at).filter((m) => ['load', 'unload', 'reload'].includes(m.type)).map((m) => `${m.type} ${named(m)}`);
  assert.deepStrictEqual(seq, ['unload my-a', 'unload my-b', 'load my-b', 'load my-a']);
  const loadA = s.requests.slice(at).find((m) => m.type === 'load' && m.name === 'my-a');
  assert.strictEqual(loadA.dirs['my-b'], ownTree.copyDir(b.where, 'my-b', b2.tree), 'A loads with B\'s new code');
  s.end();
  await s.done;
});

// the medium on #113's round 1: a callee that moves between own and a pack
// is a code change on either side
test('ownCodeChanged: a callee whose version is a tree on either side, and differs', () => {
  const {ownCodeChanged} = require('../lib/in-place');
  const t1 = 'a'.repeat(64);
  const t2 = 'b'.repeat(64);
  assert.strictEqual(ownCodeChanged({x: t1}, {x: t2}), 'x');
  assert.strictEqual(ownCodeChanged({x: t1}, {x: '1.2.0'}), 'x');
  assert.strictEqual(ownCodeChanged({x: '1.2.0'}, {x: t1}), 'x');
  assert.strictEqual(ownCodeChanged({x: '1.2.0'}, {x: '1.3.0'}), null);
  assert.strictEqual(ownCodeChanged({x: t1}, {x: t1}), null);
});
