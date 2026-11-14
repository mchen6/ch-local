'use strict';
// Each pack version in a tree of its own (packs in place, part 2, plan Task
// B1): <home>/packs/<name>/<key>/node_modules holds the pack's packages. The
// key is its scenario's version and a short hash of every package@version it
// holds (packKey), since a release can change a part and not the scenario. A running start keeps the tree it loaded
// while another version is installed beside it; versions no live start uses
// are collected (lib/gc.js). The runtime stays in <home>/app.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {unpackInto} = require('./unpack');

// packages: {name: version}, the scenario first. -> '0.1.0+1a2b3c4d'.
function packKey(packages) {
  const names = Object.keys(packages);
  const hash = crypto.createHash('sha256').update(names.slice().sort().map((n) => `${n}@${packages[n]}`).join('\n')).digest('hex').slice(0, 8);
  return `${packages[names[0]]}+${hash}`;
}

const packDir = (where, name, key) => path.join(where.packsDir, name, key);

// The pack's packages unpacked into its version's tree, built beside it and
// renamed into place whole. A tree already there is kept: its packages are
// the same pinned bytes. -> the tree's directory.
function placePack(where, name, bytes, packages, pins) {
  const dir = packDir(where, name, packKey(Object.fromEntries(packages.map((n) => [n, pins[n].version]))));
  if (fs.existsSync(path.join(dir, 'node_modules'))) return dir;
  const build = `${dir}.new-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.mkdirSync(path.join(build, 'node_modules'), {recursive: true});
    unpackInto(path.join(build, 'node_modules'), bytes, packages, pins);
    fs.rmSync(dir, {recursive: true, force: true});
    fs.renameSync(build, dir);
  } finally {
    fs.rmSync(build, {recursive: true, force: true});
  }
  return dir;
}

// Where a recorded pack's packages ({name: version}) are: its tree, or, in a
// home an earlier ch-local made, the flat app. -> the directory holding
// node_modules.
function packBase(where, name, packages) {
  if (where.packsDir == null || Object.keys(packages || {}).length === 0) return where.app;
  const dir = packDir(where, name, packKey(packages));
  return fs.existsSync(path.join(dir, 'node_modules')) ? dir : where.app;
}

module.exports = {packKey, packDir, placePack, packBase};
