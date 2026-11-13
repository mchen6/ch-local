'use strict';
// <home>/packs.json: what the home holds (reviewer, 2026-11-12).
//   {runtime: {versions: {name: version}},
//    packs: {<pack>: {packages: {name: version}, credentials: [variable, ...]}},
//    unreleased: true|false, at}
// unreleased is true once anything was installed with --unreleased-pins, and
// stays so until a clean install from a release.
const fs = require('node:fs');
const {writeAtomic} = require('./atomic');

// -> the record, or null when nothing is installed. Throws when it cannot be read.
function readRecord(where) {
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
  if (!isObject(r) || !isObject(r.packs) || !isObject(r.runtime) || !versions(r.runtime.versions) || !Object.values(r.packs).every(pack)) {
    throw new Error(`${where.packs} is not a ch-local record; run \`ch-local install\` again`);
  }
  return {runtime: r.runtime, packs: r.packs, unreleased: r.unreleased === true, at: r.at};
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

module.exports = {readRecord, writeRecord, packVersions, own};
