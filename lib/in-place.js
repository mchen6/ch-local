'use strict';
// A running start applies a home's pack changes to its runtime (packs in
// place, part 2, plan Task B3): a pack added is loaded, one removed unloaded,
// one at another tree (an upgrade, a rollback, a changed part) reloaded; one
// at a time, in order, each with its notice, which the runtime shows once
// (countinghouse's notices). Every applied or failed change is appended to
// <home>/history.jsonl. What is loaded is kept in the run directory's
// run.json, which collection reads (lib/gc.js).
// From the module store (#413 L1a-2): each request is the runtime's module
// form, naming the pack's scenario by its package name and each module's
// store directory: load {name, dirs}, reload {names: [scenario], dirs},
// unload {name}. (The pack form is gone: countinghouse M6.)
// By module (#413 sections 5.2 and 9.8; L2a): what loads is each available
// top-level module (lib/availability.js), once, whichever packs record it;
// `loaded` is keyed by its package name. On/off, the ceiling and the
// credentials are by module (lib/module-seams.js, lib/module-credentials.js:
// L2b). A record of another release (an upgrade
// or a release rollback while this start runs) is judged by none of this
// start's pins: it keeps what it loaded, unloads what the record withdrew
// or moved back, and loads and reloads nothing.
const fs = require('node:fs');
const path = require('node:path');
const {readModulesRecord: readRecord} = require('./module-record');
const {removeHint, releaseOf, recordRelease, staleLine, installLine, entryOf, holds} = require('./packs');
const {availability, short} = require('./availability');
const {readOwnRecord} = require('./own-record');
const {compareVersions} = require('./semver-order');
const {moduleSeams} = require('./module-seams');
const moduleCredentials = require('./module-credentials');
const heldBack = require('./held-back');
const {writeAtomic} = require('./atomic');
const {readSettings, valueOf, runtimeValue, withSettingsLock, loosens, shown} = require('./settings');
const {ceilingFor, ceilingRefusal, startUnderCeiling, forbiddenBy} = require('./ceiling');
const {reportOutsideEdits} = require('./outside-edits');

// The settings a running runtime takes at once (countinghouse_settings'
// "now" ones); the rest apply at the next start.
const LIVE = ['locale', 'maxOutputBytes', 'requestTimeout'];

const {appendHistory} = require('./history');
const {enforceAvailable} = require('./sandbox-support');
const {teller} = require('./control');
// whether two packs' module versions are the same: no reload between them
const sameModules = (a, b) => {
  const x = Object.entries(a || {}).sort(([m], [n]) => (m < n ? -1 : 1));
  const y = Object.entries(b || {}).sort(([m], [n]) => (m < n ? -1 : 1));
  return JSON.stringify(x) === JSON.stringify(y);
};
// Under a home upgraded or rolled back under this process (#413 section
// 9.8), the unloads no pins decide: a
// module removed from the record (or a callee of it no longer installed:
// the medium review of the high round, 1), no longer a pack's top-level
// module, turned off, refused by the ceiling, or without its credential;
// a caller goes with a callee unloaded for one of these.
// (an own module's reasons too: no pins decide them -- B-own-add)
const NO_PINS = ['removed', 'not installed', 'not top-level', 'off', 'ceiling', 'credential', 'changed', 'sandbox', 'collision'];
// a unit's version as a notice says it: an own module's by its code's hash
const shownVersion = (p) => (p.own === true ? `(own, ${String(p.version).slice(0, 12)})` : p.version);
// the loaded-map entry of a unit
const entryFor = (p) => ({version: p.version, scenario: p.name, modules: p.modules, ...(p.own === true ? {own: true} : {})});

// state: {where, io, runDir, control, loaded: Map name ->
// {key, version, scenario}, say, host}. -> {apply() -> Promise}
// The runtime knows a pack by its scenario's package name (countinghouse
// #205), so every load, reload and unload names that; a removed pack's is
// kept in `loaded`, since packs.json no longer has it. The history and the
// notices name the pack.
function inPlace(state) {
  const {where, io, runDir, control, loaded, say: sayAlways, host, passed = []} = state;
  // set by close(): nothing more is applied, said, told or recorded (an
  // apply or a module-stopped already under way included: the medium on
  // #106's round 1, 2)
  let closed = false;
  const say = (text) => { if (!closed) sayAlways(text); };
  // the withdrawn modules this start has told the sessions about (start's
  // notices and the unloads here): never told twice
  const withdrawnTold = state.withdrawnTold instanceof Set ? state.withdrawnTold : new Set();
  // never silent (part 3, section 5): start's teller (lib/control.js), which
  // said what start found; on its own, said and told here
  const tellAlways = state.tell || (() => { const t = teller(say); t.attach(control); return t.tell; })();
  const tell = (text) => { if (!closed) tellAlways(text); };
  const loosenedText = (name, was, now, later) => `${name} loosened from ${shown(name, was)} to ${shown(name, now)}${later ? `, at the next start${typeof(later) === 'string' ? ` (${later})` : ''}` : ''}`;
  // the settings the runtime was started with (start's own reading), so a
  // change made before the watcher began is still applied
  let applied = state.settings != null ? state.settings : readSettings(where);
  // the runtime this start spawned: a pack change against another runtime
  // version waits for the next start (the review of ch-local #13)
  const runtimeAtSpawn = JSON.stringify(state.runtimeVersions || null);
  let runtimeSaid = false;
  let settingsSaid = null;
  let ceilingSaid = null;
  // what was told already, start's included: told once
  const notesSaid = state.told || new Set();
  const history = (entry) => { if (!closed) appendHistory(where, {by: 'start', ...entry}, {host, pid: io.pid}); };
  // the modules the runtime stopped for good in this start (module-stopped,
  // #413 section 7.3): module -> {code, version}, run.json's stopped, which
  // status shows. Never loaded again in this start unless the module's
  // active version changes; a fresh start begins with none, so each is tried
  // again then (the Reviewer on L2a: a transient crash never keeps it out).
  const stopped = new Map();
  // the record the last apply read, a stop's baseline when it cannot be read
  let lastRecord = state.record != null ? state.record : null;
  // the closure the runtime was last asked to run, by top-level module
  // (start's plan, then each load and reload as it is sent): a stop is
  // recorded at that, so a module that crashes on a reload is never let
  // back in at the version it crashed on (the high review of L2a, 4)
  const asked = new Map([...loaded].map(([n, v]) => [n, v.modules || null]));
  // a request that never reached the runtime (refused busy, or not sent):
  // it was never asked to run the new closure, so what was asked before
  // stands. No answer, or a runtime gone, may follow a request it took and
  // runs: the new closure stands then, as after any other refusal (the
  // high review of L2a's medium round, 1)
  const NEVER_REACHED = ['CONTROL_BUSY', 'CONTROL_SEND_FAILED'];
  const askOr = (name, reply, before) => {
    if (reply.ok === true || !NEVER_REACHED.includes(reply.code)) return;
    if (before === undefined) asked.delete(name); else asked.set(name, before);
  };

  // run.json's loaded: every module version this runtime holds
  // ({module: version}), which collection keeps (lib/gc.js collectStore)
  const writeRun = () => {
    // a module two loaded packs hold at different versions keeps both (the
    // medium review of L1a-2, 5): run.json's value is then a list
    const versions = {};
    for (const v of loaded.values()) {
      for (const [m, ver] of Object.entries(v.modules || {})) {
        const had = versions[m];
        if (had == null) versions[m] = ver;
        else if (![].concat(had).includes(ver)) versions[m] = [].concat(had, ver);
      }
    }
    try {
      const file = path.join(runDir, 'run.json');
      const run = JSON.parse(fs.readFileSync(file, 'utf8'));
      const why = Object.fromEntries([...stopped].map(([m, s]) => [m, s.code]));
      writeAtomic(file, JSON.stringify({...run, loaded: versions, stopped: why}) + '\n');
    } catch (err) { /* the run directory is gone: start is ending */ }
  };
  // the slots this runtime was started with, by module (lib/module-
  // credentials.js forStart: {variable, origin, source, digest, slot}); a
  // load or reload carries, for each module of its closure that has one, its
  // allowance naming that slot (#413 section 7.3, M4's credentials field), and
  // only a slot that still matches the store (applyStates decided the
  // module available)
  const identities = state.identities instanceof Map ? state.identities : new Map();
  const allowanceOf = (modules) => {
    const out = {};
    for (const m of modules) {
      const id = identities.get(m);
      if (id != null) out[m] = {[id.origin]: {[id.variable]: id.slot}};
    }
    return out;
  };
  // where a key goes is said once per module: start said it for what it
  // loaded; one loaded later is said here, when its key first goes with a
  // load or reload (the medium on the high round, 5)
  const sendsSaid = state.sendsSaid instanceof Set ? state.sendsSaid : new Set();
  const withAllowance = (msg, modules) => {
    const a = allowanceOf(modules);
    return Object.keys(a).length > 0 ? {...msg, credentials: a} : msg;
  };
  // said, and marked said, only once the runtime took the load or reload
  // (the Reviewer's round 3, 5: as an unload's notice)
  const sayWhereKeysGo = (msg) => {
    for (const m of Object.keys(msg.credentials || {})) {
      if (sendsSaid.has(m)) continue;
      sendsSaid.add(m);
      const id = identities.get(m);
      say(`sends ${id.variable} to ${id.origin} for ${short(m)}${id.source === 'gh' ? ' (your gh login\'s token, held in memory)' : ''}`);
    }
  };
  // one reload for several packs: every scenario named, every module's
  // directory given, one notice for all; each pack's history line as a
  // send's would be. The runtime switches them all or none. -> whether it did.
  const sendReload = async (list) => {
    const dirs = Object.assign({}, ...list.map(({p}) => p.dirs));
    const notice = list.map((r) => r.notice).join('; ');
    const before = new Map(list.map(({p}) => [p.name, asked.get(p.name)]));
    for (const {p} of list) asked.set(p.name, p.modules);
    const reloadMsg = withAllowance({type: 'reload', names: list.map(({p}) => p.name), dirs, notice}, Object.keys(dirs));
    const reply = await control.request(reloadMsg);
    for (const {p} of list) askOr(p.name, reply, before.get(p.name));
    if (reply.ok === true) {
      sayWhereKeysGo(reloadMsg);
      for (const {p, how, notice: own} of list) {
        // wanted again: a later refused unload of it is told again (3), and
        // an earlier "restart now" is resolved (the medium on round 3, 5)
        if (stuck.delete(p.name)) tell(`module ${short(p.name)} is served again as it should be; the earlier "restart your client now" no longer applies`);
        loaded.set(p.name, entryFor(p));
        history({module: p.name, change: how, notice: own});
      }
      writeRun();
      say(notice);
      return true;
    }
    for (const {p, how, notice: own} of list) history({module: p.name, change: how, notice: own, problem: `${reply.code || 'failed'}: ${reply.message || ''}`.slice(0, 300)});
    say(`${notice}: not applied in place (${reply.code || 'failed'}); restart your client to apply it`);
    return false;
  };
  const send = async (change, p, msg, notice) => {
    const before = asked.get(p.name);
    if (msg.type === 'load') asked.set(p.name, p.modules);
    const reply = await control.request({...msg, notice});
    if (msg.type === 'load') askOr(p.name, reply, before);
    if (msg.type === 'load') {
      loadsSent.add(p.name);
      // (only a request that reached the runtime: refused, or not answered,
      // where it may be serving; never CONTROL_BUSY or SEND_FAILED, which
      // left it unloaded: the reviewer's round 2 on #106, 3)
      if (reply.ok === true || NEVER_REACHED.includes(reply.code)) loadFailed.delete(p.name); else loadFailed.add(p.name);
    }
    if (reply.ok === true) {
      if (msg.type === 'unload') loaded.delete(p.name); else loaded.set(p.name, entryFor(p));
      // a load: where its keys go is said now, and it is wanted again, so a
      // later refused unload of it is told again (the Reviewer's round 3, 3, 5)
      if (msg.type === 'load') {
        sayWhereKeysGo(msg);
        if (stuck.delete(p.name)) tell(`module ${short(p.name)} is served again as it should be; the earlier "restart your client now" no longer applies`);
      }
      writeRun();
      history({module: p.name, change, notice});
      // a request's notice rides on it, and the runtime tells the sessions
      // (an unload's, those that listed it before it goes: B3 Task 6): said
      // here only, never told again (the high review of L2a, 7)
      say(notice);
      return;
    }
    history({module: p.name, change, notice, problem: `${reply.code || 'failed'}: ${reply.message || ''}`.slice(0, 300)});
    say(`${notice}: not applied in place (${reply.code || 'failed'}); restart your client to apply it`);
  };
  // Part 3 while start runs: an edit made outside the tools is said and
  // recorded (under the settings lock, as at start), and what is applied is
  // bound by the operator's ceiling as start's values are: a cap or timeout
  // clamped, a pack turned on that it forbids left off; under a ceiling that
  // cannot be trusted, a change that loosens keeps the settings in effect.
  let recheck = null;
  // (each pack's clash notice as last said: said once per change)
  const clashSaid = new Map();
  // packs whose load the runtime refused or did not answer: whether a
  // restart loads one is not known, and an unanswered one may be serving, so
  // the held-back list does not name it (the medium on #106's round 1, 5)
  const loadFailed = new Set();
  // (the loads sent in this apply: a pack whose load failed and that was not
  // sent this time -- a clash, a frozen home, no longer available -- has its
  // own reason now, and the list names it again: round 2, 3)
  const loadsSent = new Set();
  // the credentials' states as last read (start's at first): a store that
  // could not be read (EBUSY, a racing add) decides nothing; the last good
  // states stand and it is read again shortly, so only a read that
  // succeeds and differs unloads (the Reviewer's high review of L5a, 3)
  // A last good state stands only for a module whose declaration is the
  // same as when it was read: one installed or changed since is not usable
  // until a read decides it (the medium on the high round, 2). A read that
  // keeps failing is tried again after 1 s, then 2, 4 ... up to 60 s (3).
  let lastCredentialStates = state.credentialStates instanceof Map ? state.credentialStates : null;
  const declKey = (d) => (d == null ? '' : `${d.problem || ''} ${d.variable} ${d.origin}`);
  let lastDecls = lastCredentialStates != null && state.credentialDecls instanceof Map
    ? new Map([...state.credentialDecls].map(([m, d]) => [m, declKey(d)])) : null;
  let credentialProblemSaid = null;
  let retryMs = 1000;
  let credentialRetry = null;
  const credentialStates = (record) => {
    const now = moduleCredentials.applyStates(where, record, identities, {platform: io.platform, startStates: state.credentialStates, seen: state.credentialSeen});
    const decls = now.decls != null ? now.decls : moduleCredentials.declarations(where, record);
    if (now.unreadable == null) {
      // a good read: a pending retry, armed with an old delay, goes (6)
      if (credentialRetry != null) { clearTimeout(credentialRetry); credentialRetry = null; }
      lastCredentialStates = now;
      lastDecls = new Map([...decls].map(([m, d]) => [m, declKey(d)]));
      credentialProblemSaid = null;
      retryMs = 1000;
      return now;
    }
    if (credentialProblemSaid !== now.unreadable) {
      credentialProblemSaid = now.unreadable;
      say(`the stored credentials could not be read (${now.unreadable}); what is loaded stays as it is, and they are read again shortly`);
    }
    // its own timer: the settings' 250 ms busy retry (recheck) never waits
    // behind it (the Reviewer's round 3, 4)
    if (credentialRetry == null) {
      credentialRetry = setTimeout(() => { credentialRetry = null; state.reapply(); }, retryMs);
      if (typeof credentialRetry.unref === 'function') credentialRetry.unref();
      retryMs = Math.min(retryMs * 2, 60000);
    }
    const out = new Map();
    for (const [m, d] of decls) {
      const kept = lastCredentialStates != null && lastDecls != null && lastDecls.get(m) === declKey(d) ? lastCredentialStates.get(m) : null;
      out.set(m, kept != null ? kept : {state: 'store-problem', reason: `the stored credentials are not used (${now.unreadable})`});
    }
    return out;
  };
  const bound = (given, record = null) => {
    const platform = io.platform || process.platform;
    const ceiling = ceilingFor(where, {platform, env: io.env});
    const settings = {...given, values: {...given.values}};
    let busy = false;
    // never waits on start's event loop: a writer holding the lock is
    // looked at again shortly (its change fires the watcher too)
    try {
      const edits = withSettingsLock(where, () => reportOutsideEdits(where, readSettings(where), {say: tell, host, pid: io.pid, refusal: forbiddenBy(ceiling)}), {waitMs: 0});
      for (const e of edits) if (e.refused != null) settings.values[e.setting] = valueOf(applied, e.setting);
    } catch (err) {
      if (err.code === 'SETTINGS_BUSY' && recheck == null) {
        recheck = setTimeout(() => { recheck = null; state.reapply(); }, 250);
        if (typeof recheck.unref === 'function') recheck.unref();
      }
      // a lock held never turns the checks off: what loosens keeps what is in
      // effect until the history can be compared (the review of #18)
      busy = true;
    }
    if (busy || ceiling.state === 'untrusted') {
      // each loosening against what is in effect keeps what is in effect;
      // tightenings apply
      const kept = [];
      for (const name of new Set([...Object.keys(applied.values), ...Object.keys(settings.values)])) {
        if (!loosens(name, valueOf(applied, name), valueOf(settings, name))) continue;
        if (Object.prototype.hasOwnProperty.call(applied.values, name)) settings.values[name] = applied.values[name]; else delete settings.values[name];
        kept.push(name);
      }
      // the outcome first: a notice is cut at 200 characters
      const why = kept.length === 0 ? null : busy
        ? `${kept.join(', ')} not loosened yet, the values in effect kept: the settings are being changed by another writer`
        : `${kept.join(', ')} not loosened, the values in effect kept: the operator's ceiling file ${ceiling.file} cannot be trusted (${ceiling.problem})`;
      if (why != null && ceilingSaid !== why) tell(why);
      ceilingSaid = why;
      return settings;
    }
    ceilingSaid = null;
    const bounded = startUnderCeiling(settings, ceiling, {where, forcedAudit: !enforceAvailable(where, platform)});
    const values = bounded.values;
    // (a pack or a module turned on in the file: section 8, by module)
    // (apply's own record, read once: the high review of #90, 10)
    const ceilingRecord = record;
    for (const name of Object.keys(values).filter((k) => /^(pack|enabled)\./.test(k))) {
      if (valueOf(applied, name) !== false || values[name] !== true) continue;
      const refusal = ceilingRefusal(ceiling, name, true, ceilingRecord);
      if (refusal == null) continue;
      values[name] = false;
      bounded.notes.push(`${name.replace(/^(pack|enabled)\./, '')} not loaded: ${refusal.message.replace(/; nothing was changed$/, '')}`);
    }
    for (const note of bounded.notes) if (!notesSaid.has(note)) { tell(note); notesSaid.add(note); }
    return {...settings, values};
  };
  const apply = async () => {
    let record;
    try { record = readRecord(where); } catch (err) { say(`the home cannot be read (${err.message}); nothing applied`); return; }
    lastRecord = record;
    let settings = readSettings(where);
    if (settings.error != null) {
      // fail closed: the last good settings stand
      if (settingsSaid !== settings.error) { say(`${settings.error}; the settings in effect are kept`); settingsSaid = settings.error; }
      settings = applied;
    } else {
      settingsSaid = null;
      settings = bound(settings, record);
    }
    const runtimeChanged = state.runtimeVersions != null && JSON.stringify(record.runtime.versions) !== runtimeAtSpawn;
    // whose home this is (#413 section 9.8): one rule with start
    // (lib/packs.js recordRelease). A process the home was upgraded or
    // rolled back under is frozen: judged by none of its pins, nothing
    // loaded or reloaded, only what no pins decide applied. A record of
    // another release under the home's own ch-local is judged by these
    // pins, and "run ch-local install" said. A changed runtime loads and
    // reloads nothing either. Each said once, start's lines included.
    const ours = releaseOf(io);
    const whose = recordRelease(record, io, where);
    // the home upgraded or rolled back under this process
    const frozenByHome = whose.state === 'stale';
    const frozen = frozenByHome || runtimeChanged;
    const once = (notice, change) => {
      if (notesSaid.has(notice)) return;
      notesSaid.add(notice);
      history({change, notice});
      tell(notice);
    };
    if (frozenByHome) once(staleLine(whose.installed, whose.how), 'release changed');
    else if (whose.state === 'other') once(installLine(whose.ours, where), 'record of another release');
    if (runtimeChanged && !frozenByHome && !runtimeSaid) {
      runtimeSaid = true;
      const notice = 'a runtime update applies at the next start: restart your client to use it and the packs installed with it';
      history({change: 'runtime update', notice});
      say(notice);
    }
    // the operator's allowlist of packs (cached: ceilingFor): an unlisted pack
    // never loads, and one loaded before the list named it is unloaded
    const ceilingNow = ceilingFor(where, {platform: io.platform || process.platform, env: io.env});
    // what is wanted, by module (section 5.2); a credential not set leaves a
    // module out, as start's does
    // the user's own modules (B-own-add): an own.json that can't be read
    // wants none of them (those loaded are unloaded), said once; the sandbox
    // as this start runs it
    let ownRecord = null;
    try {
      ownRecord = readOwnRecord(where);
    } catch (err) {
      once(`your own modules are not loaded: ${err.message}`, 'own modules unreadable');
    }
    const av = availability(where, record, {release: ours, pins: !frozenByHome,
      seams: Object.assign(moduleSeams({settings, ceiling: ceilingNow, record, where}),
        {credential: moduleCredentials.credentialSeam(credentialStates(record))}),
      own: {record: ownRecord, sandboxOk: state.ownSandboxOk === true}});
    for (const u of av.shadowed.values()) once(u.line, 'not loaded');
    // a module the runtime stopped for good is not loaded again in this
    // start unless what it would run has changed (section 7.3): a member of
    // its closure at another version than the runtime was asked to run, or
    // (never asked) its version another than the record named at the stop.
    // Only a record read successfully decides: no failed read, and no
    // rewrite that leaves the module as it was, lets it back in (the high
    // review of L2a's medium round, 7). run.json written once.
    let unstopped = false;
    for (const [m, st] of [...stopped]) {
      const unit = av.units.find((u) => u.name === m);
      // (no baseline at all: no record ever read, nothing asked: kept out for
      // the rest of this start; a fresh start tries it again: the medium
      // review of the high round, 3)
      const changed = unit != null && (st.modules != null ? !sameModules(unit.modules, st.modules)
        : st.known ? st.version == null || unit.version !== st.version : false);
      if (changed) { stopped.delete(m); unstopped = true; }
    }
    if (unstopped) writeRun();
    const load = av.units.filter((u) => !stopped.has(u.name));
    // a module not available is told once, with its reason (start's lines
    // included: never repeated); one turned off is the user's own doing, and
    // under another release's record nothing new is judged
    if (!frozenByHome) {
      for (const [m, u] of av.unavailable) {
        if (u.kind === 'off' || loaded.has(m) || notesSaid.has(u.line) || (u.kind === 'withdrawn' && withdrawnTold.has(m))) continue;
        notesSaid.add(u.line);
        if (u.kind === 'withdrawn') withdrawnTold.add(m);
        history({module: m, change: 'not loaded', notice: u.line, problem: u.reason});
        tell(u.line);
      }
    }
    const target = new Map(load.map((u) => [u.name, u]));
    // the unloads: each loaded top-level module no longer wanted, its reason
    // the notice (section 9.8); under another release's record only those no
    // pins decide (turned off, removed, the ceiling, the credential), and
    // what the record withdrew or moved back, with the modules that call it
    // (under a home upgraded or rolled back under this process)
    const inPacks = (m) => entryOf(record, m) != null;
    const inRecord = (m) => inPacks(m) || (ownRecord != null && holds(ownRecord.modules, m));
    const packOf = (m) => Object.keys(record.packs || {}).find((n) => record.packs[n] != null && holds(record.packs[n].modules, m)) || null;
    const withdrawnNow = new Set(frozenByHome && Array.isArray(record.withdrawn) ? record.withdrawn : []);
    for (const name of [...loaded.keys()]) {
      if (target.has(name) && !frozenByHome) continue;
      const mods = Object.keys(loaded.get(name).modules || {});
      if (frozenByHome) {
        // what the release just installed (or the rollback just made)
        // withdrew, or moved back (the medium review of the refinement, 9)
        const cause = whose.how === 'rolled back' ? 'the rollback just made' : 'the release just installed';
        const w = mods.find((m) => withdrawnNow.has(m));
        const low = w == null ? mods.find((m) => inPacks(m) && compareVersions(loaded.get(name).modules[m], record.modules[m].version) === 1) : null;
        const by = name === (w || low) ? '' : `; ${short(name)} calls it and is stopped with it`;
        if (w != null) {
          // as any withdrawn unload: retried, "restart now" if refused twice,
          // and told once (the high review of L2a, 2)
          withdrawnTold.add(w);
          await unloadWithdrawn(name, null, `module ${short(w)} was withdrawn in ${cause} and is no longer served${by}`, {about: w, release: cause});
          continue;
        }
        if (low != null) { await send('moved back', {name}, {type: 'unload', name}, `${short(low)} was moved back to ${record.modules[low].version} by ${cause}; it is stopped here until this client restarts${by}`); continue; }
        if (target.has(name)) continue;
      }
      const u = av.unavailable.get(name);
      // the unload's notice tells why; its line is never told again once it
      // is no longer loaded (the medium review of the high round, 2)
      if (u != null) notesSaid.add(u.line);
      // installed still, but no pack's top-level module any more: never
      // said to be removed (the high review of L2a, 6)
      const kind = !inRecord(name) ? 'removed' : u == null ? 'not top-level' : u.kind;
      // (no longer a pack's top-level module is a pack removed: no pins
      // decide it either; the medium review of the high round, 4; nor does a
      // callee lost to one of these: the high review of its medium round, 6)
      if (frozenByHome && !NO_PINS.includes(kind) && !(kind === 'calls' && u != null && NO_PINS.includes(u.root))) continue;
      if (kind === 'not top-level') { await send('not top-level', {name}, {type: 'unload', name}, `${short(name)} unloaded: it is no longer a pack's top-level module`); continue; }
      if (kind === 'withdrawn') { withdrawnTold.add(name); await unloadWithdrawn(name, packOf(name)); continue; }
      if (kind === 'removed') { await send('removed', {name}, {type: 'unload', name}, `${short(name)} removed`); continue; }
      // reason: what the runtime needs to tell every session its own text
      // (#449's moduleMessages: id 9 "off", id 10 "calls" with because);
      // only the reasons the vectors pin are sent. The ceiling sends none:
      // the module may still be turned on, so the runtime tells this notice,
      // which says why it can't simply be turned back on (the Reviewer on
      // A-reason)
      if (kind === 'off') { await send('turned off', {name}, {type: 'unload', name, reason: 'off'}, `${short(name)} turned off`); continue; }
      if (kind === 'ceiling') { await send('turned off', {name}, {type: 'unload', name}, `${short(name)} turned off: the operator's settings don't allow it`); continue; }
      // a credential's, its own or a callee's (its state's own reason:
      // the /code-review medium on L5a, 5): retried and told, never left
      // serving silently (the Fable pass, F4)
      if (kind === 'credential' || (kind === 'calls' && u != null && u.root === 'credential')) {
        const notice = `${short(name)} unloaded: ${u.reason}`;
        await unloadOrTell(name, notice, 'credential', `${short(name)} could not be stopped in place after a credential was removed or changed: restart your client now to stop it`, {sayIt: true});
        continue;
      }
      // a caller kept from loading only by a module it calls that is turned
      // off: the runtime tells its line with the way back (availability's
      // becauseOff: a direct callee, the only blocker)
      const why = kind === 'calls' && u != null && u.becauseOff != null ? {reason: 'calls', because: u.becauseOff} : {};
      await send('not available', {name}, {type: 'unload', name, ...why}, `${short(name)} unloaded: ${u.reason}`);
    }
    // a setting the runtime takes at once is sent; any other waits for the
    // next start, and is said so
    for (const name of LIVE) {
      const was = valueOf(applied, name);
      const now = valueOf(settings, name);
      if (was === now) continue;
      // the client passed this option itself: its own value stands, as at start
      if (passed.some((o) => o === `--${name}` || o.startsWith(`--${name}=`))) {
        say(`${name} set to ${shown(name, now)}: your client passes --${name} itself, so its value stands`);
        continue;
      }
      // in the runtime's unit (requestTimeout: seconds), as start passes it
      const reply = await control.request({type: 'set', name, value: runtimeValue(name, now)});
      // a loosening is told to the client as well (part 3, section 5); the
      // history holds what was said
      const loosening = loosens(name, was, now);
      const notice = loosening ? loosenedText(name, was, now, reply.ok === true ? false : (reply.code || 'not applied now'))
        : reply.ok === true ? `${name} set to ${shown(name, now)}` : `${name} set to ${shown(name, now)}: applies at the next start (${reply.code || 'not applied now'})`;
      history({setting: name, change: 'set', notice, ...(reply.ok === true ? {} : {problem: reply.code || 'failed'})});
      if (loosening) tell(notice); else say(notice);
    }
    // a module's settings changed (module.*, kept names: #413 section 4.3):
    // the runtime reads them again and applies each it accepts (its own
    // refusal is its notice and history line); one it could not take is
    // said, and applies at the next load
    const moduleText = (s) => JSON.stringify(Object.entries((s && s.kept) || {}).filter(([n]) => n.startsWith('module.')).sort(([a], [b]) => (a < b ? -1 : 1)));
    if (moduleText(applied) !== moduleText(settings)) {
      const reply = await control.request({type: 'reread', what: 'module-settings'});
      if (reply.ok !== true) {
        const notice = `a module's settings changed: not applied in place (${reply.code || 'failed'}); they apply at the module's next load`;
        history({setting: 'module.*', change: 'reread', notice, problem: reply.code || 'failed'});
        say(notice);
      }
    }
    for (const name of ['moduleSandbox', 'autoUpgrade']) {
      const was = valueOf(applied, name);
      const now = valueOf(settings, name);
      if (was === now) continue;
      if (loosens(name, was, now)) tell(loosenedText(name, was, now, true));
      else say(`${name} set to ${shown(name, now)}: applies at the next start`);
    }
    applied = settings;
    // The reloads in ONE request naming every loaded pack whose modules
    // changed: a part two loaded packs share moves only with both named
    // (countinghouse's PART_VERSION_CONFLICT; the vectors' "a reload of two
    // names that share a part": #83's high review, 1). It goes before any
    // new pack loads, so one that shares a part at its new version meets it
    // there (the medium review of #83's fixes, 4). Packs that share a moved
    // module go together or not at all: one that cannot be reloaded in
    // place keeps the others of its group back too, each said (5).
    const reloads = [];
    const loads = [];
    // an own module whose code changed (its tree; its package version may
    // not), or a module that changed between own and a pack's: unloaded,
    // then loaded -- the runtime's reload switches a module only when its
    // version changes (B-own-add)
    const swaps = [];
    for (const p of load) {
      const was = loaded.get(p.name);
      if (was != null && sameModules(was.modules, p.modules) && (was.own === true) === (p.own === true)) continue;
      if (frozen) continue;   // the next start loads it, with its release and runtime
      if (was == null) { loads.push(p); continue; }
      if ((was.own === true || p.own === true) && ((was.own === true) !== (p.own === true) || was.modules[p.name] !== p.modules[p.name])) { swaps.push(p); continue; }
      if (p.own === true) { reloads.push({p, was, how: 'updated', notice: `${p.short} updated ${shownVersion(p)}`}); continue; }
      const order = compareVersions(p.version, was.version);
      const how = order === 1 ? 'upgraded' : order === -1 ? 'rolled back' : 'updated';
      reloads.push({p, was, how, notice: `${p.short} ${how} ${was.version} → ${p.version}`});
    }
    for (const p of swaps) {
      await send('replaced', {name: p.name}, {type: 'unload', name: p.name}, `${p.short} unloaded: its code changed; loading the new code`);
      if (!loaded.has(p.name)) loads.push(p);
    }
    // groups: packs joined by a module that moves in both, a module a pack
    // drops included (it moves from its old version to none: the medium
    // review of the Reviewer's round on #83, 1); each pack's moved set once
    for (const r of reloads) r.moved = new Set([...Object.keys(r.was.modules), ...Object.keys(r.p.modules)].filter((m) => r.was.modules[m] !== r.p.modules[m]));
    const group = new Map(reloads.map((r) => [r.p.name, r.p.name]));
    const root = (n) => (group.get(n) === n ? n : root(group.get(n)));
    for (let i = 0; i < reloads.length; i++) {
      for (let j = i + 1; j < reloads.length; j++) {
        if ([...reloads[j].moved].some((m) => reloads[i].moved.has(m))) group.set(root(reloads[j].p.name), root(reloads[i].p.name));
      }
    }
    const groups = new Map();
    for (const r of reloads) {
      const g = root(r.p.name);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(r);
    }
    // each group its own reload: all or none within a group, never across
    // groups, so packs that share nothing never fail together (the
    // Reviewer's check of #83's fixes, 6)
    for (const list of groups.values()) await sendReload(list);
    // a new pack that takes a module at another version than one still
    // loaded waits: beside it, it would conflict. Checked against every
    // loaded pack's versions after the reloads, which covers a held-back
    // group, a refused reload and a refused unload alike (the Reviewer's
    // round on #83, 6); at the same version it loads
    // (module -> [{pack, version}] every loaded pack's, once, kept up to date
    // as each new pack loads: the medium review of the Reviewer's round, 10;
    // a module whose holders hold another version, whichever one, clashes:
    // the runtime holds one version of a module, 3)
    const holders = new Map();
    const hold = (n, modules) => { for (const [m, ver] of Object.entries(modules || {})) { if (!holders.has(m)) holders.set(m, []); holders.get(m).push({pack: n, version: ver}); } };
    for (const [n, v] of loaded) hold(n, v.modules);
    const otherVersion = (m, ver) => (holders.get(m) || []).find((h) => h.version !== ver) || null;
    // the module form: the scenario by its package name, each module by its
    // store directory; no device config is written (--deviceConfigPath
    // names the start's own empty directory: #413 rev 3, P3)
    // (a pack no longer among the loads -- turned off, removed, loaded, or
    // waiting under another release -- has its clash notice forgotten, so
    // a later clash is said again: the medium on #106's round 1, 3)
    for (const n of [...clashSaid.keys()]) if (!loads.some((p) => p.name === n)) clashSaid.delete(n);
    loadsSent.clear();
    for (const p of loads) {
      const clashes = Object.keys(p.modules).map((m) => [m, otherVersion(m, p.modules[m])]).filter(([, h]) => h != null);
      if (clashes.length > 0) {
        const [clash, by] = clashes[0];
        const problem = `it takes ${clash} ${p.modules[clash]}, which ${short(by.pack)} keeps at ${by.version} for now; restart your client`;
        const notice = `${p.short} not loaded in place: ${problem}`;
        // (said once per change, not on every apply: the reviewer's high on
        // #106, 2)
        if (clashSaid.get(p.name) !== notice) {
          clashSaid.set(p.name, notice);
          history({module: p.name, change: 'added', notice, problem});
          say(notice);
        }
        continue;
      }
      clashSaid.delete(p.name);
      await send('added', p, withAllowance({type: 'load', name: p.name, dirs: p.dirs}, p.packages), `${p.short} added ${shownVersion(p)}`);
      if (loaded.has(p.name)) hold(p.name, p.modules);
    }
    // what is held back, as it ended up after the unloads and the loads,
    // under another release's record or runtime too (the reviewer's high on
    // #106, 4 and 9): what is wanted and not loaded, and why. (One frozen
    // in place still serves: not held back.)
    // - availability keeps it out: its reason;
    // - the runtime stopped it: stopped, until its version changes;
    // - available, but not loaded here (a clash, a refused load, another
    //   release's record or runtime): restart, which loads it.
    for (const n of [...loadFailed]) if (!loadsSent.has(n)) loadFailed.delete(n);
    const heldNow = new Map();
    for (const [name, u] of av.unavailable) if (!loaded.has(name)) heldNow.set(name, u);
    for (const u of av.units) {
      if (loaded.has(u.name) || heldNow.has(u.name)) continue;
      if (stopped.has(u.name)) heldNow.set(u.name, {kind: 'stopped'});
      else if (!loadFailed.has(u.name)) heldNow.set(u.name, {kind: 'restart'});
    }
    await heldBackNow(heldNow);
  };
  // The held-back file (lib/held-back.js; A-firstrun d1): rewritten when the
  // set changes, then re-read by the runtime. A write or a reread that fails
  // is said once and tried again (sendHeld); the runtime's list is empty
  // after a read it could not make (#490's reread).
  // (off when start passed the runtime no file: nothing would read it; the
  // medium on d1, 3)
  const heldOn = state.heldBack != null;
  // (the text the runtime took; null once a reread reached it and failed:
  // its list is empty then, #490's reread, so any text is sent again: the
  // medium on round 2, 1)
  let heldSent = heldOn ? state.heldBack : null;
  let heldWritten = heldSent;   // the text in the file now
  let heldPending = null;   // the text to send, not yet taken
  let heldGivenUp = null;   // a text not sent again until what is held back changes
  let heldGen = 0;          // one per pending text: a retry for an older one does nothing
  let heldAttempts = 0;
  let heldRetry = null;
  // (the first retry's delay: 1 s; a test's io may shorten it)
  const HELD_FIRST_MS = Number.isInteger(io.heldRetryMs) && io.heldRetryMs > 0 ? io.heldRetryMs : 1000;
  let heldDelay = HELD_FIRST_MS;
  const HELD_TRIES = 5;
  const NOT_REACHED = ['CONTROL_UNKNOWN', ...NEVER_REACHED];
  const clearHeldRetry = () => { if (heldRetry != null) { clearTimeout(heldRetry); heldRetry = null; } };
  // The pending text written (once) and the runtime asked to read it again. A
  // retry sends only this, never a whole apply (the reviewer's round 2 on
  // #106, 1: an apply re-sends refused loads and re-says them). CONTROL_FAILED
  // is any failed read, a passing one on Windows included (#490's reread), so
  // it is tried again, 1 s doubling; but a runtime without the request, or
  // one that can't use the file (no --heldBackFile, a file it judges not
  // this user's), answers so for good: after HELD_TRIES, or at once on
  // CONTROL_UNKNOWN, it is not sent again until the text changes, said once
  // (round 2, 1 and 2). It runs only on the applier's chain, as heldBackNow
  // does, so the two never interleave; gen is the pending text's own.
  const sendHeld = async (gen) => {
    const text = heldPending;
    if (closed || text == null || gen !== heldGen) return;
    heldAttempts += 1;
    let problem = null;
    let reached = false;
    try {
      if (heldWritten !== text) { heldBack.write(runDir, text); heldWritten = text; }
      const reply = await control.request({type: 'reread', what: 'held-back'});
      if (reply == null || reply.ok !== true) {
        problem = (reply && reply.code) || 'failed';
        reached = !NOT_REACHED.includes(problem);
      }
    } catch (e) { problem = e.code || e.message; }
    if (closed) return;
    if (problem == null) { heldSent = text; heldPending = null; clearHeldRetry(); return; }
    if (reached) heldSent = null;
    const final = problem === 'CONTROL_UNKNOWN' || heldAttempts >= HELD_TRIES;
    if (final) {
      heldGivenUp = text;
      heldPending = null;
      clearHeldRetry();
      // (one line for one event: a failure final at its first try says only
      // this; the medium on round 2, 10)
      say(`the runtime did not take the held-back list after ${heldAttempts} ${heldAttempts === 1 ? 'try' : 'tries'} (${problem}); it is sent again when what is held back changes`);
      return;
    }
    if (heldAttempts === 1) say(`the overview may not say which modules are held back for now (${problem}); it is tried again`);
    clearHeldRetry();
    heldRetry = setTimeout(() => { heldRetry = null; chain = chain.then(() => sendHeldSafe(gen), () => sendHeldSafe(gen)); }, heldDelay);
    if (typeof heldRetry.unref === 'function') heldRetry.unref();
    heldDelay *= 2;
  };
  const sendHeldSafe = (gen) => sendHeld(gen).catch(() => {});
  // what is held back now -> sent if the runtime doesn't have it: a new text
  // replaces any retry for an older one, armed or already queued, and starts
  // its own tries from 1 s (round 2, 4; its medium, 2)
  const heldBackNow = async (held) => {
    if (!heldOn || closed) return;
    const text = heldBack.contentOf(where, held, io.platform || process.platform);
    if (text === heldPending || text === heldGivenUp) return;
    if (heldPending == null && text === heldSent) return;
    clearHeldRetry();
    heldGen += 1;
    heldPending = text;
    heldGivenUp = null;
    heldAttempts = 0;
    heldDelay = HELD_FIRST_MS;
    await sendHeld(heldGen);
  };
  // Ended with start (its finally): no timer left to run apply again, and
  // nothing applied after (the reviewer's high on #106, 1: a daemon calls
  // start again on every runtime restart, and an old applier kept running)
  const close = () => {
    closed = true;
    for (const t of [recheck, credentialRetry, heldRetry]) if (t != null) clearTimeout(t);
    recheck = null; credentialRetry = null; heldRetry = null;
  };
  const safe = () => (closed ? Promise.resolve() : apply()).catch((err) => say(`a change could not be applied in place (${err.message}); restart your client to apply it`));
  let chain = Promise.resolve();
  const run = () => { chain = chain.then(safe, safe); return chain; };
  state.reapply = run;
  // a withdrawn pack's unload: the notice rides on it, as any unload's does.
  // A refusal (a runtime busy or mid-reload) is tried again 250 ms later; one
  // refused twice is said once per start, "restart your client now", never
  // "restart to apply"; every later apply tries again, quietly.
  // about: the withdrawn module (the unloaded one, or a module it calls);
  // release: the words for the release that withdrew it
  // An unload that must happen (a withdrawn module, a credential removed
  // or changed): retried once, and if the runtime still refuses or never
  // answers, the sessions are told to restart now, once; never left serving
  // silently (the Fable pass on L5a, F4).
  const unloadOrTell = async (name, notice, change, stuckLine, {sayIt = false} = {}) => {
    const msg = {type: 'unload', name, notice};
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
      const reply = await control.request(msg);
      if (reply.ok === true) {
        loaded.delete(name);
        writeRun();
        history({module: name, change, notice: msg.notice});
        // (said once it happened, never before: the medium on the high round, 1)
        if (sayIt) say(notice);
        if (stuck.delete(name)) tell(`module ${short(name)} is no longer served`);
        return;
      }
      if (attempt === 1 && !stuck.has(name)) {
        stuck.add(name);
        history({module: name, change, notice: msg.notice, problem: `${reply.code || 'failed'}: ${reply.message || ''}`.slice(0, 300)});
        tell(stuckLine);
      }
    }
  };
  const unloadWithdrawn = async (name, pack, notice = `module ${short(name)} was withdrawn in this release and is no longer served; ${removeHint(pack || '<pack>', where)}`, {about = name, release = 'this release'} = {}) => {
    const what = about === name ? `module ${short(name)} was withdrawn in ${release}` : `module ${short(about)} was withdrawn in ${release}, and ${short(name)}, which calls it,`;
    await unloadOrTell(name, notice, 'withdrawn', `${what} could not be stopped in place: restart your client now to stop it`);
  };
  // (M5b removed the runtime's load-pack and unload-pack asks, and M6 the
  // pack form: the applier answers none of them; a module is turned on and
  // off at a terminal or as a stored value, #413 section 5.3. L6)
  const stuck = new Set();
  // module-stopped {name, code, when}: the runtime stopped a top-level module
  // for good, after unloading it itself (when: 'restart'), or refused it in
  // start's own plan (when: 'start'). On the applier's chain: out of what is
  // loaded and of run.json's loaded, recorded as stopped, said once to the
  // sessions, and written to the history.
  const moduleStopped = (msg) => {
    const p = chain.then(async () => {
      if (closed) return;
      const name = String(msg && msg.name);
      const code = msg != null && typeof msg.code === 'string' && msg.code !== '' ? msg.code : 'MODULE_STOPPED';
      if (stopped.has(name)) return;
      // kept out at what the runtime was asked to run (start's plan, each
      // load and reload as sent); never asked, at the version the record
      // names now, or the last record read when this one cannot be
      const modules = asked.has(name) ? asked.get(name) : loaded.has(name) ? loaded.get(name).modules || null : null;
      let version = null;
      let known = modules != null;
      if (modules == null) {
        let r = lastRecord;
        try { r = readRecord(where); } catch (err) { /* the last one read */ }
        known = r != null;
        const e = known ? entryOf(r, name) : null;
        version = e != null ? e.version : null;
      }
      loaded.delete(name);
      stopped.set(name, {code, modules, version, known});
      writeRun();
      const notice = `${short(name)} stopped (${code}); restart your client`;
      history({module: name, change: 'stopped', notice, when: msg != null && msg.when === 'start' ? 'start' : 'restart'});
      tell(notice);
      // (the held-back list follows: applied once more, after this; the
      // reviewer's high on #106, 4)
      if (heldOn) run();
    });
    chain = p.catch(() => {});
    return p;
  };
  return {apply: run, moduleStopped, close};
}

module.exports = {inPlace};
