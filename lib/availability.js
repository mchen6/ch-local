'use strict';
// What loads, by module (#413 section 5.2; L2a). A module is available when
// all of these hold, the first that fails its reason:
//   1. its active version is in the module store;
//   2. the running release lists it at that version: a module no pack of it
//      lists is withdrawn (section 9.7), one at another version than the
//      release's pin is not loaded either (a development home is exempt);
//   3. (a top-level module) the operator's ceiling allows it;
//   4. (a top-level module) it is not turned off;
//   5. (a top-level module) its credential is usable;
//   6. every module in its closure is available, for whatever reason one
//      is not (to a fixed point: a cycle of available modules stays so).
// Every available top-level module is loaded, once, whichever packs record
// it; a part is loaded exactly while some loaded module's closure holds it.
//
// Rules 3 to 5 sit behind seams (the Reviewer on L2a): today's behaviour,
// by the pack whose scenario the module is (pack.<p>, the ceiling's packs,
// the release's version 1 credentials), which L2b replaces with L3's
// enabled.<module> and ceiling by module and L5's slots:
//   seams.ceiling(module, packs) -> null | the reason
//   seams.off(module, packs) -> null | the reason
//   seams.credential(module, packs, unit) -> null | the reason
// A module's closure is read from the stored manifests' countinghouse.calls,
// matched by friendly name (api.json's device.friendlyName) as the runtime
// matches it.
const fs = require('node:fs');
const path = require('node:path');
const {versionDir, looksPlaced} = require('./store-paths');
const {removeHint, packScenario} = require('./packs');

const short = (name) => name.replace(/^@[^/]+\//, '');

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
// order], unavailable: Map(module -> {kind, reason, line, withdrawn})}. A unit: {name: the module, short, scenario: the module, version,
// modules: {m: version} over its closure, dirs: {m: store dir}, dir,
// packages: its closure's names, packs: the packs whose scenario it is}.
function availability(where, record, {release, seams, pins: byPins = true}) {
  const modules = record.modules || {};
  const names = Object.keys(modules);
  const dirOf = (m) => versionDir(where, m, modules[m].version);
  // each module's placement, looked at once (the high review of L2a, 9)
  const placed = new Map(names.map((m) => [m, looksPlaced(where, m, modules[m].version)]));
  const recordedBy = (m) => Object.entries(record.packs || {}).filter(([, p]) => p.modules != null && p.modules[m] != null).map(([n]) => n);
  // the packs whose scenario the module is (the seams' unit, today); a
  // module that is some pack's scenario is top-level, whatever role it
  // declares (a pack whose modules declare none: its first), and every
  // other module is a part, loaded only within a closure (the medium
  // review of L2a, 1: never past a pack's seams)
  const scenarioOf = new Map();
  for (const pack of Object.keys(record.packs || {})) {
    const m = packScenario(record, pack);
    if (m == null || modules[m] == null) continue;
    if (!scenarioOf.has(m)) scenarioOf.set(m, []);
    scenarioOf.get(m).push(pack);
  }
  const top = (m) => scenarioOf.has(m);
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
  const byFriendly = new Map();
  for (const m of names) {
    const f = placed.get(m) ? friendlyOf(dirOf(m)) : null;
    if (typeof f === 'string' && !byFriendly.has(f)) byFriendly.set(f, m);
  }
  const byShort = new Map();
  for (const m of names) if (!byShort.has(short(m))) byShort.set(short(m), m);
  const target = (c) => byFriendly.get(c) || (byShort.has(c) && !placed.get(byShort.get(c)) ? byShort.get(c) : null);
  // each reason twice: as the module's own ("not loading m: <reason>") and
  // as its caller says it ("it calls m, which <which>": section 11)
  const own = (m) => {
    const v = modules[m].version;
    if (!placed.get(m)) return {kind: 'missing', reason: 'its files are missing; run `ch-local install` again', which: 'is missing from the module store; run `ch-local install` again'};
    if (byPins && record.unreleased !== true) {
      if (!listed.has(m) || withdrawnByRecord.has(m)) {
        return {kind: 'withdrawn', reason: `it was withdrawn in this release and is not started; ${removeHint(recordedBy(m)[0] || '<pack>')}`, which: 'was withdrawn in this release'};
      }
      const pin = pins[m] != null ? pins[m].version : null;
      if (pin !== v) {
        const pinned = pin != null ? pin : 'no version of it';
        return {kind: 'pin', reason: `${v} is installed and this release pins ${pinned}; run \`ch-local install\` again`, which: `is installed at ${v} and this release pins ${pinned}; run \`ch-local install\` again`};
      }
    }
    const packs = scenarioOf.get(m) || [];
    const asWhich = (kind, reason) => (reason == null ? null : {kind, reason, which: `is not available (${reason})`});
    if (!top(m)) return null;
    return asWhich('ceiling', seams.ceiling(m, packs)) || asWhich('off', seams.off(m, packs));
  };
  const credentialOf = new Map();   // module -> {credentials, credential} the seam chose
  // rules 1 to 4 per module, then rule 6 to a fixed point: a module is not
  // available while any module it calls is not, so a cycle of available
  // modules stays available and one that reaches an unavailable module
  // does not (the medium review of L2a, 2: never cached mid-cycle)
  const state = new Map(names.map((m) => { const w = own(m); return [m, w == null ? {ok: true} : {ok: false, ...w}]; }));
  const settle = () => {
    for (let changed = true; changed;) {
      changed = false;
      for (const m of names) {
        if (!state.get(m).ok) continue;
        for (const c of callsOfModule(m)) {
          const t = target(c);
          const why = t == null ? {kind: 'calls', reason: `it calls ${c}, which is not installed`, which: `calls ${c}, which is not installed`}
            : !state.get(t).ok ? {kind: 'calls', reason: `it calls ${c}, which ${state.get(t).which}`, which: `calls ${c}, which ${state.get(t).which}`} : null;
          if (why != null) { state.set(m, {ok: false, ...why}); changed = true; break; }
        }
      }
    }
  };
  settle();
  // rule 5 last, asked only of a top-level module that would otherwise
  // load (the medium review of the high round, 8: never a token asked for
  // what cannot load, never a credential said over the real blocker); one
  // without it is not available to its callers either (the high review, 1)
  for (const m of names) {
    if (!top(m) || !state.get(m).ok) continue;
    const chose = {};
    const reason = seams.credential(m, scenarioOf.get(m) || [], chose);
    credentialOf.set(m, chose);
    if (reason != null) state.set(m, {ok: false, kind: 'credential', reason, which: `is not available (${reason})`});
  }
  settle();
  const closureOf = (m, seen = new Set()) => {
    if (seen.has(m)) return seen;
    seen.add(m);
    for (const c of callsOfModule(m)) { const t = target(c); if (t != null) closureOf(t, seen); }
    return seen;
  };
  const units = [];
  const unavailable = new Map();
  for (const m of names) {
    if (!top(m)) continue;
    const s = state.get(m);
    if (!s.ok) {
      // a withdrawn module is said as section 9.7 says it
      const line = s.kind === 'withdrawn' ? `module ${short(m)} was withdrawn in this release and was not started; ${removeHint(recordedBy(m)[0] || '<pack>')}`
        : `not loading ${short(m)}: ${s.reason}`;
      unavailable.set(m, {kind: s.kind, reason: s.reason, line, withdrawn: s.kind === 'withdrawn'});
      continue;
    }
    const closure = [...closureOf(m)];
    units.push({name: m, short: short(m), scenario: m, version: modules[m].version,
      modules: Object.fromEntries(closure.map((n) => [n, modules[n].version])),
      dirs: Object.fromEntries(closure.map((n) => [n, dirOf(n)])),
      dir: dirOf(m), packages: closure, packs: scenarioOf.get(m), ...credentialOf.get(m)});
  }
  return {units, unavailable};
}

module.exports = {availability, short};
