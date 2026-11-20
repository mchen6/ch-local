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
// counts as unknown, so what the release says it sends or calls is reported
// as new (an automatic upgrade is held back, never let through on a guess).
const fs = require('node:fs');
const path = require('node:path');
const {versionDir} = require('./store-paths');
const {describeModule, friendlyNames} = require('./describe-module');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return null; }
}

function installedDescription(where, record) {
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const packs = {};
  for (const [name, p] of Object.entries((record && record.packs) || {})) packs[name] = {modules: Object.keys((p && p.modules) || {}).sort()};
  const versions = {};
  for (const [m, e] of Object.entries((record && record.modules) || {})) if (e != null && typeof e.version === 'string') versions[m] = e.version;
  const manifests = {};
  const apis = {};
  for (const [m, v] of Object.entries(versions)) {
    const dir = versionDir(where, m, v);
    manifests[m] = readJson(path.join(dir, 'package.json'));
    apis[m] = readJson(path.join(dir, 'api.json'));
  }
  // (two installed modules sharing a friendly name: no call resolves, so
  // every module is unknown, never one guessed)
  const friendly = friendlyNames(apis);
  const modules = {};
  for (const m of Object.keys(versions).sort()) {
    const manifest = manifests[m];
    if (!own(manifests, m) || manifest == null || friendly.problem != null) { modules[m] = null; continue; }
    const d = describeModule(manifest, friendly.map);
    modules[m] = d.problem != null ? null : d;
  }
  return {packs, modules};
}

module.exports = {installedDescription};
