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
//   6. every module in its closure is available.
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
const {removeHint} = require('./packs');

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
// order], unavailable: Map(module -> {reason, line}), of: (module) -> its
// state}. A unit: {name: the module, short, scenario: the module, version,
// modules: {m: version} over its closure, dirs: {m: store dir}, dir,
// packages: its closure's names, packs: the packs whose scenario it is}.
function availability(where, record, {release, seams, pins: byPins = true}) {
  const modules = record.modules || {};
  const names = Object.keys(modules);
  const dirOf = (m) => versionDir(where, m, modules[m].version);
  const recordedBy = (m) => Object.entries(record.packs || {}).filter(([, p]) => p.modules != null && p.modules[m] != null).map(([n]) => n);
  // the packs whose scenario the module is (the seams' unit, today)
  const scenarioOf = (m) => recordedBy(m).filter((p) => names.find((n) => record.packs[p].modules[n] != null && modules[n].role === 'scenario') === m);
  const listed = new Set();
  for (const p of Object.values((release && release.packs) || {})) for (const m of (p.modules || p.packages || [])) listed.add(m);
  // withdrawn when this release does not list it, or the record's own list
  // names it (an upgrade's pins wrote it: section 9.7)
  const withdrawnByRecord = new Set(Array.isArray(record.withdrawn) ? record.withdrawn : []);
  const pins = (release && release.pins) || {};
  // friendly name -> module (an installed one, placed)
  const byFriendly = new Map();
  for (const m of names) {
    const f = looksPlaced(where, m, modules[m].version) ? friendlyOf(dirOf(m)) : null;
    if (typeof f === 'string' && !byFriendly.has(f)) byFriendly.set(f, m);
  }
  // an installed module whose files are missing has no friendly name to
  // read: it is found by its short name, so a caller says why
  const byShort = new Map();
  for (const m of names) if (!byShort.has(short(m))) byShort.set(short(m), m);
  const state = new Map();   // module -> {ok, reason, which} | 'visiting'
  // each reason twice: as the module's own ("not loading m: <reason>") and
  // as its caller says it ("it calls m, which <which>": section 11)
  const own = (m) => {
    const v = modules[m].version;
    if (!looksPlaced(where, m, v)) return {kind: 'missing', reason: 'its files are missing; run `ch-local install` again', which: 'is missing from the module store; run `ch-local install` again'};
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
    return null;
  };
  const asWhich = (kind, reason) => (reason == null ? null : {kind, reason, which: `is not available (${reason})`});
  const top = (m) => modules[m].role !== 'part';
  const check = (m) => {
    if (state.has(m)) { const s = state.get(m); return s === 'visiting' ? {ok: true} : s; }
    state.set(m, 'visiting');
    let why = own(m);
    const packs = scenarioOf(m);
    if (why == null && top(m)) why = asWhich('ceiling', seams.ceiling(m, packs));
    if (why == null && top(m)) why = asWhich('off', seams.off(m, packs));
    if (why == null) {
      for (const c of callsOf(manifestOf(dirOf(m)))) {
        const target = byFriendly.get(c) || (byShort.has(c) && !looksPlaced(where, byShort.get(c), modules[byShort.get(c)].version) ? byShort.get(c) : null);
        if (target == null) { why = {kind: 'calls', reason: `it calls ${c}, which is not installed`, which: `calls ${c}, which is not installed`}; break; }
        const s = check(target);
        if (!s.ok) { why = {kind: 'calls', reason: `it calls ${c}, which ${s.which}`, which: `calls ${c}, which ${s.which}`}; break; }
      }
    }
    const result = why == null ? {ok: true} : {ok: false, ...why};
    state.set(m, result);
    return result;
  };
  const closureOf = (m, seen = new Set()) => {
    if (seen.has(m)) return seen;
    seen.add(m);
    for (const c of callsOf(manifestOf(dirOf(m)))) { const t = byFriendly.get(c); if (t != null) closureOf(t, seen); }
    return seen;
  };
  const units = [];
  const unavailable = new Map();
  for (const m of names) {
    if (!top(m)) continue;
    const s = check(m);
    if (!s.ok) {
      // a withdrawn module is said as section 9.7 says it
      const line = s.kind === 'withdrawn' ? `module ${short(m)} was withdrawn in this release and was not started; ${removeHint(recordedBy(m)[0] || '<pack>')}`
        : `not loading ${short(m)}: ${s.reason}`;
      unavailable.set(m, {kind: s.kind, reason: s.reason, line, withdrawn: s.kind === 'withdrawn'});
      continue;
    }
    const closure = [...closureOf(m)];
    const unit = {name: m, short: short(m), scenario: m, version: modules[m].version,
      modules: Object.fromEntries(closure.map((n) => [n, modules[n].version])),
      dirs: Object.fromEntries(closure.map((n) => [n, dirOf(n)])),
      dir: dirOf(m), packages: closure, packs: scenarioOf(m)};
    // rule 5 last: a credential is asked only of what would otherwise load
    const cred = seams.credential(m, unit.packs, unit);
    if (cred != null) { unavailable.set(m, {kind: 'credential', reason: cred, line: `not loading ${short(m)}: ${cred}`}); continue; }
    units.push(unit);
  }
  return {units, unavailable, of: (m) => (state.get(m) === 'visiting' ? null : state.get(m) || null)};
}

module.exports = {availability, short, callsOf};
