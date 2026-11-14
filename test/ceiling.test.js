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
const {ceilingFor, ceilingRefusal, startUnderCeiling} = require('../lib/ceiling');
const {outsideEdits, reportOutsideEdits} = require('../lib/outside-edits');
const {install} = require('../lib/install');
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
  const dir = path.join(layout({COUNTINGHOUSE_HOME: home}).app, 'node_modules', 'countinghouse', 'lib');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'settings-ceiling.js'), `module.exports = {readCeiling: () => (${JSON.stringify(ceiling)})};\n`);
};
const trusted = (c) => ({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: Object.assign({forbid: [], conversation: true}, c)});
const UNTRUSTED = {state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: '/etc/countinghouse is not owned by root'};

test('a loosening is asked at a terminal, recorded as confirmed there; no is no; tightening is not asked', async () => {
  const home = tmp('ch-home-');
  const no = await run(home, ['settings', 'set', 'maxOutputBytes', '16MiB'], {answers: ['n']});
  assert.strictEqual(no.code, 1);
  assert.match(no.io.asked[0], /^Loosen maxOutputBytes from 8388608 to 16777216\? This is kept until you change it back\. \[y\/N\] $/);
  assert.match(no.io.err, /maxOutputBytes was not changed/);
  assert.strictEqual(readSettings(layout({COUNTINGHOUSE_HOME: home})).values.maxOutputBytes, undefined);
  const yes = await run(home, ['settings', 'set', 'maxOutputBytes', '16MiB'], {answers: ['y']});
  assert.strictEqual(yes.code, 0, yes.io.err);
  assert.deepStrictEqual(history(home).map((h) => [h.setting, h.new, h.loosened, h.confirmed]), [['maxOutputBytes', 16 * MiB, true, 'cli']]);
  const down = await run(home, ['settings', 'set', 'maxOutputBytes', '4MiB'], {interactive: false});
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
  io.ask = async () => { setSetting(where, 'maxOutputBytes', '2MiB', {by: 'settings tool'}); return 'y'; };
  assert.strictEqual(await main(['settings', 'set', 'maxOutputBytes', '16MiB'], io), 1);
  assert.match(io.err, /maxOutputBytes changed while you were asked; nothing was changed; run it again/);
  assert.strictEqual(readSettings(where).values.maxOutputBytes, 2 * MiB);
});

test('the operator\'s ceiling, from the installed runtime\'s reader: above it, forbidden, or untrusted, refused before anything is asked', async () => {
  const home = tmp('ch-home-');
  reader(home, trusted({maxOutputBytes: 4 * MiB, forbid: ['autoUpgrade', 'packs']}));
  const above = await run(home, ['settings', 'set', 'maxOutputBytes', '16MiB']);
  assert.strictEqual(above.code, 2);
  assert.match(above.io.err, /maxOutputBytes 16MiB is above the ceiling this machine's operator set \(at most 4MiB\); nothing was changed/);
  assert.deepStrictEqual(above.io.asked, []);
  const auto = await run(home, ['upgrade', '--auto', 'on']);
  assert.match(auto.io.err, /autoUpgrade cannot be changed to on on this machine: its operator's ceiling forbids it/);
  assert.strictEqual((await run(home, ['settings', 'set', 'pack.other', 'off'], {interactive: false})).code, 0, 'turning one off is anyone\'s');
  const pack = await run(home, ['settings', 'set', 'pack.other', 'on']);
  assert.match(pack.io.err, /pack\.other cannot be changed to on on this machine/);
  // within it: asked, and made
  const within = await run(home, ['settings', 'set', 'maxOutputBytes', '4MiB'], {answers: ['y']});
  assert.strictEqual(within.code, 0, within.io.err);
  reader(home, UNTRUSTED);
  const untrusted = await run(home, ['settings', 'set', 'requestTimeout', '60s']);
  assert.match(untrusted.io.err, /the operator's ceiling file \/etc\/countinghouse\/ceiling\.json cannot be trusted \(\/etc\/countinghouse is not owned by root\), so no setting is loosened/);
  // tightening is never refused by it
  assert.strictEqual((await run(home, ['settings', 'set', 'maxOutputBytes', '2MiB'], {interactive: false})).code, 0);
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
  assert.strictEqual(ceilingRefusal(c, 'maxOutputBytes', 16 * MiB).code, 'SETTING_CEILING_UNTRUSTED');
  // a reader that throws fails closed too
  reader(home, null);
  fs.writeFileSync(path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'settings-ceiling.js'), 'module.exports = {readCeiling: () => { throw new Error("boom"); }};\n');
  assert.strictEqual(ceilingFor(where, {file}).state, 'untrusted');
});

test('start, under the ceiling: values clamped and said; a forbidden audit runs under enforce; one that cannot be trusted refuses a loosening start', () => {
  const s = (values) => ({values});
  const c = trusted({maxOutputBytes: 4 * MiB, requestTimeout: 30000, forbid: ['moduleSandbox', 'autoUpgrade']});
  const r = startUnderCeiling(s({maxOutputBytes: 16 * MiB, requestTimeout: 60000, moduleSandbox: 'audit', autoUpgrade: true, locale: 'zh'}), c, {platform: 'linux'});
  assert.deepStrictEqual(r.values, {maxOutputBytes: 4 * MiB, requestTimeout: 30000, moduleSandbox: 'enforce', autoUpgrade: false, locale: 'zh'});
  assert.deepStrictEqual(r.notes, [
    'maxOutputBytes 16MiB is above the operator\'s ceiling: the runtime gets 4MiB',
    'requestTimeout 60s is above the operator\'s ceiling: the runtime gets 30s',
    'moduleSandbox audit is forbidden by the operator\'s ceiling: the runtime runs under enforce',
    'automatic upgrades are forbidden by the operator\'s ceiling: they stay off'
  ]);
  assert.match(startUnderCeiling(s({}), c, {platform: 'linux', passedAudit: true}).problem, /--moduleSandbox audit is forbidden by this machine's operator ceiling: not starting/);
  assert.deepStrictEqual(startUnderCeiling(s({maxOutputBytes: 2 * MiB}), c, {platform: 'linux'}), {values: {maxOutputBytes: 2 * MiB}, notes: []});
  // untrusted: defaults or tighter start; anything looser does not
  assert.deepStrictEqual(startUnderCeiling(s({maxOutputBytes: 2 * MiB, locale: 'zh'}), UNTRUSTED, {platform: 'linux'}).notes, []);
  assert.match(startUnderCeiling(s({maxOutputBytes: 16 * MiB}), UNTRUSTED, {platform: 'linux'}).problem, /cannot be trusted .*, and this start would loosen maxOutputBytes: not starting/);
  assert.match(startUnderCeiling(s({}), UNTRUSTED, {platform: 'linux', passedAudit: true}).problem, /would loosen --moduleSandbox audit/);
  // Windows: the sandbox is audit there until countinghouse#195 reaches ch-local; not a loosening made
  assert.strictEqual(startUnderCeiling(s({}), UNTRUSTED, {platform: 'win32', passedAudit: true}).problem, undefined);
  assert.deepStrictEqual(startUnderCeiling(s({moduleSandbox: 'audit'}), c, {platform: 'win32'}).values, {moduleSandbox: 'audit', maxOutputBytes: 4 * MiB},
    'a default above the ceiling is clamped too');
  assert.deepStrictEqual(startUnderCeiling(s({maxOutputBytes: 16 * MiB}), {state: 'none'}, {platform: 'linux'}), {values: {maxOutputBytes: 16 * MiB}, notes: []});
});

test('outside edits: a setting changed outside the tools is reported once, and recorded; a change the tools made is not', () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  setSetting(where, 'maxOutputBytes', '16MiB', {by: 'cli', mayLoosen: true});
  setSetting(where, 'locale', 'zh', {by: 'settings tool'});
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), []);
  // a request not confirmed and a this-start change set nothing
  fs.appendFileSync(path.join(home, 'history.jsonl'), JSON.stringify({by: 'settings tool', setting: 'requestTimeout', asked: 120000, change: 'not confirmed'}) + '\n' +
    JSON.stringify({by: 'settings tool', setting: 'requestTimeout', old: 30000, new: 120000, change: 'this start'}) + '\n');
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), []);
  // edited by hand: a raise, and a pack turned on that was never recorded
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 32 * MiB, locale: 'zh', 'pack.other': false}}));
  const said = [];
  const edits = reportOutsideEdits(where, readSettings(where), {say: (s) => said.push(s), host: 'box', pid: 1});
  assert.deepStrictEqual(edits.map((e) => [e.setting, e.old, e.new, e.loosened]), [['maxOutputBytes', 16 * MiB, 32 * MiB, true], ['pack.other', true, false, false]]);
  assert.deepStrictEqual(said, ['maxOutputBytes was changed outside ch-local: 16777216 -> 33554432 (this loosens a guarding setting)', 'pack.other was changed outside ch-local: on -> off']);
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
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {maxOutputBytes: 16 * MiB}}));
  const go = async () => {
    const f = fakeIo({env: {COUNTINGHOUSE_HOME: home, GITHUB_TOKEN: 'secret'}, homedir: '/nowhere'});
    Object.assign(f, {pid: 4242, hostname: 'box-1', cwd: home, alive: () => true, trapSignals: () => () => {}, exit: () => {}});
    let args = null;
    let end = null;
    f.spawn = (c, a) => { args = a; return {kill: () => {}, exited: new Promise((resolve) => { end = resolve; }), send: () => {}, onMessage: () => {}}; };
    const done = start({passThrough: []}, f);
    for (let i = 0; end == null && i < 500; i++) {
      await new Promise((res) => setTimeout(res, 10));
      if (f.err.includes('not starting')) break;
    }
    if (end != null) end(0);
    return {code: await done, args, err: f.err};
  };
  reader(home, trusted({maxOutputBytes: 4 * MiB}));
  const clamped = await go();
  assert.match(clamped.err, /maxOutputBytes was changed outside ch-local: 8388608 -> 16777216 \(this loosens a guarding setting\)/);
  assert.match(clamped.err, /maxOutputBytes 16MiB is above the operator's ceiling: the runtime gets 4MiB/);
  assert.deepStrictEqual(clamped.args.slice(clamped.args.indexOf('--maxOutputBytes'), clamped.args.indexOf('--maxOutputBytes') + 2), ['--maxOutputBytes', String(4 * MiB)]);
  assert.strictEqual(readSettings(where).values.maxOutputBytes, 16 * MiB, 'the file is the user\'s: clamped, not rewritten');
  reader(home, UNTRUSTED);
  const refused = await go();
  assert.strictEqual(refused.code, 1, refused.err);
  assert.strictEqual(refused.args, null, 'nothing spawned');
  assert.match(refused.err, /cannot be trusted .*, and this start would loosen maxOutputBytes: not starting; fix the file, or `ch-local settings reset`/);
});
