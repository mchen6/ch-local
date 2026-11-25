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
// a pack tree's key, as an earlier ch-local named it: its scenario's version
// and a short hash of every package@version it held (once lib/pack-dir.js);
// read only to keep the trees a record from before names
const packKey = (packages) => {
  const names = Object.keys(packages);
  const hash = require('node:crypto').createHash('sha256').update(names.slice().sort().map((n) => `${n}@${packages[n]}`).join('\n')).digest('hex').slice(0, 8);
  return `${packages[names[0]]}+${hash}`;
};
const {readModulesRecord} = require('./module-record');
const store = require('./module-store');
const {removeAside} = require('./aside');
const {SCOPE} = require('./names');

const {machineId} = require('./machine');
const {HEARTBEAT_MS, STALE_MS, hostTag} = require('./run-liveness');

// The run.json of every start that is alive: on this machine while its pid
// or its runtime's lives; on another (a home on a shared disk) while its
// heartbeat is under STALE_MS old. -> [run], each with an object `loaded`.
// alive(pid) is required: a caller that left it out would take every start
// on this machine for dead, and collect what they loaded (#82's high review, 1).
// sameMachine: only this machine's (a home on a shared disk has others').
// unreadable(name): given the directory of a run that can't be read, which is
// then left out and not thrown for (never collection's).
function liveRuns(where, {alive, hostname, now = Date.now(), machine = machineId(), sameMachine = false, unreadable: skip = null} = {}) {
  if (typeof alive !== 'function') throw new Error('liveRuns: alive is required');
  const here = hostTag(hostname);
  // a run that cannot be read could be a live start's: unknown, which
  // throws, and the caller collects nothing (#82's medium, 1). Only "not
  // there" is no run: no run directory, or a run directory being removed.
  const unreadable = (what, err) => Object.assign(new Error(`${what} could not be read (${err.code || err.message}); nothing was collected`), {unknown: true});
  let names = [];
  try { names = fs.readdirSync(where.run); } catch (err) { if (err.code !== 'ENOENT') throw unreadable(where.run, err); }
  const out = [];
  for (const name of names) {
    let run = null;
    let mtime = 0;
    const file = path.join(where.run, name, 'run.json');
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); mtime = fs.statSync(file).mtimeMs; } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;
      if (skip != null) { skip(name); continue; }
      throw unreadable(file, err);
    }
    // written whole (writeAtomic): one that is not JSON is not a run's
    try { run = JSON.parse(raw); } catch (err) {
      if (skip != null) { skip(name); continue; }
      throw unreadable(file, err);
    }
    if (run == null || typeof run.loaded !== 'object' || run.loaded == null) continue;
    const thisMachine = (run.machine != null) ? run.machine === machine : run.host === here;
    const live = thisMachine
      ? ((Number.isInteger(run.pid) && alive(run.pid)) || (Number.isInteger(run.childPid) && alive(run.childPid)))
      : now - mtime < STALE_MS;
    if (live && (thisMachine || !sameMachine)) out.push(run);
  }
  return out;
}

// The rollback's kept record, as collection reads it (#82's medium, 3): not
// there names nothing; there but unreadable is unknown, and nothing is
// collected; readable but not a record names nothing (rollback refuses it,
// and nothing of its is needed). -> {record} or {problem}.
function keptRecord(file, read) {
  try { fs.accessSync(file, fs.constants.R_OK); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return {record: null};
    return {problem: `${file} could not be read (${err.code || err.message}); nothing was collected`};
  }
  try {
    fs.readFileSync(file);
  } catch (err) {
    return {problem: `${file} could not be read (${err.code || err.message}); nothing was collected`};
  }
  try { return {record: read(file)}; } catch (err) { return {record: null}; }
}

// The pack trees an earlier ch-local unpacked (<home>/packs/<pack>/<key>/)
// are never deleted: the whole directory is renamed aside
// (packs.migrated-<time>) once no live start from before uses one of them
// (its run.json's loaded names a tree, {<pack>: <tree key>}); while one
// does, it stays where it is, untouched, and a later install sets it aside
// (the Reviewer's ruling on #83: nothing deleted; the medium review of it,
// 1 and 2). A rename that fails leaves it where it is.
// -> {keptAt} | {waiting: true} | {problem} | {}  (nothing to keep)
function keepOldTreesAside(where, {alive, hostname, now = Date.now(), machine = machineId()} = {}) {
  if (typeof alive !== 'function') throw new Error('keepOldTreesAside: alive is required');
  if (!fs.existsSync(where.packsDir)) return {};
  let runs;
  try { runs = liveRuns(where, {alive, hostname, now, machine}); } catch (err) { return {problem: err.message}; }
  // a tree key: its scenario's version, "+", 8 hex digits
  const fromBefore = runs.some((r) => Object.values(r.loaded).some((v) => typeof v === 'string' && /\+[0-9a-f]{8}$/.test(v)));
  if (fromBefore) return {waiting: true};
  const keptAt = `${where.packsDir}.migrated-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  try { fs.renameSync(where.packsDir, keptAt); } catch (err) { return {problem: `${where.packsDir} could not be kept aside (${err.code || err.message}); it is left where it is`}; }
  return {keptAt};
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
//   tree in place (keepOldTreesAside above); reading it here too only keeps more.
// Everything else under the store is renamed aside and deleted: staging and
// trash leftovers, a version not named, a version with no marker, a marker
// with no version, anything that is not a module's. Under the home's lock
// (the caller's). -> {removed: [path], kept: [{dir, why}]}
// (problem: why nothing was collected, when the record cannot be read).
function collectStore(where, {alive, hostname, now = Date.now(), machine = machineId()} = {}) {
  if (typeof alive !== 'function') throw new Error('collectStore: alive is required');
  const keep = new Map();
  const keepRec = (r, why) => {
    if (r == null) return;
    for (const p of Object.values(r.packs || {})) for (const [m, v] of Object.entries(p.modules || {})) if (!keep.has(`${m}@${v}`)) keep.set(`${m}@${v}`, why);
    for (const p of Object.values(r.held || {})) for (const [m, v] of Object.entries(p.modules || {})) if (!keep.has(`${m}@${v}`)) keep.set(`${m}@${v}`, 'held');
  };
  try { keepRec(readModulesRecord(where), 'current'); } catch (err) { return {removed: [], kept: [], problem: err.message}; }
  // the kept record names what a rollback returns to (keptRecord's rules)
  const kept0 = keptRecord(where.previousModulesRecord, (file) => readModulesRecord({modulesRecord: file}));
  if (kept0.problem != null) return {removed: [], kept: [], problem: kept0.problem};
  keepRec(kept0.record, 'rollback');
  // what a live start loaded: kept even when incomplete (a failed swap left
  // it in use), as placeModule refuses to replace it (#82's medium, 2)
  const running = new Set();
  try {
    for (const run of liveRuns(where, {alive, hostname, now, machine})) {
      // a version, or several (two loaded packs at different versions)
      for (const [m, vs] of Object.entries(run.loaded)) {
        for (const v of [].concat(vs)) {
          if (typeof v !== 'string') continue;
          running.add(`${m}@${v}`);
          if (!keep.has(`${m}@${v}`)) keep.set(`${m}@${v}`, 'running');
        }
      }
    }
  } catch (err) { return {removed: [], kept: [], problem: err.message}; }
  const removed = [];
  const kept = [];
  // marker: a version's, removed first, inside the same guard, so one that
  // cannot be removed is reported, never thrown (medium review, 3)
  const gone = (at, marker = null) => {
    try {
      if (marker != null) fs.rmSync(marker, {force: true});
      removeAside(at);
      removed.push(at);
    } catch (err) { kept.push({dir: at, why: `could not remove (${err.code || err.message})`}); }
  };
  const list = (dir) => { try { return fs.readdirSync(dir, {withFileTypes: true}); } catch (err) { return []; } };
  // one module's directory: its versions and their markers
  const collectModule = (name, dir) => {
    const entries = list(dir);
    const versions = new Set(entries.filter((e) => e.isDirectory() && store.storeVersion(e.name)).map((e) => e.name));
    for (const e of entries) {
      const at = path.join(dir, e.name);
      if (versions.has(e.name)) {
        const why = keep.get(`${name}@${e.name}`);
        // a version or marker that cannot be read is unknown, and unknown is
        // kept: never deleted on a read error (#82's high review, 2)
        let complete;
        try { complete = store.isComplete(where, name, e.name); } catch (err) { kept.push({dir: at, why: `could not be read (${err.code || err.message})`}); continue; }
        if (why != null && complete) { kept.push({dir: at, why}); continue; }
        if (running.has(`${name}@${e.name}`)) { kept.push({dir: at, why: 'running (incomplete)'}); continue; }
        // the marker first: an incomplete version is never taken for whole
        gone(at, `${at}.json`);
        continue;
      }
      // a version's marker stays with it, or goes with it above
      const marker = /^(.+)\.json$/.exec(e.name);
      if (marker != null && e.isFile() && versions.has(marker[1])) continue;
      gone(at);
    }
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (err) { /* in use or gone */ }
  };
  for (const top of list(where.moduleStore)) {
    const at = path.join(where.moduleStore, top.name);
    if (top.isDirectory() && SCOPE.test(top.name)) {
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
  // the user's own modules' copies, by the same live runs' rule
  const own = collectOwn(where, {alive, hostname, now, machine});
  return {removed: removed.concat(own.removed), kept: kept.concat(own.kept), ...(own.problem != null ? {ownProblem: own.problem} : {})};
}

// The user's own modules' copies (B-own-add; the own-modules design §2.6):
// <home>/own/<name>/<tree> is kept while own.json names it or a live
// start's run.json loaded it ({<name>: <tree>}); any other copy whose
// marker (<tree>.json) names it goes, the marker first, so a copy cut short
// is never taken for whole. A folder with no such marker is not ch-local's
// to take: kept. An own.json or a run that can't be read collects nothing
// (unknown is kept). Under the home's lock (the caller's). -> {removed:
// [path], kept: [{dir, why}], problem?}
const TREE = /^[0-9a-f]{64}$/;
function collectOwn(where, {alive, hostname, now = Date.now(), machine = machineId()} = {}) {
  const {readOwnRecord} = require('./own-record');
  const {markerOf} = require('./own-tree');
  const keep = new Set();
  try {
    const record = readOwnRecord(where);
    if (record != null) for (const [name, e] of Object.entries(record.modules)) keep.add(`${name}\0${e.tree}`);
  } catch (err) { return {removed: [], kept: [], problem: err.message}; }
  try {
    for (const run of liveRuns(where, {alive, hostname, now, machine})) {
      for (const [m, vs] of Object.entries(run.loaded)) for (const v of [].concat(vs)) if (typeof v === 'string' && TREE.test(v)) keep.add(`${m}\0${v}`);
    }
  } catch (err) { return {removed: [], kept: [], problem: err.message}; }
  const removed = [];
  const kept = [];
  const list = (dir) => { try { return fs.readdirSync(dir, {withFileTypes: true}); } catch (err) { return []; } };
  const collectName = (name, dir) => {
    for (const e of list(dir)) {
      if (!e.isDirectory() || !TREE.test(e.name)) continue;
      const at = path.join(dir, e.name);
      if (keep.has(`${name}\0${e.name}`)) { kept.push({dir: at, why: 'in use'}); continue; }
      const marker = markerOf(where, name, e.name);
      let mine = false;
      try { const m = JSON.parse(fs.readFileSync(marker, 'utf8')); mine = m != null && m.name === name && m.tree === e.name; } catch (err) { mine = false; }
      if (!mine) { kept.push({dir: at, why: 'not marked as ch-local\'s'}); continue; }
      try {
        // (a copy is read-only: writable again before it goes, and its
        // marker removed only then, so one that can't be unlocked is kept
        // marked and collected later: the medium on #113's round 1)
        require('./own-tree').unlockTree(at);
        fs.rmSync(marker, {force: true});
        removeAside(at);
        removed.push(at);
      } catch (err) { kept.push({dir: at, why: `could not remove (${err.code || err.message})`}); }
    }
    try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch (err) { /* in use or gone */ }
  };
  for (const top of list(where.own)) {
    if (!top.isDirectory()) continue;
    const at = path.join(where.own, top.name);
    if (SCOPE.test(top.name)) {
      for (const e of list(at)) if (e.isDirectory() && store.PACKAGE.test(`${top.name}/${e.name}`)) collectName(`${top.name}/${e.name}`, path.join(at, e.name));
      try { if (fs.readdirSync(at).length === 0) fs.rmdirSync(at); } catch (err) { /* in use or gone */ }
    } else if (!top.name.startsWith('@') && store.PACKAGE.test(top.name)) {
      collectName(top.name, at);
    }
  }
  return {removed, kept};
}

module.exports = {keepOldTreesAside, collectStore, collectOwn, liveRuns, packKey, hostTag, HEARTBEAT_MS, STALE_MS};
