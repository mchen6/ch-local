'use strict';
// What an install, or an upgrade's install, does to the home's packs
// (module-level install, #413 sections 9.2, 9.4 and 10; L1a-2 Task 3):
// - In a released home the pins decide. The pack named, and every installed
//   pack this release lists, are brought to this release's pins, up or down,
//   with no question: the release is a tested set. A pack the release does
//   not list stays as it was; its modules are then withdrawn (section 9.7,
//   the record's derived list).
// - With development pins (--unreleased-pins), only the pack named takes
//   these pins; every other pack keeps its own, and a module two packs
//   record at different versions is active at the highest (section 9.2,
//   rule 2). Over a home with packs, install then applies section 9.4's
//   table and its questions to this plan (lib/pack-table.js; L1b-2).
// - The migration: a home with an earlier ch-local's packs.json and no
//   modules.json is read as the new shape. Each recorded pack becomes a pack
//   entry, its packages its modules and from the release being installed;
//   its credentials are dropped. A held pack marked withdrawn or relisted
//   becomes an ordinary pack, and the release's listing decides whether its
//   modules load. A pack held after a rollback stays held.
// Nothing here writes; install does, under the home's lock.
const {readModulesRecord, EARLIER} = require('./module-record');
const {readRecord} = require('./record');
const store = require('./module-store');
const {VERSION} = require('./names');

const own = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

// The home as the new shape, whichever file it has. -> {record: {runtime,
// release, unreleased, packs, held, shim?} | null, migrating: the earlier
// record (packs.json) when that is what was read, else null}. Throws as the
// readers do (a rollback cut short, a file that is not a record).
function readHome(where, {release, eff = null}) {
  try {
    const r = readModulesRecord(where);
    return {record: r, migrating: null};
  } catch (err) {
    if (err.message !== EARLIER) throw err;
  }
  const old = readRecord(where);
  if (old == null) return {record: null, migrating: null};
  // from the pins this install takes: a development pins file's digest when
  // it is one (#83's high review, 6)
  const thisFrom = fromRelease(release, eff);
  const packs = {};
  const held = {};
  // an entry with no packages has nothing to migrate (the record holds no
  // empty pack: the medium review of L1a-2, 4)
  const some = (x) => x != null && Object.keys(x).length > 0;
  for (const [name, p] of Object.entries(old.packs || {})) if (some(p.packages)) packs[name] = {from: thisFrom, modules: {...p.packages}};
  for (const [name, h] of Object.entries(old.held || {})) {
    if (!some(h.packages)) continue;
    if (h.withdrawn === true || h.relisted === true) { packs[name] = {from: thisFrom, modules: {...h.packages}}; continue; }
    // held after a rollback: from the release it was installed under
    const under = typeof h.installedUnder === 'string' && VERSION.test(h.installedUnder) ? h.installedUnder : null;
    held[name] = {from: under != null ? {release: under} : thisFrom, modules: {...h.packages}};
  }
  return {
    record: {runtime: old.runtime, release: old.release, unreleased: old.unreleased === true, packs, held,
      ...(old.shim != null ? {shim: old.shim} : {})},
    migrating: old
  };
}

// from for a pack this install takes at its pins
// (the release's version; with none given, the ch-local version it pins)
function fromRelease(allow, eff = null) {
  if (eff != null && eff.unreleased === true) return {unreleased: eff.digest};
  const self = allow != null && allow.pins != null ? allow.pins['@countinghouse/ch-local'] : null;
  return {release: allow != null && allow.release != null && typeof allow.release.version === 'string' ? allow.release.version : self.version};
}

// The pack names this install brings to its pins: the one named, and, from
// a release, every installed pack it lists.
// migrating: a home an earlier ch-local made carries over ONLY the packs
// these pins list, every module of them pinned, each reinstalled from the
// pinned, integrity-checked tarballs; every other pack is not carried over
// (the Reviewer on #83: one rule). Under development pins an unpinned pack
// is simply not carried over.
function touchedPacks(record, {pack, allow, eff, migrating = false}) {
  const listed = (n) => own(allow.packs, n) && (!migrating || allow.packs[n].packages.every((m) => allow.pins[m] != null));
  const out = [];
  if (pack != null) out.push(pack);
  if ((eff.unreleased !== true || migrating) && record != null) for (const n of Object.keys(record.packs)) if (n !== pack && listed(n)) out.push(n);
  return out;
}

// The packs after the install. -> {packs, held, touched, modules: {m: pin}
// (every module a touched pack takes, at its pin)}.
// migrating: only the touched packs are recorded (install names the others,
// from the earlier record itself).
function planInstall(record, {pack, allow, eff, migrating = false}) {
  const touched = touchedPacks(record, {pack, allow, eff, migrating});
  const from = fromRelease(allow, eff);
  const packs = record != null && !migrating ? {...record.packs} : {};
  const held = record != null && !migrating ? {...record.held} : {};

  const modules = {};
  for (const name of touched) {
    const spec = allow.packs[name];
    packs[name] = {from, modules: Object.fromEntries(spec.packages.map((m) => [m, allow.pins[m].version]))};
    delete held[name];
    for (const m of spec.packages) modules[m] = allow.pins[m];
  }
  return {packs, held, touched, modules};
}

// The modules to fetch: those a touched pack takes that the store does not
// hold whole at their pin's integrity (a module already installed is not
// installed again, section 9.1). A hint read without the lock; install
// checks again under it.
function toFetch(where, modules) {
  // unknown (a marker that cannot be read): fetched, and placing it then
  // refuses rather than guesses
  const whole = (m, pin) => { try { return store.wholeAt(where, m, pin); } catch (err) { return false; } };
  return Object.entries(modules).filter(([m, pin]) => !whole(m, pin)).map(([m]) => m);
}

// roleOf for the record's derived modules: a version's role from the store;
// one that is not there (a withdrawn pack an earlier ch-local held, never
// placed in the store) has none to read, and is never loaded.
const roleFor = (where) => (name, version) => {
  try { return store.roleOf(where, name, version); } catch (err) { return null; }
};

// Whether a live start uses a module version (section 9.1's in-use test):
// the run directory read once per operation, under the home's lock (a start
// writes its run.json under it, so none begins meanwhile: the medium review
// of L1a-2, 9). A run's loaded holds a version, or several when two loaded
// packs held a module at different versions.
function inUseFor(where, io) {
  let used = null;
  return (name, version) => {
    if (used == null) {
      used = new Set();
      for (const r of require('./gc').liveRuns(where, {alive: io.alive, hostname: io.hostname})) {
        for (const [m, v] of Object.entries(r.loaded || {})) for (const x of [].concat(v)) if (typeof x === 'string') used.add(`${m}@${x}`);
      }
    }
    return used.has(`${name}@${version}`);
  };
}

module.exports = {readHome, planInstall, touchedPacks, toFetch, fromRelease, roleFor, inUseFor};
