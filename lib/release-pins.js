'use strict';
// What a release pins, as data (docs/development/auto-upgrade.md, "The trust
// chain", step 5): lib/release-pins.json, never code, so a new release's pins
// are read from its verified tarball's bytes in memory, and nothing of it runs
// before it is installed. lib/allowlist.js reads this release's own copy.
//
//   {v: 1,
//    release: {security: {fixes} | null},
//    self: {repository, repositoryId, ownerId, workflow},
//    runtime: {packages: ["@countinghouse/ch-local", "countinghouse"], lockfile: <npm v3 lockfile> | null},
//    packs: {<pack>: {packages: [<name>...], credentials: [<VARIABLE>...]}},
//    allowedOrigins: {<https origin>: [<VARIABLE>...]},
//    pins: {<name>: {version, integrity, repository, repositoryId, ownerId, workflow, tag}}}
//
// self is ch-local's own identity. A release can't pin its own digest (its
// tarball holds this file), so ch-local's pin is the digest its provenance
// verifies, with this identity and the tag v<version>; no pin may name it.
// The key sets are exact, at every level. A pin names a package of this
// release (the runtime's or a pack's), a strict MAJOR.MINOR.PATCH version, a
// sha512, and the identity its provenance must carry (lib/provenance.js).
// The runtime's lockfile, when present, is npm's v3. Its entries are checked
// at install, where ch-local's own entry is filled in from its verified
// digest.
const MAX_BYTES = 1024 * 1024;
const STRICT = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const PACK = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const TAG = /^[A-Za-z0-9_.-]+$/;
const RUNTIME = ['@countinghouse/ch-local', 'countinghouse'];

const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const keysAre = (o, keys) => isObject(o) && JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());
const listOf = (a, re, {nonEmpty = false} = {}) => Array.isArray(a) && (!nonEmpty || a.length > 0) && a.every((x) => typeof x === 'string' && re.test(x)) && new Set(a).size === a.length;

const deepFreeze = (v) => {
  if (v != null && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};

function pinProblem(name, p) {
  if (!keysAre(p, ['version', 'integrity', 'repository', 'repositoryId', 'ownerId', 'workflow', 'tag'])) return `the pin for ${name} must be exactly {version, integrity, repository, repositoryId, ownerId, workflow, tag}`;
  if (typeof p.version !== 'string' || !STRICT.test(p.version)) return `the pin for ${name} has no strict MAJOR.MINOR.PATCH version`;
  if (typeof p.integrity !== 'string' || !SHA512.test(p.integrity)) return `the pin for ${name} has no sha512 integrity`;
  if (typeof p.repository !== 'string' || !REPOSITORY.test(p.repository)) return `the pin for ${name} names no repository`;
  for (const k of ['repositoryId', 'ownerId']) if (!Number.isSafeInteger(p[k]) || p[k] <= 0) return `the pin for ${name} has no numeric ${k}`;
  if (typeof p.workflow !== 'string' || !WORKFLOW.test(p.workflow)) return `the pin for ${name} names no workflow`;
  if (typeof p.tag !== 'string' || !TAG.test(p.tag)) return `the pin for ${name} names no tag`;
  return null;
}

// a parsed document, checked -> its problem, or null
function documentProblem(d) {
  if (!keysAre(d, ['v', 'release', 'self', 'runtime', 'packs', 'allowedOrigins', 'pins'])) return 'must be exactly {v, release, self, runtime, packs, allowedOrigins, pins}';
  if (d.v !== 1) return `v must be 1, not ${JSON.stringify(d.v)}`;
  if (!keysAre(d.release, ['security'])) return 'release must be exactly {security}';
  if (d.release.security !== null && !(keysAre(d.release.security, ['fixes']) && typeof d.release.security.fixes === 'string' && d.release.security.fixes.length <= 500)) {
    return 'release.security must be null or {fixes: <text>}';
  }
  if (!keysAre(d.self, ['repository', 'repositoryId', 'ownerId', 'workflow'])) return 'self must be exactly {repository, repositoryId, ownerId, workflow}';
  if (typeof d.self.repository !== 'string' || !REPOSITORY.test(d.self.repository)) return 'self names no repository';
  for (const k of ['repositoryId', 'ownerId']) if (!Number.isSafeInteger(d.self[k]) || d.self[k] <= 0) return `self has no numeric ${k}`;
  if (typeof d.self.workflow !== 'string' || !WORKFLOW.test(d.self.workflow)) return 'self names no workflow';
  if (!keysAre(d.runtime, ['packages', 'lockfile'])) return 'runtime must be exactly {packages, lockfile}';
  if (JSON.stringify(d.runtime.packages) !== JSON.stringify(RUNTIME)) return `runtime.packages must be ${JSON.stringify(RUNTIME)}`;
  const lock = d.runtime.lockfile;
  if (lock !== null && !(isObject(lock) && lock.lockfileVersion === 3 && isObject(lock.packages) && lock.dependencies === undefined)) {
    return 'runtime.lockfile must be null or an npm v3 lockfile (lockfileVersion 3, packages, no dependencies tree)';
  }
  if (!isObject(d.packs) || Object.keys(d.packs).length === 0) return 'packs must name at least one pack';
  for (const [name, p] of Object.entries(d.packs)) {
    if (!PACK.test(name)) return `the pack name ${JSON.stringify(name)} is not one`;
    if (!keysAre(p, ['packages', 'credentials'])) return `the pack ${name} must be exactly {packages, credentials}`;
    if (!listOf(p.packages, PACKAGE, {nonEmpty: true})) return `the pack ${name} must list its packages, each once`;
    if (!listOf(p.credentials, VARIABLE)) return `the pack ${name}'s credentials must be variable names, each once`;
  }
  if (!isObject(d.allowedOrigins)) return 'allowedOrigins must be an object';
  for (const [origin, vars] of Object.entries(d.allowedOrigins)) {
    if (!ORIGIN.test(origin)) return `${JSON.stringify(origin)} is not an https origin`;
    if (!listOf(vars, VARIABLE, {nonEmpty: true})) return `the origin ${origin} must list the variables it may receive, each once`;
  }
  if (!isObject(d.pins)) return 'pins must be an object';
  const known = new Set([...d.runtime.packages, ...Object.values(d.packs).flatMap((p) => p.packages)]);
  for (const [name, p] of Object.entries(d.pins)) {
    if (name === RUNTIME[0]) return `no pin may name ${RUNTIME[0]}: its digest is the one its provenance verifies (self)`;
    if (!known.has(name)) return `the pin for ${name} names no package of this release`;
    const why = pinProblem(name, p);
    if (why != null) return why;
  }
  return null;
}

// a document (an object, or the bytes of one) -> {pins} (frozen) or {problem}
function parseReleasePins(input) {
  let doc = input;
  if (Buffer.isBuffer(input)) {
    if (input.length > MAX_BYTES) return {problem: `release-pins.json is over ${MAX_BYTES} bytes`};
    try {
      doc = JSON.parse(input.toString('utf8'));
    } catch (e) {
      return {problem: 'release-pins.json is not JSON'};
    }
  }
  const why = documentProblem(doc);
  if (why != null) return {problem: `release-pins.json: ${why}`};
  return {pins: deepFreeze(JSON.parse(JSON.stringify(doc)))};
}

// What `next` adds over `now` that the user must agree to (docs/development/
// auto-upgrade.md, step 5), for the packs the user has installed: a package in
// one, a credential for one, a new origin, or a variable sent to an existing
// one. A pack not installed, and anything removed, asks nothing.
// -> [one line each]
function additions(now, next, installed) {
  const out = [];
  for (const pack of installed) {
    const a = now.packs[pack];
    const b = next.packs[pack];
    if (b == null) continue;
    for (const p of b.packages) if (a == null || !a.packages.includes(p)) out.push(`a package in ${pack}: ${p}`);
    for (const c of b.credentials) if (a == null || !a.credentials.includes(c)) out.push(`a credential for ${pack}: ${c}`);
  }
  for (const [origin, vars] of Object.entries(next.allowedOrigins)) {
    const had = now.allowedOrigins[origin];
    if (had == null) { out.push(`an origin: ${origin}`); continue; }
    for (const v of vars) if (!had.includes(v)) out.push(`${v} sent to ${origin}`);
  }
  return out;
}

module.exports = {parseReleasePins, additions, MAX_BYTES};
