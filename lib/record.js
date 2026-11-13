'use strict';
// <home>/packs.json: what the home holds (reviewer, 2026-11-12).
//   {runtime: {versions: {name: version}},
//    packs: {<pack>: {packages: {name: version}, credentials: [variable, ...]}},
//    unreleased: true|false, release: {version, security: null | {fixes}},
//    held?: {<pack>: {packages, credentials, installedUnder: <ch-local version>}}, at}
// held: packs a rollback's restored release does not have (lib/rollback.js).
// unreleased is true once anything was installed with --unreleased-pins, and
// stays so until a clean install from a release.
const fs = require('node:fs');
const {writeAtomic} = require('./atomic');

// -> the record, or null when nothing is installed. Throws when it cannot be read.
function readRecord(where) {
  if (where.journal != null && fs.existsSync(where.journal)) {
    throw new Error('a rollback was interrupted; run `ch-local rollback` to finish it');
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
      throw new Error(`this home was made by an earlier development ch-local; run \`ch-local install --pack ${pack} --from <dir>\` again`);
    }
    throw new Error(`${where.packs} is not readable (${err.code}); run \`ch-local install\` again`);
  }
  let r;
  try { r = JSON.parse(raw); } catch (err) { r = null; }
  const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
  const versions = (x) => isObject(x) && Object.values(x).every((v) => typeof v === 'string');
  const pack = (p) => isObject(p) && versions(p.packages) && Array.isArray(p.credentials) && p.credentials.every((c) => typeof c === 'string');
  const heldOk = (h) => h === undefined || (isObject(h) && Object.values(h).every((p) => pack(p) && typeof p.installedUnder === 'string'));
  const releaseOk = (x) => x == null || (isObject(x) && (x.version == null || typeof x.version === 'string') && (x.security == null || (isObject(x.security) && typeof x.security.fixes === 'string')));
  if (!isObject(r) || !isObject(r.packs) || !isObject(r.runtime) || !versions(r.runtime.versions) || !Object.values(r.packs).every(pack) || !heldOk(r.held) || !releaseOk(r.release)) {
    throw new Error(`${where.packs} is not a ch-local record; run \`ch-local install\` again`);
  }
  return {runtime: r.runtime, packs: r.packs, unreleased: r.unreleased === true, release: r.release != null ? r.release : null, ...(r.held !== undefined ? {held: r.held} : {}), at: r.at};
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

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

// The record without its held packs (they belong to the release they wait for).
function withoutHeld(record) {
  const {held: _held, ...rest} = record;
  void _held;
  return rest;
}

module.exports = {readRecord, writeRecord, packVersions, own, withoutHeld};
