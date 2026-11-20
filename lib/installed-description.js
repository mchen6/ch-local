'use strict';
// What the home has installed, described as the release pins describe a
// release (#413 rev 3 sections 9.3 and 9.6; L4): the baseline a new
// release's additions are judged against. It is the home's own record, not
// the bundled pins as such: a module is described only when it is verifiably
// what the running release pinned (the Reviewer's high on L4, 3):
// - the record has it at the running release's pin version, and
// - the store's marker for that version names the pin's integrity;
// then the running release's description of those bytes is its description.
// Anything else (a module the version table keeps off its pin, a held
// pack's, a marker that can't be read or names other bytes) is null:
// unknown, which holds an automatic upgrade back. The store's files are
// never read as a description: they are not verified to be the pinned bytes.
//
// What runs is start's own rule (packs.withdrawnNames against the running
// release: a pack it does not list, or one the record has withdrawn, is not
// running; the Reviewer's high on #101, round 2). A pack not running is
// {modules: [], withdrawn: true}, and a module no running pack lists is not
// in `modules`, so a release that serves it again adds them (the
// Reviewer's high on L4, 4). A module is verified by the store holding it
// whole at the pin (module-store wholeAt: its directory and its marker).
//
// -> {packs: {<pack>: {modules: [package], withdrawn?: true}}, modules:
// {<package>: description | null}}, pins-shaped for lib/release-pins.js
// additions(). running: the bundled release (lib/allowlist ALLOWLIST:
// {packs, pins, modules}; its packs decide what runs), the same data
// findUpgrade judges the new release against.
const {own} = require('./module-record');
const {wholeAt} = require('./module-store');
const {withdrawnNames} = require('./packs');

function installedDescription(where, record, running) {
  const all = Object.entries((record && record.packs) || {});
  const out = withdrawnNames(record, all.map(([name]) => ({name})), running);
  const packs = {};
  const runs = new Set();
  for (const [name, p] of all) {
    const mods = Object.keys((p && p.modules) || {}).sort();
    if (out.has(name)) { packs[name] = {modules: [], withdrawn: true}; continue; }
    packs[name] = {modules: mods};
    for (const m of mods) runs.add(m);
  }
  const pins = (running && running.pins) || {};
  const descs = (running && running.modules) || {};
  const verified = (m, version) => {
    // (a pin with no integrity verifies nothing: the medium on #101 round 2, 5)
    if (!own(pins, m) || !own(descs, m) || pins[m].version !== version || typeof pins[m].integrity !== 'string') return false;
    try { return wholeAt(where, m, pins[m]); } catch (err) { return false; }
  };
  const modules = {};
  for (const [m, e] of Object.entries((record && record.modules) || {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!runs.has(m)) continue;
    modules[m] = e != null && typeof e.version === 'string' && verified(m, e.version) ? descs[m] : null;
  }
  return {packs, modules};
}

module.exports = {installedDescription};
