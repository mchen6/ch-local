'use strict';
// The module store (module-level install, #413 section 9.1, L1a-1 Task 1):
// one directory per module version, placed whole and then marked; a version
// with the pin's integrity is never unpacked again; one with other contents
// is replaced only when no running start uses it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../lib/module-store');
const {layout} = require('../lib/home');
const {packageTgz} = require('./tgz');
const {tmp} = require('./fake-io');

const where = () => layout({COUNTINGHOUSE_HOME: tmp('ch-store-')});
function tarball(name, version, extra = {}) {
  const bytes = packageTgz({name, version, countinghouse: {role: 'part'}, ...extra}, {'index.js': `module.exports = ${JSON.stringify(version)};\n`});
  return {bytes, pin: {version, integrity: require('../lib/integrity').integrityOf(bytes)}};
}

test('a placed version is its directory and then its marker; a scoped name is two directories', () => {
  const w = where();
  const {bytes, pin} = tarball('@countinghouse/ch-access-github', '0.2.0');
  const r = store.placeModule(w, '@countinghouse/ch-access-github', bytes, pin, {inUse: () => false, now: () => new Date('2026-12-01T10:00:00.000Z')});
  assert.strictEqual(r.placed, true);
  assert.strictEqual(r.dir, path.join(w.moduleStore, '@countinghouse', 'ch-access-github', '0.2.0'));
  assert.strictEqual(fs.readFileSync(path.join(r.dir, 'index.js'), 'utf8'), 'module.exports = "0.2.0";\n');
  assert.deepStrictEqual(store.readMarker(w, '@countinghouse/ch-access-github', '0.2.0'),
    {name: '@countinghouse/ch-access-github', version: '0.2.0', integrity: pin.integrity, placedAt: '2026-12-01T10:00:00.000Z'});
  assert.strictEqual(store.isComplete(w, '@countinghouse/ch-access-github', '0.2.0'), true);
  assert.strictEqual(store.roleOf(w, '@countinghouse/ch-access-github', '0.2.0'), 'part');
  // nothing left beside it
  assert.deepStrictEqual(fs.readdirSync(path.dirname(r.dir)).sort(), ['0.2.0', '0.2.0.json']);
});

test('a second place of the same version neither unpacks nor touches the directory', () => {
  const w = where();
  const {bytes, pin} = tarball('weather-tool', '1.2.0');
  const first = store.placeModule(w, 'weather-tool', bytes, pin, {inUse: () => false});
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(first.dir, old, old);
  fs.utimesSync(path.join(first.dir, 'index.js'), old, old);
  const again = store.placeModule(w, 'weather-tool', bytes, pin, {inUse: () => { throw new Error('not asked'); }});
  assert.strictEqual(again.placed, false);
  assert.strictEqual(fs.statSync(first.dir).mtimeMs, old.getTime());
  assert.strictEqual(fs.statSync(path.join(first.dir, 'index.js')).mtimeMs, old.getTime());
});

test('a version directory with no marker is incomplete, and is placed again whole', () => {
  const w = where();
  const {bytes, pin} = tarball('weather-tool', '1.2.0');
  const {dir} = store.placeModule(w, 'weather-tool', bytes, pin, {inUse: () => false});
  // a crash between the rename and the marker
  fs.rmSync(store.markerFile(w, 'weather-tool', '1.2.0'));
  fs.writeFileSync(path.join(dir, 'stray.js'), 'half of something');
  assert.strictEqual(store.isComplete(w, 'weather-tool', '1.2.0'), false);
  assert.throws(() => store.readStoredManifest(w, 'weather-tool', '1.2.0'), /not in the module store/);
  assert.strictEqual(store.placeModule(w, 'weather-tool', bytes, pin, {inUse: () => false}).placed, true);
  assert.strictEqual(fs.existsSync(path.join(dir, 'stray.js')), false);
  assert.strictEqual(store.isComplete(w, 'weather-tool', '1.2.0'), true);
});

test('a marker that is not this version\'s, or not readable, is no marker', () => {
  const w = where();
  const {bytes, pin} = tarball('weather-tool', '1.2.0');
  store.placeModule(w, 'weather-tool', bytes, pin, {inUse: () => false});
  const file = store.markerFile(w, 'weather-tool', '1.2.0');
  fs.writeFileSync(file, JSON.stringify({name: 'weather-tool', version: '1.2.1', integrity: pin.integrity, placedAt: 'x'}));
  assert.strictEqual(store.readMarker(w, 'weather-tool', '1.2.0'), null);
  fs.writeFileSync(file, '{');
  assert.strictEqual(store.isComplete(w, 'weather-tool', '1.2.0'), false);
});

test('other contents under one version: replaced when no running start uses it, refused when one does', () => {
  const w = where();
  const a = tarball('weather-tool', '1.2.0');
  const b = tarball('weather-tool', '1.2.0', {description: 'built again'});
  assert.notStrictEqual(a.pin.integrity, b.pin.integrity);
  const {dir} = store.placeModule(w, 'weather-tool', a.bytes, a.pin, {inUse: () => false});
  const asked = [];
  assert.throws(() => store.placeModule(w, 'weather-tool', b.bytes, b.pin, {inUse: (n, v) => { asked.push(`${n}@${v}`); return true; }}),
    /weather-tool 1\.2\.0 is installed with other contents and a running client uses it; stop it and run this again/);
  assert.deepStrictEqual(asked, ['weather-tool@1.2.0']);
  assert.strictEqual(store.readMarker(w, 'weather-tool', '1.2.0').integrity, a.pin.integrity, 'unchanged');
  assert.strictEqual(store.placeModule(w, 'weather-tool', b.bytes, b.pin, {inUse: () => false}).placed, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).description, 'built again');
  assert.strictEqual(store.readMarker(w, 'weather-tool', '1.2.0').integrity, b.pin.integrity);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(dir)).sort(), ['1.2.0', '1.2.0.json'], 'no aside left');
});

test('bytes that are not the pin\'s, a manifest that is not the pinned one, and npm dependencies are refused with nothing placed', () => {
  const w = where();
  const a = tarball('weather-tool', '1.2.0');
  assert.throws(() => store.placeModule(w, 'weather-tool', a.bytes, {version: '1.2.0', integrity: tarball('weather-tool', '1.2.1').pin.integrity}, {inUse: () => false}), /integrity is not the pinned one/);
  const wrong = tarball('weather-tool', '1.2.1');
  assert.throws(() => store.placeModule(w, 'weather-tool', wrong.bytes, {version: '1.2.0', integrity: wrong.pin.integrity}, {inUse: () => false}), /package\.json is weather-tool@1\.2\.1/);
  const deps = tarball('weather-tool', '1.2.0', {dependencies: {lodash: '4.0.0'}});
  assert.throws(() => store.placeModule(w, 'weather-tool', deps.bytes, deps.pin, {inUse: () => false}), /declares npm dependencies/);
  const left = fs.existsSync(path.join(w.moduleStore, 'weather-tool')) ? fs.readdirSync(path.join(w.moduleStore, 'weather-tool')) : [];
  assert.deepStrictEqual(left, [], 'no stage, no version, no marker');
});

test('a name or version that is not a release\'s is refused before any path is made', () => {
  const w = where();
  assert.throws(() => store.versionDir(w, '../escape', '1.0.0'), /not a package name/);
  assert.throws(() => store.versionDir(w, 'weather-tool', '1.0.0/../../x'), /not a version/);
  assert.throws(() => store.versionDir(w, '@scope/../x', '1.0.0'), /not a package name/);
});

// the medium review of L1a-1
test('inUse is required: a caller that leaves it out replaces nothing (1)', () => {
  const w = where();
  const {bytes, pin} = tarball('weather-tool', '1.2.0');
  assert.throws(() => store.placeModule(w, 'weather-tool', bytes, pin), /inUse is required/);
  assert.strictEqual(fs.existsSync(path.join(w.moduleStore, 'weather-tool')), false);
});

test('a version that ends in .json or holds .new- or .trash- is refused: it would be another\'s marker or staging name (4)', () => {
  const w = where();
  for (const v of ['1.0.0-rc.json', '1.2.0-beta.new-ab12cd34', '1.2.0-x.trash-11223344']) {
    assert.throws(() => store.versionDir(w, 'weather-tool', v), /not a version/, v);
    assert.strictEqual(store.storeVersion(v), false, v);
  }
  assert.strictEqual(store.storeVersion('1.0.0-rc.1+build.7'), true);
});

test('a version path that is a link or a file, beside a right marker, is not taken as installed: it is placed again (5)', () => {
  const w = where();
  const {bytes, pin} = tarball('weather-tool', '1.2.0');
  const {dir} = store.placeModule(w, 'weather-tool', bytes, pin, {inUse: () => false});
  const elsewhere = path.join(w.home, 'elsewhere');
  fs.renameSync(dir, elsewhere);
  fs.symlinkSync(elsewhere, dir, 'dir');
  assert.strictEqual(store.isComplete(w, 'weather-tool', '1.2.0'), false);
  // something is at its path: asked (#82's high review, 4); not in use, placed
  const asked = [];
  const r = store.placeModule(w, 'weather-tool', bytes, pin, {inUse: (n, v) => { asked.push(`${n}@${v}`); return false; }});
  assert.deepStrictEqual(asked, ['weather-tool@1.2.0']);
  assert.strictEqual(r.placed, true);
  assert.strictEqual(fs.lstatSync(dir).isDirectory(), true);
  assert.strictEqual(fs.existsSync(path.join(elsewhere, 'package.json')), true, 'a link\'s target is never deleted through it');
});

// #82's high review
test('a marker that cannot be read refuses the place: unknown is never taken for missing (2)', {skip: process.platform === 'win32' || process.getuid() === 0}, () => {
  const w = where();
  const a = tarball('weather-tool', '1.2.0');
  const b = tarball('weather-tool', '1.2.0', {description: 'built again'});
  store.placeModule(w, 'weather-tool', a.bytes, a.pin, {inUse: () => false});
  const file = store.markerFile(w, 'weather-tool', '1.2.0');
  fs.chmodSync(file, 0o000);
  try {
    assert.throws(() => store.placeModule(w, 'weather-tool', b.bytes, b.pin, {inUse: () => false}), (e) => e.unknown === true && /could not be read \(EACCES\)/.test(e.message));
    assert.throws(() => store.isComplete(w, 'weather-tool', '1.2.0'), /could not be read/);
  } finally {
    fs.chmodSync(file, 0o644);
  }
  assert.strictEqual(store.readMarker(w, 'weather-tool', '1.2.0').integrity, a.pin.integrity, 'unchanged');
});

test('a version with an upper-case letter is refused: on a case-insensitive file system it would share another\'s directory (3)', () => {
  const w = where();
  assert.strictEqual(store.storeVersion('1.0.0-RC.1'), false);
  assert.strictEqual(store.storeVersion('1.0.0+Build'), false);
  assert.strictEqual(store.storeVersion('1.0.0-rc.1'), true);
  assert.throws(() => store.versionDir(w, 'weather-tool', '1.0.0-RC.1'), /not a version/);
});

test('an incomplete version still at its path is asked about too: in use, it is refused (4)', () => {
  const w = where();
  const {bytes, pin} = tarball('weather-tool', '1.2.0');
  const {dir} = store.placeModule(w, 'weather-tool', bytes, pin, {inUse: () => false});
  fs.rmSync(store.markerFile(w, 'weather-tool', '1.2.0'));
  const asked = [];
  assert.throws(() => store.placeModule(w, 'weather-tool', bytes, pin, {inUse: (n, v) => { asked.push(`${n}@${v}`); return true; }}),
    /weather-tool 1\.2\.0 is incomplete in the module store and a running client uses it; stop it and run this again/);
  assert.deepStrictEqual(asked, ['weather-tool@1.2.0']);
  assert.ok(fs.existsSync(path.join(dir, 'package.json')), 'not touched');
});

// (lib/unpack.js still comes through lib/pack-dir.js until L1a-2 removes it)
test('start loads none of collection\'s or the store\'s code (10)', () => {
  const r = require('node:child_process').spawnSync(process.execPath, ['-e',
    "require('./lib/start'); const loaded = Object.keys(require.cache).map((k) => require('node:path').basename(k)); console.log(JSON.stringify(['gc.js', 'module-store.js', 'module-record.js'].filter((f) => loaded.includes(f))))"],
  {cwd: path.join(__dirname, '..'), encoding: 'utf8'});
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), []);
});

// #82's medium review of the high fixes
test('a version that ends in a dot or holds an empty identifier is refused: Windows drops a trailing dot (4)', () => {
  for (const v of ['1.0.0-a.', '1.0.0-a..b', '1.0.0+b.']) assert.strictEqual(store.storeVersion(v), false, v);
  assert.strictEqual(store.storeVersion('1.0.0-a.b'), true);
});

test('a reader of modules.json loads none of the store\'s code (8)', () => {
  const r = require('node:child_process').spawnSync(process.execPath, ['-e',
    "require('./lib/module-record'); const loaded = Object.keys(require.cache).map((k) => require('node:path').basename(k)); console.log(JSON.stringify(['module-store.js', 'unpack.js', 'tar.js'].filter((f) => loaded.includes(f))))"],
  {cwd: path.join(__dirname, '..'), encoding: 'utf8'});
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), []);
});
