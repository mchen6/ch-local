'use strict';
require('./tmp-dirs');   // its ch-* temporary directories removed at its end, under any runner
// L3 (#413 sections 4.2 and 4.3): a module's settings at a terminal.
// `settings modules [<m>]`, `settings set <m>.<setting> [<value>]` (a value
// prompted when left out), `settings reset <m>[.<setting>]`; the value is
// checked with the installed runtime's own reader (lib/module-settings.js in
// the app), stored as module.<package>.<setting>, recorded first (a long
// value cut, with its hash).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {main} = require('../bin/ch-local');
const {install} = require('../lib/install');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm} = require('./install-helpers');

const SCENARIO = '@countinghouse/ch-pack-ci-failure-triage';
const SETTINGS = {
  units: {type: 'enum', values: ['metric', 'imperial'], default: 'metric', title: 'Units'},
  defaultRepo: {type: 'string', format: 'repo', title: 'Default repository', description: 'owner/name of the repository to triage'},
  shareStats: {type: 'boolean', default: false, confirm: true, title: 'Share stats'},
  note: {type: 'string', maxLength: 200, title: 'Note'}
};

// The installed runtime's reader, as the app holds it: the shapes of
// countinghouse lib/module-settings.js parseDeclaration and checkValue
// (a stub, as test/start-in-place.test.js stubs the ceiling's reader).
const READER = `
const allowed = (d) => d.type === 'enum' ? d.values.join(' or ') : d.type === 'boolean' ? 'true or false' : d.format === 'repo' ? 'owner/name' : 'text of at most ' + (d.maxLength || 256) + ' characters';
module.exports = {
  parseDeclaration: (pkg) => {
    const s = pkg && pkg.countinghouse && pkg.countinghouse.settings;
    if (s == null) return {settings: null, problems: [], warnings: []};
    const out = Object.create(null);
    for (const [n, d] of Object.entries(s)) out[n] = Object.freeze(Object.assign({name: n, maxLength: d.maxLength || 256}, d));
    return {settings: out, problems: [], warnings: []};
  },
  checkValue: (d, v) => {
    const no = {ok: false, code: 'SETTING_OUT_OF_BOUNDS', reason: d.name + ' is ' + allowed(d)};
    if (d.type === 'enum') return d.values.includes(v) ? {ok: true, value: v} : no;
    if (d.type === 'boolean') return typeof v === 'boolean' ? {ok: true, value: v} : no;
    if (typeof v !== 'string' || v.length > d.maxLength) return no;
    if (d.format === 'repo' && !/^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(v)) return no;
    return {ok: true, value: v};
  }
};
`;
async function installed({reader = true, ceiling = null} = {}) {
  const home = tmp('ch-home-');
  const r = release({extra: {[SCENARIO]: {countinghouse: {role: 'scenario', calls: ['ch-access-github/githubService.listRuns', 'ch-step-redact/redactService.redact'], settings: SETTINGS}}}});
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  const lib = path.join(home, 'app', 'node_modules', 'countinghouse', 'lib');
  fs.mkdirSync(lib, {recursive: true});
  if (reader) fs.writeFileSync(path.join(lib, 'module-settings.js'), READER);
  if (ceiling != null) {
    require('../lib/ceiling').resetForTests();
    // the runtime reader's shape (countinghouse lib/settings-ceiling.js:
    // moduleSettings {conversation, byModule: {pkg: {setting: rule}}}) and
    // its own moduleSettingRule, as written there
    fs.writeFileSync(path.join(lib, 'settings-ceiling.js'), `module.exports = {readCeiling: () => (${JSON.stringify(ceiling)}),
  moduleSettingRule: (c, pkg, setting) => {
    const m = (c != null && c.state === 'trusted' && c.ceiling != null) ? c.ceiling.moduleSettings : null;
    if (m == null) return null;
    const own = (m.byModule[pkg] != null) ? m.byModule[pkg][setting] : undefined;
    if (own != null && Object.prototype.hasOwnProperty.call(own, 'fixed')) return own;
    if (m.conversation === false) return {conversation: false};
    return own != null ? own : null;
  }};\n`);
  }
  return home;
}
// the user at a terminal (answers: what each question gets, in order)
const cli = async (home, argv, {interactive = true, answers = []} = {}) => {
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}}), {interactive});
  const left = [...answers];
  io.ask = async (q) => { io.asked.push(q); return left.length > 0 ? left.shift() : ''; };
  const code = await main(argv, io);
  return {code, io};
};
const fileValues = (home) => (fs.existsSync(path.join(home, 'settings.json')) ? JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).values : {});
const historyOf = (home) => fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const STORED = (s) => `module.${SCENARIO}.${s}`;

test('settings modules lists every installed module\'s settings, loaded or not: value, default and what is allowed', async () => {
  const home = await installed();
  const r = await cli(home, ['settings', 'modules']);
  assert.strictEqual(r.code, 0, r.io.err);
  assert.match(r.io.out, /^ch-pack-ci-failure-triage\.units = metric {2}\(Units; default metric; metric or imperial\)$/m);
  assert.match(r.io.out, /^ch-pack-ci-failure-triage\.defaultRepo = \(not set\) {2}\(Default repository; owner\/name\)$/m);
  assert.match(r.io.out, /^ch-pack-ci-failure-triage\.shareStats = off {2}\(Share stats; default off; true or false; asks before a change\)$/m);
  // one module, with its descriptions
  const one = await cli(home, ['settings', 'modules', 'ch-pack-ci-failure-triage']);
  assert.strictEqual(one.code, 0, one.io.err);
  assert.match(one.io.out, /owner\/name of the repository to triage/);
});

test('settings set <m>.<setting> <value>: checked by the runtime\'s reader, stored as module.<package>.<setting>, recorded first', async () => {
  const home = await installed();
  for (const name of ['ch-pack-ci-failure-triage.units', `module.${SCENARIO}.units`, `${SCENARIO}.units`]) {
    const r = await cli(home, ['settings', 'set', name, 'imperial']);
    assert.strictEqual(r.code, 0, `${name}: ${r.io.err}`);
  }
  assert.strictEqual(fileValues(home)[STORED('units')], 'imperial');
  assert.deepStrictEqual(historyOf(home).filter((l) => l.setting === STORED('units')).map((l) => [l.old, l.new]).slice(0, 1), [['metric', 'imperial']]);
  // an explicit value equal to the default is kept (an upgrade's new default never overrides it)
  assert.strictEqual((await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.units', 'metric'])).code, 0);
  assert.strictEqual(fileValues(home)[STORED('units')], 'metric');
});

test('a value the reader refuses says what is allowed, and nothing is written; an unknown setting names the declared ones', async () => {
  const home = await installed();
  const bad = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.units', 'kelvin']);
  assert.strictEqual(bad.code, 2);
  assert.match(bad.io.err, /units is metric or imperial; nothing was changed/);
  const repo = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.defaultRepo', 'not a repo']);
  assert.match(repo.io.err, /defaultRepo is owner\/name/);
  const unknown = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.color', 'red']);
  assert.strictEqual(unknown.code, 2);
  assert.match(unknown.io.err, /ch-pack-ci-failure-triage declares no setting color; it declares units, defaultRepo, shareStats, note/);
  const noModule = await cli(home, ['settings', 'set', 'ch-nothing.units', 'x']);
  assert.match(noModule.io.err, /no installed module is named ch-nothing/);
  assert.deepStrictEqual(fileValues(home), {});
});

test('a value left out is prompted for at a terminal, and refused without one', async () => {
  const home = await installed();
  const r = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.defaultRepo'], {answers: ['acme/api']});
  assert.strictEqual(r.code, 0, r.io.err);
  assert.ok(r.io.asked.some((q) => /defaultRepo for ch-pack-ci-failure-triage \(owner\/name\): /.test(q)), r.io.asked.join(' | '));
  assert.strictEqual(fileValues(home)[STORED('defaultRepo')], 'acme/api');
  const headless = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.note'], {interactive: false});
  assert.strictEqual(headless.code, 2);
  assert.match(headless.io.err, /give the value, or run it at a terminal/);
});

test('a confirm: true setting asks at a terminal, with no --yes, and is refused without one', async () => {
  const home = await installed();
  const no = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.shareStats', 'true'], {answers: ['n']});
  assert.strictEqual(no.code, 1);
  assert.ok(no.io.asked.some((q) => q === 'Change shareStats for ch-pack-ci-failure-triage from false to true? [y/N] '), no.io.asked.join(' | '));
  assert.strictEqual(fileValues(home)[STORED('shareStats')], undefined);
  const yes = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.shareStats', 'true'], {answers: ['y']});
  assert.strictEqual(yes.code, 0, yes.io.err);
  assert.strictEqual(fileValues(home)[STORED('shareStats')], true);
  const headless = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.shareStats', 'false'], {interactive: false});
  assert.strictEqual(headless.code, 2);
  assert.match(headless.io.err, /shareStats for ch-pack-ci-failure-triage is confirmed at a terminal/);
});

test('the ceiling: a fixed value refuses every change; a ceiling confirm asks', async () => {
  const fixed = await installed({ceiling: {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], moduleSettings: {conversation: true, byModule: {[SCENARIO]: {units: {fixed: 'metric'}, note: {confirm: true}}}}}}});
  const r = await cli(fixed, ['settings', 'set', 'ch-pack-ci-failure-triage.units', 'imperial']);
  assert.strictEqual(r.code, 2);
  assert.match(r.io.err, /units for ch-pack-ci-failure-triage is fixed by this machine's operator ceiling; nothing was changed/);
  const asked = await cli(fixed, ['settings', 'set', 'ch-pack-ci-failure-triage.note', 'hello'], {answers: ['y']});
  assert.strictEqual(asked.code, 0, asked.io.err);
  assert.ok(asked.io.asked.length === 1, 'the ceiling asks for a confirmation');
});

test('settings reset <m>.<setting> and reset <m>: back to the default, other names kept, recorded', async () => {
  const home = await installed();
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh', [STORED('units')]: 'imperial', [STORED('note')]: 'x', 'module.@acme/other.k': 'v'}}));
  assert.strictEqual((await cli(home, ['settings', 'reset', 'ch-pack-ci-failure-triage.units'])).code, 0);
  assert.deepStrictEqual(fileValues(home), {locale: 'zh', [STORED('note')]: 'x', 'module.@acme/other.k': 'v'});
  assert.strictEqual((await cli(home, ['settings', 'reset', 'ch-pack-ci-failure-triage'])).code, 0);
  assert.deepStrictEqual(fileValues(home), {locale: 'zh', 'module.@acme/other.k': 'v'});
  assert.ok(historyOf(home).some((l) => l.setting === STORED('note') && l.change === 'reset'));
});

test('a value over 64 characters is recorded cut, with the SHA-256 of the whole', async () => {
  const home = await installed();
  const long = 'n'.repeat(150);
  assert.strictEqual((await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.note', long])).code, 0);
  const line = historyOf(home).find((l) => l.setting === STORED('note'));
  assert.strictEqual(line.new.length, 64);
  assert.strictEqual(line.newSha256, crypto.createHash('sha256').update(JSON.stringify(long)).digest('hex'));
  assert.strictEqual(fileValues(home)[STORED('note')], long);
});

test('with no runtime reader installed, a module setting is refused, saying how to get one', async () => {
  const home = await installed({reader: false});
  const r = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.units', 'imperial']);
  assert.strictEqual(r.code, 2);
  assert.match(r.io.err, /the installed countinghouse cannot check a module's setting: run `ch-local upgrade`/);
});

// L3 (#413 section 4.3): the outside-edits check learns module.* and
// enabled.*; a value recorded cut is compared by its hash
test('outside edits: a module value the tools wrote, reset or kept is never reported; one edited by hand is, once', async () => {
  const {outsideEdits, reportOutsideEdits, resetForTests} = require('../lib/outside-edits');
  const {readSettings} = require('../lib/settings');
  const {layout} = require('../lib/home');
  resetForTests();
  const home = await installed();
  const where = layout({COUNTINGHOUSE_HOME: home});
  const long = 'q'.repeat(120);
  assert.strictEqual((await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.units', 'imperial'])).code, 0);
  assert.strictEqual((await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.note', long])).code, 0);
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), [], 'what the tools wrote, a long value by its hash');
  // a reset of one, and a bare reset (which keeps module.*): nothing reported
  assert.strictEqual((await cli(home, ['settings', 'reset', 'ch-pack-ci-failure-triage.units'])).code, 0);
  assert.strictEqual((await cli(home, ['settings', 'set', 'locale', 'zh'])).code, 0);
  assert.strictEqual((await cli(home, ['settings', 'reset'])).code, 0);
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), []);
  // edited by hand: the long value changed, and a new one added
  const values = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).values;
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {...values, [STORED('note')]: 'r'.repeat(120), [STORED('units')]: 'imperial'}}));
  const said = [];
  const edits = reportOutsideEdits(where, readSettings(where), {say: (s) => said.push(s)});
  assert.deepStrictEqual(edits.map((e) => e.setting).sort(), [STORED('note'), STORED('units')].sort());
  assert.ok(said.some((s) => s === `${STORED('units')} was changed outside ch-local: (not set) -> imperial`), said.join(' | '));
  assert.ok(said.some((s) => s.startsWith(`${STORED('note')} was changed outside ch-local: (a long value) -> ${'r'.repeat(64)}…`)), said.join(' | '));
  const line = historyOf(home).find((l) => l.setting === STORED('note') && l.change === 'changed outside ch-local');
  assert.strictEqual(line.new.length, 64);
  assert.ok(typeof line.newSha256 === 'string');
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), [], 'reported once');
});

test('outside edits: a terminal "on" that removes a leftover pack.* is not an outside edit; enabled.* on by hand that the ceiling forbids is refused', async () => {
  const {outsideEdits, reportOutsideEdits, resetForTests} = require('../lib/outside-edits');
  const {readSettings} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const {forbiddenBy, ceilingFor} = require('../lib/ceiling');
  resetForTests();
  const home = await installed();
  const where = layout({COUNTINGHOUSE_HOME: home});
  fs.writeFileSync(path.join(home, 'history.jsonl'), JSON.stringify({by: 'cli', setting: 'pack.ci-failure-triage', old: true, new: false}) + '\n');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {'pack.ci-failure-triage': false}}));
  assert.strictEqual((await cli(home, ['settings', 'set', `enabled.${SCENARIO}`, 'on'], {answers: ['y']})).code, 0);
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)), [], 'the leftover\'s removal is recorded');
  // by hand: off then on again past the ceiling's list
  require('../lib/ceiling').resetForTests();
  fs.writeFileSync(path.join(home, 'app', 'node_modules', 'countinghouse', 'lib', 'settings-ceiling.js'),
    `module.exports = {readCeiling: () => (${JSON.stringify({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], modules: ['@countinghouse/ch-access-github']}})})};\n`);
  assert.strictEqual((await cli(home, ['settings', 'set', `enabled.${SCENARIO}`, 'off'])).code, 0);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {[`enabled.${SCENARIO}`]: true}}));
  const said = [];
  const edits = reportOutsideEdits(where, readSettings(where), {say: (s) => said.push(s), refusal: forbiddenBy(ceilingFor(where, {env: {}}))});
  assert.strictEqual(edits.length, 1);
  assert.ok(edits[0].refused != null, 'refused by the ceiling');
  assert.match(said[0], /enabled\.@countinghouse\/ch-pack-ci-failure-triage was changed outside ch-local: off -> on \(this loosens a guarding setting\); not applied: .*forbids it/);
});

// the medium on L3, 8: a reset never changes a value the ceiling fixes
test('settings reset <m>[.<setting>] is refused for a setting the ceiling fixes', async () => {
  const home = await installed({ceiling: {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], moduleSettings: {conversation: true, byModule: {[SCENARIO]: {units: {fixed: 'metric'}}}}}}});
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {[STORED('units')]: 'metric', [STORED('note')]: 'x'}}));
  for (const target of ['ch-pack-ci-failure-triage.units', 'ch-pack-ci-failure-triage']) {
    const r = await cli(home, ['settings', 'reset', target]);
    assert.strictEqual(r.code, 2, target);
    assert.match(r.io.err, /units for ch-pack-ci-failure-triage is fixed by this machine's operator ceiling; nothing was changed/);
  }
  assert.deepStrictEqual(fileValues(home), {[STORED('units')]: 'metric', [STORED('note')]: 'x'});
});

// the rule agreed with countinghouse (its historyCut vector, copied once
// it merges): code points, never a surrogate pair split; exactly 64 whole
test('the history cut counts code points: a surrogate pair is never split, and 64 is written whole', () => {
  const {historyValue} = require('../lib/settings');
  const v = `${'a'.repeat(63)}😀b`;   // 65 code points, 66 UTF-16 units
  const cut = historyValue('new', v);
  assert.strictEqual(cut.new, `${'a'.repeat(63)}😀`);
  assert.strictEqual(cut.newSha256, crypto.createHash('sha256').update(JSON.stringify(v), 'utf8').digest('hex'));
  assert.deepStrictEqual(historyValue('new', `${'a'.repeat(63)}😀`), {new: `${'a'.repeat(63)}😀`}, '64 code points: whole');
  assert.deepStrictEqual(historyValue('new', 12345), {new: 12345}, 'only a string is cut');
});

// the Reviewer's high review of #90, 2: an untrusted ceiling fails closed
test('under a ceiling that cannot be trusted, no module setting is changed, set or reset, saying why', async () => {
  const home = await installed({ceiling: {state: 'untrusted', file: '/etc/countinghouse/ceiling.json', problem: 'it is not JSON'}});
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {[STORED('note')]: 'x'}}));
  const set = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.units', 'imperial']);
  assert.strictEqual(set.code, 2);
  assert.match(set.io.err, /cannot be trusted \(it is not JSON\), so no module setting is changed/);
  const reset = await cli(home, ['settings', 'reset', 'ch-pack-ci-failure-triage']);
  assert.strictEqual(reset.code, 2);
  assert.deepStrictEqual(fileValues(home), {[STORED('note')]: 'x'});
});

// the Reviewer's high review of #90, 6: an unreadable file is said
test('settings modules with a settings file that is not valid says so, never lists defaults as current', async () => {
  const home = await installed();
  fs.writeFileSync(path.join(home, 'settings.json'), '{not json');
  const r = await cli(home, ['settings', 'modules']);
  assert.strictEqual(r.code, 1);
  assert.match(r.io.err, /is not JSON; ch-local start refuses to start until it is fixed/);
  assert.strictEqual(r.io.out, '');
});

// the medium on the high round, 1: a ceiling's "conversation": false is a
// rule for conversation; at a terminal a setting's own confirm still asks
test('a ceiling with conversation false still has a setting\'s own confirm asked at a terminal', async () => {
  const home = await installed({ceiling: {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], moduleSettings: {conversation: false, byModule: {[SCENARIO]: {note: {confirm: true}}}}}}});
  const headless = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.note', 'hello'], {interactive: false});
  assert.strictEqual(headless.code, 2);
  assert.match(headless.io.err, /is confirmed at a terminal/);
  const asked = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.note', 'hello'], {answers: ['y']});
  assert.strictEqual(asked.code, 0, asked.io.err);
  assert.strictEqual(asked.io.asked.length, 1);
});

// the medium on the high round, 2: a trusted ceiling with module-setting
// rules and a reader that cannot read them fails closed
test('a ceiling with module-setting rules over a runtime whose reader cannot read them refuses the change', async () => {
  const home = await installed();
  require('../lib/ceiling').resetForTests();
  fs.writeFileSync(path.join(home, 'app', 'node_modules', 'countinghouse', 'lib', 'settings-ceiling.js'),
    `module.exports = {readCeiling: () => (${JSON.stringify({state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], moduleSettings: {conversation: true, byModule: {[SCENARIO]: {units: {fixed: 'metric'}}}}}})})};\n`);
  const r = await cli(home, ['settings', 'set', 'ch-pack-ci-failure-triage.units', 'imperial']);
  assert.strictEqual(r.code, 2);
  assert.match(r.io.err, /has rules for module settings, which the installed countinghouse cannot read/);
  assert.deepStrictEqual(fileValues(home), {});
});
