'use strict';
// What a release does with a directory of tarballs, shared by the smoke test
// and scripts/dogfood.js (and, at the first release, the release step): pack
// a package into it, and generate the runtime's lockfile from the manifest
// install writes, so --unreleased-pins (lib/pins.js) takes what these produce.
const fs = require('node:fs');
const path = require('node:path');
const {npm} = require('./npm');
const {appManifest, tarballName} = require('./install');

const LOCK_FLAGS = ['--package-lock-only', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'];

// npm pack of `dir` into `release` -> {name, version, filename, integrity}
// (npm's own sha512 of the tarball).
async function packInto(npmIo, dir, release) {
  const r = await npm(npmIo, ['pack', '--json', '--pack-destination', release], dir);
  if (r.status !== 0) throw new Error(`npm pack of ${dir} failed:\n${String(r.stderr).split('\n').slice(-10).join('\n')}`);
  const {name, version, filename, integrity} = JSON.parse(r.stdout)[0];
  return {name, version, filename, integrity};
}

// The runtime's v3 lockfile, from the runtime tarballs in `release`, built in
// `workDir` (which must not exist). Reaches the npm registry for metadata.
async function runtimeLockfile(npmIo, release, runtime, pins, workDir) {
  fs.mkdirSync(path.join(workDir, 'tarballs'), {recursive: true});
  for (const name of runtime.packages) {
    const file = tarballName(name, pins[name].version);
    fs.copyFileSync(path.join(release, file), path.join(workDir, 'tarballs', file));
  }
  fs.writeFileSync(path.join(workDir, 'package.json'), JSON.stringify(appManifest(runtime, pins)));
  const r = await npm(npmIo, ['install', ...LOCK_FLAGS], workDir);
  if (r.status !== 0) throw new Error(`npm could not lock the runtime:\n${String(r.stderr).split('\n').slice(-10).join('\n')}`);
  return JSON.parse(fs.readFileSync(path.join(workDir, 'package-lock.json'), 'utf8'));
}

module.exports = {packInto, runtimeLockfile};
