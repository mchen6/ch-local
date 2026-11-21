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
  fs.appendFileSync(path.join(copy, 'api.json'), ' ');
  assert.strictEqual(tree.copyIntact(where, 'my-tool', h), false);
});
