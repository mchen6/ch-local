'use strict';
// The packs a home holds, which of them a start loads, and the remote
// credentials those may use (spec §2, many packs; plan Tasks 11 and 12b).
const fs = require('node:fs');
const path = require('node:path');
const {readModulesRecord, own} = require('./module-record');
const {versionDir} = require('./store-paths');
const {compareVersions} = require('./semver-order');

// where: layout(); record: readModulesRecord's, when the caller has it; io:
// the running release's pins (releaseOf). -> [{name, scenario, version,
// modules, dirs, dir, packages, credentials}] from modules.json; [] when
// nothing is installed. Still pack by pack (L2 decides by module):
// - modules: each of the pack's modules at its active version (the record's
//   derived one: the highest any pack records, in a released home the pin);
// - scenario: the pack's module whose role is scenario, else its first;
//   version: the scenario's; dirs: each module's store directory; dir: the
//   scenario's, what start loads;
// - credentials: the variables the running release's pins describe for the
//   pack's modules (version 2's modules.<package>.credentials: packVariables)
// A pack's scenario in the record: its module whose role is scenario, else
// its first, the module the pack's seams speak for (start, the applier and
// status alike); null for a pack the record has not.
// (own properties only, as countinghouse's rule reads them: a module named
// "constructor", or anything on Object.prototype, is no entry the record
// holds: #449's review; module-record's own, the one helper). Whether o
// holds its own k, not null (a key a half-written record holds as null
// holds nothing).
const holds = (o, k) => o != null && typeof o === 'object' && own(o, k) && o[k] != null;
// the record's own entry for a module, or null
const entryOf = (record, m) => (record != null && holds(record.modules, m) ? record.modules[m] : null);
function packScenario(record, pack) {
  const p = record != null && holds(record.packs, pack) ? record.packs[pack] : null;
  if (p == null || p.modules == null) return null;
  const packages = Object.keys(p.modules);
  return packages.find((m) => { const e = entryOf(record, m); return e != null && own(e, 'role') && e.role === 'scenario'; }) || packages[0] || null;
}
// the package a pack's scenario is named by, when the record has no
// scenario for it: lib/ceiling.js's fallback (packAllowed, notAllowed) for
// a pack not recorded yet
const packModuleName = (pack) => `@countinghouse/ch-pack-${pack}`;

function installedPacks(where, record = readModulesRecord(where), io = null) {
  if (record == null) return [];
  const release = releaseOf(io);
  return Object.entries(record.packs).map(([name, p]) => {
    const packages = Object.keys(p.modules);
    const modules = Object.fromEntries(packages.map((m) => { const e = entryOf(record, m); return [m, e != null ? e.version : p.modules[m]]; }));
    const scenario = packScenario(record, name);
    const dirs = Object.fromEntries(packages.map((m) => [m, versionDir(where, m, modules[m])]));
    return {
      name,
      scenario,
      version: modules[scenario],
      modules,
      dirs,
      dir: dirs[scenario],
      packages,
      credentials: packVariables(release, name)
    };
  });
}

// The variables a release's pins describe for a pack's modules (version 2,
// #413 section 9.3): [variable], each once, sorted; [] for a pack it does
// not list
function packVariables(release, pack) {
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  if (release == null || !own(release.packs, pack)) return [];
  const out = new Set();
  for (const m of (release.packs[pack].modules || [])) {
    const d = own(release.modules, m) ? release.modules[m] : null;
    for (const c of (d != null && Array.isArray(d.credentials) ? d.credentials : [])) out.add(c.variable);
  }
  return [...out].sort();
}

// Withdrawn packs (maintainer's decision, 2026-11-17; #413 section 9.7): a
// pack the running release does not list is never started. An upgrade to
// such a release keeps it recorded, and writes its modules into the
// record's withdrawn list (derived from that release's own pins), which a
// start still running from the release before reads, as it cannot ask its
// own pins (heldWithdrawn below). Each start tells each session once
// (withdrawnLine); nothing is removed: its files and data stay, for
// `ch-local remove-pack`.
// An unreleased (development) install is exempt: its record is marked only
// by --unreleased-pins, which needs CH_LOCAL_DEV=1 (lib/pins.js), so the dev
// intent is on record. Not CH_LOCAL_DEV at start as well: the shared
// daemon's environment is shim.json's allowlist, which never carries it.
// Every start of one says UNRELEASED_LINE, so it is never silent.
// packs: installedPacks(); allow: the running release's (ALLOWLIST);
// record: the record. -> the withdrawn packs.
function withdrawnPacks(packs, {allow, record = null} = {}) {
  if (record != null && record.unreleased === true) return [];
  const listed = (allow != null && allow.packs != null) ? allow.packs : {};
  return packs.filter((p) => !Object.prototype.hasOwnProperty.call(listed, p.name));
}
// What the user is told: the pack and the command, never a path.
const removeHint = (name) => `\`ch-local remove-pack ${name}\` removes it`;
const withdrawnLine = (name) => `pack ${name} was withdrawn in this release and was not started; ${removeHint(name)}`;
// ... and to a start that was serving it when the upgrade withdrew it
const withdrawnNowLine = (name) => `pack ${name} was withdrawn in this release and is no longer served; ${removeHint(name)}`;
// ... in status, and in an upgrade's preview
const withdrawnStatusLine = (name) => `${name}: withdrawn in this release, so it is not started; ${removeHint(name)}`;
// a release that lists a withdrawn pack again (lib/install.js drops it from held)
const relistedLine = (name) => `pack ${name} is in this release again: \`ch-local add-pack ${name}\` adds it back`;
const relistedStatusLine = (name) => `${name}: in this release again, not started until added: \`ch-local add-pack ${name}\` adds it back`;
// The packs the record has withdrawn: each with a module in the record's
// withdrawn list, which the operation that wrote it derived from its own
// pins (#413 section 9.7). What a start of another release reads, since its
// own pins cannot say what the new release withdrew. -> their names.
const heldWithdrawn = (record) => {
  if (record == null || !Array.isArray(record.withdrawn) || record.withdrawn.length === 0) return [];
  const gone = new Set(record.withdrawn);
  return Object.entries(record.packs || {}).filter(([, p]) => Object.keys(p.modules || {}).some((m) => gone.has(m))).map(([name]) => name);
};
// The running release's allowlist: a test's own through io.release.
const releaseOf = (io) => (io != null && io.release != null ? io.release : require('./allowlist').ALLOWLIST);
// Whose home this is (#413 section 9.8): ONE rule, for start and the
// applier alike (the Reviewer on L2a), asked in this order:
//   stale  this process was launched from the home's app, and the ch-local
//          the home holds now is another version (the home was upgraded or
//          rolled back under it): frozen; keep what is loaded, apply only
//          what no pins decide, and staleLine said once
//   same   the home's ch-local, its release's record (or either unknown):
//          judged as usual
//   other  the home's ch-local, another release's record (an install that
//          did not finish, a hand-edited home): judged by this ch-local's
//          pins, and installLine said once
// The home's ch-local is the record's own (runtime.versions), read with its
// release: never a file the install or rollback is moving (the medium
// review of the refinement, 3 and 6). A ch-local run from outside the home
// (a checkout, a global install) is never stale: it is judged by the record
// (1). Versions compare by full semver precedence (lib/semver-order.js); two
// that do not parse are never stale, and another release's record is then
// "other": fail closed, by these pins (2). io.selfVersion: a test's running
// version (null: not known, never stale).
const SELF_DIR = path.resolve(__dirname, '..');
const homeSelfDir = (where) => path.join(where.app, 'node_modules', '@countinghouse', 'ch-local');
// whether this process runs the home's own ch-local (launched by its launcher)
function runsFromHome(where, selfDir = SELF_DIR) {
  if (where == null) return false;
  const home = homeSelfDir(where);
  if (selfDir === home) return true;
  try { return fs.realpathSync(selfDir) === fs.realpathSync(home); } catch (err) { return false; }
}
function recordRelease(record, io, where) {
  const r = releaseOf(io);
  const ours = r != null && r.release != null && typeof r.release.version === 'string' ? r.release.version : null;
  const theirs = record != null && record.release != null && typeof record.release.version === 'string' ? record.release.version : null;
  const versions = record != null && record.runtime != null && record.runtime.versions != null ? record.runtime.versions : {};
  const installed = typeof versions['@countinghouse/ch-local'] === 'string' ? versions['@countinghouse/ch-local'] : null;
  const self = io != null && io.selfVersion !== undefined ? io.selfVersion
    : runsFromHome(where) ? require('../package.json').version : null;
  const c = self != null && installed != null ? compareVersions(installed, self) : null;
  if (c === 1 || c === -1) return {ours, theirs, installed, state: 'stale', how: c === 1 ? 'upgraded' : 'rolled back'};
  if (ours == null || theirs == null || ours === theirs) return {ours, theirs, installed, state: 'same'};
  return {ours, theirs, installed, state: compareVersions(theirs, ours) === 0 ? 'same' : 'other'};
}
const staleLine = (installed, how) => `ch-local in this home is now ${installed} (${how}); restart your client to use it`;
const installLine = (ours) => `this home's record is not this ch-local's release; run \`ch-local install\` to bring the home to ${ours}`;

// The packs not started, by name: those this release does not list, and
// those the record's withdrawn list names (one rule for start, the
// applier and the commands: #83's high review, 10).
// packs: installedPacks(); allow: the running release's.
function withdrawnNames(record, packs, allow) {
  return new Set([...withdrawnPacks(packs, {allow, record}).map((p) => p.name), ...heldWithdrawn(record)]);
}

module.exports = {packVariables, packScenario, entryOf, holds, packModuleName, recordRelease, runsFromHome, staleLine, installLine, withdrawnNames, installedPacks, withdrawnPacks, withdrawnLine, withdrawnNowLine, withdrawnStatusLine, relistedLine, relistedStatusLine, removeHint, heldWithdrawn, releaseOf};
