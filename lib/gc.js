'use strict';
// Packs in place (part 2, plan Task B2): the pack trees no live start uses
// are collected, after every install, add-pack, remove-pack and rollback
// (under the home's lock, so no tree is being placed meanwhile). Kept:
// - the current record's trees, a held pack's, and the rollback target's
//   (<home>/previous/packs.json);
// - any tree a running start names in its run.json: on this machine while
//   its pid or its runtime's lives; on another machine (a home on a shared
//   disk) while its heartbeat (run.json's mtime, refreshed every
//   HEARTBEAT_MS) is under STALE_MS old.
// A tree is renamed aside (.trash-*) before it is deleted, so a half-deleted
// tree is never taken for a whole one.
// Removed: every other tree under <home>/packs, staging leftovers included.
const fs = require('node:fs');
const path = require('node:path');
const {readRecord} = require('./record');
const {packKey} = require('./pack-dir');

const crypto = require('node:crypto');
const {machineId} = require('./machine');
const HEARTBEAT_MS = 10 * 60 * 1000;
const STALE_MS = 3 * HEARTBEAT_MS;
const hostTag = (hostname) => String(hostname || 'host').replace(/[^A-Za-z0-9.-]/g, '_').slice(0, 64) || 'host';

// keep: Map of '<pack>/<key>' -> why, from a record's packs and held packs
function keepRecord(keep, record, why) {
  if (record == null) return;
  for (const [name, p] of Object.entries(record.packs || {})) keep.set(`${name}/${packKey(p.packages || {})}`, why);
  for (const [name, p] of Object.entries(record.held || {})) keep.set(`${name}/${packKey(p.packages || {})}`, 'held');
}

// -> {removed: [dir], kept: [{dir, why}]}
function collect(where, {alive = () => false, hostname, now = Date.now(), machine = machineId()} = {}) {
  const keep = new Map();
  let current = null;
  try { current = readRecord(where); } catch (err) { return {removed: [], kept: [], problem: err.message}; }
  keepRecord(keep, current, 'current');
  let previous = null;
  try { previous = readRecord({packs: where.previousRecord}); } catch (err) { previous = null; }
  keepRecord(keep, previous, 'rollback');
  const here = hostTag(hostname);
  let runs = [];
  try { runs = fs.readdirSync(where.run); } catch (err) { runs = []; }
  for (const name of runs) {
    let run = null;
    let mtime = 0;
    const file = path.join(where.run, name, 'run.json');
    try { run = JSON.parse(fs.readFileSync(file, 'utf8')); mtime = fs.statSync(file).mtimeMs; } catch (err) { continue; }
    if (run == null || typeof run.loaded !== 'object' || run.loaded == null) continue;
    const thisMachine = (run.machine != null) ? run.machine === machine : run.host === here;
    const live = thisMachine
      ? ((Number.isInteger(run.pid) && alive(run.pid)) || (Number.isInteger(run.childPid) && alive(run.childPid)))
      : now - mtime < STALE_MS;
    if (!live) continue;
    for (const [pack, key] of Object.entries(run.loaded)) if (typeof key === 'string' && !keep.has(`${pack}/${key}`)) keep.set(`${pack}/${key}`, 'running');
  }
  const removed = [];
  const kept = [];
  let packs = [];
  try { packs = fs.readdirSync(where.packsDir); } catch (err) { packs = []; }
  for (const pack of packs) {
    const packDir = path.join(where.packsDir, pack);
    let trees = [];
    try { trees = fs.readdirSync(packDir); } catch (err) { continue; }
    for (const key of trees) {
      const dir = path.join(packDir, key);
      const why = keep.get(`${pack}/${key}`);
      if (why != null) { kept.push({dir, why}); continue; }
      try {
        // aside first, whole, then deleted: never half a tree under its name
        const aside = key.includes('.trash-') ? dir : `${dir}.trash-${crypto.randomBytes(4).toString('hex')}`;
        if (aside !== dir) fs.renameSync(dir, aside);
        fs.rmSync(aside, {recursive: true, force: true});
        removed.push(dir);
      } catch (err) { kept.push({dir, why: `could not remove (${err.code || err.message})`}); }
    }
    try { if (fs.readdirSync(packDir).length === 0) fs.rmdirSync(packDir); } catch (err) { /* in use or gone */ }
  }
  return {removed, kept};
}

module.exports = {collect, hostTag, HEARTBEAT_MS, STALE_MS};
