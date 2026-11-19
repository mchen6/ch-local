'use strict';
// Credentials per module (#413 sections 6.1, 6.4, 6.7 and 10; L5a): what each
// installed module declares, what the store binds to it, whether that is
// usable, and the slots a start gives its runtime.
//
// - A module's credential is (module, variable); its destination is the
//   origin of the module's one declared remote (countinghouse.remotes: one
//   remote per module in release 1). `credential` is a variable's name, or
//   {env, header?, scheme?}; fallbackEnv is never read here (section 6.1).
// - A binding (lib/credential-store.js) is usable when it is for the
//   declared variable and the declared origin, and, for the source gh, gh
//   gave a token at this start (section 6.7).
// - A start gives every installed module with a usable binding a slot,
//   COUNTINGHOUSE_CREDENTIAL_<n>, whether or not it loads now, so one turned
//   on later loads in place with its key (section 6.4). It first removes
//   every inherited COUNTINGHOUSE_CREDENTIAL_* from the runtime's
//   environment (by any case), so a planted value is never read as a key.
//   The environment it is given is an allowlist already (start), so no
//   client credential reaches the runtime. A slot's
//   identity, (module, variable, origin, source, sha256 of the value), is
//   kept in the start's memory only, never written.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./credential-store');
const {versionDir, looksPlaced} = require('./store-paths');

const SLOT_PREFIX = 'COUNTINGHOUSE_CREDENTIAL_';
const SLOT = /^COUNTINGHOUSE_CREDENTIAL_[1-9][0-9]{0,3}$/;
// the one origin a gh login is offered for (section 6.8)
const GH_ORIGIN = store.GH_ORIGIN;
// the names version 1 stored a GitHub token under (section 10)
const V1_GITHUB = ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN'];
const short = (name) => String(name).replace(/^@[^/]+\//, '');
const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);

// A module's declared credential, from its active version's manifest in the
// store: {variable, origin, remote} | null (it declares none) | {problem}.
function declared(where, record, module) {
  const e = record.modules != null ? record.modules[module] : null;
  if (e == null) return null;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(versionDir(where, module, e.version), 'package.json'), 'utf8'));
  } catch (err) {
    return {problem: 'its files are missing; run `ch-local install` again'};
  }
  // (the one reader, describe-module's credentialOf: the Reviewer's high
  // review of #98, 2)
  const c = require('./describe-module').credentialOf(isObject(manifest.countinghouse) ? manifest.countinghouse.remotes : []);
  if (c.problem != null) return {problem: c.problem === 'it declares more than one credential' ? c.problem : 'its remote declaration cannot be read'};
  return c.credential;
}

// Every installed module's declared credential: Map(module -> declared()),
// only those that declare one (or whose declaration has a problem).
function declarations(where, record) {
  const out = new Map();
  for (const m of Object.keys(record.modules || {})) {
    if (!looksPlaced(where, m, record.modules[m].version)) continue;
    const d = declared(where, record, m);
    if (d != null) out.set(m, d);
  }
  return out;
}

// The store's bindings as Map(module -> Map(variable -> entry)). A version 1
// file reads as section 10 says: each entry a binding for its recorded
// module, to https://api.githubcopilot.com (the only origin ch-local ever sent
// it to), under whichever of its two GitHub names the installed module
// declares (else the name it was stored under), source stored.
function migrateV1(read, decls) {
  const out = new Map();
  for (const [variable, e] of read.values) {
    const d = decls.get(e.module);
    const name = d != null && d.variable != null && V1_GITHUB.includes(d.variable) && V1_GITHUB.includes(variable) ? d.variable : variable;
    if (!out.has(e.module)) out.set(e.module, new Map());
    out.get(e.module).set(name, {origin: GH_ORIGIN, source: 'stored', value: e.value});
  }
  return out;
}
// A version 2 store's GitHub key under the other of its two names (the
// Reviewer's high review of #98, 3): a module that now declares one of them
// and holds a binding only under the other, for the origin it declares,
// reads it under the declared name (ch-access-github 0.2.0 moved from
// COUNTINGHOUSE_GITHUB_TOKEN to GITHUB_TOKEN). Every reader sees it so;
// carryOver below writes it once. -> [{module, from, to}], modules changed
// in place.
function carryV2(modules, decls) {
  const carried = [];
  for (const [m, d] of decls) {
    if (d == null || d.problem != null || d.variable == null || !V1_GITHUB.includes(d.variable)) continue;
    const vars = modules.get(m);
    if (vars == null || vars.has(d.variable)) continue;
    const from = V1_GITHUB.find((v) => v !== d.variable && vars.has(v));
    if (from == null || vars.get(from).origin !== d.origin) continue;
    vars.set(d.variable, vars.get(from));
    vars.delete(from);
    carried.push({module: m, from, to: d.variable});
  }
  return carried;
}
// -> {bindings, carried} or {problem}: the store read, its checks applied
function bindings(where, record, {platform} = {}) {
  let read;
  try { read = store.readStore(where.home, {platform}); } catch (err) { return {problem: err.message, transient: err.transient === true}; }
  if (read.version === 2) {
    const modules = new Map([...read.modules].map(([m, v]) => [m, new Map(v)]));
    return {bindings: modules, carried: carryV2(modules, declarations(where, record))};
  }
  return {bindings: migrateV1(read, declarations(where, record)), v1: true, carried: []};
}
// The carry-over written: each module's key bound under its declared name
// (the store keeps one binding a module), so it is done, and said, once.
// -> the lines to say, one a module; none when nothing was carried or the
// store cannot be written (every reader still sees it carried).
function carryOver(where, record, {platform} = {}) {
  const read = bindings(where, record, {platform});
  if (read.bindings == null || read.v1 === true || read.carried.length === 0) return [];
  const lines = [];
  for (const {module, from, to} of read.carried) {
    try {
      store.bind(where.home, module, to, read.bindings.get(module).get(to), {platform});
      lines.push(`the key stored for ${short(module)} under ${from} is now under ${to}, the name it declares; nothing else changed`);
    } catch (err) { /* read as carried until it can be written */ }
  }
  return lines;
}

// What a declaration changed against the key stored for the module (the
// Reviewer's high review of L5a, 5): the origin, the variable's name, or
// both. Any of them needs the key added again (the binding is all three).
// -> {reason, which}, never a value.
function declarationChange(decl, storedVariable, storedOrigin) {
  const origin = storedOrigin !== decl.origin;
  const variable = storedVariable !== decl.variable;
  if (origin && variable) {
    return {reason: `it now sends ${decl.variable} to ${decl.origin}; the stored key is ${storedVariable}, for ${storedOrigin}`,
      which: 'declares another credential and address'};
  }
  if (origin) {
    return {reason: `it sends its credential somewhere new (${decl.origin}; the stored one is for ${storedOrigin})`,
      which: 'sends its credential somewhere new'};
  }
  return {reason: `it now names its credential ${decl.variable} (the stored key is ${storedVariable}, for the same address, ${decl.origin})`,
    which: 'names its credential differently'};
}

// One module's state (section 6.7): {state: 'ok', binding} | 'none' |
// 'elsewhere' {binding} | 'gh-gave-none' {why} | 'store-problem' {problem}
// | 'unreadable' {problem}; each with the sentence a start says.
// gh: {token} or {why}, asked only when a binding's source is gh.
function stateOf(module, decl, read, gh) {
  const m = short(module);
  if (decl.problem != null) return {state: 'unreadable', reason: decl.problem};
  if (read.problem != null) return {state: 'store-problem', reason: `the stored credentials are not used (${read.problem})`};
  const vars = read.bindings.get(module);
  const binding = vars != null ? vars.get(decl.variable) : null;
  const other = vars != null ? [...vars].find(([v, b]) => v !== decl.variable || b.origin !== decl.origin) : null;
  if (binding == null || binding.origin !== decl.origin) {
    if (other != null) {
      const what = declarationChange(decl, other[0], other[1].origin);
      return {state: 'elsewhere', binding: {variable: other[0], ...other[1]},
        reason: `${what.reason}. It gets no key, and is not loaded, until you run \`ch-local credentials add ${m}\` again`,
        which: `${what.which}: run \`ch-local credentials add ${m}\` again`};
    }
    return {state: 'none', reason: `it needs a credential (${decl.variable}, sent to ${decl.origin}): run \`ch-local credentials add ${m}\``,
      which: `needs a credential: run \`ch-local credentials add ${m}\``};
  }
  if (binding.source === 'gh' && decl.origin !== GH_ORIGIN) {
    // (the store refuses such an entry; a hand-written one never gets gh's
    // token: the Fable pass on L5a, F5)
    return {state: 'store-problem', reason: `its stored credential uses your gh login, which is given only to ${GH_ORIGIN}: run \`ch-local credentials add ${m}\` again`,
      which: `has a stored credential that cannot be used: run \`ch-local credentials add ${m}\` again`};
  }
  if (binding.source === 'gh' && (gh == null || gh.token == null)) {
    return {state: 'gh-gave-none', reason: `your gh login gave no token at this start (${gh != null && gh.why != null ? gh.why : 'gh was not asked'}): run \`gh auth login\` and restart your client, or \`ch-local credentials add ${m}\``,
      which: `has no token from your gh login: run \`gh auth login\`, or \`ch-local credentials add ${m}\``};
  }
  return {state: 'ok', binding: {variable: decl.variable, ...binding}};
}

const digest = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
// a binding as it was (never its value): origin, source and, for a stored
// one, the value's digest
const fingerprint = (b) => `${b.origin} ${b.source} ${b.source === 'stored' ? digest(b.value) : ''}`;

// What a start gives its runtime (section 6.4).
// env: the environment the runtime will get (its COUNTINGHOUSE_CREDENTIAL_*
// removed here); ghToken(): -> Promise of {token} | {why}, asked once and
// only when some binding's source is gh; acceptanceMap: under
// CH_LOCAL_REMOTE_MAP only an acceptance token (chacc_...) gets a slot.
// -> {env, file: the version 2 --remoteCredentials object, identities:
//    Map(module -> {variable, origin, source, digest, slot}), states:
//    Map(module -> stateOf()), gh}
async function forStart(where, record, {env, ghToken, platform, acceptanceMap = false}) {
  const decls = declarations(where, record);
  // env is already an allowlist (start: shim-config runtimeEnv/allowedEnv),
  // so no client credential is in it; a slot name, by any case, is removed
  // all the same (a planted key). Declared names are not stripped: one
  // naming PATH would strip the runtime's own (the medium on the high
  // round, 10).
  const runEnv = {};
  for (const [k, v] of Object.entries(env || {})) if (!k.toUpperCase().startsWith(SLOT_PREFIX)) runEnv[k] = v;
  const read = bindings(where, record, {platform});
  const needsGh = read.bindings != null && [...decls].some(([m, d]) => {
    const vars = read.bindings.get(m);
    const b = vars != null && d.variable != null ? vars.get(d.variable) : null;
    return b != null && b.source === 'gh' && b.origin === d.origin && d.origin === GH_ORIGIN;
  });
  const gh = needsGh ? await ghToken() : null;
  const states = new Map();
  const identities = new Map();
  // every binding present at this start, with or without a slot (a gh one
  // gh gave nothing for, one the acceptance map kept out): applyStates says
  // "restart" only of one added since (the Fable pass on L5a, F3)
  const seen = new Map();
  const file = {version: 2, modules: {}};
  let n = 0;
  for (const [m, d] of [...decls].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let s = stateOf(m, d, read, gh);
    const present = read.bindings != null && read.bindings.get(m) != null ? read.bindings.get(m).get(d.variable) : null;
    if (present != null) seen.set(m, fingerprint(present));
    if (s.state === 'ok') {
      const value = s.binding.source === 'gh' ? gh.token : s.binding.value;
      if (acceptanceMap && !/^chacc_/.test(value)) {
        s = {state: 'none', reason: `under an acceptance run's origin map only an acceptance token is given: run \`ch-local credentials add ${short(m)}\` with one`};
      } else {
        n += 1;
        const slot = `${SLOT_PREFIX}${n}`;
        runEnv[slot] = value;
        identities.set(m, {variable: d.variable, origin: d.origin, source: s.binding.source, digest: digest(value), slot});
        file.modules[m] = {[d.origin]: {[d.variable]: slot}};
      }
    }
    states.set(m, s);
  }
  return {env: runEnv, file, identities, states, seen, gh, decls};
}

// Whether a module's slot still matches the store as it is now (section 6.4:
// all five parts; for gh, the four the store holds): -> {ok: true} |
// {ok: false, why: 'none' | 'changed'}. Read again at each load or reload.
// read, decl: the store and the declaration already read (applyStates
// reads each once for every module)
function slotMatches(where, record, module, identity, {platform, read = null, decl} = {}) {
  if (identity == null) return {ok: false, why: 'none'};
  const d = decl !== undefined ? decl : declared(where, record, module);
  if (d == null || d.problem != null || d.variable !== identity.variable || d.origin !== identity.origin) return {ok: false, why: 'changed'};
  if (read == null) read = bindings(where, record, {platform});
  if (read.problem != null) return {ok: false, why: 'changed'};
  const vars = read.bindings.get(module);
  const b = vars != null ? vars.get(identity.variable) : null;
  if (b == null) return {ok: false, why: 'removed'};
  if (b.origin !== identity.origin || b.source !== identity.source) return {ok: false, why: 'changed'};
  if (b.source === 'stored' && digest(b.value) !== identity.digest) return {ok: false, why: 'changed'};
  return {ok: true};
}

// Each declared module's state while a start runs (section 6.4): no new
// slot is given, so a module is usable only through the slot it was started
// with, matching the store now. -> Map(module -> state) as stateOf's, with:
// 'removed' / 'changed' (its slot no longer matches: unloaded until it
// matches again or the client restarts) and 'new' (usable in the store, but
// this runtime has no slot for it: "restart your client to load it").
// A store that could not be read decides nothing (the Reviewer's high
// review of L5a, 3): the Map comes back empty with `unreadable` set (the
// reason), and the caller keeps its last good states and reads again.
// startStates, seen: forStart's states and its bindings present at start;
// a binding without a slot that is the one present at start keeps start's
// own reason (how to provide its value), never "restart your client"
function applyStates(where, record, identities, {platform, startStates = null, seen = null} = {}) {
  const out = new Map();
  const decls = declarations(where, record);
  // the declarations read for this pass, for the caller (one parse of each
  // package.json per pass: the Reviewer's round 3, 10)
  out.decls = decls;
  const read = bindings(where, record, {platform});
  // (only a read that failed, not a file found wrong: that is a read, and
  // decides, store-problem for every module that declares one)
  if (read.problem != null && read.transient === true) { out.unreadable = read.problem; return out; }
  for (const [m, d] of decls) {
    const id = identities.get(m);
    if (id != null) {
      const match = slotMatches(where, record, m, id, {platform, read, decl: d});
      const gone = match.why === 'removed';
      out.set(m, match.ok ? {state: 'ok', binding: {variable: id.variable, origin: id.origin, source: id.source}}
        // the text as it behaves (8): the same key added again matches its
        // slot, and the module loads in place again; a new key needs a
        // restart, whose start gives it a slot
        : gone ? {state: 'removed',
          reason: 'its credential was removed; it is unloaded here until you add the same key again, or restart this client',
          which: 'has had its credential removed: add it again, or restart your client'}
          : {state: 'changed',
            reason: 'its credential changed; it is unloaded here until this client restarts and takes the new one (or the earlier key is added back)',
            which: 'has had its credential changed: restart your client'});
      continue;
    }
    const s = stateOf(m, d, read, {why: 'a running start asks gh only when it starts'});
    // a binding no restart would make usable (a gh entry for another origin,
    // a declaration that cannot be read, none or elsewhere) says its own
    // reason, never "restart" (the Reviewer's round 3, 2); a gh one gh was
    // not asked for here is usable after a restart, below
    if (s.state !== 'ok' && s.state !== 'gh-gave-none') { out.set(m, s); continue; }
    // usable in the store (gh's included), but this runtime was started
    // without it
    const vars = read.bindings != null ? read.bindings.get(m) : null;
    const b = vars != null && d.variable != null ? vars.get(d.variable) : null;
    if (b != null && b.origin === d.origin && seen != null && seen.get(m) === fingerprint(b) && startStates != null && startStates.get(m) != null && startStates.get(m).state !== 'ok') {
      out.set(m, startStates.get(m));
      continue;
    }
    if (b != null && b.origin === d.origin) {
      out.set(m, {state: 'new', reason: `it has a credential the running runtime was not started with; restart your client to load it`,
        which: `has a credential the running runtime was not started with: restart your client`});
      continue;
    }
    out.set(m, s);
  }
  return out;
}

// availability()'s credential seam from a start's (or an apply's) states:
// null for a module that declares none or whose binding is usable, else
// {reason, which} (lib/availability.js rule 5)
function credentialSeam(states) {
  return (m, packs, unit) => {
    const s = states.get(m);
    if (s == null) return null;
    if (s.state === 'ok') { unit.credential = s.binding.variable; return null; }
    return {reason: s.reason, which: s.which != null ? s.which : `is not available (${s.reason})`};
  };
}

module.exports = {declarationChange, applyStates, credentialSeam, declared, declarations, bindings, carryOver, migrateV1, stateOf, forStart, slotMatches, digest, GH_ORIGIN, SLOT, SLOT_PREFIX, V1_GITHUB};
