'use strict';
// countinghouse part 3 in ch-local (P4): a loosening from the terminal is
// asked there (no --yes, refused without a terminal) and bound by the
// operator's ceiling, read with the installed runtime's own reader; start
// clamps the values and flags it passes to it; a setting changed outside the
// tools is reported at the next start.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {main} = require('../bin/ch-local');
const {setSetting, readSettings} = require('../lib/settings');
const {layout} = require('../lib/home');
const ceilingModule = require('../lib/ceiling');
const {ceilingFor, ceilingRefusal, startUnderCeiling, fallbackFiles} = ceilingModule;
const {withSettingsLock} = require('../lib/settings');
const {uninstall} = require('../lib/uninstall');
const {outsideEdits, reportOutsideEdits} = require('../lib/outside-edits');
const {install} = require('../lib/install');
const {addPack} = require('../lib/packs-command');
const {start} = require('../lib/start');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm} = require('./install-helpers');

const MiB = 1024 * 1024;
const history = (home) => {
  try { return fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (err) { return []; }
};
// interactive: whether stdin is a terminal; answers: what the user types
const run = async (home, argv, {interactive = true, answers = []} = {}) => {
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}, answers}), {interactive});
  const code = await main(argv, io);
  return {code, io};
};
// The installed runtime's ceiling reader, as a test gives it.
const reader = (home, ceiling) => {
  ceilingModule.resetForTests();
  const dir = path.join(layout({COUNTINGHOUSE_HOME: home}).app, 'node_modules', 'countinghouse', 'lib');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'settings-ceiling.js'), `module.exports = {readCeiling: () => (${JSON.stringify(ceiling)})};\n`);
};
const trusted = (c) => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: Object.assign({forbid: [], conversation: true}, c)});
const UNTRUSTED = {state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: '/etc/countinghouse is not owned by root'};

test('a loosening is asked at a terminal, recorded as confirmed there; no is no; tightening is not asked', async () => {
  const home = tmp('ch-home-');
  const no = await run(home, ['settings', 'set', 'maxOutputBytes', '32MiB'], {answers: ['n']});
  assert.strictEqual(no.code, 1);
  assert.match(no.io.asked[0], /^Loosen maxOutputBytes from 16MiB to 32MiB\? This is kept until you change it back\. \[y\/N\] $/);
  assert.match(no.io.err, /maxOutputBytes was not changed/);
  assert.strictEqual(readSettings(layout({COUNTINGHOUSE_HOME: home})).values.maxOutputBytes, undefined);
  const yes = await run(home, ['settings', 'set', 'maxOutputBytes', '32MiB'], {answers: ['y']});
  assert.strictEqual(yes.code, 0, yes.io.err);
  assert.deepStrictEqual(history(home).map((h) => [h.setting, h.new, h.loosened, h.confirmed]), [['maxOutputBytes', 32 * MiB, true, 'cli']]);
  const down = await run(home, ['settings', 'set', 'maxOutputBytes', '8MiB'], {interactive: false});
  assert.strictEqual(down.code, 0, down.io.err);
  assert.deepStrictEqual(down.io.asked, [], 'tightening is anyone\'s, unasked');
  assert.strictEqual(history(home)[1].confirmed, undefined);
});

test('without a terminal a loosening is refused, and nothing is recorded or changed; there is no --yes', async () => {
  const home = tmp('ch-home-');
  for (const argv of [['settings', 'set', 'requestTimeout', '120s'], ['upgrade', '--auto', 'on']]) {
    const r = await run(home, argv, {interactive: false});
    assert.strictEqual(r.code, 2);
    assert.match(r.io.err, /loosens a guarding setting, which is confirmed at a terminal: run it in one; nothing was changed/);
  }
  assert.deepStrictEqual(history(home), []);
  assert.ok(!fs.existsSync(path.join(home, 'settings.json')));
  const flag = await run(home, ['settings', 'set', 'requestTimeout', '120s', '--yes'], {interactive: false});
  assert.notStrictEqual(flag.code, 0, 'no --yes');
});

test('a value changed while the user was asked is not overwritten', async () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}}), {interactive: true});
  io.ask = async () => { setSetting(where, 'maxOutputBytes', '4MiB', {by: 'settings tool'}); return 'y'; };
  assert.strictEqual(await main(['settings', 'set', 'maxOutputBytes', '32MiB'], io), 1);
  assert.match(io.err, /maxOutputBytes was changed by another writer meanwhile; nothing was changed; run it again/);
  assert.strictEqual(readSettings(where).values.maxOutputBytes, 4 * MiB);
});

test('the operator\'s ceiling, from the installed runtime\'s reader: above it, forbidden, or untrusted, refused before anything is asked', async () => {
  const home = tmp('ch-home-');
  reader(home, trusted({maxOutputBytes: 8 * MiB, forbid: ['autoUpgrade'], packs: ['ci-failure-triage']}));
  const above = await run(home, ['settings', 'set', 'maxOutputBytes', '32MiB']);
  assert.strictEqual(above.code, 2);
  assert.match(above.io.err, /maxOutputBytes 32MiB is above the ceiling this machine's operator set \(at most 8MiB\); nothing was changed/);
  assert.deepStrictEqual(above.io.asked, []);
  const auto = await run(home, ['upgrade', '--auto', 'on']);
  assert.match(auto.io.err, /autoUpgrade cannot be changed to on on this machine: its operator's ceiling forbids it/);
  assert.strictEqual((await run(home, ['settings', 'set', 'pack.other', 'off'], {interactive: false})).code, 0, 'turning one off is anyone\'s');
  const pack = await run(home, ['settings', 'set', 'pack.other', 'on']);
  assert.match(pack.io.err, /pack\.other cannot be changed to on on this machine/);
  // within it: asked, and made
  const within = await run(home, ['settings', 'set', 'maxOutputBytes', '8MiB'], {answers: ['y']});
  assert.strictEqual(within.code, 0, within.io.err);
  reader(home, UNTRUSTED);
  const untrusted = await run(home, ['settings', 'set', 'requestTimeout', '60s']);
  assert.match(untrusted.io.err, /the operator's ceiling file \/etc\/countinghouse\/ceiling\.json cannot be trusted \(\/etc\/countinghouse is not owned by root\), so no setting is loosened/);
  // tightening is never refused by it
  assert.strictEqual((await run(home, ['settings', 'set', 'maxOutputBytes', '4MiB'], {interactive: false})).code, 0);
});

test('a runtime without the reader, and a ceiling file present, refuses every loosening; no file is the hard bounds', () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  const file = path.join(home, 'ceiling.json');
  assert.deepStrictEqual(ceilingFor(where, {file}), {state: 'none'});
  fs.writeFileSync(file, '{"version": 1}');
  const c = ceilingFor(where, {file});
  assert.strictEqual(c.state, 'untrusted');
  assert.match(c.problem, /the installed countinghouse cannot read it: it is older than this ch-local; `ch-local upgrade` installs one that can/);
  assert.strictEqual(ceilingRefusal(c, 'maxOutputBytes', 32 * MiB).code, 'SETTING_CEILING_UNTRUSTED');
  // a reader that throws fails closed too
  reader(home, null);
  fs.writeFileSync(path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'settings-ceiling.js'), 'module.exports = {readCeiling: () => { throw new Error("boom"); }};\n');
  assert.strictEqual(ceilingFor(where, {file}).state, 'untrusted');
});

test('start, under the ceiling: values clamped and said; a forbidden audit runs under enforce; one that cannot be trusted refuses a loosening start', () => {
  const s = (values) => ({values});
  const c = trusted({maxOutputBytes: 8 * MiB, requestTimeout: 30000, forbid: ['moduleSandbox', 'autoUpgrade']});
  const r = startUnderCeiling(s({maxOutputBytes: 32 * MiB, requestTimeout: 60000, moduleSandbox: 'audit', autoUpgrade: true, locale: 'zh'}), c, {});
  assert.deepStrictEqual(r.values, {maxOutputBytes: 8 * MiB, requestTimeout: 30000, moduleSandbox: 'enforce', autoUpgrade: false, locale: 'zh'});
  assert.deepStrictEqual(r.notes, [
    'maxOutputBytes 32MiB is above the operator\'s ceiling: the runtime gets 8MiB',
    'requestTimeout 60s is above the operator\'s ceiling: the runtime gets 30s',
    'moduleSandbox audit is forbidden by the operator\'s ceiling: the runtime runs under enforce',
    'automatic upgrades are forbidden by the operator\'s ceiling: they stay off'
  ]);
  assert.match(startUnderCeiling(s({}), c, {passedAudit: true}).problem, /--moduleSandbox audit is forbidden by this machine's operator ceiling: not starting/);
  assert.deepStrictEqual(startUnderCeiling(s({maxOutputBytes: 4 * MiB}), c, {}), {values: {maxOutputBytes: 4 * MiB}, notes: []});
  // untrusted: defaults or tighter start; anything looser does not
  assert.deepStrictEqual(startUnderCeiling(s({maxOutputBytes: 4 * MiB, locale: 'zh'}), UNTRUSTED, {}).notes, []);
  assert.match(startUnderCeiling(s({maxOutputBytes: 32 * MiB}), UNTRUSTED, {}).problem, /cannot be trusted .*, and this start would loosen maxOutputBytes: not starting/);
  assert.match(startUnderCeiling(s({}), UNTRUSTED, {passedAudit: true}).problem, /would loosen --moduleSandbox audit/);
  // audit forced by an older runtime (Windows before countinghouse#195): not a loosening made
  assert.strictEqual(startUnderCeiling(s({}), UNTRUSTED, {forcedAudit: true, passedAudit: true}).problem, undefined);
  assert.deepStrictEqual(startUnderCeiling(s({moduleSandbox: 'audit'}), c, {forcedAudit: true}).values, {moduleSandbox: 'audit', maxOutputBytes: 8 * MiB},
    'a default above the ceiling is clamped too');
  assert.deepStrictEqual(startUnderCeiling(s({maxOutputBytes: 32 * MiB}), {state: 'none'}, {}), {values: {maxOutputBytes: 32 * MiB}, notes: []});
  // no value in the file: the runtime would start on its own default (16 MiB,
  // countinghouse's lib/cli-options.js), so a ceiling below that must reach
  // it as a flag. ch-local's default is the runtime's, or a ceiling between
  // the two would bound nothing (it did, at 12 MiB, while this said 8 MiB).
  assert.deepStrictEqual(startUnderCeiling(s({}), trusted({maxOutputBytes: 12 * MiB}), {}).values, {maxOutputBytes: 12 * MiB},
    'a ceiling under the runtime\'s default is passed even with nothing stored');
  assert.strictEqual(require('../lib/settings').ALLOWLIST.maxOutputBytes.default, 16 * MiB, 'the runtime\'s default');
});

test('outside edits: a setting changed outside the tools is reported once, and recorded; a change the tools made is not', () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  setSetting(where, 'maxOutputBytes', '32MiB', {by: 'cli', mayLoosen: true});
  setSetting(where, 'locale', 'zh', {by: 'settings tool'});
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), []);
  // a request not confirmed and a this-start change set nothing
  fs.appendFileSync(path.join(home, 'history.jsonl'), JSON.stringify({by: 'settings tool', setting: 'requestTimeout', asked: 120000, change: 'not confirmed'}) + '\n' +
    JSON.stringify({by: 'settings tool', setting: 'requestTimeout', old: 30000, new: 120000, change: 'this start'}) + '\n');
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), []);
  // edited by hand: a raise, and a pack turned on that was never recorded
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 64 * MiB, locale: 'zh', 'pack.other': false}}));
  const said = [];
  const edits = reportOutsideEdits(where, readSettings(where), {say: (s) => said.push(s), host: 'box', pid: 1});
  assert.deepStrictEqual(edits.map((e) => [e.setting, e.old, e.new, e.loosened]), [['maxOutputBytes', 32 * MiB, 64 * MiB, true], ['pack.other', true, false, false]]);
  assert.deepStrictEqual(said, ['maxOutputBytes was changed outside ch-local: 32MiB -> 64MiB (this loosens a guarding setting)', 'pack.other was changed outside ch-local: on -> off']);
  const last = history(home).slice(-2);
  assert.deepStrictEqual(last.map((h) => [h.by, h.setting, h.change, h.loosened]), [['start', 'maxOutputBytes', 'changed outside ch-local', true], ['start', 'pack.other', 'changed outside ch-local', undefined]]);
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), [], 'reported once');
  // a reset clears what was recorded; a change "not made" is undone
  fs.appendFileSync(path.join(home, 'history.jsonl'), JSON.stringify({by: 'cli', setting: '*', change: 'reset'}) + '\n' +
    JSON.stringify({by: 'cli', setting: 'locale', old: 'en', new: 'zh'}) + '\n' + JSON.stringify({by: 'cli', setting: 'locale', change: 'not made', problem: 'EIO'}) + '\n');
  fs.rmSync(where.settings);
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), []);
});

test('start: says an outside edit and the ceiling\'s clamps, passes the clamped values; an untrusted ceiling and a loosening setting refuse to start', async () => {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  const where = layout({COUNTINGHOUSE_HOME: home});
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 32 * MiB}}));
  const go = async () => {
    const f = fakeIo({env: {COUNTINGHOUSE_HOME: home, GITHUB_TOKEN: 'secret'}, homedir: '/nowhere'});
    Object.assign(f, {pid: 4242, hostname: 'box-1', cwd: home, alive: () => true, trapSignals: () => () => {}, exit: () => {}});
    let args = null;
    let end = null;
    f.spawn = (c, a) => { args = a; return {kill: () => {}, exited: new Promise((resolve) => { end = resolve; }), send: () => {}, onMessage: (fn) => setImmediate(() => fn({type: 'ready'}))}; };
    const done = start({passThrough: []}, f);
    for (let i = 0; end == null && i < 500; i++) {
      await new Promise((res) => setTimeout(res, 10));
      if (f.err.includes('not starting')) break;
    }
    if (end != null) end(0);
    return {code: await done, args, err: f.err};
  };
  reader(home, trusted({maxOutputBytes: 8 * MiB}));
  const clamped = await go();
  assert.match(clamped.err, /maxOutputBytes was changed outside ch-local: 16MiB -> 32MiB \(this loosens a guarding setting\)/);
  assert.match(clamped.err, /maxOutputBytes 32MiB is above the operator's ceiling: the runtime gets 8MiB/);
  assert.deepStrictEqual(clamped.args.slice(clamped.args.indexOf('--maxOutputBytes'), clamped.args.indexOf('--maxOutputBytes') + 2), ['--maxOutputBytes', String(8 * MiB)]);
  assert.strictEqual(readSettings(where).values.maxOutputBytes, 32 * MiB, 'the file is the user\'s: clamped, not rewritten');
  reader(home, UNTRUSTED);
  const refused = await go();
  assert.strictEqual(refused.code, 1, refused.err);
  assert.strictEqual(refused.args, null, 'nothing spawned');
  assert.match(refused.err, /cannot be trusted .*, and this start would loosen maxOutputBytes: not starting; the operator fixes the file, or the settings are tightened back/);
});

// The runtime's own default never governs under ch-local: start passes the
// two caps always (the stored value, or ch-local's default, after the
// ceiling), so the two repositories' defaults cannot drift into a ceiling
// that bounds nothing (countinghouse #283).
test('start: always passes --maxOutputBytes and --requestTimeout, stored or not, as the ceiling leaves them', async () => {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  const where = layout({COUNTINGHOUSE_HOME: home});
  assert.ok(!fs.existsSync(where.settings) || readSettings(where).values.maxOutputBytes === undefined, 'nothing stored');
  const go = async () => {
    const f = fakeIo({env: {COUNTINGHOUSE_HOME: home, GITHUB_TOKEN: 'secret'}, homedir: '/nowhere'});
    Object.assign(f, {pid: 4242, hostname: 'box-1', cwd: home, alive: () => true, trapSignals: () => () => {}, exit: () => {}});
    let args = null;
    let end = null;
    f.spawn = (c, a) => { args = a; return {kill: () => {}, exited: new Promise((resolve) => { end = resolve; }), send: () => {}, onMessage: (fn) => setImmediate(() => fn({type: 'ready'}))}; };
    const done = start({passThrough: []}, f);
    for (let i = 0; end == null && i < 500; i++) await new Promise((res) => setTimeout(res, 10));
    if (end != null) end(0);
    return {code: await done, args, err: f.err};
  };
  const after = (args, flag) => args.filter((a, i) => args[i - 1] === flag);
  // no ceiling, nothing stored: ch-local's defaults, in the runtime's units
  reader(home, {state: 'none'});
  const plain = await go();
  assert.deepStrictEqual(after(plain.args, '--maxOutputBytes'), [String(16 * MiB)], plain.err);
  assert.deepStrictEqual(after(plain.args, '--requestTimeout'), ['30']);
  // a ceiling under the default, nothing stored: the runtime runs at the ceiling
  reader(home, trusted({maxOutputBytes: 12 * MiB, requestTimeout: 20000}));
  const bounded = await go();
  assert.deepStrictEqual(after(bounded.args, '--maxOutputBytes'), [String(12 * MiB)], bounded.err);
  assert.deepStrictEqual(after(bounded.args, '--requestTimeout'), ['20']);
  // a stored value under the ceiling is the one passed
  assert.strictEqual((await run(home, ['settings', 'set', 'maxOutputBytes', '4MiB'], {interactive: false})).code, 0);
  assert.deepStrictEqual(after((await go()).args, '--maxOutputBytes'), [String(4 * MiB)]);
  // (neither can be passed through to ch-local start, so no client's flag competes)
});

test('the review of P4: no reader on Windows looks where ProgramData really is too; the reader is asked once while nothing changes', () => {
  // the known folder, never the environment (the review of #48): a client's ProgramData or SystemDrive moves nothing
  assert.deepStrictEqual(fallbackFiles('win32', {ProgramData: 'D:\\evil', SystemDrive: 'E:'}, {programData: () => 'D:\\mine'}),
    ['D:\\mine\\countinghouse\\ceiling.json', 'C:\\ProgramData\\countinghouse\\ceiling.json']);
  assert.deepStrictEqual(fallbackFiles('win32', {ProgramData: 'D:\\evil'}, {programData: () => null}), ['C:\\ProgramData\\countinghouse\\ceiling.json']);
  assert.deepStrictEqual(fallbackFiles('win32', {}, {programData: () => 'C:\\ProgramData'}), ['C:\\ProgramData\\countinghouse\\ceiling.json']);
  assert.doesNotMatch(require('node:fs').readFileSync(require.resolve('../lib/ceiling'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'), /env\.(ProgramData|SystemDrive)/);
  assert.deepStrictEqual(fallbackFiles('linux', {}), ['/etc/countinghouse/ceiling.json']);
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  reader(home, null);
  const file = path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'settings-ceiling.js');
  const counter = path.join(tmp('ch-count-'), 'asked.txt');
  const write = (state) => fs.writeFileSync(file, `const fs = require('fs');
module.exports = {ceilingFile: () => ${JSON.stringify(path.join(home, 'ceiling.json'))},
  readCeiling: () => { fs.appendFileSync(${JSON.stringify(counter)}, 'x'); return {state: ${JSON.stringify(state)}}; }};\n`);
  write('none');
  const asked = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0);
  assert.strictEqual(ceilingFor(where).state, 'none');
  assert.strictEqual(ceilingFor(where).state, 'none');
  assert.strictEqual(asked(), 1, 'asked once');
  fs.writeFileSync(path.join(home, 'ceiling.json'), '{}');
  ceilingFor(where);
  assert.strictEqual(asked(), 2, 'the ceiling file changed: asked again');
});

const startOnce = async (home) => {
  const f = fakeIo({env: {COUNTINGHOUSE_HOME: home, GITHUB_TOKEN: 'secret'}, homedir: '/nowhere'});
  Object.assign(f, {pid: 4242, hostname: 'box-1', cwd: home, alive: () => true, trapSignals: () => () => {}, exit: () => {}});
  let args = null;
  f.spawn = (c, a) => { args = a; return {kill: () => {}, exited: Promise.resolve(0), send: () => {}, onMessage: (fn) => setImmediate(() => fn({type: 'ready'}))}; };
  const code = await start({passThrough: []}, f);
  return {code, args, err: f.err};
};

test('the review of #18: the operator\'s allowlist of packs: an unlisted pack never loads, whatever settings.json or the history say; install refuses it', async () => {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  reader(home, trusted({packs: ['other']}));
  const s = await startOnce(home);
  assert.match(s.err, /not loading ci-failure-triage: this machine's operator ceiling allows only other/);
  assert.ok(s.args != null && !s.args.includes('--loadModule'), 'started, with no pack (#54: never ended for want of one)');
  // a history that says it was turned on changes nothing
  fs.appendFileSync(path.join(home, 'history.jsonl'), JSON.stringify({by: 'cli', setting: 'pack.ci-failure-triage', old: false, new: true}) + '\n');
  assert.ok(!(await startOnce(home)).args.includes('--loadModule'));
  // installing a pack the list does not name is refused, before anything is written
  const fresh = tmp('ch-home-');
  reader(fresh, trusted({packs: []}));
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: fresh}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, r.allow), 2);
  assert.match(io.err, /the pack "ci-failure-triage" is not allowed on this machine: this machine's operator ceiling allows only no pack; nothing was installed/);
  assert.deepStrictEqual(io.execs, []);
});

test('the review of #18: settings reset is the loosenings it implies: bound by the ceiling, asked once at a terminal; one that only tightens is made at once', async () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  setSetting(where, 'maxOutputBytes', '8MiB', {by: 'cli'});
  setSetting(where, 'pack.other', 'off', {by: 'cli'});
  const headless = await run(home, ['settings', 'reset'], {interactive: false});
  assert.strictEqual(headless.code, 2);
  assert.match(headless.io.err, /a reset that loosens a guarding setting is confirmed at a terminal/);
  assert.strictEqual(readSettings(where).values.maxOutputBytes, 8 * MiB, 'nothing changed');
  const no = await run(home, ['settings', 'reset'], {answers: ['n']});
  assert.strictEqual(no.code, 1);
  assert.deepStrictEqual(no.io.asked, ['Reset every setting to its default? This loosens: maxOutputBytes 8MiB -> 16MiB, pack.other off -> on. (A module\'s settings are kept.) [y/N] ']);
  // the ceiling first: a loosening it refuses refuses the reset, unasked
  reader(home, trusted({maxOutputBytes: 12 * MiB}));
  const above = await run(home, ['settings', 'reset']);
  assert.strictEqual(above.code, 2);
  assert.match(above.io.err, /the reset is not made: maxOutputBytes 16MiB is above the ceiling this machine's operator set \(at most 12MiB\)/);
  assert.deepStrictEqual(above.io.asked, []);
  reader(home, {state: 'none'});
  const yes = await run(home, ['settings', 'reset'], {answers: ['y']});
  assert.strictEqual(yes.code, 0, yes.io.err);
  assert.ok(!fs.existsSync(where.settings));
  assert.deepStrictEqual(history(home).slice(-1).map((h) => [h.setting, h.change, h.confirmed]), [['*', 'reset', 'cli']]);
  // only tightenings (a raised cap back down): unasked, even without a terminal
  setSetting(where, 'maxOutputBytes', '32MiB', {by: 'cli', mayLoosen: true});
  const down = await run(home, ['settings', 'reset'], {interactive: false});
  assert.strictEqual(down.code, 0, down.io.err);
  assert.deepStrictEqual(down.io.asked, []);
});

test('the review of #18: a held settings lock never turns the checks off: at start a loosening the history has not recorded is not applied', async () => {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  const where = layout({COUNTINGHOUSE_HOME: home});
  setSetting(where, 'maxOutputBytes', '8MiB', {by: 'cli'});
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 128 * MiB}}));
  // kept fresh, so never stale
  fs.writeFileSync(path.join(home, 'settings.lock'), JSON.stringify({pid: process.pid, at: Date.now()}));
  const s = await startOnce(home);
  assert.match(s.err, /could not compare the settings with their history \(SETTINGS_BUSY\): maxOutputBytes not loosened this start/);
  assert.deepStrictEqual(s.args.slice(s.args.indexOf('--maxOutputBytes'), s.args.indexOf('--maxOutputBytes') + 2), ['--maxOutputBytes', String(8 * MiB)]);
});

test('the review of P4: an outside loosening the ceiling forbids is not applied at start, and is said at every start', async () => {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  const where = layout({COUNTINGHOUSE_HOME: home});
  setSetting(where, 'autoUpgrade', 'off', {by: 'cli'});
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {autoUpgrade: true}}));
  reader(home, trusted({forbid: ['autoUpgrade']}));
  for (let i = 0; i < 2; i++) {
    require('../lib/outside-edits').resetForTests();   // each start a process of its own
    const f = fakeIo({env: {COUNTINGHOUSE_HOME: home, GITHUB_TOKEN: 'secret'}, homedir: '/nowhere'});
    Object.assign(f, {pid: 4242, hostname: 'box-1', cwd: home, alive: () => true, trapSignals: () => () => {}, exit: () => {}});
    let spawned = false;
    f.spawn = () => { spawned = true; return {kill: () => {}, exited: Promise.resolve(0), send: () => {}, onMessage: (fn) => setImmediate(() => fn({type: 'ready'}))}; };
    const done = start({passThrough: []}, f);
    for (let k = 0; !spawned && k < 300; k++) await new Promise((res) => setTimeout(res, 10));
    await done;
    assert.match(f.err, /autoUpgrade was changed outside ch-local: off -> on \(this loosens a guarding setting\); not applied: autoUpgrade cannot be changed to on on this machine: its operator's ceiling forbids it/);
    assert.ok(spawned);
  }
  assert.deepStrictEqual(history(home).filter((h) => h.by === 'start').map((h) => h.change), ['changed outside ch-local, refused by the ceiling', 'changed outside ch-local, refused by the ceiling']);
});

test('the review of P4: a settings file that cannot be read is no outside edit; start\'s event loop never waits on the lock', () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  setSetting(where, 'maxOutputBytes', '32MiB', {by: 'cli', mayLoosen: true});
  assert.deepStrictEqual(reportOutsideEdits(where, {values: {}, error: 'x'}, {say: () => assert.fail('nothing said')}), []);
  assert.strictEqual(history(home).length, 1);
  fs.writeFileSync(path.join(home, 'settings.lock'), JSON.stringify({pid: process.pid, at: Date.now()}));
  const t = Date.now();
  assert.throws(() => withSettingsLock(where, () => 0, {waitMs: 0}), {code: 'SETTINGS_BUSY'});
  assert.ok(Date.now() - t < 1000);
});

test('the review of #18: uninstall --keep-data keeps settings.json with the history, so a reinstall keeps the user\'s own tightenings', async () => {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  const where = layout({COUNTINGHOUSE_HOME: home});
  setSetting(where, 'maxOutputBytes', '4MiB', {by: 'cli'});
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: home}, answers: ['yes'], homedir: '/nowhere'});
  assert.strictEqual(await uninstall({keepData: true}, io), 0, io.err);
  assert.strictEqual(readSettings(where).values.maxOutputBytes, 4 * MiB);
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), [], 'the history and the file still agree');
});

test('the review of #18: a ceiling that cannot be trusted loads NO pack, and install refuses, naming the problem', async () => {
  const UNT = {state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'packs is not a list of pack names'};
  assert.strictEqual(ceilingModule.packAllowed(UNT, 'ci-failure-triage'), false);
  assert.match(ceilingModule.packRefusal(UNT, 'x'), /the operator's ceiling file \/etc\/countinghouse\/ceiling\.json cannot be trusted \(packs is not a list of pack names\), so no pack loads/);
  assert.strictEqual(ceilingModule.packAllowed({state: 'none'}, 'x'), true);
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  reader(home, UNT);
  const s = await startOnce(home);
  assert.match(s.err, /not loading ci-failure-triage: the operator's ceiling file .* cannot be trusted \(packs is not a list of pack names\), so no pack loads/);
  assert.ok(s.args != null && !s.args.includes('--loadModule'), 'started, with no pack');
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await addPack({pack: 'ci-failure-triage', from: r.from}, io, r.allow), 2);
  assert.match(io.err, /the pack "ci-failure-triage" is not allowed on this machine: the operator's ceiling file .* cannot be trusted/);
});

// The known folder from a ch-local whose environment has no SystemDrive, as
// the shim's cleared one has none: it was empty, so only C:\ProgramData was
// looked at (Windows only).
test('Windows: the known folder is found with no SystemDrive in the environment', {skip: process.platform !== 'win32'}, () => {
  const child = `
    delete process.env.SystemDrive;
    const {programDataFolder} = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'ceiling'))});
    console.log(JSON.stringify({systemDrive: process.env.SystemDrive == null ? null : process.env.SystemDrive, folder: programDataFolder()}));
  `;
  const r = require('node:child_process').spawnSync(process.execPath, ['-e', child], {encoding: 'utf8', timeout: 45000});
  assert.strictEqual(r.status, 0, `${r.stdout} ${r.stderr}`);
  const got = JSON.parse(String(r.stdout).trim());
  assert.strictEqual(got.systemDrive, null, 'the process had no SystemDrive');
  assert.match(String(got.folder), /^[A-Za-z]:\\/, JSON.stringify(got));
});

test('the known-folder script names no cmdlet', () => {
  const {PROGRAMDATA_SCRIPT} = require('../lib/ceiling');
  const code = PROGRAMDATA_SCRIPT.replace(/'[^']*'/g, "''");
  assert.doesNotMatch(code, /\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/, code);
});
