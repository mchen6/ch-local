'use strict';
// Collecting the module store (module-level install, #413 section 9.10,
// L1a-1 Task 4): a version is kept while the record (every version a pack
// or a held pack records), the release rollback's kept record, or a live
// start's run.json names it; everything else under the store goes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/module-store');
const rec = require('../lib/module-record');
const {collectStore} = require('../lib/gc');
const {layout} = require('../lib/home');
const {packageTgz} = require('./tgz');
const {tmp} = require('./fake-io');

const RELEASE = {packs: {a: {packages: ['@t/ch-pack-a', '@t/ch-step-x']}, b: {packages: ['@t/ch-pack-b', '@t/ch-step-x']}}};
const roleOf = (name) => (/ch-pack-/.test(name) ? 'scenario' : 'part');
function home() {
  const w = layout({COUNTINGHOUSE_HOME: tmp('ch-gcstore-')});
  const place = (name, version) => {
    const bytes = packageTgz({name, version, countinghouse: {role: roleOf(name)}});
    return store.placeModule(w, name, bytes, {version, integrity: store.integrityOf(bytes)}).dir;
  };
  return {w, place};
}
const from = {release: '0.9.0'};
const recordWith = (w, packs, extra = {}) => rec.writeModulesRecord(w, {runtime: {versions: {}}, release: {version: '0.9.0', security: null}, unreleased: false, packs, ...extra}, {roleOf, release: RELEASE});
function run(w, {pid = 4242, host = 'here', loaded}) {
  const dir = path.join(w.run, `${host}-${pid}-0a1b2c3d`);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({host, pid, startedAt: Date.now(), loaded}));
}
const names = (w) => {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory() && !store.VERSION.test(e.name)) walk(path.join(dir, e.name), r); else out.push(r);
    }
  };
  if (fs.existsSync(w.moduleStore)) walk(w.moduleStore, '');
  return out.sort();
};

test('every version a pack records is kept, the lower one too; one nothing names goes, with its marker and an emptied scope', () => {
  const {w, place} = home();
  place('@t/ch-pack-a', '1.0.0'); place('@t/ch-pack-b', '1.0.0');
  place('@t/ch-step-x', '1.0.0'); place('@t/ch-step-x', '2.0.0'); place('@t/ch-step-x', '0.9.0');
  place('@gone/ch-step-y', '1.0.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0', '@t/ch-step-x': '1.0.0'}}, b: {from, modules: {'@t/ch-pack-b': '1.0.0', '@t/ch-step-x': '2.0.0'}}});
  const r = collectStore(w);
  assert.deepStrictEqual(names(w), ['@t/ch-pack-a/1.0.0', '@t/ch-pack-a/1.0.0.json', '@t/ch-pack-b/1.0.0', '@t/ch-pack-b/1.0.0.json',
    '@t/ch-step-x/1.0.0', '@t/ch-step-x/1.0.0.json', '@t/ch-step-x/2.0.0', '@t/ch-step-x/2.0.0.json']);
  assert.ok(r.removed.some((p) => p.endsWith(path.join('ch-step-x', '0.9.0'))));
  assert.strictEqual(fs.existsSync(path.join(w.moduleStore, '@gone')), false, 'the scope went with its last module');
  assert.ok(r.kept.every((k) => k.why === 'current'));
});

test('a held pack\'s versions and the rollback\'s kept record\'s are kept, said as such', () => {
  const {w, place} = home();
  place('@t/ch-pack-a', '1.0.0'); place('@t/ch-pack-b', '0.5.0'); place('@t/ch-pack-a', '0.8.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0'}}}, {held: {b: {from: {release: '1.0.0'}, modules: {'@t/ch-pack-b': '0.5.0'}}}});
  fs.mkdirSync(path.dirname(w.previousModulesRecord), {recursive: true});
  const prev = rec.writeModulesRecord({modulesRecord: w.previousModulesRecord}, {runtime: {versions: {}}, release: {version: '0.8.0', security: null}, unreleased: false,
    packs: {a: {from: {release: '0.8.0'}, modules: {'@t/ch-pack-a': '0.8.0'}}}}, {roleOf, release: RELEASE});
  assert.ok(prev);
  const r = collectStore(w);
  const why = Object.fromEntries(r.kept.map((k) => [path.relative(w.moduleStore, k.dir), k.why]));
  assert.deepStrictEqual(why, {[path.join('@t', 'ch-pack-a', '0.8.0')]: 'rollback', [path.join('@t', 'ch-pack-a', '1.0.0')]: 'current', [path.join('@t', 'ch-pack-b', '0.5.0')]: 'held'});
  assert.deepStrictEqual(r.removed, []);
});

test('a live start keeps the versions its run.json names; a dead one keeps nothing', () => {
  const {w, place} = home();
  place('@t/ch-pack-a', '1.0.0'); place('@t/ch-pack-a', '0.9.0'); place('@t/ch-step-x', '0.9.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0'}}});
  run(w, {pid: 1, loaded: {'@t/ch-pack-a': '0.9.0'}});
  run(w, {pid: 2, loaded: {'@t/ch-step-x': '0.9.0'}});
  const r = collectStore(w, {alive: (pid) => pid === 1, hostname: 'here'});
  assert.deepStrictEqual(names(w), ['@t/ch-pack-a/0.9.0', '@t/ch-pack-a/0.9.0.json', '@t/ch-pack-a/1.0.0', '@t/ch-pack-a/1.0.0.json']);
  assert.ok(r.kept.some((k) => k.why === 'running' && k.dir.endsWith('0.9.0')));
});

test('a start from before the store (loaded by pack and tree key) keeps no store version and does not stop collection', () => {
  const {w, place} = home();
  place('@t/ch-pack-a', '1.0.0'); place('@t/ch-pack-a', '0.9.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0'}}});
  run(w, {pid: 1, loaded: {a: '0.9.0+1a2b3c4d'}});
  collectStore(w, {alive: () => true, hostname: 'here'});
  assert.deepStrictEqual(names(w), ['@t/ch-pack-a/1.0.0', '@t/ch-pack-a/1.0.0.json']);
});

test('staging and trash leftovers, a version with no marker, a marker with no version, and what is no module\'s all go', () => {
  const {w, place} = home();
  const dir = place('@t/ch-pack-a', '1.0.0');
  place('@t/ch-step-x', '1.0.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0', '@t/ch-step-x': '1.0.0'}}});
  // a crash between the rename and the marker: named, but incomplete
  fs.rmSync(store.markerFile(w, '@t/ch-step-x', '1.0.0'));
  fs.mkdirSync(`${dir}.new-0a1b2c3d`);
  fs.mkdirSync(path.join(path.dirname(dir), '0.5.0.trash-11223344'));
  fs.writeFileSync(path.join(path.dirname(dir), '0.4.0.json'), '{}');
  fs.writeFileSync(path.join(w.moduleStore, 'stray.txt'), 'x');
  fs.mkdirSync(path.join(w.moduleStore, 'Not A Name'));
  collectStore(w);
  assert.deepStrictEqual(names(w), ['@t/ch-pack-a/1.0.0', '@t/ch-pack-a/1.0.0.json']);
});

test('a record that cannot be read collects nothing, and says why', () => {
  const {w, place} = home();
  place('@t/ch-pack-a', '1.0.0');
  fs.writeFileSync(w.modulesRecord, '{');
  const r = collectStore(w);
  assert.match(r.problem, /not a ch-local record/);
  assert.deepStrictEqual(names(w), ['@t/ch-pack-a/1.0.0', '@t/ch-pack-a/1.0.0.json']);
});
