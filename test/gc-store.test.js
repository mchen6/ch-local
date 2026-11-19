'use strict';
require('./tmp-dirs');
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
    return store.placeModule(w, name, bytes, {version, integrity: require('../lib/integrity').integrityOf(bytes)}, {inUse: () => false}).dir;
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
  const r = collectStore(w, {alive: () => false});
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
  const r = collectStore(w, {alive: () => false});
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
  collectStore(w, {alive: () => false});
  assert.deepStrictEqual(names(w), ['@t/ch-pack-a/1.0.0', '@t/ch-pack-a/1.0.0.json']);
});

test('a record that cannot be read collects nothing, and says why', () => {
  const {w, place} = home();
  place('@t/ch-pack-a', '1.0.0');
  fs.writeFileSync(w.modulesRecord, '{');
  const r = collectStore(w, {alive: () => false});
  assert.match(r.problem, /not a ch-local record/);
  assert.deepStrictEqual(names(w), ['@t/ch-pack-a/1.0.0', '@t/ch-pack-a/1.0.0.json']);
});

// the medium review of L1a-1, 3: a marker that cannot be removed is said, and
// the pass goes on
test('a version whose marker cannot be removed is reported kept, and the rest is still collected', () => {
  const {w, place} = home();
  place('@t/ch-pack-a', '1.0.0');
  const x = place('@t/ch-step-x', '1.0.0');
  place('@t/ch-step-z', '1.0.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0'}}});
  // a marker rmSync refuses (a directory, where a file was)
  fs.rmSync(`${x}.json`);
  fs.mkdirSync(`${x}.json`);
  fs.writeFileSync(path.join(`${x}.json`, 'held'), 'x');
  const r = collectStore(w, {alive: () => false});
  assert.ok(r.kept.some((k) => k.dir === x && /could not remove/.test(k.why)), JSON.stringify(r.kept));
  assert.strictEqual(fs.existsSync(path.join(w.moduleStore, '@t', 'ch-step-z')), false, 'the pass went on');
});

// #82's high review
test('alive is required: a caller that leaves it out collects nothing (1)', () => {
  const {w, place} = home();
  place('@t/ch-pack-a', '1.0.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0'}}});
  assert.throws(() => collectStore(w), /alive is required/);
  assert.throws(() => require('../lib/gc').keepOldTreesAside(w), /alive is required/);
  assert.ok(fs.existsSync(path.join(w.moduleStore, '@t', 'ch-pack-a', '1.0.0')));
});

test('a marker that cannot be read is unknown, and unknown is kept: never deleted on a read error (2)', {skip: process.platform === 'win32' || process.getuid() === 0}, () => {
  const {w, place} = home();
  const dir = place('@t/ch-step-x', '1.0.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0'}}});
  place('@t/ch-pack-a', '1.0.0');
  fs.chmodSync(`${dir}.json`, 0o000);
  try {
    const r = collectStore(w, {alive: () => false});
    assert.ok(r.kept.some((k) => k.dir === dir && /could not be read \(EACCES\)/.test(k.why)), JSON.stringify(r.kept));
    assert.ok(fs.existsSync(dir));
  } finally {
    fs.chmodSync(`${dir}.json`, 0o644);
  }
});

test('a marker that is a link is no marker: the version is incomplete, and goes with its link (6)', () => {
  const {w, place} = home();
  const dir = place('@t/ch-pack-a', '1.0.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0'}}});
  const real = path.join(w.home, 'marker-elsewhere.json');
  fs.renameSync(`${dir}.json`, real);
  fs.symlinkSync(real, `${dir}.json`);
  assert.strictEqual(store.isComplete(w, '@t/ch-pack-a', '1.0.0'), false);
  collectStore(w, {alive: () => false});
  assert.strictEqual(fs.existsSync(dir), false, 'incomplete: collected');
  assert.strictEqual(fs.existsSync(real), true, 'the link\'s target is not touched');
});

// #82's medium review of the high fixes
test('a run.json that cannot be read could be a live start\'s: nothing is collected, and why is said (1)', () => {
  const {w, place} = home();
  place('@t/ch-pack-a', '1.0.0'); place('@t/ch-step-x', '1.0.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0'}}});
  const dir = path.join(w.run, 'here-1-0a1b2c3d');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'run.json'), '{"loaded": ');
  const r = collectStore(w, {alive: () => true});
  assert.match(r.problem, /run\.json could not be read .*nothing was collected/);
  assert.ok(fs.existsSync(path.join(w.moduleStore, '@t', 'ch-step-x', '1.0.0')));
  fs.mkdirSync(w.packsDir, {recursive: true});
  assert.match(require('../lib/gc').keepOldTreesAside(w, {alive: () => true}).problem, /nothing was collected/);
});

test('an incomplete version a live start loaded is kept, as placeModule refuses to replace it (2)', () => {
  const {w, place} = home();
  const dir = place('@t/ch-step-x', '1.0.0');
  place('@t/ch-pack-a', '1.0.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0'}}});
  fs.rmSync(`${dir}.json`);
  run(w, {pid: 7, loaded: {'@t/ch-step-x': '1.0.0'}});
  const r = collectStore(w, {alive: (pid) => pid === 7, hostname: 'here'});
  assert.ok(r.kept.some((k) => k.dir === dir && k.why === 'running (incomplete)'));
  assert.ok(fs.existsSync(dir));
});

test('a kept rollback record that cannot be read stops collection; one that is not a record names nothing (3)', {skip: process.platform === 'win32' || process.getuid() === 0}, () => {
  const {w, place} = home();
  place('@t/ch-pack-a', '1.0.0'); place('@t/ch-pack-a', '0.9.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0'}}});
  fs.mkdirSync(path.dirname(w.previousModulesRecord), {recursive: true});
  fs.writeFileSync(w.previousModulesRecord, '{}');
  fs.chmodSync(w.previousModulesRecord, 0o000);
  try {
    assert.match(collectStore(w, {alive: () => false}).problem, /previous.*modules\.json could not be read/);
    assert.ok(fs.existsSync(path.join(w.moduleStore, '@t', 'ch-pack-a', '0.9.0')));
  } finally {
    fs.chmodSync(w.previousModulesRecord, 0o644);
  }
  // readable, not a record: names nothing (rollback refuses it)
  assert.strictEqual(collectStore(w, {alive: () => false}).problem, undefined);
  assert.strictEqual(fs.existsSync(path.join(w.moduleStore, '@t', 'ch-pack-a', '0.9.0')), false);
});

// the medium review of L1a-2, 5: two loaded packs holding a module at
// different versions name both in run.json, and both are kept
test('a live start that holds a module at two versions keeps both', () => {
  const {w, place} = home();
  place('@t/ch-step-x', '1.0.0'); place('@t/ch-step-x', '2.0.0'); place('@t/ch-pack-a', '1.0.0');
  recordWith(w, {a: {from, modules: {'@t/ch-pack-a': '1.0.0'}}});
  run(w, {pid: 9, loaded: {'@t/ch-step-x': ['1.0.0', '2.0.0']}});
  collectStore(w, {alive: (pid) => pid === 9, hostname: 'here'});
  assert.ok(fs.existsSync(path.join(w.moduleStore, '@t', 'ch-step-x', '1.0.0')));
  assert.ok(fs.existsSync(path.join(w.moduleStore, '@t', 'ch-step-x', '2.0.0')));
});
