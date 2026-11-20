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
// A pack the record has withdrawn is not running (section 9.7): it is
// {modules: [], withdrawn: true}, and its withdrawn modules are not in
// `modules`, so a release that lists it again adds them (the Reviewer's high
// on L4, 4).
//
// -> {packs: {<pack>: {modules: [package], withdrawn?: true}}, modules:
// {<package>: description | null}}, pins-shaped for lib/release-pins.js
// additions(). running: the bundled release (lib/allowlist ALLOWLIST: {pins,
// modules}), the same data findUpgrade judges the new release against.
const {own} = require('./module-record');
const {readMarker} = require('./module-store');
const {heldWithdrawn} = require('./packs');

function installedDescription(where, record, running) {
  const gone = new Set((record && Array.isArray(record.withdrawn)) ? record.withdrawn : []);
  const held = new Set(heldWithdrawn(record));
  const packs = {};
  for (const [name, p] of Object.entries((record && record.packs) || {})) {
    const mods = Object.keys((p && p.modules) || {}).filter((m) => !gone.has(m)).sort();
    packs[name] = held.has(name) ? {modules: mods, withdrawn: true} : {modules: mods};
  }
  const pins = (running && running.pins) || {};
  const descs = (running && running.modules) || {};
  const verified = (m, version) => {
    if (!own(pins, m) || !own(descs, m) || pins[m].version !== version) return false;
    let marker;
    try { marker = readMarker(where, m, version); } catch (err) { return false; }
    return marker != null && typeof marker.integrity === 'string' && marker.integrity === pins[m].integrity;
  };
  const modules = {};
  for (const [m, e] of Object.entries((record && record.modules) || {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (gone.has(m)) continue;
    modules[m] = e != null && typeof e.version === 'string' && verified(m, e.version) ? descs[m] : null;
  }
  return {packs, modules};
}

module.exports = {installedDescription};
