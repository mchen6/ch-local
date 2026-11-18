'use strict';
// A module's package from its tarball, already checked against its pin:
// unpacked by the strict reader (lib/tar.js: files and directories only, no
// link) and its package.json checked (the pinned name and version, no npm
// dependencies). The module store's staging step (lib/module-store.js).
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

// One package unpacked into dir (which must not exist yet), from its tarball
// already checked against its pin, and its package.json checked: the pinned
// name and version, no npm dependencies. The module store's staging step
// (lib/module-store.js). Throws with a message naming the package; a failure
// leaves no dir.
function unpackOne(dir, bytes, name, version) {
  try {
    extractPackage(bytes, dir);
  } catch (err) {
    throw new Error(`${name}@${version}: ${err.message}`);
  }
  try {
    checkManifest(dir, name, version);
  } catch (err) {
    fs.rmSync(dir, {recursive: true, force: true});
    throw err;
  }
}

module.exports = {unpackOne, tarballName, checkManifest};
