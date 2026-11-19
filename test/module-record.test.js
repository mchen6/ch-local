'use strict';
require('./tmp-dirs');   // its ch-* temporary directories removed at its end, under any runner
// <home>/modules.json (module-level install, #413 section 9.2, L1a-1 Task
// 2): the shape, its derived modules (the highest version any pack records,
// with that version's role) and withdrawn list, and its checks.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const rec = require('../lib/module-record');
const {layout} = require('../lib/home');
const {tmp} = require('./fake-io');

const where = () => layout({COUNTINGHOUSE_HOME: tmp('ch-modrec-')});
const ROLES = {'@countinghouse/ch-pack-ci-failure-triage': 'scenario', '@countinghouse/ch-pack-weekly-report': 'scenario'};
const roleOf = (name) => (ROLES[name] != null ? ROLES[name] : 'part');
const RELEASE_V1 = {packs: {'ci-failure-triage': {packages: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', '@countinghouse/ch-step-redact']}}};
const base = (packs, extra = {}) => ({runtime: {versions: {'@countinghouse/ch-local': '0.9.0', countinghouse: '8.0.0'}},
  release: {version: '0.9.0', security: null}, unreleased: false, packs, ...extra});
const triage = (access = '0.2.0') => ({from: {release: '0.9.0'}, modules: {
  '@countinghouse/ch-pack-ci-failure-triage': '0.5.0', '@countinghouse/ch-access-github': access, '@countinghouse/ch-step-redact': '0.2.0'}});

test('written and read back: the shape of section 9.2, modules and withdrawn derived', () => {
  const w = where();
  const written = rec.writeModulesRecord(w, base({'ci-failure-triage': triage()}), {roleOf, release: RELEASE_V1});
  assert.deepStrictEqual(written.modules, {
    '@countinghouse/ch-access-github': {version: '0.2.0', role: 'part'},
    '@countinghouse/ch-pack-ci-failure-triage': {version: '0.5.0', role: 'scenario'},
    '@countinghouse/ch-step-redact': {version: '0.2.0', role: 'part'}
  });
  assert.deepStrictEqual(written.withdrawn, []);
  const r = rec.readModulesRecord(w);
  assert.strictEqual(r.v, 2);
  assert.deepStrictEqual(r.packs, written.packs);
  assert.deepStrictEqual(r.modules, written.modules);
  assert.deepStrictEqual(r.held, {});
  assert.strictEqual(rec.activeVersion(r, '@countinghouse/ch-access-github'), '0.2.0');
  assert.strictEqual(rec.activeVersion(r, 'weather-tool'), null);
});

test('between packs from different pins the active version is the highest any pack records (semver, a pre-release below its release)', () => {
  const w = where();
  const weekly = {from: {unreleased: '0123456789abcdef'}, modules: {'@countinghouse/ch-pack-weekly-report': '0.3.0', '@countinghouse/ch-access-github': '0.10.0'}};
  const r = rec.writeModulesRecord(w, base({'ci-failure-triage': triage('0.9.0'), 'weekly-report': weekly}, {unreleased: true}), {roleOf, release: RELEASE_V1});
  assert.strictEqual(r.modules['@countinghouse/ch-access-github'].version, '0.10.0', 'numerically, not as text');
  assert.ok(rec.compareVersions('1.0.0-rc.1', '1.0.0') < 0);
  assert.ok(rec.compareVersions('1.0.0-rc.2', '1.0.0-rc.10') < 0);
  assert.ok(rec.compareVersions('1.0.0+b1', '1.0.0+b2') === 0);
  assert.deepStrictEqual(r.withdrawn, [], 'a development record is exempt');
});

test('withdrawn: each recorded module no pack of the release lists', () => {
  const w = where();
  const old = {from: {release: '0.8.0'}, modules: {'@countinghouse/ch-pack-old': '0.1.0', '@countinghouse/ch-step-redact': '0.2.0'}};
  const r = rec.writeModulesRecord(w, base({'ci-failure-triage': triage(), old}), {roleOf, release: RELEASE_V1});
  assert.deepStrictEqual(r.withdrawn, ['@countinghouse/ch-pack-old'], 'a module another listed pack ships is not withdrawn');
  const v2 = {packs: {'ci-failure-triage': {modules: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-step-redact']}}};
  assert.deepStrictEqual(rec.withdrawnOf(rec.readModulesRecord(w), v2), ['@countinghouse/ch-access-github', '@countinghouse/ch-pack-old'], 'version 2 pins read too');
});

test('a record whose modules is not what its packs give is refused, as is each malformed field', () => {
  const w = where();
  rec.writeModulesRecord(w, base({'ci-failure-triage': triage()}), {roleOf, release: RELEASE_V1});
  const good = JSON.parse(fs.readFileSync(w.modulesRecord, 'utf8'));
  const bad = (mutate, why) => {
    const r = JSON.parse(JSON.stringify(good));
    mutate(r);
    fs.writeFileSync(w.modulesRecord, JSON.stringify(r));
    assert.throws(() => rec.readModulesRecord(w), (e) => e.message.includes(why) && /run `ch-local install` again/.test(e.message), why);
  };
  bad((r) => { r.modules['@countinghouse/ch-access-github'].version = '0.3.0'; }, 'modules is not what packs give');
  bad((r) => { r.modules['weather-tool'] = {version: '1.0.0', role: null}; }, 'modules is not what packs give');
  bad((r) => { delete r.modules['@countinghouse/ch-step-redact']; }, 'modules is not what packs give');
  bad((r) => { r.modules['@countinghouse/ch-step-redact'].role = 'tool'; }, 'modules');
  bad((r) => { r.packs['ci-failure-triage'].from = {release: '0.9.0', unreleased: '0123456789abcdef'}; }, 'packs');
  bad((r) => { r.packs['ci-failure-triage'].from = {unreleased: 'xyz'}; }, 'packs');
  bad((r) => { r.packs['ci-failure-triage'].modules['../x'] = '1.0.0'; }, 'packs');
  bad((r) => { r.packs['Bad Name'] = r.packs['ci-failure-triage']; }, 'packs');
  bad((r) => { r.packs['ci-failure-triage'].modules = {}; }, 'packs');
  bad((r) => { r.withdrawn = ['weather-tool']; }, 'withdrawn');
  bad((r) => { r.withdrawn = ['@countinghouse/ch-step-redact', '@countinghouse/ch-step-redact']; }, 'withdrawn');
  bad((r) => { r.held = {'ci-failure-triage': r.packs['ci-failure-triage']}; }, 'both installed and held');
  bad((r) => { r.v = 1; }, 'not version 2');
  fs.writeFileSync(w.modulesRecord, '{');
  assert.throws(() => rec.readModulesRecord(w), /not version 2/);
});

test('the writer refuses a record it would refuse to read', () => {
  const w = where();
  assert.throws(() => rec.writeModulesRecord(w, base({'ci-failure-triage': {from: {release: 'latest'}, modules: {}}}), {roleOf, release: RELEASE_V1}), /not valid \(packs\)/);
  assert.strictEqual(fs.existsSync(w.modulesRecord), false);
});

test('a held pack is recorded and kept apart: never in modules', () => {
  const w = where();
  const held = {'weekly-report': {from: {release: '1.0.0'}, modules: {'@countinghouse/ch-pack-weekly-report': '0.3.0'}}};
  const r = rec.writeModulesRecord(w, base({'ci-failure-triage': triage()}, {held}), {roleOf, release: RELEASE_V1});
  assert.strictEqual(r.modules['@countinghouse/ch-pack-weekly-report'], undefined);
  assert.deepStrictEqual(rec.readModulesRecord(w).held, held);
});

test('nothing installed is null; only an earlier ch-local\'s packs.json says to install again; both there takes modules.json', () => {
  const w = where();
  assert.strictEqual(rec.readModulesRecord(w), null);
  fs.mkdirSync(w.home, {recursive: true});
  fs.writeFileSync(w.packs, JSON.stringify({runtime: {versions: {}}, packs: {}}));
  assert.throws(() => rec.readModulesRecord(w), {message: 'this home was made by an earlier ch-local; run `ch-local install` again'});
  // a migration cut short between writing modules.json and removing packs.json
  rec.writeModulesRecord(w, base({'ci-failure-triage': triage()}), {roleOf, release: RELEASE_V1});
  assert.strictEqual(rec.readModulesRecord(w).packs['ci-failure-triage'].modules['@countinghouse/ch-access-github'], '0.2.0');
});

test('an interrupted rollback is finished first', () => {
  const w = where();
  rec.writeModulesRecord(w, base({'ci-failure-triage': triage()}), {roleOf, release: RELEASE_V1});
  fs.writeFileSync(w.journal, '{}');
  assert.throws(() => rec.readModulesRecord(w), /a rollback was interrupted; run `ch-local rollback` to finish it/);
});

// the medium review of L1a-1
test('a released record is written only with its release\'s pins, and roleOf is required (2)', () => {
  const w = where();
  assert.throws(() => rec.writeModulesRecord(w, base({'ci-failure-triage': triage()}), {roleOf}), /written with its release's pins/);
  assert.throws(() => rec.writeModulesRecord(w, base({'ci-failure-triage': triage()}), {roleOf, release: null}), /written with its release's pins/);
  assert.throws(() => rec.writeModulesRecord(w, base({'ci-failure-triage': triage()})), /roleOf is required/);
  assert.strictEqual(fs.existsSync(w.modulesRecord), false);
  // a development record needs none: nothing is withdrawn there
  assert.deepStrictEqual(rec.writeModulesRecord(w, base({'ci-failure-triage': triage()}, {unreleased: true}), {roleOf}).withdrawn, []);
});

test('two versions equal but for build metadata: the same one is active whatever the packs\' order (7)', () => {
  const w = where();
  const p = (v) => ({from: {unreleased: '0123456789abcdef'}, modules: {'weather-tool': v}});
  const one = rec.writeModulesRecord(w, base({x: p('1.0.0+a'), y: p('1.0.0+b')}, {unreleased: true}), {roleOf});
  const two = rec.writeModulesRecord(w, base({y: p('1.0.0+b'), x: p('1.0.0+a')}, {unreleased: true}), {roleOf});
  assert.strictEqual(one.modules['weather-tool'].version, two.modules['weather-tool'].version);
});

// #82's high review, 5: a record never names a version the store refuses
test('a module version the store would refuse is refused in the record too (5)', () => {
  const w = where();
  const p = (v) => ({'ci-failure-triage': {from: {release: '0.9.0'}, modules: {'@countinghouse/ch-step-redact': v}}});
  for (const v of ['1.0.0-RC.1', '1.0.0-rc.json', '1.0.0-x.new-ab12cd34']) {
    assert.throws(() => rec.writeModulesRecord(w, base(p(v)), {roleOf, release: RELEASE_V1}), /not valid \(packs\)/, v);
  }
});

// #83's high review, 2 [security]: a withdrawn pack's newer version never
// overrides what a release pins for a live pack
test('a module\'s active version comes from the live packs: a withdrawn pack\'s higher version is not it', () => {
  const w = where();
  const live = {from: {release: '0.9.0'}, modules: {'@countinghouse/ch-pack-ci-failure-triage': '0.5.0', '@countinghouse/ch-access-github': '1.1.0'}};
  const gone = {from: {release: '0.8.0'}, modules: {'@countinghouse/ch-pack-old': '0.1.0', '@countinghouse/ch-access-github': '2.0.0'}};
  const release = {packs: {'ci-failure-triage': {packages: Object.keys(live.modules)}}};
  const r = rec.writeModulesRecord(w, base({'ci-failure-triage': live, old: gone}), {roleOf, release});
  assert.deepStrictEqual(r.withdrawn, ['@countinghouse/ch-pack-old']);
  assert.strictEqual(r.modules['@countinghouse/ch-access-github'].version, '1.1.0', 'the security release\'s pin, not the withdrawn pack\'s 2.0.0');
  assert.strictEqual(r.modules['@countinghouse/ch-pack-old'].version, '0.1.0', 'a module only a withdrawn pack records keeps its version (never loaded)');
  assert.strictEqual(rec.readModulesRecord(w).modules['@countinghouse/ch-access-github'].version, '1.1.0', 'the reader derives the same');
});
