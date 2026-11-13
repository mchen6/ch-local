'use strict';
// The allowlist a command works with: the release's own, or, with
// --unreleased-pins <file> (reviewer, 2026-11-12; development only), the same
// packs with the file's pins and runtime lockfile in place of the release's.
// The file cannot add a pack.
const fs = require('node:fs');
const {tarballName} = require('./unpack');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

// -> {allow, unreleased} or {problem}. env: the command's environment.
function effectiveAllow(allow, unreleasedPins, env = {}) {
  if (unreleasedPins == null) return {allow, unreleased: false};
  // A released launcher carries the flag, so it is behind an explicit switch.
  if (env.CH_LOCAL_DEV !== '1') return {problem: '--unreleased-pins is for development: set CH_LOCAL_DEV=1 to use it'};
  const bad = (why) => ({problem: `--unreleased-pins ${unreleasedPins}: ${why}`});
  let file;
  try { file = JSON.parse(fs.readFileSync(unreleasedPins, 'utf8')); } catch (err) { return bad(`not a readable JSON file (${err.code || 'invalid JSON'})`); }
  const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
  if (!isObject(file) || !isObject(file.pins) || !isObject(file.runtimeLockfile)) return bad('must be {"pins": {...}, "runtimeLockfile": {...}}');
  for (const [name, pin] of Object.entries(file.pins)) {
    if (!isObject(pin) || typeof pin.version !== 'string' || !SEMVER.test(pin.version) || typeof pin.integrity !== 'string' || !SHA512.test(pin.integrity)) {
      return bad(`the pin for ${name} must be {"version": "<x.y.z>", "integrity": "sha512-..."}`);
    }
  }
  // v3 only: an older lockfile's legacy dependencies tree is what npm ci would read, and it is not checked here.
  if (file.runtimeLockfile.lockfileVersion !== 3 || !isObject(file.runtimeLockfile.packages) || file.runtimeLockfile.dependencies !== undefined) {
    return bad('runtimeLockfile must be an npm v3 lockfile (lockfileVersion 3, packages, and no dependencies tree)');
  }
  // Where each locked package comes from (reviewer, 2026-11-12): a runtime
  // package from its own tarball in the release directory (npm resolves
  // file:tarballs/<name> inside the app, where install writes the checked
  // bytes); every dependency from the npm registry, with a sha512 integrity
  // npm ci checks. Nothing from git, another file or another host.
  for (const [key, entry] of Object.entries(file.runtimeLockfile.packages)) {
    if (key === '') continue;
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const top = key === `node_modules/${name}`;
    if (top && allow.runtime.packages.includes(name)) {
      const pin = file.pins[name];
      const want = pin == null ? null : `file:tarballs/${tarballName(name, pin.version)}`;
      if (!isObject(entry) || entry.resolved !== want) return bad(`runtimeLockfile resolves ${name} from ${isObject(entry) ? JSON.stringify(entry.resolved) : 'nothing'}, not its tarball ${want}`);
      if (entry.version !== pin.version) return bad(`runtimeLockfile has ${name} at version ${entry.version}, not its pinned ${pin.version}`);
      if (entry.integrity !== undefined && entry.integrity !== pin.integrity) return bad(`runtimeLockfile's integrity for ${name} is not its pin's`);
      continue;
    }
    if (isObject(entry) && entry.link === true) return bad(`runtimeLockfile links ${key}; nothing may be linked`);
    // A dependency bundled inside a registry tarball is covered by that tarball's integrity.
    if (isObject(entry) && entry.inBundle === true && entry.resolved === undefined) continue;
    if (!isObject(entry) || typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://registry.npmjs.org/') ||
        typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity)) {
      return bad(`runtimeLockfile's ${key} must come from https://registry.npmjs.org/ with a sha512 integrity`);
    }
  }
  return {allow: {...allow, pins: file.pins, runtime: {...allow.runtime, lockfile: file.runtimeLockfile}}, unreleased: true};
}

const UNRELEASED_LINE = 'this is an unreleased install (development only); upgrade is refused until a clean install from a release';

module.exports = {effectiveAllow, UNRELEASED_LINE};
