'use strict';
// The user's own modules, recorded (B-own-add; the own-modules design,
// ch-business tech/plans/2026-11-20-own-modules-design.md §2.1-2.2):
// <home>/own.json, apart from modules.json (the pinned record, whose readers
// all assume a release's pins). Written whole and atomically, under
// packs.lock, by add-module and remove-module; read by start, the applier,
// status, credentials, gc and uninstall, and by the runtime's overview
// (countinghouse settings-tool installedOwn).
//
//   {"v": 1,
//    "modules": {"<package>": {
//      "tree": "<sha256 of the confirmed copy's tree, 64 hex>",
//      "version": "<package.json version>",
//      "friendlyName": "<api.json device.friendlyName>",
//      "addedAt": "<ISO instant of the user's yes>",
//      "from": "<the absolute folder it was added from>",
//      "calls": ["<address>", ...]       its declared countinghouse.calls
//    }}}
//
// (What its calls can reach through other modules -- a pack's keys -- is
// neither listed at the yes nor recorded: accepted for release 1 as R7 and
// R8, the maintainer's decision, for 1.1.)
//
// The shape is versioned and kept stable: the release-1 -> next upgrade
// test pins it (C), and the 1.1 host process takes it unchanged (§2.7).
const fs = require('node:fs');
const path = require('node:path');
const {PACKAGE, endsTrimmed} = require('./names');
const {writeAtomic} = require('./atomic');
const {chLocal} = require('./command-line');

const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const TREE = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// a call address as a module declares it: <module>/<service>.<action>
const ADDRESS = /^[^/\s]{1,214}\/[^.\s/]{1,128}\.[^.\s/]{1,128}$/;
const MAX_LIST = 256;
const isString = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max;
const listOf = (x, rule) => Array.isArray(x) && x.length <= MAX_LIST && x.every((v) => typeof v === 'string' && rule.test(v)) && new Set(x).size === x.length;

// -> why m is not one own module's entry, or null
function entryProblem(m) {
  if (!isObject(m)) return 'an entry is not an object';
  const keys = Object.keys(m).sort().join(',');
  if (keys !== 'addedAt,calls,friendlyName,from,tree,version') return 'an entry has other fields than tree, version, friendlyName, addedAt, from and calls';
  if (!TREE.test(m.tree)) return 'tree is not a sha256';
  if (!isString(m.version, 64)) return 'version is not a string';
  if (!isString(m.friendlyName, 64)) return 'friendlyName is not a string';
  if (typeof m.addedAt !== 'string' || !ISO.test(m.addedAt)) return 'addedAt is not an instant';
  if (!isString(m.from, 4096) || !path.isAbsolute(m.from)) return 'from is not an absolute path';
  if (!listOf(m.calls, ADDRESS)) return 'calls is not a list of addresses';
  return null;
}

// -> why r is not an own-modules record, or null
function shapeProblem(r) {
  if (!isObject(r) || r.v !== 1 || !isObject(r.modules) || Object.keys(r).sort().join(',') !== 'modules,v') return 'it is not {"v": 1, "modules": {...}}';
  for (const [name, m] of Object.entries(r.modules)) {
    if (!PACKAGE.test(name) || name.startsWith('@countinghouse/') || endsTrimmed(name)) return `${JSON.stringify(name.slice(0, 80))} is not an own module's package name`;
    const p = entryProblem(m);
    if (p != null) return `${name}: ${p}`;
  }
  return null;
}

const ownError = (where, reason, code) => Object.assign(new Error(`${reason}; run \`${chLocal(where, 'status')}\` to see the own modules`), {code, reason});

// -> the record ({v: 1, modules}, a map with no prototype), or null with
// none. Throws OWN_RECORD_IO / OWN_RECORD_FORMAT for one that is there and
// can't be read as one: never taken for "none".
function readOwnRecord(where) {
  let raw;
  try {
    raw = fs.readFileSync(where.ownRecord, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw ownError(where, `${where.ownRecord} is not readable (${err.code})`, 'OWN_RECORD_IO');
  }
  let r;
  try { r = JSON.parse(raw); } catch (err) { r = null; }
  const problem = shapeProblem(r);
  if (problem != null) throw ownError(where, `${where.ownRecord} is not ch-local's own-modules record (${problem})`, 'OWN_RECORD_FORMAT');
  const modules = Object.create(null);
  for (const [name, m] of Object.entries(r.modules)) modules[name] = {...m, calls: [...m.calls]};
  return {v: 1, modules};
}

// Writes the record whole, atomically; refuses one it would refuse to read.
// The caller holds packs.lock.
function writeOwnRecord(where, record) {
  const problem = shapeProblem(record);
  if (problem != null) throw new Error(`refused to write the own-modules record: ${problem}`);
  writeAtomic(where.ownRecord, `${JSON.stringify({v: 1, modules: record.modules}, null, 2)}\n`);
}

module.exports = {readOwnRecord, writeOwnRecord, shapeProblem, entryProblem, TREE};
