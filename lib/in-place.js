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
// unload {name}. The pack form cannot find a part in the store.
// By module (#413 sections 5.2 and 9.8; L2a): what loads is each available
// top-level module (lib/availability.js), once, whichever packs record it;
// `loaded` is keyed by its package name. On/off, the ceiling and the
// credentials are today's, by the pack whose scenario the module is
// (lib/pack-seams.js), until L2b. A record of another release (an upgrade
// or a release rollback while this start runs) is judged by none of this
// start's pins: it keeps what it loaded, unloads what the record withdrew
// or moved back, and loads and reloads nothing.
const fs = require('node:fs');
const path = require('node:path');
const {readModulesRecord: readRecord} = require('./module-record');
const {installedPacks, declaredRemotes, credentialUnion, withdrawnNames, removeHint, releaseOf, recordRelease, staleLine, installLine, packScenario, packModuleName} = require('./packs');
const {availability, short} = require('./availability');
const {compareVersions} = require('./semver-order');
const {packSeams, writeDeviceConfig, credentialReason} = require('./pack-seams');
const {ALLOWED_ORIGINS} = require('./allowlist');
const {pickCredential} = require('./credential');
const {writeAtomic} = require('./atomic');
const {readSettings, valueOf, runtimeValue, withSettingsLock, loosens, shown} = require('./settings');
const {ceilingFor, ceilingRefusal, startUnderCeiling, forbiddenBy, packAllowed} = require('./ceiling');
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
// Under a newer record (#413 section 9.8), the unloads no pins decide: a
// module removed from the record (or a callee of it no longer installed:
// the medium review of the high round, 1), no longer a pack's top-level
// module, turned off, refused by the ceiling, or without its credential;
// a caller goes with a callee unloaded for one of these.
const NO_PINS = ['removed', 'not installed', 'not top-level', 'off', 'ceiling', 'credential'];
// A load-pack is started within this of its arrival or refused (CONTROL_BUSY):
// with the load's own 30 s, under the runtime's 45 s wait, so a pack is never
// loaded after the runtime has told the user it was not.
const LOAD_PACK_DEADLINE_MS = 10000;
// A load-pack answered past this is not told as turned on: the runtime stops
// waiting at 45 s and tells the user nothing changed, so start unloads it
// and refuses instead (the review of #24).
const LOAD_PACK_ANSWER_MS = 40000;

// state: {where, io, runDir, configDir, env (start's, with any token),
// childEnv (what the runtime was given), control, loaded: Map name ->
// {key, version, scenario}, defaultRepo, say, host}. -> {apply() -> Promise}
// The runtime knows a pack by its scenario's package name (countinghouse
// #205), so every load, reload and unload names that; a removed pack's is
// kept in `loaded`, since packs.json no longer has it. The history and the
// notices name the pack.
function inPlace(state) {
  const {where, io, runDir, configDir, env, childEnv, control, loaded, defaultRepo, say, host, passed = []} = state;
  // the withdrawn packs this start has told the sessions about (start's
  // notices and the unloads here): a load-pack refusal never repeats one
  const withdrawnTold = state.withdrawnTold instanceof Set ? state.withdrawnTold : new Set();
  // a shared runtime (ch-local daemon's): a pack a session turned on is that
  // session's, not this start's (countinghouse's B3, "For C")
  const shared = state.shared === true;
  // never silent (part 3, section 5): start's teller (lib/control.js), which
  // said what start found; on its own, said and told here
  const tell = state.tell || (() => { const t = teller(say); t.attach(control); return t.tell; })();
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
  const history = (entry) => appendHistory(where, {by: 'start', ...entry}, {host, pid: io.pid});
  // packs turned on for this start in the client's dialog (countinghouse
  // part 3 P2, Task 5): name -> settings.json's value for it then. On while
  // the file keeps that value (a change there is what governs it, and ends
  // this start's turn-on), and while the operator's ceiling allows it (one
  // that stops allowing it ends it too: allowed again, it stays off until
  // confirmed again); never written to settings.json
  const thisStart = new Map();
  // the next load of a pack, when this start's dialog asked for it
  const confirmed = new Set();
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
  // whether a pack's remotes are within what this runtime was started with:
  // the module form carries no credentials file of its own, so a pack that
  // needs an origin or variable the start's --remoteCredentials did not
  // give waits for a restart (a bridge until L5 sends the module's
  // credentials with the load: the Reviewer, 11-18). -> {} or {problem}
  const startCredentials = state.remoteCredentials != null ? state.remoteCredentials : {};
  const credentialsFor = (p) => {
    let declared;
    try { declared = declaredRemotes(p.dirs, p.packages); } catch (err) { return {problem: `${err.message}; run \`ch-local install\` again`}; }
    const {credentials, refused} = credentialUnion(declared, ALLOWED_ORIGINS);
    if (refused.length > 0) return {problem: 'it would send a credential somewhere not allowed'};
    for (const [origin, variables] of Object.entries(credentials)) {
      const pick = pickCredential(env, variables);
      if (pick == null) continue;
      const given = startCredentials[origin];
      if (childEnv[pick.name] == null || !Array.isArray(given) || !given.includes(pick.name)) {
        return {problem: 'it needs a credential this client was not started with; restart your client'};
      }
    }
    writeDeviceConfig(configDir, p, defaultRepo);   // until P1 (lib/pack-seams.js)
    return {};
  };
  // one reload for several packs: every scenario named, every module's
  // directory given, one notice for all; each pack's history line as a
  // send's would be. The runtime switches them all or none. -> whether it did.
  const sendReload = async (list) => {
    const dirs = Object.assign({}, ...list.map(({p}) => p.dirs));
    const notice = list.map((r) => r.notice).join('; ');
    const before = new Map(list.map(({p}) => [p.name, asked.get(p.name)]));
    for (const {p} of list) asked.set(p.name, p.modules);
    const reply = await control.request({type: 'reload', names: list.map(({p}) => p.name), dirs, notice});
    for (const {p} of list) askOr(p.name, reply, before.get(p.name));
    if (reply.ok === true) {
      for (const {p, how, notice: own} of list) {
        loaded.set(p.name, {version: p.version, scenario: p.name, modules: p.modules});
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
  const send = async (change, p, msg, notice, {quiet = false} = {}) => {
    const before = asked.get(p.name);
    if (msg.type === 'load') asked.set(p.name, p.modules);
    const reply = await control.request({...msg, ...(quiet ? {} : {notice})});
    if (msg.type === 'load') askOr(p.name, reply, before);
    if (reply.ok === true) {
      if (msg.type === 'unload') loaded.delete(p.name); else loaded.set(p.name, {version: p.version, scenario: p.name, modules: p.modules});
      writeRun();
      history({module: p.name, change, notice});
      if (quiet) return;
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
  const bound = (given) => {
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
    const bounded = startUnderCeiling(settings, ceiling, {forcedAudit: !enforceAvailable(where, platform)});
    const values = bounded.values;
    for (const name of Object.keys(values).filter((k) => /^pack\./.test(k))) {
      if (valueOf(applied, name) !== false || values[name] !== true) continue;
      const refusal = ceilingRefusal(ceiling, name, true);
      if (refusal == null) continue;
      values[name] = false;
      bounded.notes.push(`${name.slice(5)} not loaded: ${refusal.message.replace(/; nothing was changed$/, '')}`);
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
      settings = bound(settings);
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
    const otherRelease = whose.state === 'stale';
    const frozen = otherRelease || runtimeChanged;
    const once = (notice, change) => {
      if (notesSaid.has(notice)) return;
      notesSaid.add(notice);
      history({change, notice});
      tell(notice);
    };
    if (otherRelease) once(staleLine(whose.installed, whose.how), 'release changed');
    else if (whose.state === 'other') once(installLine(whose.ours), 'record of another release');
    if (runtimeChanged && !otherRelease && !runtimeSaid) {
      runtimeSaid = true;
      const notice = 'a runtime update applies at the next start: restart your client to use it and the packs installed with it';
      history({change: 'runtime update', notice});
      say(notice);
    }
    const all = installedPacks(where, record, io);
    // the operator's allowlist of packs (cached: ceilingFor): an unlisted pack
    // never loads, and one loaded before the list named it is unloaded
    const ceilingNow = ceilingFor(where, {platform: io.platform || process.platform, env: io.env});
    // this start's turn-on ends when the file's value for the pack changes,
    // the ceiling stops allowing it, or the pack installed is no longer the
    // version the user confirmed (an upgrade or rollback in place: never
    // reloaded at a version nobody confirmed)
    const installedVersion = new Map(all.map((p) => [p.name, p.version]));
    // this start's turn-on ends with any of those (a runtime of its own
    // only: a shared runtime takes no session's own pack)
    for (const [name, held] of [...thisStart]) {
      const fileValue = valueOf(settings, `pack.${name}`);
      if (fileValue === held.fileValue && packAllowed(ceilingNow, name) && installedVersion.get(name) === held.version) continue;
      thisStart.delete(name);
    }
    // what is wanted, by module (section 5.2); a credential not set leaves a
    // module out, as start's does
    const av = availability(where, record, {release: ours, pins: !otherRelease,
      seams: packSeams({installed: all, settings, ceiling: ceilingNow, env, on: (n) => thisStart.has(n), credentialReason: (vars) => credentialReason(vars, {shared})})});
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
    if (!otherRelease) {
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
    const inRecord = (m) => record.modules != null && Object.prototype.hasOwnProperty.call(record.modules, m);
    const packOf = (m) => Object.keys(record.packs || {}).find((n) => record.packs[n].modules != null && record.packs[n].modules[m] != null) || null;
    const withdrawnNow = new Set(otherRelease && Array.isArray(record.withdrawn) ? record.withdrawn : []);
    for (const name of [...loaded.keys()]) {
      if (target.has(name) && !otherRelease) continue;
      const mods = Object.keys(loaded.get(name).modules || {});
      if (otherRelease) {
        // what the release just installed withdrew, or moved back
        const w = mods.find((m) => withdrawnNow.has(m));
        const low = w == null ? mods.find((m) => inRecord(m) && compareVersions(loaded.get(name).modules[m], record.modules[m].version) === 1) : null;
        const by = name === (w || low) ? '' : `; ${short(name)} calls it and is stopped with it`;
        if (w != null) {
          // as any withdrawn unload: retried, "restart now" if refused twice,
          // and told once (the high review of L2a, 2)
          withdrawnTold.add(w);
          await unloadWithdrawn(name, null, `module ${short(w)} was withdrawn in the release just installed and is no longer served${by}`, {about: w, release: 'the release just installed'});
          continue;
        }
        if (low != null) { await send('moved back', {name}, {type: 'unload', name}, `${short(low)} was moved back to ${record.modules[low].version} by the release just installed; it is stopped here until this client restarts${by}`); continue; }
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
      if (otherRelease && !NO_PINS.includes(kind) && !(kind === 'calls' && u != null && NO_PINS.includes(u.root))) continue;
      if (kind === 'not top-level') { await send('not top-level', {name}, {type: 'unload', name}, `${short(name)} unloaded: it is no longer a pack's top-level module`); continue; }
      if (kind === 'withdrawn') { withdrawnTold.add(name); await unloadWithdrawn(name, packOf(name)); continue; }
      if (kind === 'removed') { await send('removed', {name}, {type: 'unload', name}, `${short(name)} removed`); continue; }
      if (kind === 'off' || kind === 'ceiling') { await send('turned off', {name}, {type: 'unload', name}, `${short(name)} turned off`); continue; }
      if (kind === 'credential') { await send('credential removed', {name}, {type: 'unload', name}, `${short(name)}'s credential was removed (or changed); it is unloaded here until this client restarts`); continue; }
      await send('not available', {name}, {type: 'unload', name}, `${short(name)} unloaded: ${u.reason}`);
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
    const held = new Map();   // pack -> why it cannot change in place
    for (const p of load) {
      const was = loaded.get(p.name);
      if (was != null && sameModules(was.modules, p.modules)) continue;
      if (frozen) continue;   // the next start loads it, with its release and runtime
      const creds = credentialsFor(p);
      if (creds.problem != null) {
        if (was != null) { held.set(p.name, creds.problem); reloads.push({p, was, problem: creds.problem}); continue; }
        const notice = `${p.short} not loaded in place: ${creds.problem}`;
        history({module: p.name, change: 'added', notice, problem: creds.problem});
        say(notice);
        continue;
      }
      if (was == null) { loads.push(p); continue; }
      const order = compareVersions(p.version, was.version);
      const how = order === 1 ? 'upgraded' : order === -1 ? 'rolled back' : 'updated';
      reloads.push({p, was, how, notice: `${p.short} ${how} ${was.version} → ${p.version}`});
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
    const blocked = new Set([...held.keys()].map(root));
    const groups = new Map();
    for (const r of reloads) {
      const g = root(r.p.name);
      if (!blocked.has(g)) { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); continue; }
      const problem = held.has(r.p.name) ? held.get(r.p.name) : `it shares a module with ${[...held.keys()].filter((n) => root(n) === g).map(short).join(', ')}, which cannot change in place; restart your client`;
      const notice = `${r.p.short} not changed in place: ${problem}`;
      history({module: r.p.name, change: 'changed', notice, problem});
      say(notice);
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
    // store directory; the device config stays the runtime's own
    // (--deviceConfigPath, given at spawn)
    for (const p of loads) {
      const clashes = Object.keys(p.modules).map((m) => [m, otherVersion(m, p.modules[m])]).filter(([, h]) => h != null);
      if (clashes.length > 0) {
        const [clash, by] = clashes[0];
        const problem = `it takes ${clash} ${p.modules[clash]}, which ${short(by.pack)} keeps at ${by.version} for now; restart your client`;
        const notice = `${p.short} not loaded in place: ${problem}`;
        history({module: p.name, change: 'added', notice, problem});
        say(notice);
        continue;
      }
      if (p.packs.some((n) => confirmed.has(n))) {
        // told by loadPack once it knows the runtime is still waiting
        await send('turned on this start (confirmed in the client)', p, {type: 'load', name: p.name, dirs: p.dirs}, `${p.short} turned on for this start ${p.version} (confirmed in your client)`, {quiet: true});
      } else {
        await send('added', p, {type: 'load', name: p.name, dirs: p.dirs}, `${p.short} added ${p.version}`);
      }
      if (loaded.has(p.name)) hold(p.name, p.modules);
    }
  };
  const safe = () => apply().catch((err) => say(`a change could not be applied in place (${err.message}); restart your client to apply it`));
  let chain = Promise.resolve();
  const run = () => { chain = chain.then(safe, safe); return chain; };
  state.reapply = run;
  const refuse = (code) => Object.assign(new Error(code), {code});
  // a load-pack refused for a withdrawn pack: the refusal carries only its
  // code, and the runtime's request names no session, so the line goes to
  // the sessions as start's does, once per start (start's own count too)
  // a withdrawn pack's unload: the notice rides on it, as any unload's does.
  // A refusal (a runtime busy or mid-reload) is tried again 250 ms later; one
  // refused twice is said once per start, "restart your client now", never
  // "restart to apply"; every later apply tries again, quietly.
  // about: the withdrawn module (the unloaded one, or a module it calls);
  // release: the words for the release that withdrew it
  const unloadWithdrawn = async (name, pack, notice = `module ${short(name)} was withdrawn in this release and is no longer served; ${removeHint(pack || '<pack>')}`, {about = name, release = 'this release'} = {}) => {
    const msg = {type: 'unload', name, notice};
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
      const reply = await control.request(msg);
      if (reply.ok === true) {
        loaded.delete(name);
        writeRun();
        history({module: name, change: 'withdrawn', notice: msg.notice});
        if (stuck.delete(name)) tell(`module ${short(name)} is no longer served`);
        return;
      }
      if (attempt === 1 && !stuck.has(name)) {
        stuck.add(name);
        history({module: name, change: 'withdrawn', notice: msg.notice, problem: `${reply.code || 'failed'}: ${reply.message || ''}`.slice(0, 300)});
        const what = about === name ? `module ${short(name)} was withdrawn in ${release}` : `module ${short(about)} was withdrawn in ${release}, and ${short(name)}, which calls it,`;
        tell(`${what} could not be stopped in place: restart your client now to stop it`);
      }
    }
  };
  const stuck = new Set();
  // by its scenario module, as start and the applier tell it
  const tellWithdrawn = (name, record) => {
    const m = packScenario(record, name) || packModuleName(name);
    if (withdrawnTold.has(m)) return;
    withdrawnTold.add(m);
    tell(`module ${short(m)} was withdrawn in this release and was not started; ${removeHint(name)}`);
  };
  // load-pack {name, version}: on the applier's chain (it never races an
  // apply). The pack must be installed at the version the form showed (its
  // @countinghouse/ch-pack-<name> package, as the runtime's settings tool
  // read it), allowed by the ceiling, and turned off. -> {} once loaded.
  const loadPack = (msg) => {
    const received = Date.now();
    const p = chain.then(async () => {
      // started too late for the runtime's wait (45 s): refused, never loaded
      // after the runtime has said it was not
      if (Date.now() - received > LOAD_PACK_DEADLINE_MS) throw refuse('CONTROL_BUSY');
      const name = String(msg && msg.name);
      let record;
      try { record = readRecord(where); } catch (err) { throw refuse('CONTROL_NOT_INSTALLED'); }
      const entry = record != null && record.packs != null ? record.packs[name] : null;
      if (entry == null) throw refuse('CONTROL_NOT_INSTALLED');
      // withdrawn (by this release or by the record's list): never loaded,
      // and the session told why, the pack and the remove command named,
      // never a path (the refusal carries only its code)
      if (withdrawnNames(record, [{name}], releaseOf(io)).has(name)) {
        tellWithdrawn(name, record);
        throw refuse('CONTROL_PACK_NOT_ALLOWED');
      }
      // the version the form showed is its ch-pack package's, and that is
      // the package loaded (the pack's scenario, at its active version)
      const scenario = packScenario(record, name) || packModuleName(name);
      const active = record.modules != null && record.modules[scenario] != null ? record.modules[scenario].version : null;
      if (entry.modules == null || entry.modules[scenario] == null || typeof(msg.version) !== 'string' || active !== msg.version) throw refuse('CONTROL_VERSION_CHANGED');
      // the operator's ceiling, as the runtime checked it: trusted (or none),
      // conversation not turned off, the pack allowed
      const ceiling = ceilingFor(where, {platform: io.platform || process.platform, env: io.env});
      if (ceiling.state === 'untrusted') throw refuse('CONTROL_CEILING_UNTRUSTED');
      if (ceiling.state === 'trusted' && ceiling.ceiling != null && ceiling.ceiling.conversation === false) throw refuse('CONTROL_CONVERSATION_OFF');
      if (!packAllowed(ceiling, name)) throw refuse('CONTROL_PACK_NOT_ALLOWED');
      if (loaded.has(scenario)) return {};   // on already
      // a session's own pack on a shared runtime: the module form the store
      // needs is global there, and one session must never turn a pack on for
      // everyone (per-session on/off is dropped for release 1: the Reviewer,
      // 11-18); it is turned on for every session in the settings. Only
      // after every other check, so a withdrawn, forbidden or missing pack is
      // told as such (the medium review of L1a-2, 6)
      if (shared) {
        tell(`${name} is turned on for every session: \`ch-local settings set pack.${name} on\``);
        throw refuse('CONTROL_PACK_NOT_ALLOWED');
      }
      thisStart.set(name, {fileValue: valueOf(readSettings(where), `pack.${name}`), version: msg.version});
      confirmed.add(name);
      await safe();
      confirmed.delete(name);
      if (!loaded.has(scenario)) { thisStart.delete(name); throw refuse('CONTROL_LOAD_FAILED'); }
      // what was loaded is what was confirmed (packs.json could change
      // between the check and the load): otherwise unloaded, and refused
      if (loaded.get(scenario).version !== msg.version) {
        thisStart.delete(name);
        await safe();
        throw refuse('CONTROL_VERSION_CHANGED');
      }
      // too late for the runtime, which has told the user nothing changed:
      // unloaded again, and refused, so what the user was told stands
      if (Date.now() - received > (Number.isFinite(state.loadPackAnswerMs) ? state.loadPackAnswerMs : LOAD_PACK_ANSWER_MS)) {
        thisStart.delete(name);
        await safe();
        history({module: scenario, change: 'not turned on (answered too late)'});
        throw refuse('CONTROL_BUSY');
      }
      // the settings have it on: it loaded for everyone, not only this session
      const forEveryone = valueOf(readSettings(where), `pack.${name}`) !== false;
      const notice = forEveryone ? `${short(scenario)} turned on ${msg.version}` : `${short(scenario)} turned on for this start ${msg.version} (confirmed in your client)`;
      tell(notice, {pack: name});
      return {};
    });
    chain = p.catch(() => {});
    return p;
  };
  // module-stopped {name, code, when}: the runtime stopped a top-level module
  // for good, after unloading it itself (when: 'restart'), or refused it in
  // start's own plan (when: 'start'). On the applier's chain: out of what is
  // loaded and of run.json's loaded, recorded as stopped, said once to the
  // sessions, and written to the history.
  const moduleStopped = (msg) => {
    const p = chain.then(async () => {
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
        version = known && r.modules != null && r.modules[name] != null ? r.modules[name].version : null;
      }
      loaded.delete(name);
      stopped.set(name, {code, modules, version, known});
      writeRun();
      const notice = `${short(name)} stopped (${code}); restart your client`;
      history({module: name, change: 'stopped', notice, when: msg != null && msg.when === 'start' ? 'start' : 'restart'});
      tell(notice);
    });
    chain = p.catch(() => {});
    return p;
  };
  // unload-pack {name}: this start's pack turned off again (a pack on in
  // settings.json is turned off there, not here)
  const unloadPack = (msg) => {
    const p = chain.then(async () => {
      const name = String(msg && msg.name);
      if (!thisStart.has(name)) throw refuse('CONTROL_NOT_THIS_START');
      let module = null;
      try { module = packScenario(readRecord(where), name); } catch (err) { /* below: by the pack's own name */ }
      if (module == null) module = packModuleName(name);
      thisStart.delete(name);
      await safe();
      if (loaded.has(module)) {
        // still on by another pack that records it (on in the settings, or
        // this start's own): the right outcome, said, never a failure (the
        // medium review of the high round, 6)
        // judged as the seams judge: the settings in effect (apply's, bound
        // by the ceiling) and a pack the ceiling allows (the high review of
        // L2a's medium round, 2)
        let record = null;
        try { record = readRecord(where); } catch (err) { /* below: a failure */ }
        const ceiling = ceilingFor(where, {platform: io.platform || process.platform, env: io.env});
        const others = record == null ? [] : Object.keys(record.packs || {}).filter((n) => n !== name && packScenario(record, n) === module
          && packAllowed(ceiling, n) && (thisStart.has(n) || valueOf(applied, `pack.${n}`) !== false));
        if (others.length === 0) throw refuse('CONTROL_UNLOAD_FAILED');
        tell(`${short(module)} stays on: pack ${others[0]} has it on (\`ch-local settings set pack.${others[0]} off\`)`);
      }
      return {};
    });
    chain = p.catch(() => {});
    return p;
  };
  return {apply: run, loadPack, unloadPack, moduleStopped};
}

module.exports = {inPlace, loadPackDeadlineMs: LOAD_PACK_DEADLINE_MS, loadPackAnswerMs: LOAD_PACK_ANSWER_MS};
