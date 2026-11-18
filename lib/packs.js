'use strict';
// The packs a home holds, which of them a start loads, and the remote
// credentials those may use (spec §2, many packs; plan Tasks 11 and 12b).
const fs = require('node:fs');
const path = require('node:path');
const {pickCredential} = require('./credential');
const {readModulesRecord} = require('./module-record');
const {versionDir} = require('./store-paths');

// where: layout(); record: readModulesRecord's, when the caller has it; io:
// the running release's pins (releaseOf). -> [{name, scenario, version,
// modules, dirs, dir, packages, credentials}] from modules.json; [] when
// nothing is installed. Still pack by pack (L2 decides by module):
// - modules: each of the pack's modules at its active version (the record's
//   derived one: the highest any pack records, in a released home the pin);
// - scenario: the pack's module whose role is scenario, else its first;
//   version: the scenario's; dirs: each module's store directory; dir: the
//   scenario's, what start loads;
// - credentials: the variables the running release's pins give the pack
//   (version 1). A bridge until L5 moves credentials to the module.
// A pack's scenario in the record: its module whose role is scenario, else
// its first, the module the pack's seams speak for (start, the applier,
// load-pack and status alike); null for a pack the record has not.
function packScenario(record, pack) {
  const p = record != null && record.packs != null && Object.prototype.hasOwnProperty.call(record.packs, pack) ? record.packs[pack] : null;
  if (p == null || p.modules == null) return null;
  const packages = Object.keys(p.modules);
  return packages.find((m) => record.modules != null && record.modules[m] != null && record.modules[m].role === 'scenario') || packages[0] || null;
}
// the package a pack's form names it by, when the record has no scenario
// for it (load-pack's version is that package's)
const packModuleName = (pack) => `@countinghouse/ch-pack-${pack}`;

function installedPacks(where, record = readModulesRecord(where), io = null) {
  if (record == null) return [];
  const release = releaseOf(io);
  return Object.entries(record.packs).map(([name, p]) => {
    const packages = Object.keys(p.modules);
    const modules = Object.fromEntries(packages.map((m) => [m, record.modules[m] != null ? record.modules[m].version : p.modules[m]]));
    const scenario = packScenario(record, name);
    const dirs = Object.fromEntries(packages.map((m) => [m, versionDir(where, m, modules[m])]));
    const spec = release != null && release.packs != null && Object.prototype.hasOwnProperty.call(release.packs, name) ? release.packs[name] : null;
    return {
      name,
      scenario,
      version: modules[scenario],
      modules,
      dirs,
      dir: dirs[scenario],
      packages,
      credentials: spec != null && Array.isArray(spec.credentials) ? spec.credentials : []
    };
  });
}

// A module's package in its store directory; missing or unreadable, the
// install is broken, and a start must not go ahead as if it declared no
// remotes. dirs: {name: its directory}.
function readManifest(dirs, name) {
  // a module with no store directory is missing: never a path relative to
  // wherever this process runs
  if (dirs == null || typeof dirs[name] !== 'string' || !path.isAbsolute(dirs[name])) throw new Error(`${name} is not in the module store`);
  const file = path.join(dirs[name], 'package.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(err.code === 'ENOENT' ? `${name} is not in the module store` : `${name}'s package.json is not readable (${err.code})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name}'s package.json is not readable JSON`);
  }
}

// The remotes the named packages declare (countinghouse.remotes), each as
// {origin, variables, from}; origin is null when the URL cannot be read, so
// the caller refuses it rather than skipping it. Throws for a package that is
// missing or unreadable. dirs: {name: its store directory}.
function declaredRemotes(dirs, packages) {
  const out = [];
  for (const name of packages) {
    const manifest = readManifest(dirs, name);
    const remotes = manifest != null && manifest.countinghouse != null && Array.isArray(manifest.countinghouse.remotes) ? manifest.countinghouse.remotes : [];
    for (const remote of remotes) {
      const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
      if (!isObject(remote) || (remote.credential != null && !isObject(remote.credential))) { out.push({origin: null, variables: [], from: name}); continue; }
      let origin = null;
      try { origin = new URL(remote.url).origin; } catch (err) { origin = null; }
      const c = remote.credential || {};
      out.push({origin, variables: origin == null ? [] : [c.env, c.fallbackEnv].filter((v) => typeof v === 'string' && v !== ''), from: name});
    }
  }
  return out;
}

// -> {credentials: {origin: [variable, ...]}, refused: [{from, origin, variable?}]}.
// An origin not in `allowed`, or a variable not pinned to it, is refused.
function credentialUnion(remotes, allowed) {
  const credentials = {};
  const refused = [];
  for (const {origin, variables, from} of remotes) {
    if (origin == null || !Object.prototype.hasOwnProperty.call(allowed, origin)) { refused.push({from, origin}); continue; }
    const list = credentials[origin] || (credentials[origin] = []);
    for (const variable of variables) {
      if (!allowed[origin].includes(variable)) refused.push({from, origin, variable});
      else if (!list.includes(variable)) list.push(variable);
    }
  }
  return {credentials, refused};
}

// -> {load: [pack + {credential: <variable name>}], missing: [{name, variables}]}.
// Names only: the value is the runtime's to read.
function loadablePacks(packs, env) {
  const load = [];
  const missing = [];
  for (const pack of packs) {
    const chosen = pickCredential(env, pack.credentials);
    if (chosen == null && pack.credentials.length > 0) missing.push({name: pack.name, variables: pack.credentials});
    else load.push({...pack, credential: chosen == null ? null : chosen.name});
  }
  return {load, missing};
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

// The packs not started, by name: those this release does not list, and
// those the record's withdrawn list names (one rule for start, the
// applier, load-pack and the commands: #83's high review, 10).
// packs: installedPacks(); allow: the running release's.
function withdrawnNames(record, packs, allow) {
  return new Set([...withdrawnPacks(packs, {allow, record}).map((p) => p.name), ...heldWithdrawn(record)]);
}

module.exports = {packScenario, packModuleName, withdrawnNames, installedPacks, declaredRemotes, credentialUnion, loadablePacks, withdrawnPacks, withdrawnLine, withdrawnNowLine, withdrawnStatusLine, relistedLine, relistedStatusLine, removeHint, heldWithdrawn, releaseOf};
