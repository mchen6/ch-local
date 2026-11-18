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

// The run.json of every start that is alive: on this machine while its pid
// or its runtime's lives; on another (a home on a shared disk) while its
// heartbeat is under STALE_MS old. -> [run], each with an object `loaded`.
function liveRuns(where, {alive = () => false, hostname, now = Date.now(), machine = machineId()} = {}) {
  const here = hostTag(hostname);
  let names = [];
  try { names = fs.readdirSync(where.run); } catch (err) { names = []; }
  const out = [];
  for (const name of names) {
    let run = null;
    let mtime = 0;
    const file = path.join(where.run, name, 'run.json');
    try { run = JSON.parse(fs.readFileSync(file, 'utf8')); mtime = fs.statSync(file).mtimeMs; } catch (err) { continue; }
    if (run == null || typeof run.loaded !== 'object' || run.loaded == null) continue;
    const thisMachine = (run.machine != null) ? run.machine === machine : run.host === here;
    const live = thisMachine
      ? ((Number.isInteger(run.pid) && alive(run.pid)) || (Number.isInteger(run.childPid) && alive(run.childPid)))
      : now - mtime < STALE_MS;
    if (live) out.push(run);
  }
  return out;
}

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
  for (const run of liveRuns(where, {alive, hostname, now, machine})) {
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

// The module store (module-level install, #413 section 9.10): a version is
// kept while any of these names it:
// - an installed or a held pack of modules.json: every version a pack
//   records, not only the active one (the lower ones are what remove-pack
//   goes back to);
// - the release rollback's kept record (previous/modules.json);
// - a live start's run.json, whose loaded is {<module>: <version>}. A run
//   from before the store ({<pack>: <tree key>}) names no store version
//   (its pack names are not package names it loaded), and keeps its old
//   tree through collect() above; reading it here too only keeps more.
// Everything else under the store is renamed aside and deleted: staging and
// trash leftovers, a version not named, a version with no marker, a marker
// with no version, anything that is not a module's. Under the home's lock
// (the caller's), as collect(). -> {removed: [path], kept: [{dir, why}]}
// (problem: why nothing was collected, when the record cannot be read).
function collectStore(where, {alive = () => false, hostname, now = Date.now(), machine = machineId()} = {}) {
  const {readModulesRecord} = require('./module-record');
  const store = require('./module-store');
  const keep = new Map();
  const keepRec = (r, why) => {
    if (r == null) return;
    for (const p of Object.values(r.packs || {})) for (const [m, v] of Object.entries(p.modules || {})) if (!keep.has(`${m}@${v}`)) keep.set(`${m}@${v}`, why);
    for (const p of Object.values(r.held || {})) for (const [m, v] of Object.entries(p.modules || {})) if (!keep.has(`${m}@${v}`)) keep.set(`${m}@${v}`, 'held');
  };
  try { keepRec(readModulesRecord(where), 'current'); } catch (err) { return {removed: [], kept: [], problem: err.message}; }
  // the kept record names what a rollback returns to; unreadable, it names
  // nothing (rollback then refuses it, and nothing of its is needed)
  try { keepRec(readModulesRecord({modulesRecord: where.previousModulesRecord}), 'rollback'); } catch (err) { /* none */ }
  for (const run of liveRuns(where, {alive, hostname, now, machine})) {
    for (const [m, v] of Object.entries(run.loaded)) if (typeof v === 'string' && !keep.has(`${m}@${v}`)) keep.set(`${m}@${v}`, 'running');
  }
  const removed = [];
  const kept = [];
  const gone = (at) => {
    try {
      const base = path.basename(at);
      const aside = base.includes('.trash-') ? at : `${at}.trash-${crypto.randomBytes(4).toString('hex')}`;
      if (aside !== at) fs.renameSync(at, aside);
      fs.rmSync(aside, {recursive: true, force: true});
      removed.push(at);
    } catch (err) { kept.push({dir: at, why: `could not remove (${err.code || err.message})`}); }
  };
  const list = (dir) => { try { return fs.readdirSync(dir, {withFileTypes: true}); } catch (err) { return []; } };
  // one module's directory: its versions and their markers
  const collectModule = (name, dir) => {
    const entries = list(dir);
    const versions = new Set(entries.filter((e) => e.isDirectory() && store.VERSION.test(e.name)).map((e) => e.name));
    for (const e of entries) {
      const at = path.join(dir, e.name);
      if (versions.has(e.name)) {
        const why = keep.get(`${name}@${e.name}`);
        if (why != null && store.isComplete(where, name, e.name)) { kept.push({dir: at, why}); continue; }
        // the marker first: an incomplete version is never taken for whole
        fs.rmSync(`${at}.json`, {force: true});
        gone(at);
        continue;
      }
      const marker = /^(.+)\.json$/.exec(e.name);
      if (marker != null && e.isFile() && versions.has(marker[1]) && keep.has(`${name}@${marker[1]}`)) continue;
      if (marker != null && e.isFile() && versions.has(marker[1])) continue;   // went with its version above
      gone(at);
    }
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (err) { /* in use or gone */ }
  };
  for (const top of list(where.moduleStore)) {
    const at = path.join(where.moduleStore, top.name);
    if (top.isDirectory() && /^@[a-z0-9][a-z0-9._-]{0,63}$/.test(top.name)) {
      for (const e of list(at)) {
        const name = `${top.name}/${e.name}`;
        if (e.isDirectory() && store.PACKAGE.test(name)) collectModule(name, path.join(at, e.name));
        else gone(path.join(at, e.name));
      }
      try { if (fs.readdirSync(at).length === 0) fs.rmdirSync(at); } catch (err) { /* in use or gone */ }
    } else if (top.isDirectory() && !top.name.startsWith('@') && store.PACKAGE.test(top.name)) {
      collectModule(top.name, at);
    } else {
      gone(at);
    }
  }
  return {removed, kept};
}

module.exports = {collect, collectStore, liveRuns, hostTag, HEARTBEAT_MS, STALE_MS};
