'use strict';
// Where a module version is in the store (lib/module-store.js, #413 section
// 9.1), and nothing else: what start and the applier read to load from the
// store, without the store's placing code (unpack, the tar reader).
const path = require('node:path');
const {PACKAGE, storeVersion} = require('./names');

function checkName(name, version) {
  if (typeof name !== 'string' || !PACKAGE.test(name)) throw new Error(`${JSON.stringify(name)} is not a package name`);
  if (!storeVersion(version)) throw new Error(`${name}: ${JSON.stringify(version)} is not a version`);
}

// where: layout(). -> <store>/<name>/<version> (a scoped name is two directories)
function versionDir(where, name, version) {
  checkName(name, version);
  return path.join(where.moduleStore, ...name.split('/'), version);
}
const markerFile = (where, name, version) => `${versionDir(where, name, version)}.json`;

// Whether the version looks placed: its directory and its marker there. A
// start's own check before it names the version to the runtime (which
// checks the directory against --modulesRoot itself); placing and
// collection read the marker in full (lib/module-store.js isComplete).
function looksPlaced(where, name, version) {
  const fs = require('node:fs');
  try {
    return fs.lstatSync(versionDir(where, name, version)).isDirectory() && fs.lstatSync(markerFile(where, name, version)).isFile();
  } catch (err) {
    return false;
  }
}

module.exports = {versionDir, markerFile, checkName, looksPlaced};
