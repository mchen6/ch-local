'use strict';
// <home>/modules.json: what the home holds, by module (module-level install,
// #413 section 9.2). It replaces packs.json (lib/record.js) once install
// writes it (L1a-2); the file name changes so no older reader takes the new
// shape for its own.
//
//   {v: 2,
//    runtime: {versions: {name: version}},
//    release: {version, security: null | {fixes}},
//    unreleased: true|false,
//    packs: {<pack>: {from: {release: <ch-local version>} | {unreleased: <16 hex>},
//                     modules: {<module>: <version>}}},
//    modules: {<module>: {version, role: 'scenario' | 'part' | null}},
//    withdrawn: [<module>, ...],
//    held: {<pack>: {from, modules}},
//    shim?: {package, version}, at}
//
// - packs.<p>.from: the pins the pack was installed from: a release, or a
//   development pins file (the first 16 hex digits of its SHA-256).
// - packs.<p>.modules: the version of each module the pack was installed with.
// - modules: derived from packs: the highest version any installed pack
//   records for a module (in a released home, the one they all record: the
//   pin), and that version's countinghouse.role. Written so that readers need
//   no version arithmetic (the runtime's settings tool reads it); a record
//   whose modules is not what its packs give is refused.
// - withdrawn: derived; the recorded modules no pack of the record's release
//   lists (section 9.7), for a start still running from another release.
// - held: packs a release rollback's restored release does not have:
//   recorded, never loaded, removed by remove-pack.
const fs = require('node:fs');
const {writeAtomic} = require('./atomic');
const {VERSION, PACKAGE} = require('./module-store');

const PACK = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UNRELEASED = /^[0-9a-f]{16}$/;
const ROLES = new Set(['scenario', 'part', null]);
const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// Semver precedence (build metadata ignored), so "highest" is the one npm
// means. -> <0, 0, >0
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = String(v).split('+')[0].split(/-(.*)/s);
    return {nums: core.split('.').map(Number), pre: pre == null || pre === '' ? null : pre.split('.')};
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre == null || y.pre == null) return (x.pre == null ? 1 : 0) - (y.pre == null ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i >= x.pre.length) return -1;
    if (i >= y.pre.length) return 1;
    const [p, q] = [x.pre[i], y.pre[i]];
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// packs -> {<module>: the highest version any pack records}
function highest(packs) {
  const out = {};
  for (const p of Object.values(packs)) {
    for (const [m, v] of Object.entries(p.modules)) if (!own(out, m) || compareVersions(v, out[m]) > 0) out[m] = v;
  }
  return out;
}

// The derived modules: each one's active version and that version's role.
// roleOf(name, version) -> 'scenario' | 'part' | null (lib/module-store.js's,
// with the home's layout bound).
function derive(packs, roleOf) {
  return Object.fromEntries(Object.entries(highest(packs)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([m, version]) => [m, {version, role: roleOf(m, version)}]));
}

// The recorded modules no pack of `release` lists: a module is withdrawn when
// the release does not ship it (section 9.7). A development record is exempt.
// release: the pins' (version 1 lists a pack's packages, version 2 its
// modules). -> sorted names.
function withdrawnOf(record, release) {
  if (record.unreleased === true) return [];
  const listed = new Set();
  for (const p of Object.values((release != null && release.packs) || {})) {
    for (const m of (Array.isArray(p.modules) ? p.modules : (Array.isArray(p.packages) ? p.packages : []))) listed.add(m);
  }
  return Object.keys(highest(record.packs)).filter((m) => !listed.has(m)).sort();
}

// -> the module's active version (section 9.2), or null when no pack records it
function activeVersion(record, name) {
  return own(record.modules, name) ? record.modules[name].version : null;
}

const recordOf = (where) => where.modulesRecord;
const EARLIER = 'this home was made by an earlier ch-local; run `ch-local install` again';

// -> the record, or null when nothing is installed. Throws when it cannot be
// read, or when only an earlier ch-local's packs.json is there (an install
// migrates it, section 10).
function readModulesRecord(where) {
  if (where.journal != null && fs.existsSync(where.journal)) {
    throw new Error('a rollback was interrupted; run `ch-local rollback` to finish it');
  }
  const file = recordOf(where);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${file} is not readable (${err.code}); run \`ch-local install\` again`);
    // a migration cut short leaves both: modules.json is the one taken
    if (where.packs != null && fs.existsSync(where.packs)) throw new Error(EARLIER);
    return null;
  }
  let r;
  try { r = JSON.parse(raw); } catch (err) { r = null; }
  const problem = shapeProblem(r);
  if (problem != null) throw new Error(`${file} is not a ch-local record (${problem}); run \`ch-local install\` again`);
  return {
    v: 2,
    runtime: {versions: {...r.runtime.versions}},
    release: r.release != null ? r.release : null,
    unreleased: r.unreleased === true,
    packs: r.packs,
    modules: r.modules,
    withdrawn: r.withdrawn,
    held: r.held != null ? r.held : {},
    ...(r.shim !== undefined ? {shim: {package: r.shim.package, version: r.shim.version}} : {}),
    at: r.at
  };
}

// -> why r is not a version 2 record, or null
function shapeProblem(r) {
  const versions = (x, {nonEmpty = false} = {}) => isObject(x) && (!nonEmpty || Object.keys(x).length > 0) &&
    Object.entries(x).every(([n, v]) => PACKAGE.test(n) && typeof v === 'string' && VERSION.test(v));
  const from = (f) => isObject(f) && Object.keys(f).length === 1 &&
    ((typeof f.release === 'string' && VERSION.test(f.release)) || (typeof f.unreleased === 'string' && UNRELEASED.test(f.unreleased)));
  const pack = (p) => isObject(p) && from(p.from) && versions(p.modules, {nonEmpty: true});
  const packs = (o) => isObject(o) && Object.entries(o).every(([n, p]) => PACK.test(n) && pack(p));
  if (!isObject(r) || r.v !== 2) return 'not version 2';
  if (!isObject(r.runtime) || !versions(r.runtime.versions)) return 'runtime';
  if (r.release != null && !(isObject(r.release) && (r.release.version == null || (typeof r.release.version === 'string' && VERSION.test(r.release.version))) &&
    (r.release.security == null || (isObject(r.release.security) && typeof r.release.security.fixes === 'string')))) return 'release';
  if (r.unreleased !== undefined && typeof r.unreleased !== 'boolean') return 'unreleased';
  if (!packs(r.packs)) return 'packs';
  if (r.held !== undefined && !packs(r.held)) return 'held';
  if (r.held !== undefined && Object.keys(r.held).some((n) => own(r.packs, n))) return 'a pack both installed and held';
  if (!isObject(r.modules) || !Object.entries(r.modules).every(([n, m]) => PACKAGE.test(n) && isObject(m) && typeof m.version === 'string' && VERSION.test(m.version) && ROLES.has(m.role))) return 'modules';
  // modules is what packs give: the same names, each at its highest version
  const want = highest(r.packs);
  const names = Object.keys(r.modules).sort();
  if (names.join('\n') !== Object.keys(want).sort().join('\n') || names.some((n) => r.modules[n].version !== want[n])) return 'modules is not what packs give';
  if (!Array.isArray(r.withdrawn) || !r.withdrawn.every((m) => typeof m === 'string' && own(want, m)) || new Set(r.withdrawn).size !== r.withdrawn.length) return 'withdrawn';
  if (r.shim !== undefined && !(isObject(r.shim) && typeof r.shim.package === 'string' && PACKAGE.test(r.shim.package) && typeof r.shim.version === 'string' && VERSION.test(r.shim.version))) return 'shim';
  return null;
}

// Writes the record with its derived fields made here: modules from packs
// (roleOf as derive's), withdrawn from `release` (the operation's own pins).
// record: {runtime, release, unreleased, packs, held?, shim?}. -> what was written.
function writeModulesRecord(where, record, {roleOf, release}) {
  const out = {
    v: 2,
    runtime: record.runtime,
    release: record.release != null ? record.release : null,
    unreleased: record.unreleased === true,
    packs: record.packs,
    modules: derive(record.packs, roleOf),
    withdrawn: withdrawnOf({unreleased: record.unreleased === true, packs: record.packs}, release),
    ...(record.held != null && Object.keys(record.held).length > 0 ? {held: record.held} : {}),
    ...(record.shim !== undefined ? {shim: record.shim} : {}),
    at: new Date().toISOString()
  };
  const problem = shapeProblem(out);
  if (problem != null) throw new Error(`the record to write is not valid (${problem})`);
  writeAtomic(recordOf(where), JSON.stringify(out, null, 2) + '\n');
  return out;
}

module.exports = {readModulesRecord, writeModulesRecord, derive, withdrawnOf, activeVersion, compareVersions, shapeProblem, EARLIER};
