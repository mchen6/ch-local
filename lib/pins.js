'use strict';
// The allowlist a command works with: the release's own, or, with
// --unreleased-pins <file> (reviewer, 2026-11-12; development only), the same
// packs with the file's pins and runtime lockfile in place of the release's.
// The file cannot add a pack.
const fs = require('node:fs');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

// -> {allow, unreleased} or {problem}.
function effectiveAllow(allow, unreleasedPins) {
  if (unreleasedPins == null) return {allow, unreleased: false};
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
  if (typeof file.runtimeLockfile.lockfileVersion !== 'number' || !isObject(file.runtimeLockfile.packages)) return bad('runtimeLockfile must be an npm lockfile (lockfileVersion and packages)');
  return {allow: {...allow, pins: file.pins, runtime: {...allow.runtime, lockfile: file.runtimeLockfile}}, unreleased: true};
}

const UNRELEASED_LINE = 'this is an unreleased install (development only); upgrade is refused until a clean install from a release';

module.exports = {effectiveAllow, UNRELEASED_LINE};
