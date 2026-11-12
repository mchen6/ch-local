'use strict';
// A pack's packages into <app>/node_modules, from their tarballs, already
// checked against their pins: each is unpacked by the strict reader into a
// staging directory and its package.json checked (the pinned name and version,
// no npm dependencies) before any is moved into place. A failure leaves
// node_modules as it was.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {extractPackage} = require('./tar');

const tarballName = (name, version) => `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;
const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies'];

function checkManifest(dir, name, version) {
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (err) { pkg = null; }
  if (pkg == null || typeof pkg !== 'object') throw new Error(`${name}@${version}: the tarball has no readable package.json`);
  if (pkg.name !== name || pkg.version !== version) throw new Error(`${name}@${version}: the tarball's package.json is ${pkg.name}@${pkg.version}`);
  const declared = DEPENDENCY_FIELDS.filter((f) => pkg[f] != null && (Array.isArray(pkg[f]) ? pkg[f].length > 0 : Object.keys(pkg[f]).length > 0));
  if (declared.length > 0) throw new Error(`${name} declares npm dependencies (${declared.join(', ')}); a pack's packages may have none`);
}

// names: the packages to add, none of which may exist under nodeModules yet.
// -> the names moved into place. Throws with a message naming the package.
function unpackInto(nodeModules, from, names, pins) {
  const stage = path.join(nodeModules, `.ch-local-stage-${crypto.randomBytes(4).toString('hex')}`);
  const moved = [];
  try {
    fs.mkdirSync(stage, {recursive: true});
    const staged = names.map((name, i) => {
      const dir = path.join(stage, String(i));
      try {
        extractPackage(fs.readFileSync(path.join(from, tarballName(name, pins[name].version))), dir);
      } catch (err) {
        throw new Error(`${name}@${pins[name].version}: ${err.message}`);
      }
      checkManifest(dir, name, pins[name].version);
      return {name, dir};
    });
    for (const {name, dir} of staged) {
      const to = path.join(nodeModules, ...name.split('/'));
      if (fs.existsSync(to)) throw new Error(`${name} is already in ${nodeModules}`);
      fs.mkdirSync(path.dirname(to), {recursive: true});
      fs.renameSync(dir, to);
      moved.push(name);
    }
    return moved;
  } catch (err) {
    for (const name of moved) removePackage(nodeModules, name);
    throw err;
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
  }
}

// Removes one package, and its scope directory when that is left empty.
function removePackage(nodeModules, name) {
  const at = path.join(nodeModules, ...name.split('/'));
  fs.rmSync(at, {recursive: true, force: true});
  if (name.startsWith('@')) {
    const scope = path.dirname(at);
    try { if (fs.readdirSync(scope).length === 0) fs.rmdirSync(scope); } catch (err) { /* gone, or not empty */ }
  }
}

module.exports = {unpackInto, removePackage, tarballName, checkManifest};
