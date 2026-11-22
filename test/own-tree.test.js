'use strict';
require('./tmp-dirs');
// B-own-add: an own module's folder judged, hashed and copied into the home
// (lib/own-tree.js; the own-modules design §2.1). Nothing read until the
// walk passes; the copy is what the user's yes binds to.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const tree = require('../lib/own-tree');
const {layout} = require('../lib/home');
const {tmp} = require('./fake-io');

const real = (p) => fs.realpathSync.native(p);
const SVC = 'urn:countinghouse-test:serviceID:toolService';
function writeModule(dir, {name = 'my-tool', role = 'scenario', deps = null, friendlyName = 'my-tool'} = {}) {
  fs.mkdirSync(path.join(dir, 'handlers', 'toolService'), {recursive: true});
  const pkg = {name, version: '1.0.0'};
  if (role != null) pkg.countinghouse = {role};
  if (deps != null) pkg.dependencies = deps;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName, serviceList: {[SVC]: {actionList: [{name: 'run'}]}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'toolService', 'run.js'), 'module.exports = async () => ({output: {ok: true}});\n');
  return dir;
}
const setup = () => {
  const base = real(tmp('ch-owntree-'));
  const where = layout({COUNTINGHOUSE_HOME: path.join(base, 'home')});
  fs.mkdirSync(where.home, {recursive: true});
  return {base, where};
};

// (both path flavours, on every OS: a Windows path's drive is its root,
// never a part of the way -- countinghouse #499's same walk looked up C:\\C:)
test('pathsOnTheWay: each folder from below the root to the path, the root never a part', () => {
  assert.deepStrictEqual(tree.pathsOnTheWay('C:\\Users\\me\\mod', path.win32), ['C:\\Users', 'C:\\Users\\me', 'C:\\Users\\me\\mod']);
  assert.deepStrictEqual(tree.pathsOnTheWay('\\\\server\\share\\mod', path.win32), ['\\\\server\\share\\mod']);
  assert.deepStrictEqual(tree.pathsOnTheWay('/home/me/mod', path.posix), ['/home', '/home/me', '/home/me/mod']);
  assert.deepStrictEqual(tree.pathsOnTheWay('C:\\', path.win32), []);
});

test('a clean folder: its package, its spec and its entries', () => {
  const {base, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const r = tree.checkFolder(dir, where.home);
  assert.deepStrictEqual([r.problems, r.real, r.pkg.name, r.spec.device.friendlyName], [undefined, dir, 'my-tool', 'my-tool']);
  assert.deepStrictEqual(r.entries.map((e) => e.rel), ['api.json', 'handlers', 'handlers/toolService', 'handlers/toolService/run.js', 'package.json']);
});

test('refused: the path, then the walk (nothing read), then the package', () => {
  const {base, where} = setup();
  const work = path.join(base, 'work');
  const cases = [];
  // the path
  const inHome = writeModule(path.join(where.home, '..mine'));
  cases.push([inHome, /inside the ch-local home/]);
  cases.push([base, /holds the ch-local home/]);
  const realDir = writeModule(path.join(work, 'real'));
  fs.symlinkSync(realDir, path.join(work, 'linked'), 'dir');
  cases.push([path.join(work, 'linked'), /goes through a link/]);
  cases.push([path.join(work, 'nowhere'), /not there/]);
  // the walk: a link to a home file never read
  const secret = path.join(where.home, 'credential.json');
  fs.writeFileSync(secret, JSON.stringify({name: 'LEAKED'}));
  const pkgLink = writeModule(path.join(work, 'pkg-link'));
  fs.rmSync(path.join(pkgLink, 'package.json'));
  fs.symlinkSync(secret, path.join(pkgLink, 'package.json'));
  cases.push([pkgLink, /holds a link \(package\.json\)/]);
  // a link's name with an escape in it is said with ? (the reviewer's high on
  // #113; Windows allows no control character in a name, so not there)
  if (process.platform !== 'win32') {
    const odd = writeModule(path.join(work, 'odd'));
    fs.symlinkSync(secret, path.join(odd, 'x\u001b[2Ky'));
    cases.push([odd, /holds a link \(x\?\[2Ky\)/]);
  }
  const twice = writeModule(path.join(work, 'twice'));
  fs.rmSync(path.join(twice, 'package.json'));
  fs.linkSync(secret, path.join(twice, 'package.json'));
  cases.push([twice, /second name \(package\.json\)/]);
  const nm = writeModule(path.join(work, 'nm'));
  fs.mkdirSync(path.join(nm, 'node_modules'));
  cases.push([nm, /node_modules/]);
  const native = writeModule(path.join(work, 'native'));
  fs.writeFileSync(path.join(native, 'addon.node'), '');
  cases.push([native, /native code/]);
  // the package
  cases.push([writeModule(path.join(work, 'deps'), {deps: {a: '1'}}), /npm dependencies/]);
  cases.push([writeModule(path.join(work, 'role'), {role: null}), /is a scenario/]);
  cases.push([writeModule(path.join(work, 'scope'), {name: '@countinghouse/x'}), /@countinghouse\/ scope/]);
  // a version that would move the terminal's cursor (or hide a line of the
  // question) is no version: refused
  const ctl = writeModule(path.join(work, 'ctl'));
  fs.writeFileSync(path.join(ctl, 'package.json'), JSON.stringify({name: 'my-tool', version: '1.0.0\r\u001b[2K', countinghouse: {role: 'scenario'}}));
  cases.push([ctl, /package\.json's version is not a plain version/]);
  // a name Windows would trim to another's (the reviewer's high on #113, 1)
  cases.push([writeModule(path.join(work, 'dot'), {name: 'my-tool.'}), /package\.json's name ends in a dot/]);
  for (const [dir, want] of cases) {
    const r = tree.checkFolder(dir, where.home);
    assert.ok(Array.isArray(r.problems) && r.problems.some((p) => want.test(p)), `${dir}: ${JSON.stringify(r.problems)}`);
    assert.ok(!JSON.stringify(r.problems).includes('LEAKED'));
  }
});

test('a FIFO in the folder blocks the read', {skip: process.platform === 'win32'}, () => {
  const {base, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'fifo'));
  fs.rmSync(path.join(dir, 'api.json'));
  require('node:child_process').execFileSync('mkfifo', [path.join(dir, 'api.json')]);
  const r = tree.checkFolder(dir, where.home);
  assert.ok(r.problems.some((p) => /neither a file nor a folder \(api\.json\)/.test(p)), JSON.stringify(r.problems));
});

test('the tree hash: the same for the same tree; another for a changed byte or executable bit', () => {
  const {base, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'h'));
  const hash = () => tree.treeHash(dir, tree.checkFolder(dir, where.home).entries);
  const first = hash();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.strictEqual(hash(), first);
  fs.appendFileSync(path.join(dir, 'handlers', 'toolService', 'run.js'), '// changed\n');
  const second = hash();
  assert.notStrictEqual(second, first);
  if (process.platform !== 'win32') {
    fs.chmodSync(path.join(dir, 'handlers', 'toolService', 'run.js'), 0o755);
    assert.notStrictEqual(hash(), second);
  }
});

test('the copy: placed under its hash with its marker; refused when the folder no longer hashes so; a changed copy is not intact', () => {
  const {base, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'c'));
  const r = tree.checkFolder(dir, where.home);
  const h = tree.treeHash(dir, r.entries);
  const copy = tree.placeCopy(where, 'my-tool', r.real, r.entries, h);
  assert.strictEqual(copy, path.join(where.own, 'my-tool', h));
  assert.strictEqual(fs.readFileSync(path.join(copy, 'package.json'), 'utf8'), fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.strictEqual(tree.copyIntact(where, 'my-tool', h), true);
  // the user's folder changes after it was hashed: the copy is refused
  // (another module: its tree is not the first's)
  const other = writeModule(path.join(base, 'work', 'c2'), {name: 'my-other', friendlyName: 'my-other'});
  const r2 = tree.checkFolder(other, where.home);
  const h2 = tree.treeHash(other, r2.entries);
  fs.appendFileSync(path.join(other, 'api.json'), ' ');
  assert.notStrictEqual(h2, h);
  assert.throws(() => tree.placeCopy(where, 'my-other', r2.real, r2.entries, h2), (e) => e.code === 'OWN_TREE_CHANGED');
  assert.strictEqual(fs.existsSync(path.join(where.own, 'my-other', h2)), false, 'nothing placed');
  // a copy changed after it was placed is not intact
  // (read-only: changing it takes a chmod first, as a client's permission
  // prompt sees)
  fs.chmodSync(path.join(copy, 'api.json'), 0o644);
  fs.appendFileSync(path.join(copy, 'api.json'), ' ');
  assert.strictEqual(tree.copyIntact(where, 'my-tool', h), false);
});

// the reviewer's high on #113, 2 (design §2.1 step 4): the copy is read-only
// -- its files, and on POSIX its folders -- so a change to it takes an
// explicit chmod first; ch-local's own deletes make it writable first
// E10 (A-own-gone): gone only when the copy's directory is not there at
// all; there but not intact is changed, whatever is wrong with it
test('copyState: intact; changed when edited or its marker is gone; gone only when its directory is not there', () => {
  const {base, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'c'));
  const r = tree.checkFolder(dir, where.home);
  const h = tree.treeHash(dir, r.entries);
  const copy = tree.placeCopy(where, 'my-tool', r.real, r.entries, h);
  assert.strictEqual(tree.copyState(where, 'my-tool', h), 'intact');
  fs.renameSync(tree.markerOf(where, 'my-tool', h), `${tree.markerOf(where, 'my-tool', h)}.aside`);
  assert.strictEqual(tree.copyState(where, 'my-tool', h), 'changed', 'its marker gone, the copy there');
  fs.renameSync(`${tree.markerOf(where, 'my-tool', h)}.aside`, tree.markerOf(where, 'my-tool', h));
  tree.unlockTree(copy);
  fs.rmSync(copy, {recursive: true});
  assert.strictEqual(tree.copyState(where, 'my-tool', h), 'gone');
  assert.strictEqual(tree.copyState(where, 'never-added', h), 'gone', 'nothing there at all');
});

test('the copy is read-only; unlockTree makes it removable again, following no link', () => {
  const {base, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'ro'));
  const r = tree.checkFolder(dir, where.home);
  const h = tree.treeHash(dir, r.entries);
  const copy = tree.placeCopy(where, 'my-tool', r.real, r.entries, h);
  const file = path.join(copy, 'handlers', 'toolService', 'run.js');
  assert.strictEqual(fs.statSync(file).mode & 0o222, 0, 'a file is read-only');
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(path.join(copy, 'handlers')).mode & 0o222, 0, 'a folder is read-only');
    assert.throws(() => fs.writeFileSync(path.join(copy, 'new.js'), 'x'), (e) => e.code === 'EACCES');
  }
  assert.throws(() => fs.appendFileSync(file, 'x'), (e) => e.code === 'EACCES' || e.code === 'EPERM');
  assert.strictEqual(tree.copyIntact(where, 'my-tool', h), true, 'read-only, still whole');
  // unlockTree: writable again, never through a link
  const outside = path.join(base, 'outside.txt');
  fs.writeFileSync(outside, 'x');
  fs.chmodSync(outside, 0o444);
  tree.unlockTree(copy);
  fs.rmSync(copy, {recursive: true});
  assert.strictEqual(fs.existsSync(copy), false);
  assert.strictEqual(fs.statSync(outside).mode & 0o222, 0, 'nothing outside touched');
});

// the medium on #113's round 1
test('a folder that cannot be read is named with ?, never its raw name', {skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0)}, () => {
  const {base, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'unreadable'));
  const odd = path.join(dir, 'x\u001b[2Jy');
  fs.mkdirSync(odd);
  fs.chmodSync(odd, 0o000);
  try {
    const r = tree.checkFolder(dir, where.home);
    assert.ok(r.problems.some((p) => p.includes('x?[2Jy cannot be read')) && !JSON.stringify(r.problems).includes('\u001b'), JSON.stringify(r.problems));
  } finally { fs.chmodSync(odd, 0o755); }
});

test('a repair that fails leaves the old copy marked and read-only', () => {
  const {base, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'rep'));
  const r = tree.checkFolder(dir, where.home);
  const h = tree.treeHash(dir, r.entries);
  const copy = tree.placeCopy(where, 'my-tool', r.real, r.entries, h);
  fs.chmodSync(path.join(copy, 'api.json'), 0o644);
  fs.appendFileSync(path.join(copy, 'api.json'), ' ');
  fs.chmodSync(path.join(copy, 'api.json'), 0o444);
  // the source changes too: the stage won't hash to h
  fs.appendFileSync(path.join(dir, 'api.json'), ' ');
  assert.throws(() => tree.placeCopy(where, 'my-tool', r.real, r.entries, h), (e) => e.code === 'OWN_TREE_CHANGED');
  assert.ok(fs.existsSync(tree.markerOf(where, 'my-tool', h)), 'the marker stays');
  assert.strictEqual(fs.statSync(path.join(copy, 'handlers', 'toolService', 'run.js')).mode & 0o222, 0, 'still read-only');
});

test('chmodNoFollow never changes a link\'s target', {skip: process.platform === 'win32'}, () => {
  const {base} = setup();
  const target = path.join(base, 'target.txt');
  fs.writeFileSync(target, 'x');
  fs.chmodSync(target, 0o444);
  const link = path.join(base, 'link');
  fs.symlinkSync(target, link);
  assert.throws(() => tree.chmodNoFollow(link, 0o644), (e) => e.code === 'ELOOP' || e.code === 'EMLINK');
  assert.strictEqual(fs.statSync(target).mode & 0o222, 0);
});

// the reviewer's re-probe of #113: a repair whose unlock fails leaves the
// old copy marked (unlocked first, the marker removed after)
test('a repair whose unlock fails keeps the old copy\'s marker', {skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0)}, () => {
  const {base, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'unl'));
  const r = tree.checkFolder(dir, where.home);
  const h = tree.treeHash(dir, r.entries);
  const copy = tree.placeCopy(where, 'my-tool', r.real, r.entries, h);
  const file = path.join(copy, 'api.json');
  fs.chmodSync(file, 0o000);
  try {
    assert.throws(() => tree.placeCopy(where, 'my-tool', r.real, r.entries, h), (e) => e.code === 'EACCES');
    assert.ok(fs.existsSync(tree.markerOf(where, 'my-tool', h)), 'the marker stays');
  } finally { fs.chmodSync(file, 0o444); }
});

// the reviewer on #113 at 10220b9: fchmod on a handle opened to read is
// refused on Windows (EPERM), so the read-only lock never worked there. The
// Windows branch, taken by its platform argument, pinned on every OS: a
// file made read-only and back; a link refused (where this OS can make one)
for (const platform of ['win32', 'posix']) {
  test(`chmodNoFollow (${platform}): a file read-only and back; a link refused, its target unchanged`, () => {
    const {base} = setup();
    const file = path.join(base, 'f.txt');
    fs.writeFileSync(file, 'x');
    if (platform === 'posix' && process.platform === 'win32') return;   // (the POSIX branch needs O_NOFOLLOW)
    // (as Windows answers fchmod on a handle opened to read: the Windows
    // branch must never need it)
    const realFchmod = fs.fchmodSync;
    if (platform === 'win32') fs.fchmodSync = () => { throw Object.assign(new Error('EPERM: operation not permitted, fchmod'), {code: 'EPERM'}); };
    try {
      tree.chmodNoFollow(file, 0o444, platform);
      assert.strictEqual(fs.statSync(file).mode & 0o222, 0);
      tree.chmodNoFollow(file, 0o644, platform);
      assert.notStrictEqual(fs.statSync(file).mode & 0o200, 0);
    } finally { fs.fchmodSync = realFchmod; }
    const link = path.join(base, 'l');
    try { fs.symlinkSync(file, link); } catch (e) { return; }   // (Windows without the symlink privilege)
    fs.chmodSync(file, 0o644);
    assert.throws(() => tree.chmodNoFollow(link, 0o444, platform), (e) => e.code === 'ELOOP' || e.code === 'EMLINK');
    assert.notStrictEqual(fs.statSync(file).mode & 0o200, 0, 'the target unchanged');
  });
}

test('placeCopy makes each folder it creates under <home>/own private (0700)', {skip: process.platform === 'win32' && 'the home\'s ACL applies'}, () => {
  const {base, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'priv'), {name: '@me/my-tool', friendlyName: 'my-tool'});
  const r = tree.checkFolder(dir, where.home);
  const h = tree.treeHash(dir, r.entries);
  const old = process.umask(0o002);
  try { tree.placeCopy(where, '@me/my-tool', r.real, r.entries, h); } finally { process.umask(old); }
  for (const d of [where.own, path.join(where.own, '@me'), path.join(where.own, '@me', 'my-tool')]) assert.strictEqual(fs.statSync(d).mode & 0o777, 0o700, d);
});

// the /code-review medium on B-own-settings, 3: a file of a copy, read once
// and taken only if the tree it is part of still hashes to the record's
test('readIntact: a copy\'s file as hashed; null once the copy changed', () => {
  const {base, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'ri'));
  const r = tree.checkFolder(dir, where.home);
  const h = tree.treeHash(dir, r.entries);
  const copy = tree.placeCopy(where, 'my-tool', r.real, r.entries, h);
  assert.strictEqual(tree.readIntact(where, 'my-tool', h, 'package.json').toString('utf8'), fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  fs.chmodSync(path.join(copy, 'package.json'), 0o644);
  fs.appendFileSync(path.join(copy, 'package.json'), ' ');
  assert.strictEqual(tree.readIntact(where, 'my-tool', h, 'package.json'), null);
});
