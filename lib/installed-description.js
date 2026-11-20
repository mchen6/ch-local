'use strict';
// What the home has installed, described as the release pins describe a
// release (#413 rev 3 sections 9.3 and 9.6; L4): the baseline a new
// release's additions are judged against. It is the home's own record, not
// the bundled pins of the ch-local that runs: a module the version table
// keeps off its pin, or a held pack's, is described as it is installed.
// Each module is read from the store at the version the record names, by
// the reader install's description check uses (lib/describe-module.js), so
// the preview and the install judge a manifest the same way.
//
// -> {packs: {<pack>: {modules: [package]}}, modules: {<package>:
// description | null}}, pins-shaped for lib/release-pins.js additions().
// A module whose stored manifest can't be read or described is null: it
// counts as unknown: additions reports it as such, and an automatic upgrade
// is held back, never let through on a guess.
const {fileOf} = require('./description-check');
const {describeModule, friendlyNames} = require('./describe-module');

function installedDescription(where, record) {
  const packs = {};
  for (const [name, p] of Object.entries((record && record.packs) || {})) packs[name] = {modules: Object.keys((p && p.modules) || {}).sort()};
  const versions = {};
  for (const [m, e] of Object.entries((record && record.modules) || {})) if (e != null && typeof e.version === 'string') versions[m] = e.version;
  // (each read as install's description check reads a stored module:
  // lib/description-check.js fileOf; the medium on L4, 9)
  const json = (m, name) => { const r = fileOf(where, m, versions[m], undefined, name); return r != null && r.unreadable !== true ? r : null; };
  const manifests = {};
  const apis = {};
  for (const m of Object.keys(versions)) { manifests[m] = json(m, 'package.json'); apis[m] = json(m, 'api.json'); }
  // The names calls resolve to: every installed module's (a withdrawn
  // pack's own calls resolve among its own modules); a name two of them
  // share is no one's, so only a call to it is unknown, never the whole home
  // (the medium on L4, 2)
  const map = new Map();
  const shared = new Set();
  for (const m of Object.keys(versions).sort()) {
    for (const [name] of friendlyNames({[m]: apis[m]}).map) {
      if (map.has(name)) shared.add(name); else map.set(name, m);
    }
  }
  for (const name of shared) map.delete(name);
  const modules = {};
  for (const m of Object.keys(versions).sort()) {
    const manifest = manifests[m];
    if (manifest == null) { modules[m] = null; continue; }
    const d = describeModule(manifest, map);
    modules[m] = d.problem != null ? null : d;
  }
  return {packs, modules};
}

module.exports = {installedDescription};
