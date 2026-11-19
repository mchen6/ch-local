'use strict';
require('./tmp-dirs');   // its ch-* temporary directories removed at its end, under any runner
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {assemble, cargoVersion} = require('../npm-shim/assemble');
const targets = require('../npm-shim/targets');
const {tmp} = require('./fake-io');

const exe = (t) => (t.os === 'win32' ? 'ch-shim.exe' : 'ch-shim');

// A Cargo.toml of the test's own: [package] at `version`, and a decoy
// version key in another table, which must never be read.
function cargoToml(dir, version) {
  const file = path.join(dir, 'Cargo.toml');
  fs.writeFileSync(file, `[workspace.package]\nversion = "9.9.9"\n\n[package]\nname = "ch-shim"\nversion = "${version}"\n`);
  return file;
}

function artifacts(dir, skip) {
  for (const t of targets) {
    if (t.key === skip) continue;
    fs.mkdirSync(path.join(dir, `ch-shim-${t.key}`), {recursive: true});
    fs.writeFileSync(path.join(dir, `ch-shim-${t.key}`, exe(t)), `binary for ${t.key}`);
  }
}

test('assemble makes six platform packages and a wrapper with an exact optionalDependency on each', () => {
  const dir = tmp('ch-npm-shim-');
  try {
    // a version of the test's own, in a copy of the tree: 0.0.0 (the
    // scaffold's) is refused
    const version = '1.2.3';
    artifacts(path.join(dir, 'a'));
    const out = assemble({version, artifacts: path.join(dir, 'a'), out: path.join(dir, 'out'), cargoToml: cargoToml(dir, version)});
    for (const t of targets) {
      const pkg = JSON.parse(fs.readFileSync(path.join(out, `ch-shim-${t.key}`, 'package.json'), 'utf8'));
      assert.strictEqual(pkg.name, `@countinghouse/ch-shim-${t.key}`);
      assert.deepStrictEqual([pkg.os, pkg.cpu], [[t.os], [t.cpu]]);
      assert.strictEqual(pkg.libc, undefined, 'the Linux builds are static');
      assert.strictEqual(pkg.license, 'Apache-2.0');
      assert.strictEqual(fs.readFileSync(path.join(out, `ch-shim-${t.key}`, 'bin', exe(t)), 'utf8'), `binary for ${t.key}`);
    }
    const wrapper = JSON.parse(fs.readFileSync(path.join(out, 'ch-shim', 'package.json'), 'utf8'));
    assert.strictEqual(wrapper.bin, undefined, 'no JS launcher: ch-local writes the binary path into client configs');
    assert.ok(fs.existsSync(path.join(out, 'ch-shim', 'targets.js')), 'the wrapper carries the target list locate() reads');
    assert.deepStrictEqual(Object.keys(wrapper.optionalDependencies).sort(), targets.map((t) => `@countinghouse/ch-shim-${t.key}`).sort());
    for (const v of Object.values(wrapper.optionalDependencies)) assert.strictEqual(v, version);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('assemble refuses a missing binary, a version that is not [package]\'s, a prerelease, and the scaffold\'s 0.0.0', () => {
  const dir = tmp('ch-npm-shim-');
  try {
    artifacts(path.join(dir, 'a'), 'win32-arm64');
    const args = (version, cargo = version) => ({version, artifacts: path.join(dir, 'a'), out: path.join(dir, 'out'), cargoToml: cargoToml(dir, cargo)});
    assert.throws(() => assemble(args('1.2.3')), /no binary for win32-arm64/);
    assert.throws(() => assemble(args('9.9.9', '1.2.3')), /shim\/Cargo.toml says 1.2.3/, 'the decoy 9.9.9 is not [package]\'s');
    assert.throws(() => assemble(args('1.0.0-rc.1')), /a release x.y.z only/);
    assert.throws(() => assemble(args('0.0.0')), /unwired scaffold/);
    assert.strictEqual(cargoVersion(), '0.0.0', 'the scaffold itself is 0.0.0');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('locate tells a supported platform whose package is missing from an unsupported one', () => {
  const {locate} = require('../npm-shim/ch-shim');
  // none of the platform packages is installed in this repository
  assert.deepStrictEqual(locate('linux', 'x64'), {status: 'missing', package: '@countinghouse/ch-shim-linux-x64'});
  assert.deepStrictEqual(locate('win32', 'arm64'), {status: 'missing', package: '@countinghouse/ch-shim-win32-arm64'});
  assert.deepStrictEqual(locate('freebsd', 'x64'), {status: 'unsupported'});
  assert.deepStrictEqual(locate('linux', 'ia32'), {status: 'unsupported'});
});
