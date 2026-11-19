'use strict';
// install's and add-pack's check that each module is what the release's
// pins describe (#413 section 9.3; L5b): its credential destination, its
// calls and its confirm settings, read from the package's own package.json
// by lib/describe-module.js, the reader the release step wrote the
// description with. A difference refuses the whole operation before anything
// is placed, so what an upgrade showed (additions) is what is installed.
//
// Every module of the operation is checked: one about to be placed, from its
// fetched, integrity-checked bytes; one the store already holds whole at its
// pin, from the store (the same bytes, by its integrity; checked anyway, so
// a release whose description is wrong is refused, not trusted).
const fs = require('node:fs');
const path = require('node:path');
const {readMember} = require('./tar');
const {versionDir} = require('./store-paths');
const {describeModule, friendlyNames, describeProblem} = require('./describe-module');

// one file of a module: from its bytes when given, else from the store at
// version -> parsed JSON, null when absent, {unreadable} when not JSON
function fileOf(where, m, version, bytes, name) {
  let raw = null;
  try {
    raw = bytes != null ? readMember(bytes, name) : fs.readFileSync(path.join(versionDir(where, m, version), name));
  } catch (err) {
    // the strict tar reader's own refusal is said as it is
    if (bytes != null) return {unreadable: true, why: err.message};
    if (err.code !== 'ENOENT') return {unreadable: true};
    raw = null;
  }
  if (raw == null) return null;
  try { return JSON.parse(raw.toString('utf8')); } catch (err) { return {unreadable: true}; }
}

// modules: the operation's modules; allow: the release (or the development
// pins file's) pins, with modules (the descriptions) and pins; bytes:
// {module: Buffer} for those about to be placed -> null, or the refusal
// (without its "nothing was installed")
function descriptionRefusal(where, modules, allow, bytes = {}) {
  const described = allow != null && allow.modules != null ? allow.modules : {};
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const at = (m) => `${m} ${allow.pins[m].version}`;
  const manifests = {};
  const apis = {};
  for (const m of modules) {
    if (!own(described, m)) return `${at(m)}: this release does not describe it`;
    const version = allow.pins[m].version;
    const manifest = fileOf(where, m, version, bytes[m], 'package.json');
    if (manifest != null && manifest.why != null) return `${at(m)}: ${manifest.why}`;
    if (manifest == null || manifest.unreadable) return `${at(m)}: its package.json cannot be read`;
    manifests[m] = manifest;
    const api = fileOf(where, m, version, bytes[m], 'api.json');
    apis[m] = api != null && !api.unreadable ? api : null;
  }
  const friendly = friendlyNames(apis);
  if (friendly.problem != null) return friendly.problem;
  for (const m of modules) {
    const got = describeModule(manifests[m], friendly.map);
    // a call that maps to no module of the operation differs from a
    // description whose calls all do
    const part = got.problem != null ? (/calls/.test(got.problem) ? 'its calls' : got.problem) : describeProblem(described[m], got);
    if (part != null) return `${at(m)} does not match this release's description of it (${part})`;
  }
  return null;
}

module.exports = {descriptionRefusal};
