'use strict';
// The allowlist a command works with: the release's own, or, with
// --unreleased-pins <file> (reviewer, 2026-11-12; development only), the same
// packs with the file's pins, runtime lockfile and module descriptions in
// place of the release's (#413 section 9.3: install checks each module
// against them). The file cannot add a pack.
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
  let digest;
  try {
    const bytes = fs.readFileSync(unreleasedPins);
    // which pins a pack came from (modules.json packs.<p>.from.unreleased,
    // #413 section 9.2): the first 16 hex digits of the file's SHA-256
    digest = require('node:crypto').createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    file = JSON.parse(bytes.toString('utf8'));
  } catch (err) { return bad(`not a readable JSON file (${err.code || 'invalid JSON'})`); }
  const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
  if (!isObject(file) || !isObject(file.pins) || !isObject(file.runtimeLockfile) || !isObject(file.modules)) {
    return bad('must be {"pins": {...}, "runtimeLockfile": {...}, "modules": {...}} (modules: `node scripts/describe-release.js <tarballs> --unreleased-pins <file>` writes them)');
  }
  for (const [name, pin] of Object.entries(file.pins)) {
    if (!isObject(pin) || typeof pin.version !== 'string' || !SEMVER.test(pin.version) || typeof pin.integrity !== 'string' || !SHA512.test(pin.integrity)) {
      return bad(`the pin for ${name} must be {"version": "<x.y.z>", "integrity": "sha512-..."}`);
    }
  }
  // The lockfile's rules, shared with a released one (lib/lockfile-rules.js,
  // the review of #42): a runtime package from its own tarball at its pin;
  // every dependency from the npm registry with a sha512; nothing linked, from
  // git or another host; a bundled entry only where its runtime parent
  // bundles it (its tarball's contents are checked at install, once read).
  const why = require('./lockfile-rules').lockfileProblem(file.runtimeLockfile, {runtime: allow.runtime.packages, pins: file.pins});
  if (why != null) return bad(why);
  // its own descriptions of the pack modules it pins (the Reviewer on L5b,
  // Q2): checked at install as a release's are, by the release's rule
  // (a runtime package is never described: one a pack lists is refused by
  // the operation itself, in its own words)
  const runtime = new Set((allow.runtime && allow.runtime.packages) || []);
  const pinned = Object.values(allow.packs).flatMap((p) => p.modules).filter((m) => Object.prototype.hasOwnProperty.call(file.pins, m) && !runtime.has(m));
  const described = require('./release-pins').modulesProblem(file.modules, new Set(pinned));
  if (described != null) return bad(described);
  return {allow: {...allow, pins: file.pins, modules: file.modules, runtime: {...allow.runtime, lockfile: file.runtimeLockfile}}, unreleased: true, digest};
}

const UNRELEASED_LINE = 'this is an unreleased install (development only); upgrade is refused until a clean install from a release';

module.exports = {effectiveAllow, UNRELEASED_LINE};
