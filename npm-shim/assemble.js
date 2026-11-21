#!/usr/bin/env node
'use strict';
// Assembles the seven npm packages from shim.yml's build artifacts:
//   @countinghouse/ch-shim-<os>-<arch>, one per target, holding its binary;
//   @countinghouse/ch-shim, the wrapper, with an exact optionalDependency on
//   each, so npm installs only the one whose os, cpu (and libc) match.
// node npm-shim/assemble.js --version <v> --artifacts <dir> --out <dir>
// <artifacts>/ch-shim-<key>/ holds each target's binary (actions/download-artifact).
const fs = require('fs');
const path = require('path');
const targets = require('./targets');

const ROOT = path.join(__dirname, '..');
const exe = (t) => (t.os === 'win32' ? 'ch-shim.exe' : 'ch-shim');

// The [package] table's version, never another table's version key.
function cargoVersion(file = path.join(ROOT, 'shim', 'Cargo.toml')) {
  const text = fs.readFileSync(file, 'utf8');
  let table = null;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*(#.*)?$/.exec(line);
    if (header) { table = header[1].trim(); continue; }
    const m = /^\s*version\s*=\s*"([^"]+)"\s*(#.*)?$/.exec(line);
    if (m && table === 'package') return m[1];
  }
  return null;
}

function common(version) {
  return {
    version,
    license: 'Apache-2.0',
    repository: {type: 'git', url: 'https://github.com/mchen6/ch-local.git', directory: 'shim'},
    publishConfig: {access: 'public'},
  };
}

// One target's package at dir: bin/<exe> from the binary at `from` (0755)
// and its package.json -- the shape publish makes, and dogfood --release-dir
// makes for this machine's target (A-shim-from). builtFrom: what the binary
// was built from, as its description says it (publish: the target's Rust
// triple). -> dir
function writeTarget(dir, t, version, from, builtFrom = t.rust) {
  fs.mkdirSync(path.join(dir, 'bin'), {recursive: true});
  fs.copyFileSync(from, path.join(dir, 'bin', exe(t)));
  fs.chmodSync(path.join(dir, 'bin', exe(t)), 0o755);
  const pkg = Object.assign({name: `@countinghouse/ch-shim-${t.key}`,
    description: `ch-shim for ${t.key} (built from ${builtFrom}); installed by @countinghouse/ch-shim`},
  common(version), {os: [t.os], cpu: [t.cpu], files: ['bin/']});
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return dir;
}

function assemble({version, artifacts, out, cargoToml}) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error(`version ${version}: a release x.y.z only`);
  // 0.0.0 is the scaffold's, which is not wired to a runtime: never published
  if (version === '0.0.0') throw new Error('version 0.0.0 is the unwired scaffold: not for publishing');
  const cargo = cargoVersion(cargoToml);
  if (cargo !== version) throw new Error(`the tag says ${version} but shim/Cargo.toml says ${cargo}`);
  fs.rmSync(out, {recursive: true, force: true});
  for (const t of targets) {
    const from = path.join(artifacts, `ch-shim-${t.key}`, exe(t));
    if (!fs.existsSync(from)) throw new Error(`no binary for ${t.key} at ${from}`);
    writeTarget(path.join(out, `ch-shim-${t.key}`), t, version, from);
  }
  const dir = path.join(out, 'ch-shim');
  fs.mkdirSync(dir, {recursive: true});
  fs.copyFileSync(path.join(__dirname, 'ch-shim', 'index.js'), path.join(dir, 'index.js'));
  fs.copyFileSync(path.join(__dirname, 'targets.js'), path.join(dir, 'targets.js'));
  const pkg = Object.assign({name: '@countinghouse/ch-shim',
    description: "countinghouse's native per-session shim: locate() finds this platform's binary"},
  common(version), {main: 'index.js', files: ['index.js', 'targets.js'],
    optionalDependencies: Object.fromEntries(targets.map((t) => [`@countinghouse/ch-shim-${t.key}`, version]))});
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  return out;
}

if (require.main === module) {
  const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? null : process.argv[i + 1]; };
  try {
    assemble({version: arg('version'), artifacts: arg('artifacts'), out: arg('out')});
  } catch (e) {
    console.error(`assemble: ${e.message}`);
    process.exit(1);
  }
}

module.exports = {assemble, cargoVersion, writeTarget, exe};
