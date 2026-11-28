'use strict';
require('./tmp-dirs');
// ch-local settings (packs in place, part 2, plan Task B4): the allowlist and
// bounds countinghouse_settings has; the CLI, the user at a terminal, may
// loosen a guarding setting, and every change is recorded. start applies the
// settings at spawn, and while it runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {main} = require('../bin/ch-local');
const {loosens, setSetting, readSettings} = require('../lib/settings');
const {layout} = require('../lib/home');
const {install} = require('../lib/install');
const {addPack} = require('../lib/packs-command');
const {start} = require('../lib/start');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm} = require('./install-helpers');

// the user at a terminal, who answers yes to a loosening (part 3: asked there;
// test/ceiling.test.js has the rest)
const cli = async (home, ...argv) => {
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}}), {interactive: true});
  io.ask = async (q) => { io.asked.push(q); return 'y'; };
  const code = await main(argv, io);
  return {code, io};
};
const history = (home) => fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// On Windows the sandbox setting has only audit (countinghouse#195), so
// these use another guarding setting as the loosening there.
const WIN = process.platform === 'win32';
const LOOSEN = WIN ? ['autoUpgrade', 'on'] : ['moduleSandbox', 'audit'];

test('settings get lists every setting with its default and bounds; set stays within them, and is recorded', async () => {
  const home = tmp('ch-home-');
  const got = await cli(home, 'settings', 'get');
  assert.strictEqual(got.code, 0, got.io.err);
  assert.match(got.io.out, /^maxOutputBytes = 16777216 {2}\(default 16777216; 1048576 to 268435456; guarding\)$/m);
  assert.match(got.io.out, /^upgradeCheck = daily {2}\(default daily; daily, weekly, never\)$/m);
  for (const [name, value, stored] of [['maxOutputBytes', '128MiB', 128 * 1024 * 1024], ['requestTimeout', '20s', 20000], ['upgradeCheck', 'weekly', 'weekly']]) {
    const r = await cli(home, 'settings', 'set', name, value);
    assert.strictEqual(r.code, 0, r.io.err);
    assert.strictEqual(readSettings(layout({COUNTINGHOUSE_HOME: home})).values[name], stored);
  }
  const h = history(home);
  assert.deepStrictEqual(h.map((e) => [e.by, e.setting]), [['cli', 'maxOutputBytes'], ['cli', 'requestTimeout'], ['cli', 'upgradeCheck']]);
  for (const [name, value, code] of [['maxOutputBytes', '1024MiB', /outside the allowed range \(1048576 to 268435456\)/], ['requestTimeout', '1s', /outside/], ['nonsense', '1', /there is no setting named nonsense/]]) {
    const r = await cli(home, 'settings', 'set', name, value);
    assert.strictEqual(r.code, 2);
    assert.match(r.io.err, code);
  }
});

test('the CLI may loosen a guarding setting (the user at a terminal), and says so; anything else may not', async () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  const r = await cli(home, 'settings', 'set', ...LOOSEN);
  assert.strictEqual(r.code, 0);
  assert.match(r.io.out, /this loosens a guarding setting/);
  assert.throws(() => setSetting(where, 'maxOutputBytes', '32MiB', {by: 'settings tool'}), {code: 'SETTING_LOOSENS_A_GUARD'});
  assert.strictEqual(setSetting(where, LOOSEN[0], WIN ? 'off' : 'enforce', {by: 'settings tool'}).loosened, false, 'tightening is anyone\'s');
});

test('loosens: raising a cap or a timeout, audit, automatic upgrades on and a pack on loosen; the reverse never does', () => {
  const cases = [['maxOutputBytes', 8, 16, true], ['maxOutputBytes', 16, 8, false], ['requestTimeout', 30000, 60000, true]].concat(WIN
    ? [['moduleSandbox', 'audit', 'audit', false]] : [['moduleSandbox', 'enforce', 'audit', true], ['moduleSandbox', 'audit', 'enforce', false]], [['autoUpgrade', false, true, true], ['autoUpgrade', true, false, false], ['pack.other', false, true, true], ['pack.other', true, false, false],
    ['upgradeCheck', 'never', 'daily', false]]);
  for (const [name, o, n, want] of cases) assert.strictEqual(loosens(name, o, n), want, `${name} ${o} -> ${n}`);
});

test('an earlier {autoUpgrade} settings file is read as version 1, and upgrade --auto writes through settings', async () => {
  const home = tmp('ch-home-');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({autoUpgrade: true}));
  assert.deepStrictEqual(readSettings(layout({COUNTINGHOUSE_HOME: home})).values, {autoUpgrade: true});
  const r = await cli(home, 'upgrade', '--auto', 'off');
  assert.strictEqual(r.code, 0, r.io.err);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')), {version: 1, values: {autoUpgrade: false}});
});

test('start: a pack turned off is not loaded; the runtime\'s settings are passed unless the client passed them; while running, a pack turned off is unloaded and a live setting is sent', async () => {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  assert.strictEqual(await addPack({pack: 'other', from: r.from}, cmd(), r.allow), 0);
  assert.strictEqual((await cli(home, 'settings', 'set', 'enabled.@countinghouse/ch-pack-other', 'off')).code, 0);
  assert.strictEqual((await cli(home, 'settings', 'set', 'maxOutputBytes', '32MiB')).code, 0);
  require('./store-helpers').bindAccess(home);
  const f = fakeIo({env: {COUNTINGHOUSE_HOME: home}, homedir: '/nowhere'});
  Object.assign(f, {pid: 4242, hostname: 'box-1', cwd: home, alive: () => true, trapSignals: () => () => {}, exit: () => {}});
  const requests = [];
  let end = null;
  let listener = null;
  let args = null;
  f.spawn = (c, a) => {
    args = a;
    return {kill: () => {}, exited: new Promise((resolve) => { end = resolve; }),
      send: (m) => { requests.push(m); setImmediate(() => listener({id: m.id, ok: true})); }, onMessage: (fn) => { listener = fn; setImmediate(() => fn({type: 'ready'})); }};
  };
  const done = start({passThrough: []}, f);
  for (let i = 0; end == null && i < 500; i++) await new Promise((res) => setTimeout(res, 10));
  assert.ok(!args.some((a) => a.includes(`${path.sep}other${path.sep}`)), 'other is off: not loaded');
  assert.match(f.err, /not loading ch-pack-other: it is turned off/);
  assert.deepStrictEqual(args.slice(args.indexOf('--maxOutputBytes'), args.indexOf('--maxOutputBytes') + 2), ['--maxOutputBytes', String(32 * 1024 * 1024)]);
  // none stored: the default, passed all the same (the two caps always are,
  // so the runtime's own default never governs: countinghouse #283)
  assert.deepStrictEqual(args.slice(args.indexOf('--requestTimeout'), args.indexOf('--requestTimeout') + 2), ['--requestTimeout', '30']);
  // (the held-back list's rereads, which follow each change in what is held
  // back, are read apart: A-firstrun d1)
  const isHeld = (m) => m.type === 'reread' && m.what === 'held-back';
  const sent = () => requests.filter((m) => !isHeld(m));
  assert.strictEqual((await cli(home, 'settings', 'set', 'enabled.@countinghouse/ch-pack-other', 'on')).code, 0);
  for (let i = 0; sent().length < 1 && i < 500; i++) await new Promise((res) => setTimeout(res, 10));
  assert.deepStrictEqual([sent()[0].type, sent()[0].name], ['load', '@countinghouse/ch-pack-other']);
  // (the pack turned on is no longer held back: one reread, after its load)
  const rereads = () => requests.filter(isHeld).length;
  for (let i = 0; rereads() < 1 && i < 500; i++) await new Promise((res) => setTimeout(res, 10));
  assert.strictEqual(rereads(), 1);
  assert.ok(requests.findIndex(isHeld) > requests.indexOf(sent()[0]), 'after the load');
  assert.strictEqual((await cli(home, 'settings', 'set', 'requestTimeout', '15s')).code, 0);
  for (let i = 0; sent().length < 2 && i < 500; i++) await new Promise((res) => setTimeout(res, 10));
  assert.deepStrictEqual(sent()[1], {type: 'set', name: 'requestTimeout', value: 15, id: sent()[1].id});
  assert.strictEqual((await cli(home, 'settings', 'set', 'enabled.@countinghouse/ch-pack-ci-failure-triage', 'off')).code, 0);
  for (let i = 0; sent().length < 3 && i < 500; i++) await new Promise((res) => setTimeout(res, 10));
  assert.deepStrictEqual([sent()[2].type, sent()[2].name, sent()[2].notice], ['unload', '@countinghouse/ch-pack-ci-failure-triage', 'ch-pack-ci-failure-triage turned off']);
  // (a timeout changes nothing held back: no reread for it; the pack turned
  // off is: one more, after its unload)
  for (let i = 0; rereads() < 2 && i < 500; i++) await new Promise((res) => setTimeout(res, 10));
  assert.strictEqual(rereads(), 2);
  assert.ok(requests.indexOf(requests.filter(isHeld)[1]) > requests.indexOf(sent()[2]), 'the second after the unload, none for the timeout');
  end(0);
  await done;
});

test('settings set takes the settings lock: a change under way makes it wait, then say so; nothing is written', async () => {
  const home = tmp('ch-home-');
  fs.writeFileSync(path.join(home, 'settings.lock'), JSON.stringify({pid: process.pid, at: Date.now()}));
  const r = await cli(home, 'settings', 'set', 'upgradeCheck', 'weekly');
  assert.strictEqual(r.code, 1);
  assert.match(r.io.err, /another change to the settings is under way/);
  assert.ok(!fs.existsSync(path.join(home, 'settings.json')));
});

test('settings fail closed: a file that cannot be read, or holds a value not allowed, is refused, never part-applied', async () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  for (const [text, why] of [['{not json', /is not JSON/], [JSON.stringify({version: 1, values: {'pack.x': 'off'}}), /has pack\.x = "off", which is not allowed/],
    [JSON.stringify({version: 1, values: {maxOutputBytes: 1}}), /maxOutputBytes = 1, which is not allowed/], [JSON.stringify({version: 2, values: {}}), /not a version 1 settings file/]]) {
    fs.writeFileSync(path.join(home, 'settings.json'), text);
    const read = readSettings(where);
    assert.deepStrictEqual(read.values, {});
    assert.match(read.error, why);
    const r = await cli(home, 'settings', 'set', 'upgradeCheck', 'weekly');
    assert.strictEqual(r.code, 1);
    assert.match(r.io.err, /fix or remove it first/);
  }
});

test('a change is recorded before it is made: an unwritable history refuses it; a loosening is flagged in the history', async () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  fs.mkdirSync(path.join(home, 'history.jsonl'));   // cannot be appended to
  assert.throws(() => setSetting(where, 'upgradeCheck', 'weekly', {by: 'cli'}), {code: 'SETTING_NOT_RECORDED'});
  assert.ok(!fs.existsSync(path.join(home, 'settings.json')));
  fs.rmdirSync(path.join(home, 'history.jsonl'));
  setSetting(where, LOOSEN[0], LOOSEN[1], {by: 'cli', mayLoosen: true});
  assert.deepStrictEqual((({setting, loosened, by}) => ({setting, loosened, by}))(history(home)[0]), {setting: LOOSEN[0], loosened: true, by: 'cli'});
});

// English-only product (Matt, 11-22): ch-local has no language to choose
test('locale is no setting: get does not list it, and a set is refused and stores nothing', async () => {
  const home = tmp('ch-home-');
  assert.doesNotMatch((await cli(home, 'settings', 'get')).io.out, /^locale\b/m);
  const set = await cli(home, 'settings', 'set', 'locale', 'en');
  assert.notStrictEqual(set.code, 0);
  assert.ok(!fs.existsSync(path.join(home, 'settings.json')), 'nothing stored');
});

test('settings get prints a bad file\'s problem, never defaults as current; reset removes it, recorded', async () => {
  const home = tmp('ch-home-');
  fs.writeFileSync(path.join(home, 'settings.json'), '{not json');
  const got = await cli(home, 'settings', 'get');
  assert.strictEqual(got.code, 1);
  assert.match(got.io.err, /is not JSON; ch-local start refuses to start until it is fixed\n/);
  assert.doesNotMatch(got.io.out, /upgradeCheck/);
  const reset = await cli(home, 'settings', 'reset');
  assert.strictEqual(reset.code, 0, reset.io.err);
  assert.ok(!fs.existsSync(path.join(home, 'settings.json')));
  assert.deepStrictEqual((({setting, change}) => ({setting, change}))(history(home).pop()), {setting: '*', change: 'reset'});
  assert.strictEqual((await cli(home, 'settings', 'get')).code, 0);
});

test('a setting this ch-local does not know is ignored, with a warning; the file stays valid', () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {fromTheFuture: true, upgradeCheck: 'weekly'}}));
  const read = readSettings(where);
  assert.deepStrictEqual(read.values, {upgradeCheck: 'weekly'});
  assert.match(read.warning, /fromTheFuture/);
  assert.strictEqual(read.error, undefined);
});

// L0 (module-level configuration design, 2026-11-18, section 4.2: both
// writers keep names they do not know). The runtime's settings tool writes
// module.* values into the same file; a terminal set or reset must never
// erase them, nor any other name a newer runtime writes.
const KEPT = {'module.@acme/weather-tool.units': 'imperial', 'module.weather-tool.maxResults': 40, someNewSetting: {nested: [1, 2]}};
const settingsFile = (home) => path.join(home, 'settings.json');
const writeSettings = (home, values) => fs.writeFileSync(settingsFile(home), JSON.stringify({version: 1, values}, null, 2) + '\n');
const storedValues = (home) => JSON.parse(fs.readFileSync(settingsFile(home), 'utf8')).values;

test('L0: settings set keeps every name this ch-local does not know, exactly as stored', async () => {
  const home = tmp('ch-home-');
  writeSettings(home, {...KEPT, upgradeCheck: 'weekly'});
  const got = await cli(home, 'settings', 'set', 'requestTimeout', '20s');
  assert.strictEqual(got.code, 0, got.io.err);
  assert.deepStrictEqual(storedValues(home), {...KEPT, upgradeCheck: 'weekly', requestTimeout: 20000});
  // and again, through the library, as the start's applier and the tool's peers use it
  setSetting(layout({COUNTINGHOUSE_HOME: home}), 'upgradeCheck', 'daily', {by: 'cli'});
  assert.deepStrictEqual(storedValues(home), {...KEPT, upgradeCheck: 'daily', requestTimeout: 20000});
});

test('L0: a bare settings reset removes every known name and keeps the rest; the reset is recorded as before', async () => {
  const home = tmp('ch-home-');
  writeSettings(home, {...KEPT, upgradeCheck: 'weekly', requestTimeout: 20000});
  const reset = await cli(home, 'settings', 'reset');
  assert.strictEqual(reset.code, 0, reset.io.err);
  assert.deepStrictEqual(storedValues(home), KEPT);
  assert.deepStrictEqual((({setting, change}) => ({setting, change}))(history(home).pop()), {setting: '*', change: 'reset'});
  const read = readSettings(layout({COUNTINGHOUSE_HOME: home}));
  assert.strictEqual(read.error, undefined, 'the file it leaves is a valid one');
  assert.deepStrictEqual(read.values, {});
});

test('L0: a reset of a file with only names this ch-local knows removes it, as before', async () => {
  const home = tmp('ch-home-');
  writeSettings(home, {upgradeCheck: 'weekly'});
  const reset = await cli(home, 'settings', 'reset');
  assert.strictEqual(reset.code, 0, reset.io.err);
  assert.ok(!fs.existsSync(settingsFile(home)));
});

test('L0: a reset of a file whose known value is not allowed keeps the unknown names and drops the rest', async () => {
  const home = tmp('ch-home-');
  writeSettings(home, {...KEPT, requestTimeout: 1});
  const read = readSettings(layout({COUNTINGHOUSE_HOME: home}));
  assert.match(read.error, /requestTimeout/, 'still a bad file: nothing of it is applied');
  assert.deepStrictEqual(read.values, {});
  const reset = await cli(home, 'settings', 'reset');
  assert.strictEqual(reset.code, 0, reset.io.err);
  assert.deepStrictEqual(storedValues(home), KEPT);
});

test('L0: a reset of a file that is not a readable version 1 settings file removes it whole, as before', async () => {
  for (const text of ['{not json', JSON.stringify({version: 2, values: KEPT}), JSON.stringify([1])]) {
    const home = tmp('ch-home-');
    fs.writeFileSync(settingsFile(home), text);
    const reset = await cli(home, 'settings', 'reset');
    assert.strictEqual(reset.code, 0, reset.io.err);
    assert.ok(!fs.existsSync(settingsFile(home)), text);
  }
});

test('L0: names kept by a set or a reset are never reported as edits made outside ch-local', async () => {
  const {outsideEdits} = require('../lib/outside-edits');
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  writeSettings(home, {...KEPT, upgradeCheck: 'weekly'});
  // the module values as the runtime's settings tool writes them: each with
  // its history line first (#413 section 4.2), so none is an outside edit
  fs.writeFileSync(path.join(home, 'history.jsonl'), Object.entries(KEPT).filter(([n]) => n.startsWith('module.')).map(([setting, v]) => JSON.stringify({by: 'settings tool', setting, new: v})).join('\n') + '\n');
  await cli(home, 'settings', 'set', 'requestTimeout', '20s');
  await cli(home, 'settings', 'reset');
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), []);
});

test('L0: a set keeps the file\'s own order of names; a name new to the file goes last', async () => {
  const home = tmp('ch-home-');
  writeSettings(home, {maxOutputBytes: 8388608, 'module.a.b': 1, requestTimeout: 20000});
  assert.strictEqual((await cli(home, 'settings', 'set', 'maxOutputBytes', '4MiB')).code, 0);
  assert.deepStrictEqual(Object.keys(storedValues(home)), ['maxOutputBytes', 'module.a.b', 'requestTimeout']);
  assert.strictEqual((await cli(home, 'settings', 'set', 'upgradeCheck', 'weekly')).code, 0);
  assert.deepStrictEqual(Object.keys(storedValues(home)), ['maxOutputBytes', 'module.a.b', 'requestTimeout', 'upgradeCheck']);
});

test('L0: a settings file that is there but cannot be read is never removed by a reset; nothing is recorded', async () => {
  const home = tmp('ch-home-');
  fs.mkdirSync(settingsFile(home));   // read fails (EISDIR), as a held file can on Windows
  const reset = await cli(home, 'settings', 'reset');
  assert.strictEqual(reset.code, 1, reset.io.err);
  assert.match(reset.io.err, /cannot be read .*nothing was changed/);
  assert.ok(fs.statSync(settingsFile(home)).isDirectory(), 'left as it was');
  assert.ok(!fs.existsSync(path.join(home, 'history.jsonl')) || !/"reset"/.test(fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8')));
});

test('L0: a reset whose write fails is recorded as not made: the values before it stand for the outside-edit check', () => {
  const atomic = require('../lib/atomic');
  const settingsPath = require.resolve('../lib/settings');
  const real = atomic.writeAtomic;
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  setSetting(where, 'requestTimeout', '20s', {by: 'cli'});
  const raw = JSON.parse(fs.readFileSync(settingsFile(home), 'utf8'));
  writeSettings(home, {...raw.values, 'module.a.b': 1});
  // (written as the runtime's settings tool writes it: its line first)
  fs.appendFileSync(path.join(home, 'history.jsonl'), JSON.stringify({by: 'settings tool', setting: 'module.a.b', new: 1}) + '\n');
  delete require.cache[settingsPath];
  atomic.writeAtomic = () => { throw Object.assign(new Error('no space'), {code: 'ENOSPC'}); };
  try {
    const fresh = require('../lib/settings');
    assert.throws(() => fresh.resetSettings(where, {by: 'cli'}), {code: 'ENOSPC'});
  } finally {
    atomic.writeAtomic = real;
    delete require.cache[settingsPath];
    require('../lib/settings');
  }
  assert.deepStrictEqual(storedValues(home), {requestTimeout: 20000, 'module.a.b': 1}, 'the file as it was');
  assert.deepStrictEqual((({setting, change, problem}) => ({setting, change, problem}))(history(home).pop()), {setting: '*', change: 'not made', problem: 'ENOSPC'});
  const {outsideEdits} = require('../lib/outside-edits');
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), [], 'no edit reported: the reset was not made');
});

test('L0: a session-only change the runtime could not make undoes nothing of the stored values; a failed write for every session undoes its own', async () => {
  const {outsideEdits} = require('../lib/outside-edits');
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  assert.strictEqual((await cli(home, 'settings', 'set', 'requestTimeout', '20s')).code, 0);
  const runtime = (line) => fs.appendFileSync(path.join(home, 'history.jsonl'), JSON.stringify({by: 'settings tool', setting: 'requestTimeout', ...line}) + '\n');
  // (the runtime's lines, as countinghouse's settings tool writes them: a session's own change that failed carries its
  // session and no scope; it never touched settings.json, as its success, 'this session', is not recorded either)
  runtime({old: 20000, new: 10000, change: 'this session', session: 's1'});
  runtime({change: 'not made', problem: 'EIO', session: 's1'});
  // (the way back to the value for all sessions, whose set failed)
  runtime({old: 10000, new: 20000, change: 'this session: its own lowering undone', session: 's1'});
  runtime({change: 'not made', problem: 'SETTING_OUT_OF_BOUNDS', session: 's1'});
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), [], 'the 20s set at the terminal still stands');
  // a change for every session whose rename failed: its line, then the not made carrying the every-session scope, which
  // undoes it (the file still holds 20s)
  runtime({old: 20000, new: 15000, session: 's1', scope: 'every session'});
  runtime({change: 'not made', problem: 'EACCES', session: 's1', scope: 'every session'});
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), [], 'the failed write for every session is undone');
  // a session's change kept for all sessions, whose write failed: its own label, with a session, still undoes it
  runtime({old: 20000, new: 12000, change: 'all sessions', session: 's1'});
  runtime({change: 'all sessions: not made', problem: 'EIO', session: 's1'});
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), [], 'the failed change for all sessions is undone');
});

test('L0: module.* names are expected and not warned about; any other unknown name still is; every read returns kept', () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  writeSettings(home, {'module.a.b': 1, upgradeCheck: 'weekly'});
  assert.strictEqual(readSettings(where).warning, undefined);
  writeSettings(home, {'module.a.b': 1, someNewSetting: 2});
  assert.match(readSettings(where).warning, /someNewSetting/);
  assert.doesNotMatch(readSettings(where).warning, /module\.a\.b/);
  fs.writeFileSync(settingsFile(home), '{not json');
  assert.deepStrictEqual(readSettings(where).kept, {});
});

test('the settings lock: a fresh one, even empty, is waited for and never taken; a stale one is cleared', () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  const lock = path.join(home, 'settings.lock');
  fs.writeFileSync(lock, '');
  assert.throws(() => setSetting(where, 'upgradeCheck', 'weekly', {by: 'cli'}), {code: 'SETTINGS_BUSY'});
  assert.ok(fs.existsSync(lock));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  setSetting(where, 'upgradeCheck', 'weekly', {by: 'cli'});
  assert.ok(!fs.existsSync(lock), 'released');
  assert.strictEqual(readSettings(where).values.upgradeCheck, 'weekly');
});

test('the machine id: stable, and a hash (it names no host or id)', () => {
  const {machineId} = require('../lib/machine');
  assert.match(machineId(), /^m:[0-9a-f]{24}$/);
  assert.strictEqual(machineId(), machineId());
  assert.ok(!machineId().includes(require('node:os').hostname()));
});

test('runtimeValue: requestTimeout in whole seconds rounded down, at least 1', () => {
  const {runtimeValue} = require('../lib/settings');
  assert.deepStrictEqual([20999, 20000, 5000, 400].map((ms) => runtimeValue('requestTimeout', ms)), [20, 20, 5, 1]);
});

test('the sandbox setting is enforce and audit, enforce the default, on every platform (countinghouse#195: enforce on Windows)', () => {
  const {sandboxEntry} = require('../lib/settings');
  for (const p of ['linux', 'darwin', 'win32']) {
    assert.deepStrictEqual([sandboxEntry(p).values, sandboxEntry(p).default], [['enforce', 'audit'], 'enforce'], p);
    assert.strictEqual(sandboxEntry(p).tighter('enforce', 'audit'), false, 'audit loosens');
  }
});
