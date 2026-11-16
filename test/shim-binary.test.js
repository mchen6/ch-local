'use strict';
// shimFor (lib/shim-binary.js): outside a source checkout only the binary
// install verified and placed is used. A ch-shim package Node's own lookup
// by name could find (a parent directory's node_modules, $NODE_PATH) is never
// chosen: not from an installed home, whether the installed shim is absent or
// fails a check; not from code whose place can't be told; and not from a
// checkout, which looks only at fixed paths inside itself.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'lib');
const KEY = `${process.platform}-${process.arch}`;
const EXE = process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim';
const POSIX = {skip: process.platform === 'win32' && 'POSIX modes'};

const roots = [];
test.after(() => { for (const r of roots) fs.rmSync(r, {recursive: true, force: true}); });
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); roots.push(d); return d; };
const linkDir = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');

// a ch-shim wrapper and its platform package under <dir>/node_modules, as a
// stranger could plant them: the wrapper's locate says it found <planted>,
// and the platform package holds a binary
function plant(dir, planted) {
  const nm = path.join(dir, 'node_modules', '@countinghouse');
  fs.mkdirSync(path.join(nm, 'ch-shim'), {recursive: true});
  fs.writeFileSync(path.join(nm, 'ch-shim', 'package.json'), JSON.stringify({name: '@countinghouse/ch-shim', version: '0.0.0', main: 'index.js'}));
  fs.writeFileSync(path.join(nm, 'ch-shim', 'index.js'), `module.exports = {locate: () => ({status: 'found', path: ${JSON.stringify(planted)}})};\n`);
  const pkg = path.join(nm, `ch-shim-${KEY}`);
  fs.mkdirSync(path.join(pkg, 'bin'), {recursive: true});
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name: `@countinghouse/ch-shim-${KEY}`, version: '0.0.0'}));
  fs.writeFileSync(path.join(pkg, 'bin', EXE), '#!/bin/sh\n', {mode: 0o755});
}

// <root>/<sub>/lib, a copy of this lib/ (and npm-shim/ beside it, for a
// checkout), with a stranger's ch-shim where Node's lookup by name reaches
// it: on <root>/node_modules (a parent), or on a NODE_PATH directory
function copied({sub, checkout = false, pins = null, at = 'parent'}) {
  const root = tmp('ch-shimfor-');
  const lib = path.join(root, sub, 'lib');
  fs.cpSync(LIB, lib, {recursive: true});
  if (checkout) fs.cpSync(path.join(ROOT, 'npm-shim'), path.join(root, sub, 'npm-shim'), {recursive: true});
  if (pins != null) {
    const file = path.join(lib, 'release-pins.json');
    fs.writeFileSync(file, pins(JSON.parse(fs.readFileSync(file, 'utf8'))));
  }
  if (at === 'parent') plant(root, path.join(root, 'planted-parent'));
  const np = path.join(tmp('ch-shimfor-np-'), 'np');
  if (at === 'NODE_PATH') plant(np, path.join(np, 'planted-node-path'));
  return {root, lib, nodePath: path.join(np, 'node_modules')};
}

// an installed home: <root>/h, with app/lib the copy
function installedHome(opts = {}) {
  const s = copied(Object.assign({sub: path.join('h', 'app')}, opts));
  s.home = path.join(s.root, 'h');
  fs.chmodSync(s.home, 0o700);
  return s;
}

const PINNED = (doc) => {
  doc.pins[doc.shim.packages[KEY]] = {version: '9.9.9', integrity: `sha512-${'A'.repeat(86)}==`, repository: doc.self.repository,
    repositoryId: doc.self.repositoryId, ownerId: doc.self.ownerId, workflow: '.github/workflows/shim.yml', tag: 'shim-v9.9.9'};
  return JSON.stringify(doc);
};

// a call into a copy, in a process of its own (so NODE_PATH is read as Node
// reads it): shimFor({home}) with the default locate, or defaultLocate()
function callIn(lib, call, nodePath) {
  const mod = JSON.stringify(path.join(lib, 'shim-binary.js'));
  const script = `process.stdout.write(JSON.stringify(require(${mod}).${call}))`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {env: Object.assign({}, process.env, {NODE_PATH: nodePath}), encoding: 'utf8'}));
}
const shimForIn = (s, home = s.home) => callIn(s.lib, `shimFor({home: ${JSON.stringify(home)}})`, s.nodePath);

// a shim there that fails a check: writable by group and others
function looseShim(home) {
  const dir = path.join(home, 'shim');
  fs.mkdirSync(dir, {mode: 0o700});
  fs.writeFileSync(path.join(dir, EXE), '#!/bin/sh\n');
  fs.chmodSync(path.join(dir, EXE), 0o777);
}

test('runsFromHome: by realpath, <home>/app/lib is this code or not; a home or app not there is not', () => {
  const root = tmp('ch-runs-');
  const home = path.join(root, 'h');
  const lib = path.join(home, 'app', 'lib');
  fs.mkdirSync(lib, {recursive: true});
  const {runsFromHome} = require('../lib/shim-binary');
  assert.strictEqual(runsFromHome(home, {libDir: lib}), true);
  assert.strictEqual(runsFromHome(home, {libDir: LIB}), false, 'a source checkout is not the home\'s app');
  assert.strictEqual(runsFromHome(home), false, 'nor is this file, by default');
  assert.strictEqual(runsFromHome(path.join(root, 'none'), {libDir: LIB}), false);
  assert.strictEqual(runsFromHome(null), false);
  // the home's app a link to the code that runs: the same realpath
  const linked = path.join(root, 'linked');
  fs.mkdirSync(linked);
  linkDir(path.join(home, 'app'), path.join(linked, 'app'));
  assert.strictEqual(runsFromHome(linked, {libDir: lib}), true);
  // case-insensitive where the file system usually is
  if (process.platform === 'darwin' || process.platform === 'win32') {
    assert.strictEqual(runsFromHome(home, {libDir: lib.toUpperCase()}), fs.existsSync(lib.toUpperCase()));
  }
});

for (const at of ['parent', 'NODE_PATH']) {
  test(`installed, no shim there, none pinned: a ch-shim planted on ${at} is not chosen; said as this release's per-session mode`, () => {
    const s = installedHome({at});
    const r = shimForIn(s);
    assert.strictEqual(r.shim, null, JSON.stringify(r));
    assert.match(r.note, /this release installs no shared-runtime shim for this platform/);
  });

  test(`installed, no shim there, one pinned: a ch-shim planted on ${at} is not chosen; said as a reinstall`, () => {
    const s = installedHome({at, pins: PINNED});
    const r = shimForIn(s);
    assert.strictEqual(r.shim, null, JSON.stringify(r));
    assert.match(r.note, /shim for this platform is not installed .*reinstall ch-local/);
  });

  test(`installed, a shim there that fails a check: a ch-shim planted on ${at} is not chosen; the problem and a reinstall are said`, POSIX, () => {
    const s = installedHome({at, pins: PINNED});
    looseShim(s.home);
    const r = shimForIn(s);
    assert.strictEqual(r.shim, null, JSON.stringify(r));
    assert.match(r.note, /the installed shim is not used: .*writable by group or others.*reinstall ch-local/s);
    assert.match(r.note, /each session runs its own runtime/);
  });

  test(`code that is neither a checkout nor the home's app (a home elsewhere, a rollback's previous/app): a ch-shim planted on ${at} is not chosen`, () => {
    const s = copied({sub: path.join('h', 'previous', 'app'), at});
    const elsewhere = path.join(tmp('ch-elsewhere-'), 'h');
    for (const home of [path.join(s.root, 'h'), elsewhere]) {
      const r = shimForIn(s, home);
      assert.strictEqual(r.shim, null, JSON.stringify(r));
    }
  });

  test(`a checkout's defaultLocate looks only inside the checkout: a ch-shim planted on ${at} is not found; one in its own node_modules is`, () => {
    const s = copied({sub: 'co', checkout: true, at});
    assert.deepStrictEqual(callIn(s.lib, 'defaultLocate()', s.nodePath), {status: 'missing', package: `@countinghouse/ch-shim-${KEY}`});
    const own = path.join(s.root, 'co', 'node_modules', '@countinghouse', `ch-shim-${KEY}`, 'bin');
    fs.mkdirSync(own, {recursive: true});
    fs.writeFileSync(path.join(own, EXE), '#!/bin/sh\n', {mode: 0o755});
    assert.deepStrictEqual(callIn(s.lib, 'defaultLocate()', s.nodePath), {status: 'found', path: path.join(own, EXE)});
  });
}

test('installed, a release-pins.json that does not parse: said as a reinstall, which repairs it', () => {
  const s = installedHome({pins: () => '{"v": 1'});
  const r = shimForIn(s);
  assert.strictEqual(r.shim, null);
  assert.match(r.note, /reinstall ch-local/);
});

test('installed: a locate passed in is never asked; the shim install placed is used', POSIX, () => {
  const s = installedHome();
  const {shimFor} = require(path.join(s.lib, 'shim-binary.js'));
  let asked = 0;
  const locate = () => { asked += 1; return {status: 'found', path: '/planted'}; };
  assert.strictEqual(shimFor({home: s.home, locate}).shim, null);
  looseShim(s.home);
  assert.strictEqual(shimFor({home: s.home, locate}).shim, null);
  assert.strictEqual(asked, 0);
  fs.chmodSync(path.join(s.home, 'shim', EXE), 0o755);
  assert.strictEqual(shimFor({home: s.home, locate}).shim, path.join(s.home, 'shim', EXE));
});

test('a source checkout (not the home\'s app) still asks its locate, for dev and tests', () => {
  const home = path.join(tmp('ch-checkout-'), 'h');
  const {shimFor} = require('../lib/shim-binary');
  let asked = 0;
  const r = shimFor({home, locate: () => { asked += 1; return {status: 'found', path: '/built/ch-shim'}; }});
  assert.strictEqual(asked, 1);
  assert.strictEqual(r.shim, '/built/ch-shim');
});

test('no published ch-local is a checkout: npm-shim/ is not in its files', () => {
  const files = require('../package.json').files;
  assert.ok(!files.some((f) => f.startsWith('npm-shim')), files.join(', '));
  assert.strictEqual(require('../lib/shim-binary').isCheckout(), true, 'this one is');
});
