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
// {module: Buffer} for those about to be placed; versionOf(module): the
// version the operation records it at (#413 section 9.4's table keeps a
// module installed at another version: its pin, by default) -> null, or the
// refusal (without its "nothing was installed").
// Only a module at its pin is held to the release's description: the
// description is of the pinned bytes. One the table keeps at another
// version is read at that version, for the friendly names the others' calls
// are matched by, and is not compared. context: {module: version}, the
// home's other installed modules, read from the store for those names only
// (a pack's calls can name a module the home already holds).
function descriptionRefusal(where, modules, allow, bytes = {}, versionOf = (m) => allow.pins[m].version, context = {}) {
  const described = allow != null && allow.modules != null ? allow.modules : {};
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const atPin = (m) => versionOf(m) === allow.pins[m].version;
  const at = (m) => `${m} ${versionOf(m)}`;
  const manifests = {};
  const apis = {};
  for (const m of modules) {
    if (atPin(m) && !own(described, m)) return `${at(m)}: this release does not describe it`;
    const version = versionOf(m);
    const fromBytes = atPin(m) ? bytes[m] : undefined;
    const manifest = fileOf(where, m, version, fromBytes, 'package.json');
    if (manifest != null && manifest.why != null) return `${at(m)}: ${manifest.why}`;
    if (manifest == null || manifest.unreadable) return `${at(m)}: its package.json cannot be read`;
    manifests[m] = manifest;
    const api = fileOf(where, m, version, fromBytes, 'api.json');
    apis[m] = api != null && !api.unreadable ? api : null;
  }
  const contextApis = {};
  for (const [m, version] of Object.entries(context || {})) {
    if (Object.prototype.hasOwnProperty.call(apis, m) || typeof version !== 'string') continue;
    const api = fileOf(where, m, version, undefined, 'api.json');
    contextApis[m] = api != null && !api.unreadable ? api : null;
  }
  // m's described callee that is neither placed nor installed, and the pack
  // of this release that holds it -> the refusal naming what to install
  // first, or null
  const notInstalledCallee = (m) => {
    if (!atPin(m) || !own(described, m) || !Array.isArray(described[m].calls)) return null;
    for (const callee of described[m].calls) {
      if (own(apis, callee) || own(contextApis, callee) || allow.pins == null || !own(allow.pins, callee)) continue;
      const packs = Object.keys(allow.packs || {}).filter((p) => Array.isArray(allow.packs[p].modules) && allow.packs[p].modules.includes(callee)).sort();
      if (packs.length === 0) continue;
      const p = packs[0];
      return `${m} calls ${callee}, from pack ${p}, which isn't installed; install ${p} first`;
    }
    return null;
  };
  // The operation's own names must be one each. The home's other modules
  // only add names the operation lacks; a name two of them share is no
  // one's, so a call to it matches nothing and is refused (fails closed:
  // the medium on L5b, 3; the runtime takes the first)
  const friendly = friendlyNames(apis);
  if (friendly.problem != null) return friendly.problem;
  const seen = new Map();
  for (const [m, api] of Object.entries(contextApis)) {
    const one = friendlyNames({[m]: api}).map;
    for (const [name] of one) if (!friendly.map.has(name)) seen.set(name, seen.has(name) ? null : m);
  }
  for (const [name, m] of seen) if (m != null) friendly.map.set(name, m);
  for (const m of modules) {
    if (!atPin(m)) continue;
    const got = describeModule(manifests[m], friendly.map);
    // a call that maps to no module of the operation or the home: when the
    // release describes it calling a module of a pack not installed, that is
    // what is wrong (release 1 resolves names only from what it places or
    // holds: the Reviewer's ruling on L5b; never accepted unverified)
    if (got.problem != null && got.unknownCall != null) {
      const missing = notInstalledCallee(m);
      if (missing != null) return missing;
    }
    // otherwise it differs from a description whose calls all do
    const part = got.problem != null ? (got.unknownCall != null ? 'its calls' : got.problem) : describeProblem(described[m], got);
    if (part != null) return `${at(m)} does not match this release's description of it (${part})`;
  }
  return null;
}

module.exports = {descriptionRefusal};
