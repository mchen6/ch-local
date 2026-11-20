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
const fs = require('node:fs');
const path = require('node:path');
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

// The record's own release, ALLOWLIST-shaped ({release, self, runtime,
// packs, modules, pins}), the baseline's pins (post-rel L4 baseline, ruled
// 11-20 on #101): a ch-local whose own bundled release is another (a client
// process whose home was upgraded or rolled back under it, a checkout or a
// global install) judges what the home holds by the pins it was installed
// from, not by its own, so it isn't held with every module unknown.
// The record's version is its runtime's ch-local (runtime.versions, as
// packs.recordRelease reads it); a release it records must say the same.
// - bundled is that release (its version the record's): it, no file read;
// - else the home's app, the ch-local its launcher runs (packs.homeSelfDir;
//   no wider a trust than running it): its package.json name ch-local and
//   version the record's, and its
//   lib/release-pins.json read as a regular file, not a link, at most
//   release-pins MAX_BYTES, parsed by parseReleasePins;
// - anything else (no recorded ch-local, no app, another version, a file
//   unreadable, a link, too large, a problem in it): null.
// -> that object, or null (homeDescription then holds every module unknown)
const SELF = '@countinghouse/ch-local';
function readBounded(file, max) {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile()) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) return null;
    const buf = Buffer.alloc(max + 1);
    const n = fs.readSync(fd, buf, 0, max + 1, 0);
    return n > max ? null : buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}
function ownReleasePins(where, record, bundled) {
  // (the record's own ch-local is its runtime's, as packs.recordRelease
  // reads it; its release, where it records one, must say the same)
  const versions = record != null && record.runtime != null && record.runtime.versions != null ? record.runtime.versions : {};
  const version = typeof versions[SELF] === 'string' ? versions[SELF] : null;
  if (version == null) return null;
  if (record.release != null && record.release.version !== version) return null;
  if (bundled != null && bundled.release != null && bundled.release.version === version) return bundled;
  try {
    const dir = require('./packs').homeSelfDir(where);
    const pkgBytes = readBounded(path.join(dir, 'package.json'), 64 * 1024);
    if (pkgBytes == null) return null;
    const pkg = JSON.parse(pkgBytes.toString('utf8'));
    if (pkg == null || pkg.name !== SELF || pkg.version !== version) return null;
    const {parseReleasePins, MAX_BYTES} = require('./release-pins');
    const bytes = readBounded(path.join(dir, 'lib', 'release-pins.json'), MAX_BYTES);
    if (bytes == null) return null;
    const parsed = parseReleasePins(bytes);
    if (parsed.problem != null) return null;
    const d = parsed.pins;
    return {release: {version, security: d.release.security}, self: d.self, runtime: d.runtime, packs: d.packs, modules: d.modules, pins: d.pins};
  } catch (err) {
    return null;
  }
}

// What the home holds, described by its own release's pins: the baseline
// an upgrade's additions are judged against. With those pins unknown, every
// module the record runs is unknown (null), so an automatic upgrade is held,
// as it was (fail closed); which packs run is then judged by the bundled
// release, as before.
function homeDescription(where, record, bundled) {
  const pins = ownReleasePins(where, record, bundled);
  if (pins != null) return installedDescription(where, record, pins);
  return installedDescription(where, record, {...bundled, pins: {}, modules: {}});
}

module.exports = {installedDescription, ownReleasePins, homeDescription};
