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
// unload {name}. The pack form cannot find a part in the store. Still pack
// by pack: L2 decides by module.
const fs = require('node:fs');
const path = require('node:path');
const {readModulesRecord: readRecord} = require('./module-record');
const {installedPacks, declaredRemotes, credentialUnion, loadablePacks, withdrawnPacks, withdrawnLine, withdrawnNowLine, heldWithdrawn, releaseOf} = require('./packs');
const {ALLOWED_ORIGINS} = require('./allowlist');
const {pickCredential} = require('./credential');
const {writeAtomic} = require('./atomic');
const {readSettings, valueOf, runtimeValue, withSettingsLock, loosens, shown} = require('./settings');
const {ceilingFor, ceilingRefusal, startUnderCeiling, forbiddenBy, packAllowed} = require('./ceiling');
const {reportOutsideEdits} = require('./outside-edits');

// The settings a running runtime takes at once (countinghouse_settings'
// "now" ones); the rest apply at the next start.
const LIVE = ['locale', 'maxOutputBytes', 'requestTimeout'];

const {newer} = require('./upgrade');
const {appendHistory} = require('./history');
const {enforceAvailable} = require('./sandbox-support');
const {teller} = require('./control');
// whether two packs' module versions are the same: no reload between them
const sameModules = (a, b) => {
  const x = Object.entries(a || {}).sort(([m], [n]) => (m < n ? -1 : 1));
  const y = Object.entries(b || {}).sort(([m], [n]) => (m < n ? -1 : 1));
  return JSON.stringify(x) === JSON.stringify(y);
};
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
  const forWhom = shared ? 'for this session' : 'for this start';
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

  // run.json's loaded: every module version this runtime holds
  // ({module: version}), which collection keeps (lib/gc.js collectStore)
  const writeRun = () => {
    const versions = Object.assign({}, ...[...loaded.values()].map((v) => v.modules || {}));
    try {
      const file = path.join(runDir, 'run.json');
      const run = JSON.parse(fs.readFileSync(file, 'utf8'));
      writeAtomic(file, JSON.stringify({...run, loaded: versions}) + '\n');
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
    if (defaultRepo != null) {
      const config = path.join(configDir, ...`${p.scenario}.json`.split('/'));
      fs.mkdirSync(path.dirname(config), {recursive: true});
      fs.writeFileSync(config, JSON.stringify({defaultRepo}) + '\n');
    }
    return {};
  };
  const send = async (change, p, msg, notice, {told = false, quiet = false} = {}) => {
    const reply = await control.request({...msg, ...(quiet ? {} : {notice})});
    if (reply.ok === true) {
      if (change === 'removed' || change === 'withdrawn' || /^turned off/.test(change)) loaded.delete(p.name); else loaded.set(p.name, {version: p.version, scenario: p.scenario, modules: p.modules});
      writeRun();
      history({pack: p.name, change, notice});
      if (quiet) return;
      // an unload's notice rides on the unload itself, and the runtime tells
      // the sessions that listed the pack before it goes (B3 Task 6); a
      // separate notice about it is everyone's: afterwards no session lists it
      if (told) tell(notice, msg.type === 'unload' ? {} : {pack: p.name}); else say(notice);
      return;
    }
    history({pack: p.name, change, notice, problem: `${reply.code || 'failed'}: ${reply.message || ''}`.slice(0, 300)});
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
    if (runtimeChanged && !runtimeSaid) {
      runtimeSaid = true;
      const notice = 'a runtime update applies at the next start: restart your client to use it and the packs installed with it';
      history({change: 'runtime update', notice});
      say(notice);
    }
    // a pack this release no longer lists never loads here either
    // (withdrawn: start said so once); nothing of it is removed
    const all = installedPacks(where, record, io);
    // by this release's pins, or by the record's withdrawn list (an upgrade
    // to a release that withdrew it: #413 section 9.7)
    const gone = new Set([...withdrawnPacks(all, {allow: releaseOf(io), record}).map((p) => p.name), ...heldWithdrawn(record)]);
    const packs = all.filter((p) => !gone.has(p.name));
    // the operator's allowlist of packs (cached: ceilingFor): an unlisted pack
    // never loads, and one loaded before the list named it is unloaded
    const ceilingNow = ceilingFor(where, {platform: io.platform || process.platform, env: io.env});
    // this start's turn-on ends when the file's value for the pack changes,
    // the ceiling stops allowing it, or the pack installed is no longer the
    // version the user confirmed (an upgrade or rollback in place: never
    // reloaded at a version nobody confirmed)
    const installedVersion = new Map(packs.map((p) => [p.name, p.version]));
    // packs a session turned on that the settings now turn on, for everyone:
    // loaded already, so no load follows, and the shared runtime is told
    // they are global (B3, "For C": set pack.<n> true; a terminal off is
    // always an unload, never a set to false)
    // (sent once this round's unloads, loads and reloads are done, and only
    // for a pack none of them touched: a load or reload says global itself)
    const nowGlobal = [];
    for (const [name, held] of [...thisStart]) {
      const fileValue = valueOf(settings, `pack.${name}`);
      const allowed = packAllowed(ceilingNow, name);
      const sameVersion = installedVersion.get(name) === held.version;
      if (fileValue === held.fileValue && allowed && sameVersion) continue;
      thisStart.delete(name);
      if (shared && fileValue !== false && allowed && sameVersion && loaded.has(name)) nowGlobal.push(name);
    }
    const handled = new Set();
    const off = new Set(packs.filter((p) => (valueOf(settings, `pack.${p.name}`) === false && !thisStart.has(p.name)) || !packAllowed(ceilingNow, p.name)).map((p) => p.name));
    const {load} = loadablePacks(packs.filter((p) => !off.has(p.name)), env);
    const target = new Map(load.map((p) => [p.name, p]));
    // an upgrade that withdrew a pack moved it to held (lib/install.js): a
    // start serving it stops, and the sessions are told why
    const withdrawnNow = new Set([...heldWithdrawn(record), ...gone]);
    for (const name of [...loaded.keys()]) {
      if (target.has(name)) continue;
      const scenario = loaded.get(name).scenario != null ? loaded.get(name).scenario : name;
      handled.add(name);
      if (withdrawnNow.has(name)) { withdrawnTold.add(name); await unloadWithdrawn(name, scenario); continue; }
      await send(off.has(name) ? 'turned off' : 'removed', {name}, {type: 'unload', name: scenario}, off.has(name) ? `${name} turned off` : `${name} removed`);
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
    for (const p of load) {
      const was = loaded.get(p.name);
      if (was != null && sameModules(was.modules, p.modules)) continue;
      if (runtimeChanged) continue;   // the next start loads it, with its runtime
      const creds = credentialsFor(p);
      if (creds.problem != null) {
        const notice = `${p.name} not loaded in place: ${creds.problem}`;
        history({pack: p.name, change: was == null ? 'added' : 'changed', notice, problem: creds.problem});
        say(notice);
        continue;
      }
      // the module form: the scenario by its package name, each module by its
      // store directory; the device config stays the runtime's own
      // (--deviceConfigPath, given at spawn)
      handled.add(p.name);
      if (was == null && confirmed.has(p.name)) {
        // told by loadPack once it knows the runtime is still waiting
        await send(shared ? 'turned on for this session (confirmed in the client)' : 'turned on this start (confirmed in the client)', p, {type: 'load', name: p.scenario, dirs: p.dirs}, `${p.name} turned on ${forWhom} ${p.version} (confirmed in your client)`, {quiet: true});
      } else if (was == null) {
        await send('added', p, {type: 'load', name: p.scenario, dirs: p.dirs}, `${p.name} added ${p.version}`);
      } else {
        const how = newer(p.version, was.version) ? 'upgraded' : newer(was.version, p.version) ? 'rolled back' : 'updated';
        await send(how, p, {type: 'reload', names: [p.scenario], dirs: p.dirs}, `${p.name} ${how} ${was.version} → ${p.version}`);
      }
    }
    for (const name of nowGlobal) {
      if (handled.has(name) || !loaded.has(name)) continue;
      let reply;
      try { reply = await control.request({type: 'set', name: `pack.${name}`, value: true}); } catch (err) { reply = {ok: false, code: err.code || 'failed'}; }
      const notice = `${name} turned on for everyone (it was on for a session)`;
      history({pack: name, change: 'turned on for everyone (it was on for a session)', notice, ...(reply.ok === true ? {} : {problem: reply.code || 'failed'})});
      if (reply.ok !== true) say(`${notice}: not applied in place (${reply.code || 'failed'}); restart your client to apply it`);
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
  const unloadWithdrawn = async (name, scenario) => {
    const msg = {type: 'unload', name: scenario, notice: withdrawnNowLine(name)};
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
      const reply = await control.request(msg);
      if (reply.ok === true) {
        loaded.delete(name);
        writeRun();
        history({pack: name, change: 'withdrawn', notice: msg.notice});
        if (stuck.delete(name)) tell(`pack ${name} is no longer served`);
        return;
      }
      if (attempt === 1 && !stuck.has(name)) {
        stuck.add(name);
        history({pack: name, change: 'withdrawn', notice: msg.notice, problem: `${reply.code || 'failed'}: ${reply.message || ''}`.slice(0, 300)});
        tell(`pack ${name} was withdrawn in this release and could not be stopped in place: restart your client now to stop it`);
      }
    }
  };
  const stuck = new Set();
  const tellWithdrawn = (name) => { if (withdrawnTold.has(name)) return; withdrawnTold.add(name); tell(withdrawnLine(name)); };
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
      // a session's own pack on a shared runtime: the module form the store
      // needs is global there, and one session must never turn a pack on for
      // everyone (per-session on/off is dropped for release 1: the Reviewer,
      // 11-18); it is turned on for every session in the settings
      if (shared) {
        tell(`${name} is turned on for every session: \`ch-local settings set pack.${name} on\``);
        throw refuse('CONTROL_PACK_NOT_ALLOWED');
      }
      let record;
      try { record = readRecord(where); } catch (err) { throw refuse('CONTROL_NOT_INSTALLED'); }
      // withdrawn, held by the upgrade that withdrew it: never loaded, and the
      // session is told why (the refusal carries only its code)
      if (heldWithdrawn(record).includes(name)) {
        tellWithdrawn(name);
        throw refuse('CONTROL_PACK_NOT_ALLOWED');
      }
      const entry = record != null && record.packs != null ? record.packs[name] : null;
      if (entry == null) throw refuse('CONTROL_NOT_INSTALLED');
      // withdrawn in this release: never loaded, the pack and the remove
      // command named, never a path
      if (withdrawnPacks([{name}], {allow: releaseOf(io), record}).length > 0) {
        tellWithdrawn(name);
        throw refuse('CONTROL_PACK_NOT_ALLOWED');
      }
      // the version the form showed is its ch-pack package's, and that is
      // the package loaded (the pack's scenario, at its active version)
      const scenario = `@countinghouse/ch-pack-${name}`;
      const active = record.modules != null && record.modules[scenario] != null ? record.modules[scenario].version : null;
      if (entry.modules == null || entry.modules[scenario] == null || typeof(msg.version) !== 'string' || active !== msg.version) throw refuse('CONTROL_VERSION_CHANGED');
      // the operator's ceiling, as the runtime checked it: trusted (or none),
      // conversation not turned off, the pack allowed
      const ceiling = ceilingFor(where, {platform: io.platform || process.platform, env: io.env});
      if (ceiling.state === 'untrusted') throw refuse('CONTROL_CEILING_UNTRUSTED');
      if (ceiling.state === 'trusted' && ceiling.ceiling != null && ceiling.ceiling.conversation === false) throw refuse('CONTROL_CONVERSATION_OFF');
      if (!packAllowed(ceiling, name)) throw refuse('CONTROL_PACK_NOT_ALLOWED');
      if (loaded.has(name)) return {};   // on already
      thisStart.set(name, {fileValue: valueOf(readSettings(where), `pack.${name}`), version: msg.version});
      confirmed.add(name);
      await safe();
      confirmed.delete(name);
      if (!loaded.has(name)) { thisStart.delete(name); throw refuse('CONTROL_LOAD_FAILED'); }
      // what was loaded is what was confirmed (packs.json could change
      // between the check and the load): otherwise unloaded, and refused
      if (loaded.get(name).version !== msg.version) {
        thisStart.delete(name);
        await safe();
        throw refuse('CONTROL_VERSION_CHANGED');
      }
      // too late for the runtime, which has told the user nothing changed:
      // unloaded again, and refused, so what the user was told stands
      if (Date.now() - received > (Number.isFinite(state.loadPackAnswerMs) ? state.loadPackAnswerMs : LOAD_PACK_ANSWER_MS)) {
        thisStart.delete(name);
        await safe();
        history({pack: name, change: 'not turned on (answered too late)'});
        throw refuse('CONTROL_BUSY');
      }
      // the settings have it on: it loaded for everyone, not only this session
      const forEveryone = valueOf(readSettings(where), `pack.${name}`) !== false;
      const notice = forEveryone ? `${name} turned on ${msg.version}` : `${name} turned on ${forWhom} ${msg.version} (confirmed in your client)`;
      tell(notice, {pack: name});
      return {};
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
      thisStart.delete(name);
      await safe();
      if (loaded.has(name)) throw refuse('CONTROL_UNLOAD_FAILED');
      return {};
    });
    chain = p.catch(() => {});
    return p;
  };
  return {apply: run, loadPack, unloadPack};
}

module.exports = {inPlace, loadPackDeadlineMs: LOAD_PACK_DEADLINE_MS, loadPackAnswerMs: LOAD_PACK_ANSWER_MS};
