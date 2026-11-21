'use strict';
// <home>/packs.json: what the home holds (reviewer, 2026-11-12).
//   {runtime: {versions: {name: version}},
//    packs: {<pack>: {packages: {name: version}, credentials: [variable, ...]}},
//    unreleased: true|false, release: {version, security: null | {fixes}},
//    held?: {<pack>: {packages, credentials, installedUnder: <ch-local version>, withdrawn?: true, relisted?: true}}, at}
// held: packs a rollback's restored release does not have (lib/rollback.js),
// and packs an upgrade's release withdrew (withdrawn: true; lib/install.js's
// runtime-only path), relisted once a later release lists one again (its
// files kept, for add-pack). None is started, loaded or counted as installed.
// unreleased is true once anything was installed with --unreleased-pins, and
// stays so until a clean install from a release.
const fs = require('node:fs');
const {writeAtomic} = require('./atomic');
const {chLocal} = require('./command-line');

// -> the record, or null when nothing is installed. Throws when it cannot be read.
function readRecord(where) {
  if (where.journal != null && fs.existsSync(where.journal)) {
    throw new Error(`a rollback was interrupted; run \`${chLocal(where, 'rollback')}\` to finish it`);
  }
  let raw;
  try {
    raw = fs.readFileSync(where.packs, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Only an unreleased development launcher wrote installed.json.
      if (where.installed == null) return null;
      let old = null;
      try { old = JSON.parse(fs.readFileSync(where.installed, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; }
      const pack = old != null && typeof old.pack === 'string' ? old.pack : '<name>';
      throw Object.assign(new Error(`this home was made by an earlier development ch-local; run \`${chLocal(where, `install --pack ${pack} --from <dir>`)}\` again`), {code: 'RECORD_EARLIER_DEV', reason: 'this home was made by an earlier development ch-local'});
    }
    throw Object.assign(new Error(`${where.packs} is not readable (${err.code}); run \`${chLocal(where, 'install')}\` again`), {code: 'RECORD_IO', reason: `${where.packs} is not readable (${err.code})`});
  }
  let r;
  try { r = JSON.parse(raw); } catch (err) { r = null; }
  const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
  // names and versions as a release writes them: a pack's name and a
  // version become directory names (packs in place), so nothing else passes
  const {VERSION, PACKAGE, PACK} = require('./names');
  const versions = (x) => isObject(x) && Object.entries(x).every(([n, v]) => typeof v === 'string' && VERSION.test(v) && PACKAGE.test(n));
  const pack = (p) => isObject(p) && versions(p.packages) && Array.isArray(p.credentials) && p.credentials.every((c) => typeof c === 'string');
  const heldOk = (h) => h === undefined || (isObject(h) && Object.values(h).every((p) => pack(p) && typeof p.installedUnder === 'string' && (p.withdrawn === undefined || p.withdrawn === true) && (p.relisted === undefined || p.relisted === true) && !(p.withdrawn === true && p.relisted === true)));
  const releaseOk = (x) => x == null || (isObject(x) && (x.version == null || typeof x.version === 'string') && (x.security == null || (isObject(x.security) && typeof x.security.fixes === 'string')));
  const packNames = (o) => o === undefined || Object.keys(o).every((n) => PACK.test(n));
  // the native shim install placed (lib/shim-install.js), when it did
  const shimOk = (x) => x === undefined || (isObject(x) && typeof x.package === 'string' && PACKAGE.test(x.package) && typeof x.version === 'string' && VERSION.test(x.version));
  if (!isObject(r) || !isObject(r.packs) || !isObject(r.runtime) || !versions(r.runtime.versions) || !Object.values(r.packs).every(pack) || !heldOk(r.held) || !releaseOk(r.release)
    || !packNames(r.packs) || !packNames(r.held) || !shimOk(r.shim)) {
    throw Object.assign(new Error(`${where.packs} is not a ch-local record; run \`${chLocal(where, 'install')}\` again`), {code: 'RECORD_FORMAT', reason: `${where.packs} is not a ch-local record`});
  }
  return {runtime: r.runtime, packs: r.packs, unreleased: r.unreleased === true, release: r.release != null ? r.release : null, ...(r.held !== undefined ? {held: r.held} : {}), ...(r.shim !== undefined ? {shim: {package: r.shim.package, version: r.shim.version}} : {}), at: r.at};
}

function writeRecord(where, record) {
  writeAtomic(where.packs, JSON.stringify({...record, at: new Date().toISOString()}, null, 2) + '\n');
}

// Every package a home's packs hold -> version.
function packVersions(record) {
  const out = {};
  for (const p of Object.values(record.packs)) Object.assign(out, p.packages);
  return out;
}

const {own} = require('./module-record');

// The record without its held packs (withHeld's base; held packs are never
// dropped from a record that is kept: lib/install.js carriedHeld).
function withoutHeld(record) {
  const {held: _held, ...rest} = record;
  void _held;
  return rest;
}

// The record with exactly these held packs (none: no held field).
function withHeld(record, held) {
  return {...withoutHeld(record), ...(held != null && Object.keys(held).length > 0 ? {held} : {})};
}

module.exports = {readRecord, writeRecord, packVersions, own, withHeld};
