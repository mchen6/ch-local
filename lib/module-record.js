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
// a module's version is a store directory: the store's own check (#82's high
// review, 5), so a record never names a version the store will not hold;
// from lib/names.js, so a reader of the record loads none of the store's
// code (#82's medium, 8)
const {VERSION, PACKAGE, PACK, storeVersion} = require('./names');
const {chLocal} = require('./command-line');
const UNRELEASED = /^[0-9a-f]{16}$/;
const ROLES = new Set(['scenario', 'part', null]);
const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
// the one own-property helper (record.js and install-plan.js take it from
// here): null-safe
const own = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);
// entries -> a map with no prototype: a key read from it (x[m]) can never
// reach Object.prototype ("constructor", "toString"...), wherever the record
// goes (the Reviewer's high review of #96, the root fix)
const bareEntries = (entries) => {
  const out = Object.create(null);
  for (const [k, v] of entries) out[k] = v;
  return out;
};
// a copy of o as such a map, its entries mapped by f when given
const bare = (o, f = (v) => v) => bareEntries(Object.entries(o || {}).map(([k, v]) => [k, f(v)]));
// a pack (or a held pack) with its modules as such a map
const barePack = (p) => ({...p, modules: bare(p.modules)});

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
  const out = Object.create(null);
  for (const p of Object.values(packs)) {
    // equal precedence (they differ in build metadata only): the greater
    // string, so the order of the packs never decides (medium review, 7)
    for (const [m, v] of Object.entries(p.modules)) {
      const c = own(out, m) ? compareVersions(v, out[m]) : 1;
      if (c > 0 || (c === 0 && v > out[m])) out[m] = v;
    }
  }
  return out;
}

// The packs the record's withdrawn list leaves live: none of whose modules
// it names (a withdrawn pack is never loaded: lib/packs.js heldWithdrawn).
const livePacks = (packs, withdrawn) => {
  const gone = new Set(withdrawn || []);
  return bareEntries(Object.entries(packs).filter(([, p]) => !Object.keys(p.modules).some((m) => gone.has(m))));
};

// Each module's active version: the highest the live packs record, and only
// for a module no live pack records, the highest the withdrawn ones do (it
// never loads). A withdrawn pack's newer version never overrides what a
// release pins for a live pack: a security release's lower pin is the one
// loaded (#83's high review, 2). -> {<module>: version}
function activeVersions(packs, withdrawn) {
  return Object.assign(Object.create(null), highest(packs), highest(livePacks(packs, withdrawn)));
}

// The derived modules: each one's active version and that version's role.
// roleOf(name, version) -> 'scenario' | 'part' | null (lib/module-store.js's,
// with the home's layout bound); withdrawn: the record's list.
function derive(packs, roleOf, withdrawn = []) {
  return bareEntries(Object.entries(activeVersions(packs, withdrawn)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([m, version]) => [m, {version, role: roleOf(m, version)}]));
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
// Why a record could not be read, by code, so a caller decides by it and
// never by the message's wording (the medium review of the Reviewer's
// round on #83, 5): RECORD_FORMAT (not JSON, not a record), RECORD_IO (the
// file could not be read: it may be whole), RECORD_EARLIER_DEV (only an
// earlier development launcher's installed.json).
// reason: the bare why, with no advice after it (the Reviewer's round on
// #83, 8: never trimmed off a message)
// (where: the home's layout, for the command's launcher form:
// lib/command-line.js)
const recordError = (where, reason, code, advice = `run \`${chLocal(where, 'install')}\` again`) => Object.assign(new Error(`${reason}; ${advice}`), {code, reason});
const earlierLine = (where) => `this home was made by an earlier ch-local; run \`${chLocal(where, 'install')}\` again`;

// -> the record, or null when nothing is installed. Throws when it cannot be
// read, or when only an earlier ch-local's packs.json is there (an install
// migrates it, section 10).
function readModulesRecord(where) {
  if (where.journal != null && fs.existsSync(where.journal)) {
    throw new Error(`a rollback was interrupted; run \`${chLocal(where, 'rollback')}\` to finish it`);
  }
  const file = recordOf(where);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw recordError(where, `${file} is not readable (${err.code})`, 'RECORD_IO');
    // a migration cut short leaves both: modules.json is the one taken
    if (where.packs != null && fs.existsSync(where.packs)) throw new Error(earlierLine(where));
    // only an unreleased development launcher wrote installed.json
    if (where.installed != null) {
      let old = null;
      try { old = JSON.parse(fs.readFileSync(where.installed, 'utf8')); } catch (e) { old = null; }
      if (old != null) {
        const pack = typeof old.pack === 'string' ? old.pack : '<name>';
        throw recordError(where, 'this home was made by an earlier development ch-local', 'RECORD_EARLIER_DEV', `run \`${chLocal(where, `install --pack ${pack} --from <dir>`)}\` again`);
      }
    }
    return null;
  }
  let r;
  try { r = JSON.parse(raw); } catch (err) { r = null; }
  const problem = shapeProblem(r);
  if (problem != null) throw recordError(where, `${file} is not a ch-local record (${problem})`, 'RECORD_FORMAT');
  return {
    v: 2,
    runtime: {versions: {...r.runtime.versions}},
    release: r.release != null ? r.release : null,
    unreleased: r.unreleased === true,
    // (maps with no prototype, each pack's modules too: the root fix)
    packs: bare(r.packs, barePack),
    modules: bare(r.modules),
    withdrawn: r.withdrawn,
    held: bare(r.held, barePack),
    ...(r.shim !== undefined ? {shim: {package: r.shim.package, version: r.shim.version}} : {}),
    at: r.at
  };
}

// -> why r is not a version 2 record, or null
function shapeProblem(r) {
  const versions = (x, {nonEmpty = false} = {}) => isObject(x) && (!nonEmpty || Object.keys(x).length > 0) &&
    Object.entries(x).every(([n, v]) => PACKAGE.test(n) && typeof v === 'string' && VERSION.test(v));
  const moduleVersions = (x) => isObject(x) && Object.keys(x).length > 0 && Object.entries(x).every(([n, v]) => PACKAGE.test(n) && storeVersion(v));
  const from = (f) => isObject(f) && Object.keys(f).length === 1 &&
    ((typeof f.release === 'string' && VERSION.test(f.release)) || (typeof f.unreleased === 'string' && UNRELEASED.test(f.unreleased)));
  const pack = (p) => isObject(p) && from(p.from) && moduleVersions(p.modules);
  const packs = (o) => isObject(o) && Object.entries(o).every(([n, p]) => PACK.test(n) && pack(p));
  if (!isObject(r) || r.v !== 2) return 'not version 2';
  if (!isObject(r.runtime) || !versions(r.runtime.versions)) return 'runtime';
  if (r.release != null && !(isObject(r.release) && (r.release.version == null || (typeof r.release.version === 'string' && VERSION.test(r.release.version))) &&
    (r.release.security == null || (isObject(r.release.security) && typeof r.release.security.fixes === 'string')))) return 'release';
  if (r.unreleased !== undefined && typeof r.unreleased !== 'boolean') return 'unreleased';
  if (!packs(r.packs)) return 'packs';
  if (r.held !== undefined && !packs(r.held)) return 'held';
  if (r.held !== undefined && Object.keys(r.held).some((n) => own(r.packs, n))) return 'a pack both installed and held';
  if (!isObject(r.modules) || !Object.entries(r.modules).every(([n, m]) => PACKAGE.test(n) && isObject(m) && storeVersion(m.version) && ROLES.has(m.role))) return 'modules';
  // modules is what packs give: the same names, each at its active version
  // (the live packs' highest: activeVersions)
  const want = activeVersions(r.packs, Array.isArray(r.withdrawn) ? r.withdrawn : []);
  const names = Object.keys(r.modules).sort();
  if (names.join('\n') !== Object.keys(want).sort().join('\n') || names.some((n) => r.modules[n].version !== want[n])) return 'modules is not what packs give';
  if (!Array.isArray(r.withdrawn) || !r.withdrawn.every((m) => typeof m === 'string' && own(want, m)) || new Set(r.withdrawn).size !== r.withdrawn.length) return 'withdrawn';
  if (r.shim !== undefined && !(isObject(r.shim) && typeof r.shim.package === 'string' && PACKAGE.test(r.shim.package) && typeof r.shim.version === 'string' && VERSION.test(r.shim.version))) return 'shim';
  return null;
}

// Writes the record with its derived fields made here: modules from packs
// (roleOf as derive's), withdrawn from `release` (the operation's own pins).
// record: {runtime, release, unreleased, packs, held?, shim?}. -> what was written.
function writeModulesRecord(where, record, opts = {}) {
  const out = buildModulesRecord(record, opts);
  writeAtomic(recordOf(where), JSON.stringify(out, null, 2) + '\n');
  return out;
}

// The record with its derived fields, checked as the reader checks, not
// written: install builds it before it swaps the app, so a record that
// would not be valid stops the install with nothing changed (the medium
// review of L1a-2, 4). Throws.
function buildModulesRecord(record, {roleOf, release} = {}) {
  if (typeof roleOf !== 'function') throw new Error('writeModulesRecord: roleOf is required');
  // with no release every module would read as withdrawn (medium review, 2)
  if (record.unreleased !== true && (release == null || release.packs == null || typeof release.packs !== 'object')) {
    throw new Error('writeModulesRecord: a released record is written with its release\'s pins');
  }
  const out = {
    v: 2,
    runtime: record.runtime,
    release: record.release != null ? record.release : null,
    unreleased: record.unreleased === true,
    // (maps with no prototype, as a record read back has them: the record
    // written is handed on too)
    packs: bare(record.packs, barePack),
    withdrawn: withdrawnOf({unreleased: record.unreleased === true, packs: record.packs}, release),
    modules: null,
    ...(record.held != null && Object.keys(record.held).length > 0 ? {held: bare(record.held, barePack)} : {}),
    ...(record.shim !== undefined ? {shim: record.shim} : {}),
    at: new Date().toISOString()
  };
  out.modules = derive(record.packs, roleOf, out.withdrawn);
  const problem = shapeProblem(out);
  if (problem != null) throw new Error(`the record to write is not valid (${problem})`);
  return out;
}

// A record written as it is, its derived fields kept: what the release
// rollback swaps (lib/rollback.js). Each record's modules and withdrawn were
// derived by the release that wrote it, from its own pins, which this one
// cannot re-derive. Checked as the reader checks. file: where to write.
function writeRecordAsIs(file, record) {
  const out = {...record, v: 2, at: new Date().toISOString()};
  if (out.held != null && Object.keys(out.held).length === 0) delete out.held;
  const problem = shapeProblem(out);
  if (problem != null) throw new Error(`the record to write is not valid (${problem})`);
  writeAtomic(file, JSON.stringify(out, null, 2) + '\n');
  return out;
}

// What an upgrade judged a home by (the Reviewer's high on #101, round 2):
// its packs with each module's version, every module's recorded version,
// the withdrawn list, and the runtime, release, unreleased and held packs (a
// rollback that moves no module still changes these: its medium, 1). upgrade and the automatic upgrade pass it to
// install, which refuses when the record under its lock is another: the
// preview, additions and moves were made on this record, not that one.
// -> a hex digest, or null for no record.
function judgedDigest(record) {
  if (record == null) return null;
  const sorted = (o) => Object.entries(o || {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const shape = {
    packs: sorted(record.packs).map(([p, e]) => [p, sorted(e && e.modules)]),
    modules: sorted(record.modules).map(([m, e]) => [m, e != null ? e.version : null]),
    withdrawn: [...(Array.isArray(record.withdrawn) ? record.withdrawn : [])].sort(),
    runtime: sorted(record.runtime && record.runtime.versions),
    release: record.release != null ? record.release : null,
    unreleased: record.unreleased === true,
    held: sorted(record.held).map(([p, e]) => [p, sorted(e && e.modules)])
  };
  return require('node:crypto').createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

module.exports = {judgedDigest, own, bare, readModulesRecord, writeModulesRecord, buildModulesRecord, writeRecordAsIs, derive, activeVersions, livePacks, withdrawnOf, activeVersion, compareVersions, shapeProblem, earlierLine};
