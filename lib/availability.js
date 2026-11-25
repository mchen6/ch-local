'use strict';
// What loads, by module (#413 section 5.2; L2a). A module is available when
// all of these hold, the first that fails its reason:
//   1. its active version is in the module store;
//   2. the running release lists it at that version: a module no pack of it
//      lists is withdrawn (section 9.7), one at another version than the
//      release's pin is not loaded either (a development home is exempt);
//   3. the operator's ceiling allows it (every module, a part included:
//      section 8);
//   4. (a top-level module) it is not turned off;
//   5. (every module that declares one) its credential is usable;
//   6. every module in its closure is available, for whatever reason one
//      is not (to a fixed point: a cycle of available modules stays so).
// Every available top-level module is loaded, once, whichever packs record
// it; a part is loaded exactly while some loaded module's closure holds it.
//
// Rules 3 to 5 sit behind seams (the Reviewer on L2a), each by module
// (L2b: lib/module-seams.js; L5a: lib/module-credentials.js):
//   seams.ceiling(module) -> null | the reason
//   seams.off(module) -> null | the reason
//   seams.credential(module, packs, unit) -> null | the reason | {reason, which}
//     (asked of every module, a part included: lib/module-credentials.js)
// A module's closure is read from the stored manifests' countinghouse.calls,
// matched by friendly name (api.json's device.friendlyName) as the runtime
// matches it.
//
// The user's own modules (B-own-add; the own-modules design §2.2), given as
// own: {record: own.json's, sandboxOk}, are top-level, after the packs,
// each from its copy under <home>/own, its version the copy's tree hash.
// Before the seams, in this order: its copy is intact (else changed), the
// sandbox is enforced (else sandbox), and no pack module -- nor an own
// module before it -- has its device name (else collision, via that one).
// One whose package name is a pack module's is never one of the modules
// here: it is in `shadowed` (collision), apart from that module's entries.
// An own module's calls resolve to any module here; a pack module's only
// to a pack module, so a pack never calls user code that took a name it
// calls.
const fs = require('node:fs');
const path = require('node:path');
const {versionDir, looksPlaced} = require('./store-paths');
const {removeHint, packScenario, holds} = require('./packs');
const {chLocal, folderArg} = require('./command-line');
const {copyDir, copyState} = require('./own-tree');

const short = (name) => name.replace(/^@[^/]+\//, '');
// (status says it too, of a running start's own sandbox)
const SANDBOX_LINE = 'own modules run only with the sandbox enforced';

function manifestOf(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (err) { return null; }
}
function friendlyOf(dir) {
  try {
    const api = JSON.parse(fs.readFileSync(path.join(dir, 'api.json'), 'utf8'));
    return api != null && api.device != null && typeof api.device.friendlyName === 'string' ? api.device.friendlyName : null;
  } catch (err) { return null; }
}
// the modules a manifest calls: the names before the slash, each once
const callsOf = (m) => {
  const calls = m != null && m.countinghouse != null && Array.isArray(m.countinghouse.calls) ? m.countinghouse.calls : [];
  return [...new Set(calls.filter((c) => typeof c === 'string' && c.includes('/')).map((c) => c.slice(0, c.indexOf('/'))))];
};

// where: layout(); record: modules.json's; release: the running release's
// pins (packs.<p>.packages or .modules, pins); seams: above; pins: false
// for a record of another release, which a start judges by none of its own
// pins (section 9.8): rule 2 is skipped. Each reason has a kind: missing,
// withdrawn, pin, ceiling, off, credential, calls.
// -> {units: [unit of each available top-level module, in the record's
// order, then the own modules'], unavailable: Map(module -> {kind, reason,
// line, withdrawn, via}), shadowed: Map(own module -> {kind: 'collision',
// via, reason, line}),
// states: Map(module -> {ok} | {ok: false, kind, reason}) for every
// installed module, a part included, and tops: the top-level modules
// (status, section 9.9)}. A unit: {name: the module, short, scenario: the module, version,
// modules: {m: version} over its closure, dirs: {m: store dir}, dir,
// packages: its closure's names, packs: the packs whose scenario it is;
// own: true for an own module's}.
function availability(where, record, {release, seams, pins: byPins = true, own: ownOpt = null}) {
  const modules = record.modules || {};
  const packNames = Object.keys(modules);
  // the own modules, a pack module's name apart (shadowed)
  const ownOf = new Map();
  const shadowed = new Map();
  const ownRecorded = ownOpt != null && ownOpt.record != null ? ownOpt.record.modules : {};
  for (const [m, e] of Object.entries(ownRecorded)) {
    if (holds(modules, m)) shadowed.set(m, {kind: 'collision', via: m, reason: `pack module ${m} uses its name`, line: `not loading your own module ${short(m)}: pack module ${m} uses its name`});
    else ownOf.set(m, e);
  }
  const isOwn = (m) => ownOf.has(m);
  const sandboxOk = ownOpt != null && ownOpt.sandboxOk === true;
  const names = packNames.concat([...ownOf.keys()]);
  const versionOf = (m) => (isOwn(m) ? ownOf.get(m).tree : modules[m].version);
  const dirOf = (m) => (isOwn(m) ? copyDir(where, m, ownOf.get(m).tree) : versionDir(where, m, modules[m].version));
  // each module's placement, looked at once (the high review of L2a, 9); an
  // own module's: its copy whole and hashing to the tree the user said yes to
  // (and why one is not: changed, or gone -- E10)
  const copies = new Map([...ownOf.keys()].map((m) => [m, copyState(where, m, ownOf.get(m).tree)]));
  const placed = new Map(names.map((m) => [m, isOwn(m) ? copies.get(m) === 'intact' : looksPlaced(where, m, modules[m].version)]));
  // (own properties only, as the top-level rule reads them: #449's review)
  const recordedBy = (m) => Object.entries(record.packs || {}).filter(([, p]) => p != null && holds(p.modules, m)).map(([n]) => n);
  // the packs whose scenario the module is (the seams' unit, today); a
  // module that is some pack's scenario is top-level, whatever role it
  // declares (a pack whose modules declare none: its first), and every
  // other module is a part, loaded only within a closure (the medium
  // review of L2a, 1: never past a pack's seams)
  const scenarioOf = new Map();
  for (const pack of Object.keys(record.packs || {})) {
    const m = packScenario(record, pack);
    if (m == null || !holds(modules, m)) continue;
    if (!scenarioOf.has(m)) scenarioOf.set(m, []);
    scenarioOf.get(m).push(pack);
  }
  const top = (m) => scenarioOf.has(m) || isOwn(m);
  const listed = new Set();
  for (const p of Object.values((release && release.packs) || {})) {
    const list = p == null ? null : Array.isArray(p.modules) ? p.modules : Array.isArray(p.packages) ? p.packages : null;
    for (const m of (list || [])) listed.add(m);
  }
  // withdrawn when this release does not list it, or the record's own list
  // names it (an upgrade's pins wrote it: section 9.7)
  const withdrawnByRecord = new Set(Array.isArray(record.withdrawn) ? record.withdrawn : []);
  const pins = (release && release.pins) || {};
  // each placed module's calls, read once (the closure and the check share them)
  const calls = new Map();
  const callsOfModule = (m) => {
    if (!calls.has(m)) calls.set(m, placed.get(m) ? callsOf(manifestOf(dirOf(m))) : []);
    return calls.get(m);
  };
  // friendly name -> module (an installed one, placed); an installed module
  // whose files are missing has no friendly name to read: it is found by
  // its short name, so a caller says why
  // (the packs' first, then the own modules': a pack module keeps its name)
  const byFriendly = new Map();
  const friendly = new Map();
  for (const m of names) {
    const f = placed.get(m) ? friendlyOf(dirOf(m)) : null;
    friendly.set(m, f);
    if (typeof f === 'string' && !byFriendly.has(f)) byFriendly.set(f, m);
  }
  const byShort = new Map();
  for (const m of packNames) if (!byShort.has(short(m))) byShort.set(short(m), m);
  // the module a call of `from`'s names: a pack module's calls find only
  // pack modules
  const target = (c, from) => {
    const t = byFriendly.get(c);
    if (t != null && (isOwn(from) || !isOwn(t))) return t;
    return byShort.has(c) && !placed.get(byShort.get(c)) ? byShort.get(c) : null;
  };
  // each reason twice: as the module's own ("not loading m: <reason>") and
  // as its caller says it ("it calls m, which <which>": section 11)
  const asWhich = (kind, reason) => (reason == null ? null : {kind, reason, which: `is not available (${reason})`});
  // an own module's rules: its copy, the sandbox, its device name; then
  // the ceiling and off, as any top-level module's
  const ownRule = (m) => {
    // (gone: as the overview says it, countinghouse #534 -- the folder it
    // was added from, never the copy's path)
    if (copies.get(m) === 'gone') return asWhich('gone', `its copy is gone: run \`${chLocal(where, `add-module ${folderArg(ownOf.get(m).from)}`)}\` again`);
    if (!placed.get(m)) return asWhich('changed', `its files changed since you added it: run \`${chLocal(where, `add-module ${folderArg(ownOf.get(m).from)}`)}\` again`);
    if (!sandboxOk) return asWhich('sandbox', SANDBOX_LINE);
    const holder = byFriendly.get(friendly.get(m));
    if (holder != null && holder !== m) return {...asWhich('collision', `${isOwn(holder) ? 'your own module' : 'pack module'} ${holder} uses its name`), via: holder};
    return asWhich('ceiling', seams.ceiling(m)) || asWhich('off', seams.off(m));
  };
  const own = (m) => {
    if (isOwn(m)) return ownRule(m);
    const v = modules[m].version;
    if (!placed.get(m)) return {kind: 'missing', reason: `its files are missing; run \`${chLocal(where, 'install')}\` again`, which: `is missing from the module store; run \`${chLocal(where, 'install')}\` again`};
    if (byPins && record.unreleased !== true) {
      if (!listed.has(m) || withdrawnByRecord.has(m)) {
        return {kind: 'withdrawn', reason: `it was withdrawn in this release and is not started; ${removeHint(recordedBy(m)[0] || '<pack>', where)}`, which: 'was withdrawn in this release'};
      }
      const pin = pins[m] != null ? pins[m].version : null;
      if (pin !== v) {
        const pinned = pin != null ? pin : 'no version of it';
        return {kind: 'pin', reason: `${v} is installed and this release pins ${pinned}; run \`${chLocal(where, 'install')}\` again`, which: `is installed at ${v} and this release pins ${pinned}; run \`${chLocal(where, 'install')}\` again`};
      }
    }
    // the ceiling for every module, a part included; off for a top-level one
    return asWhich('ceiling', seams.ceiling(m)) || (top(m) ? asWhich('off', seams.off(m)) : null);
  };
  const credentialOf = new Map();   // module -> {credential} the seam chose
  // rules 1 to 4 per module, then rule 6 to a fixed point: a module is not
  // available while any module it calls is not, so a cycle of available
  // modules stays available and one that reaches an unavailable module
  // does not (the medium review of L2a, 2: never cached mid-cycle)
  const state = new Map(names.map((m) => { const w = own(m); return [m, w == null ? {ok: true} : {ok: false, ...w}]; }));
  // a blocked callee's own via when it is blocked through a call, else itself
  const viaOf = (t) => (state.get(t).kind === 'calls' ? state.get(t).via : t);
  const settle = () => {
    for (let changed = true; changed;) {
      changed = false;
      for (const m of names) {
        if (!state.get(m).ok) continue;
        for (const c of callsOfModule(m)) {
          const t = target(c, m);
          // root: the kind at the bottom of the chain (a frozen record still
          // unloads a caller whose callee went for a reason no pins decide)
          // via: the module at the bottom of the chain, which the person acts
          // on; for a callee not installed, the name called (A-firstrun d1)
          const why = t == null ? {kind: 'calls', root: 'not installed', via: c, reason: `it calls ${c}, which is not installed`, which: `calls ${c}, which is not installed`}
            : !state.get(t).ok ? {kind: 'calls', root: state.get(t).root || state.get(t).kind, via: viaOf(t), reason: `it calls ${c}, which ${state.get(t).which}`, which: `calls ${c}, which ${state.get(t).which}`} : null;
          if (why != null) { state.set(m, {ok: false, ...why}); changed = true; break; }
        }
      }
    }
  };
  settle();
  // rule 5 last: asked of every module that would otherwise load, after
  // every rule before it has settled, callees before their
  // callers, so a caller whose callee lacks its credential reports that and
  // is never asked its own (the high reviews of L2a, 1, and of its medium
  // round, 8: the reason said is the real blocker)
  const order = [];
  const seen = new Set();
  const visit = (m) => {
    if (seen.has(m)) return;
    seen.add(m);
    for (const c of callsOfModule(m)) { const t = target(c, m); if (t != null) visit(t); }
    order.push(m);
  };
  for (const m of names) visit(m);
  // (callees first, so one step to the callees is enough here; a cycle is
  // settled once after: the medium review of the high round, 8)
  for (const m of order) {
    if (!state.get(m).ok) continue;
    const failed = callsOfModule(m).map((c) => [c, target(c, m)]).find(([, t]) => t != null && !state.get(t).ok);
    if (failed != null) {
      const [c, t] = failed;
      state.set(m, {ok: false, kind: 'calls', root: state.get(t).root || state.get(t).kind, via: viaOf(t), reason: `it calls ${c}, which ${state.get(t).which}`, which: `calls ${c}, which ${state.get(t).which}`});
      continue;
    }
    // every module that declares a credential is asked, a part included: a
    // credential is its declaring module's (#413 section 6.1; L5a), and a
    // caller of one without it says so (rule 6). The seam answers null, a
    // reason, or {reason, which} (what a caller says of it)
    const chose = {};
    const got = seams.credential(m, scenarioOf.get(m) || [], chose);
    credentialOf.set(m, chose);
    if (got != null) {
      const reason = typeof got === 'string' ? got : got.reason;
      const which = typeof got === 'string' || got.which == null ? `is not available (${reason})` : got.which;
      state.set(m, {ok: false, kind: 'credential', reason, which});
    }
  }
  settle();
  const closureOf = (m, seen = new Set()) => {
    if (seen.has(m)) return seen;
    seen.add(m);
    for (const c of callsOfModule(m)) { const t = target(c, m); if (t != null) closureOf(t, seen); }
    return seen;
  };
  // A caller's because (#449's moduleMessages id 10): the one module it
  // calls directly that is turned off for itself, when that is all that
  // keeps it from loading: every module it calls that is not available is
  // that one, so the runtime's "it calls <because>, which is turned off
  // (turning <because> on brings it back)" is true. Otherwise null: through
  // a part, beside another blocker, or a callee not installed, the notice
  // says it as given (the medium on A-reason, 1 and 2).
  const becauseOffOf = (m) => {
    const failing = new Set();
    for (const c of callsOfModule(m)) {
      const t = target(c, m);
      if (t == null) return null;
      if (!state.get(t).ok) failing.add(t);
    }
    if (failing.size !== 1) return null;
    const [t] = failing;
    if (!top(t) || state.get(t).kind !== 'off') return null;
    // neither it nor the module turned off is asked its credential once a
    // callee has failed: asked now, so "turning it on brings it back" is
    // never said of one a missing key would still keep out (the medium on
    // #98's high round, 1)
    for (const x of [m, t]) if (seams.credential(x, scenarioOf.get(x) || [], {}) != null) return null;
    return t;
  };
  const units = [];
  const unavailable = new Map();
  for (const m of names) {
    if (!top(m)) continue;
    const s = state.get(m);
    if (!s.ok) {
      // a withdrawn module is said as section 9.7 says it
      const line = s.kind === 'withdrawn' ? `module ${short(m)} was withdrawn in this release and was not started; ${removeHint(recordedBy(m)[0] || '<pack>', where)}`
        : `not loading ${short(m)}: ${s.reason}`;
      unavailable.set(m, {kind: s.kind, root: s.root || s.kind, via: s.kind === 'calls' || s.kind === 'collision' ? s.via : null, becauseOff: s.kind === 'calls' ? becauseOffOf(m) : null, reason: s.reason, line, withdrawn: s.kind === 'withdrawn'});
      continue;
    }
    const closure = [...closureOf(m)];
    units.push({name: m, short: short(m), scenario: m, version: versionOf(m),
      modules: Object.fromEntries(closure.map((n) => [n, versionOf(n)])),
      dirs: Object.fromEntries(closure.map((n) => [n, dirOf(n)])),
      dir: dirOf(m), packages: closure, packs: isOwn(m) ? [] : scenarioOf.get(m), ...credentialOf.get(m), ...(isOwn(m) ? {own: true} : {})});
  }
  const states = new Map(names.map((m) => { const s = state.get(m); return [m, s.ok ? {ok: true} : {ok: false, kind: s.kind, reason: s.reason}]; }));
  return {units, unavailable, shadowed, states, tops: new Set([...scenarioOf.keys(), ...ownOf.keys()])};
}

// (manifestOf, friendlyOf and callsOf: section 9.4's table finds callers as
// a start matches them, lib/pack-table.js)
module.exports = {availability, short, manifestOf, friendlyOf, callsOf, SANDBOX_LINE};
