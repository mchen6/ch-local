'use strict';
// <home>/upgrade-check.json (docs/development/auto-upgrade.md): what start's
// check and the automatic upgrade keep between runs, read as a file only
// this user wrote (lib/own-file.js) and held to its shape, field by field
// (the review of #48: a malformed firstSeen let the 72-hour wait fail open).
// - lastCheck, lastSuccess: ms, a finite number no later than now;
// - firstSeen: {version: ms}, each a strict version and a finite number no
//   later than now;
// - refused: [{version, root}], strings;
// - declined: [version], the versions a rollback left.
// Anything else in it is dropped. A file that is not private is not read:
// the record starts again (so the wait starts again), and `problem` says why.
const path = require('node:path');
const {readOwnFile, writeOwnFile} = require('./own-file');

const STRICT = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const fileOf = (home) => path.join(home, 'upgrade-check.json');
const at = (v, now) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= now ? v : undefined);
const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);

function shaped(doc, now) {
  const out = {firstSeen: {}, refused: [], declined: []};
  if (!isObject(doc)) return out;
  for (const k of ['lastCheck', 'lastSuccess']) { const v = at(doc[k], now); if (v !== undefined) out[k] = v; }
  if (isObject(doc.firstSeen)) {
    for (const [v, t] of Object.entries(doc.firstSeen)) { const ok = at(t, now); if (STRICT.test(v) && ok !== undefined) out.firstSeen[v] = ok; }
  }
  if (Array.isArray(doc.refused)) out.refused = doc.refused.filter((r) => isObject(r) && typeof r.version === 'string' && typeof r.root === 'string').map((r) => ({version: r.version, root: r.root}));
  if (Array.isArray(doc.declined)) out.declined = [...new Set(doc.declined.filter((v) => typeof v === 'string' && STRICT.test(v)))];
  return out;
}

// -> {stamp, problem: null | why it was not read}
function readStamp(home, {now = Date.now(), platform = process.platform} = {}) {
  let bytes = null;
  try {
    bytes = readOwnFile(fileOf(home), {max: 256 * 1024, platform});
  } catch (e) {
    return {stamp: shaped(null, now), problem: e.message};
  }
  if (bytes == null) return {stamp: shaped(null, now), problem: null};
  let doc = null;
  try { doc = JSON.parse(bytes.toString('utf8')); } catch (e) { return {stamp: shaped(null, now), problem: 'upgrade-check.json is not JSON'}; }
  return {stamp: shaped(doc, now), problem: null};
}

function writeStamp(home, stamp) {
  writeOwnFile(fileOf(home), JSON.stringify(stamp) + '\n');
}

// read, changed by fn(stamp), written back
function updateStamp(home, fn, opts = {}) {
  const {stamp} = readStamp(home, opts);
  fn(stamp);
  writeStamp(home, stamp);
  return stamp;
}

module.exports = {readStamp, writeStamp, updateStamp, shaped};
