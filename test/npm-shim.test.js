'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {assemble, cargoVersion} = require('../npm-shim/assemble');
const targets = require('../npm-shim/targets');
const {tmp} = require('./fake-io');

const exe = (t) => (t.os === 'win32' ? 'ch-shim.exe' : 'ch-shim');

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
    const version = cargoVersion();
    artifacts(path.join(dir, 'a'));
    const out = assemble({version, artifacts: path.join(dir, 'a'), out: path.join(dir, 'out')});
    for (const t of targets) {
      const pkg = JSON.parse(fs.readFileSync(path.join(out, `ch-shim-${t.key}`, 'package.json'), 'utf8'));
      assert.strictEqual(pkg.name, `@countinghouse/ch-shim-${t.key}`);
      assert.deepStrictEqual([pkg.os, pkg.cpu], [[t.os], [t.cpu]]);
      assert.deepStrictEqual(pkg.libc, t.os === 'linux' ? ['glibc'] : undefined);
      assert.strictEqual(pkg.license, 'Apache-2.0');
      assert.strictEqual(fs.readFileSync(path.join(out, `ch-shim-${t.key}`, 'bin', exe(t)), 'utf8'), `binary for ${t.key}`);
    }
    const wrapper = JSON.parse(fs.readFileSync(path.join(out, 'ch-shim', 'package.json'), 'utf8'));
    assert.strictEqual(wrapper.bin, undefined, 'no JS launcher: ch-local writes the binary path into client configs');
    assert.deepStrictEqual(Object.keys(wrapper.optionalDependencies).sort(), targets.map((t) => `@countinghouse/ch-shim-${t.key}`).sort());
    for (const v of Object.values(wrapper.optionalDependencies)) assert.strictEqual(v, version);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('assemble refuses a missing binary, a version that is not shim/Cargo.toml\'s, and a prerelease', () => {
  const dir = tmp('ch-npm-shim-');
  try {
    artifacts(path.join(dir, 'a'), 'win32-arm64');
    const args = (version) => ({version, artifacts: path.join(dir, 'a'), out: path.join(dir, 'out')});
    assert.throws(() => assemble(args(cargoVersion())), /no binary for win32-arm64/);
    assert.throws(() => assemble(args('9.9.9')), /shim\/Cargo.toml says/);
    assert.throws(() => assemble(args('1.0.0-rc.1')), /a release x.y.z only/);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('binaryPath gives null for a platform with no package installed (it runs the per-session mode)', () => {
  const {binaryPath} = require('../npm-shim/ch-shim');
  assert.strictEqual(binaryPath('linux', 'x64'), null);
  assert.strictEqual(binaryPath('win32', 'arm64'), null);
});
