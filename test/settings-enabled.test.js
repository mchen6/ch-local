'use strict';
require('./tmp-dirs');
// L3 (#413 sections 5.1, 5.3 and 10): on and off by module. enabled.<package>
// for a top-level module; a part has no switch; pack.<name> is still read as
// its pack's scenario module's entry (off wins), and a terminal "on" removes
// the leftover; `set pack.<x>` is refused, naming the command to use.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {main} = require('../bin/ch-local');
const {readSettings, isOn, setSetting} = require('../lib/settings');
const {layout} = require('../lib/home');
const {readModulesRecord} = require('../lib/module-record');
const {install} = require('../lib/install');
const {addPack} = require('../lib/packs-command');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm} = require('./install-helpers');

const SCENARIO = '@countinghouse/ch-pack-ci-failure-triage';
const PART = '@countinghouse/ch-access-github';
const OTHER = '@countinghouse/ch-pack-other';

// the user at a terminal, who answers yes to a loosening
const cli = async (home, ...argv) => {
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}}), {interactive: true});
  io.ask = async (q) => { io.asked.push(q); return 'y'; };
  const code = await main(argv, io);
  return {code, io};
};
async function installed({other = false} = {}) {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  if (other) assert.strictEqual(await addPack({pack: 'other', from: r.from}, cmd(), r.allow), 0);
  const where = layout({COUNTINGHOUSE_HOME: home}, () => '/nowhere');
  return {home, where, record: () => readModulesRecord(where)};
}
const writeValues = (home, values) => fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values}));
const fileValues = (home) => JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).values;
const historyOf = (home) => fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('enabled.<module> for a top-level module: off at once, on asked as a loosening, both recorded', async () => {
  const h = await installed();
  const off = await cli(h.home, 'settings', 'set', `enabled.${SCENARIO}`, 'off');
  assert.strictEqual(off.code, 0, off.io.err);
  assert.strictEqual(fileValues(h.home)[`enabled.${SCENARIO}`], false);
  assert.strictEqual(off.io.asked.length, 0, 'off is a tightening: not asked');
  const on = await cli(h.home, 'settings', 'set', `enabled.${SCENARIO}`, 'on');
  assert.strictEqual(on.code, 0, on.io.err);
  assert.ok(on.io.asked.some((q) => /Loosen enabled\.@countinghouse\/ch-pack-ci-failure-triage from off to on/.test(q)), on.io.asked.join(' | '));
  assert.strictEqual(fileValues(h.home)[`enabled.${SCENARIO}`], true);
  assert.deepStrictEqual(historyOf(h.home).filter((l) => l.setting === `enabled.${SCENARIO}`).map((l) => [l.old, l.new]), [[true, false], [false, true]]);
});

test('the enabled.* grammar: a package name, scoped or not, at most 214 characters', () => {
  const {entryOf} = require('../lib/settings');
  for (const ok of ['enabled.weather-tool', 'enabled.@acme/repo-helper', `enabled.a${'b'.repeat(213)}`]) assert.ok(entryOf(ok) != null, ok);
  for (const bad of ['enabled.', 'enabled.Weather', 'enabled.@acme', `enabled.a${'b'.repeat(214)}`, 'enabled.a/b/c']) assert.strictEqual(entryOf(bad), null, bad);
});

test('a part has no switch: set enabled.<part> is refused, naming the modules that call it', async () => {
  const h = await installed();
  const r = await cli(h.home, 'settings', 'set', `enabled.${PART}`, 'off');
  assert.notStrictEqual(r.code, 0);
  assert.match(r.io.err, /ch-access-github is a part: it runs while a module that calls it is on \(ch-pack-ci-failure-triage\)\. Turn that module off instead\./);
  assert.ok(!fs.existsSync(path.join(h.home, 'settings.json')) || fileValues(h.home)[`enabled.${PART}`] === undefined);
});

test('an enabled.<part> written into the file by hand is ignored with a warning, and the file still reads', async () => {
  const h = await installed();
  writeValues(h.home, {[`enabled.${PART}`]: false, locale: 'zh'});
  const s = readSettings(h.where);
  assert.strictEqual(s.error, undefined, s.error);
  assert.strictEqual(s.values.locale, 'zh');
  assert.ok(!(`enabled.${PART}` in s.values), 'not applied');
  assert.match(s.warning, /enabled\.@countinghouse\/ch-access-github names a part, which has no switch: ignored/);
  assert.strictEqual(isOn(s, h.record(), PART), true);
});

test('pack.<name> is still read as its scenario module\'s entry, and off wins over enabled.* on', async () => {
  const h = await installed();
  writeValues(h.home, {'pack.ci-failure-triage': false});
  assert.strictEqual(isOn(readSettings(h.where), h.record(), SCENARIO), false, 'a leftover pack.* off');
  writeValues(h.home, {'pack.ci-failure-triage': false, [`enabled.${SCENARIO}`]: true});
  assert.strictEqual(isOn(readSettings(h.where), h.record(), SCENARIO), false, 'off wins');
  writeValues(h.home, {'pack.ci-failure-triage': true, [`enabled.${SCENARIO}`]: false});
  assert.strictEqual(isOn(readSettings(h.where), h.record(), SCENARIO), false, 'off wins either way');
  writeValues(h.home, {});
  assert.strictEqual(isOn(readSettings(h.where), h.record(), SCENARIO), true, 'default on');
});

test('a terminal "on" removes the leftover pack.* off in the same write, so the module is on', async () => {
  const h = await installed();
  writeValues(h.home, {'pack.ci-failure-triage': false, [`enabled.${SCENARIO}`]: false, locale: 'zh'});
  const on = await cli(h.home, 'settings', 'set', `enabled.${SCENARIO}`, 'on');
  assert.strictEqual(on.code, 0, on.io.err);
  assert.deepStrictEqual(fileValues(h.home), {[`enabled.${SCENARIO}`]: true, locale: 'zh'});
  assert.strictEqual(isOn(readSettings(h.where), h.record(), SCENARIO), true);
  assert.ok(historyOf(h.home).some((l) => l.setting === 'pack.ci-failure-triage' && l.old === false && l.change === 'removed with enabled.@countinghouse/ch-pack-ci-failure-triage on'), JSON.stringify(historyOf(h.home)));
});

test('set pack.<x> is refused, naming the enabled.<scenario> command to use', async () => {
  const h = await installed();
  const r = await cli(h.home, 'settings', 'set', 'pack.ci-failure-triage', 'off');
  assert.notStrictEqual(r.code, 0);
  assert.match(r.io.err, /pack\.ci-failure-triage is no longer a setting: run `ch-local settings set enabled\.@countinghouse\/ch-pack-ci-failure-triage off`/);
  assert.ok(!fs.existsSync(path.join(h.home, 'settings.json')));
});

test('settings get lists one enabled.<module> row per installed top-level module, never a part or a pack', async () => {
  const h = await installed({other: true});
  writeValues(h.home, {[`enabled.${OTHER}`]: false});
  const r = await cli(h.home, 'settings', 'get');
  assert.strictEqual(r.code, 0, r.io.err);
  assert.match(r.io.out, /^enabled\.@countinghouse\/ch-pack-ci-failure-triage = on {2}\(default on; on, off; guarding\)$/m);
  assert.match(r.io.out, /^enabled\.@countinghouse\/ch-pack-other = off {2}\(default on; on, off; guarding\)$/m);
  assert.ok(!/enabled\.@countinghouse\/ch-access-github|^pack\./m.test(r.io.out), r.io.out);
});

test('a bare reset turns every enabled.* back on, asking first, and leaves module.* alone', async () => {
  const h = await installed();
  writeValues(h.home, {[`enabled.${SCENARIO}`]: false, 'module.@acme/weather.units': 'imperial'});
  const r = await cli(h.home, 'settings', 'reset');
  assert.strictEqual(r.code, 0, r.io.err);
  assert.ok(r.io.asked.some((q) => /enabled\.@countinghouse\/ch-pack-ci-failure-triage/.test(q)), r.io.asked.join(' | '));
  assert.deepStrictEqual(fileValues(h.home), {'module.@acme/weather.units': 'imperial'});
});

test('setSetting(enabled.<m>) from code obeys the same rules (a part refused, SETTING_IS_A_PART)', async () => {
  const h = await installed();
  assert.throws(() => setSetting(h.where, `enabled.${PART}`, 'off'), (e) => e.code === 'SETTING_IS_A_PART');
});

// the medium on L3, 2: turning a module on past a leftover pack.* off is a
// loosening: asked at a terminal, refused without one
test('on past a leftover pack.* off is a loosening: asked at a terminal, refused without one', async () => {
  const h = await installed();
  writeValues(h.home, {'pack.ci-failure-triage': false});
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h.home}}), {interactive: false});
  assert.strictEqual(await main(['settings', 'set', `enabled.${SCENARIO}`, 'on'], io), 2);
  assert.match(io.err, /loosens a guarding setting, which is confirmed at a terminal/);
  assert.deepStrictEqual(fileValues(h.home), {'pack.ci-failure-triage': false}, 'nothing changed');
  const on = await cli(h.home, 'settings', 'set', `enabled.${SCENARIO}`, 'on');
  assert.strictEqual(on.code, 0, on.io.err);
  assert.ok(on.io.asked.some((q) => /from off to on/.test(q)), on.io.asked.join(' | '));
});

// the medium on L3, 5: the "turned off" hint names a command that works
test('a module turned off is said with the enabled.* command that turns it on', () => {
  const {packSeams} = require('../lib/pack-seams');
  const record = {packs: {p: {modules: {[SCENARIO]: '1.0.0'}}}, modules: {[SCENARIO]: {version: '1.0.0', role: 'scenario'}}};
  const seams = packSeams({settings: {version: 1, values: {[`enabled.${SCENARIO}`]: false}}, ceiling: {state: 'none'}, record});
  assert.strictEqual(seams.off(SCENARIO, ['p']), `it is turned off (\`ch-local settings set enabled.${SCENARIO} on\`)`);
});

// the medium on L3, 6: a write that fails after a leftover's removal line
// undoes that line too, so no outside edit is reported for it
test('a set whose write fails undoes the leftover pack.* removal in the history too', async () => {
  const h = await installed();
  writeValues(h.home, {'pack.ci-failure-triage': false});
  fs.writeFileSync(path.join(h.home, 'history.jsonl'), JSON.stringify({by: 'cli', setting: 'pack.ci-failure-triage', old: true, new: false}) + '\n');
  const atomic = require('../lib/atomic');
  const settingsPath = require.resolve('../lib/settings');
  const real = atomic.writeAtomic;
  delete require.cache[settingsPath];
  atomic.writeAtomic = () => { throw Object.assign(new Error('no space'), {code: 'ENOSPC'}); };
  try {
    const fresh = require('../lib/settings');
    assert.throws(() => fresh.setSetting(h.where, `enabled.${SCENARIO}`, 'on', {mayLoosen: true}), {code: 'ENOSPC'});
  } finally {
    atomic.writeAtomic = real;
    delete require.cache[settingsPath];
    require('../lib/settings');
  }
  const {outsideEdits} = require('../lib/outside-edits');
  assert.deepStrictEqual(outsideEdits(h.where, readSettings(h.where)), []);
});

// the medium on L3, 9: reset takes no setting of ch-local's own
test('settings reset <a name of ch-local\'s own> is refused, saying what to run', async () => {
  const h = await installed();
  const r = await cli(h.home, 'settings', 'reset', `enabled.${SCENARIO}`);
  assert.strictEqual(r.code, 2);
  assert.match(r.io.err, /settings reset takes no setting of ch-local's own/);
});
