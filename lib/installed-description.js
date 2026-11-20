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
const {compareVersions} = require('./semver-order');

// alsoWithdrawnBy: another release whose withdrawn packs are not running
// either (homeDescription: the running ch-local's own, beside the home's;
// a pack either withdraws is left out, so a release serving it again holds:
// the medium on L4 baseline, 1)
function installedDescription(where, record, running, {alsoWithdrawnBy = null} = {}) {
  const all = Object.entries((record && record.packs) || {});
  const named = all.map(([name]) => ({name}));
  const out = withdrawnNames(record, named, running);
  if (alsoWithdrawnBy != null) for (const n of withdrawnNames(record, named, alsoWithdrawnBy)) out.add(n);
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

// The record's own release's pins ({packs, modules, pins}), the baseline's
// (post-rel L4 baseline, ruled 11-20 on #101): a ch-local whose own bundled
// release is another (a client process whose home was upgraded or rolled
// back under it, a checkout or a global install) judges what the home holds
// by the pins it was installed from, not by its own, so it isn't held with
// every module unknown.
// The record's version is its runtime's ch-local (runtime.versions, as
// packs.recordRelease reads it; every install records it); a release it
// records must say the same. Then, in order:
// - the home's app, the ch-local its launcher runs (packs.homeSelfDir; no
//   wider a trust than running it): its package.json ch-local at that
//   version, and its lib/release-pins.json (own-file readBoundedFile: a
//   regular file, not a link, at most release-pins MAX_BYTES), parsed by
//   parseReleasePins. Read even when the bundled release has that version:
//   a checkout or global install of the same version may carry other pins
//   (the medium on L4 baseline, 3);
// - with no such app, the bundled release when it has that version (the
//   pins main judged by, a test's home with no app);
// - anything else (no recorded ch-local, another version, a problem in
//   the file): null.
// -> {packs, modules, pins}, or null (homeDescription then holds every
// module unknown)
const SELF = '@countinghouse/ch-local';
const shapeOf = (d) => ({packs: d.packs, modules: d.modules, pins: d.pins});
// (the package.json and the pins are two reads, not tied to one app
// generation: an install or rollback landing between them can pair one
// release's version with another's pins. What that can describe is still
// bounded by the store: a module is described only when the store holds it
// whole at that pin's integrity, so no bytes the pins don't name are ever
// taken for known; the reviewer's high on #103, 4)
function appPins(where, version) {
  const {readBoundedFile} = require('./own-file');
  const dir = require('./packs').homeSelfDir(where);
  const pkgFile = path.join(dir, 'package.json');
  // Only a home with no app at all (<home>/app itself missing) is "no app";
  // an app there whose ch-local is refused or missing (package.json a link,
  // a directory, a FIFO, over the bound, gone mid-install; the app or a
  // directory under it a dangling link) is an app whose pins are unknown,
  // never a reason to take the bundled pins (the reviewer's high on #103,
  // 1; the medium on it, 3 and 4)
  try { fs.lstatSync(where.app); } catch (e) { if (e.code === 'ENOENT') return {found: false}; return {found: true, pins: null}; }
  const pkgBytes = readBoundedFile(pkgFile, {max: 64 * 1024});
  if (pkgBytes == null) return {found: true, pins: null};
  const pkg = JSON.parse(pkgBytes.toString('utf8'));
  if (pkg == null || pkg.name !== SELF || pkg.version !== version) return {found: true, pins: null};
  const {parseReleasePins, MAX_BYTES} = require('./release-pins');
  const bytes = readBoundedFile(path.join(dir, 'lib', 'release-pins.json'), {max: MAX_BYTES});
  if (bytes == null) return {found: true, pins: null};
  const parsed = parseReleasePins(bytes);
  return {found: true, pins: parsed.problem != null ? null : shapeOf(parsed.pins)};
}
function ownReleasePins(where, record, bundled) {
  const versions = record != null && record.runtime != null && record.runtime.versions != null ? record.runtime.versions : {};
  const version = typeof versions[SELF] === 'string' ? versions[SELF] : null;
  if (version == null) return null;
  // (a release recorded with no version is valid: compared only when it is
  // a string, as recordRelease does; the reviewer's high on #103, 5)
  if (record.release != null && typeof record.release.version === 'string' && record.release.version !== version) return null;
  let app;
  try { app = appPins(where, version); } catch (err) { return null; }
  if (app.found) return app.pins;
  return bundled != null && bundled.release != null && bundled.release.version === version ? shapeOf(bundled) : null;
}

// What the home holds, described by its own release's pins: the baseline
// an upgrade's additions are judged against. A pack withdrawn by the home's
// release is not running; nor is one the running release withdrew, which a
// release does by no longer listing it, so a running release older than the
// home's counts for nothing: it doesn't list a newer pack because it never
// knew it (the reviewer's high on #103, 2); one whose version can't be
// compared counts (fail closed). With the
// home's pins unknown, every module the record runs is unknown (null), so
// an automatic upgrade is held, as it was (fail closed).
function homeDescription(where, record, bundled) {
  const pins = ownReleasePins(where, record, bundled);
  if (pins != null) {
    const homeVersion = record.runtime.versions[SELF];
    const ran = bundled != null && bundled.release != null && typeof bundled.release.version === 'string' ? bundled.release.version : null;
    // (a running version not known, or not comparable, counts: fail closed;
    // the medium on #103's round 1, 1)
    const c = ran != null ? compareVersions(ran, homeVersion) : null;
    return installedDescription(where, record, pins, {alsoWithdrawnBy: c === -1 ? null : bundled});
  }
  return installedDescription(where, record, {...bundled, pins: {}, modules: {}});
}

module.exports = {installedDescription, ownReleasePins, homeDescription};
