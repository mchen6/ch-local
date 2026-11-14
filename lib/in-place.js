'use strict';
// A running start applies a home's pack changes to its runtime (packs in
// place, part 2, plan Task B3): a pack added is loaded, one removed unloaded,
// one at another tree (an upgrade, a rollback, a changed part) reloaded; one
// at a time, in order, each with its notice, which the runtime shows once
// (countinghouse's notices). Every applied or failed change is appended to
// <home>/history.jsonl. What is loaded is kept in the run directory's
// run.json, which collection reads (lib/gc.js).
const fs = require('node:fs');
const path = require('node:path');
const {readRecord} = require('./record');
const {installedPacks, declaredRemotes, credentialUnion, loadablePacks} = require('./packs');
const {ALLOWED_ORIGINS} = require('./allowlist');
const {pickCredential} = require('./credential');
const {writeAtomic} = require('./atomic');
const {readSettings, valueOf, runtimeValue, withSettingsLock, loosens} = require('./settings');
const {ceilingFor, ceilingRefusal, startUnderCeiling, forbiddenBy, packAllowed} = require('./ceiling');
const {reportOutsideEdits} = require('./outside-edits');

// The settings a running runtime takes at once (countinghouse_settings'
// "now" ones); the rest apply at the next start.
const LIVE = ['locale', 'maxOutputBytes', 'requestTimeout'];

const {newer} = require('./upgrade');
const {appendHistory} = require('./history');
const keyOf = (where, p) => (p.base === where.app ? 'flat' : path.basename(p.base));

// state: {where, io, runDir, configDir, env (start's, with any token),
// childEnv (what the runtime was given), control, loaded: Map name ->
// {key, version, scenario}, defaultRepo, say, host}. -> {apply() -> Promise}
// The runtime knows a pack by its scenario's package name (countinghouse
// #205), so every load, reload and unload names that; a removed pack's is
// kept in `loaded`, since packs.json no longer has it. The history and the
// notices name the pack.
function inPlace(state) {
  const {where, io, runDir, configDir, env, childEnv, control, loaded, defaultRepo, say, host, passed = []} = state;
  // the settings the runtime was started with (start's own reading), so a
  // change made before the watcher began is still applied
  let applied = state.settings != null ? state.settings : readSettings(where);
  // the runtime this start spawned: a pack change against another runtime
  // version waits for the next start (the review of ch-local #13)
  const runtimeAtSpawn = JSON.stringify(state.runtimeVersions || null);
  let runtimeSaid = false;
  let settingsSaid = null;
  let ceilingSaid = null;
  const notesSaid = new Set();
  const history = (entry) => appendHistory(where, {by: 'start', ...entry}, {host, pid: io.pid});
  const writeRun = () => {
    const loadedKeys = Object.fromEntries([...loaded].filter(([, v]) => v.key !== 'flat').map(([name, v]) => [name, v.key]));
    try {
      const file = path.join(runDir, 'run.json');
      const run = JSON.parse(fs.readFileSync(file, 'utf8'));
      writeAtomic(file, JSON.stringify({...run, loaded: loadedKeys}) + '\n');
    } catch (err) { /* the run directory is gone: start is ending */ }
  };
  // a pack's own credentials file, for its remotes; null with why when it
  // cannot be loaded without a restart
  const credentialsFor = (p) => {
    let declared;
    try { declared = declaredRemotes(p.base, p.packages); } catch (err) { return {problem: `${err.message}; run \`ch-local install\` again`}; }
    const {credentials, refused} = credentialUnion(declared, ALLOWED_ORIGINS);
    if (refused.length > 0) return {problem: 'it would send a credential somewhere not allowed'};
    const chosen = {};
    for (const [origin, variables] of Object.entries(credentials)) {
      const pick = pickCredential(env, variables);
      if (pick != null && childEnv[pick.name] == null) return {problem: `${pick.name} was not given to the running runtime; restart your client to load it`};
      chosen[origin] = pick == null ? [] : [pick.name];
    }
    const file = path.join(runDir, `remote-credentials-${p.name}.json`);
    writeAtomic(file, JSON.stringify(chosen, null, 2) + '\n');
    if (defaultRepo != null) {
      const config = path.join(configDir, ...`${p.scenario}.json`.split('/'));
      fs.mkdirSync(path.dirname(config), {recursive: true});
      fs.writeFileSync(config, JSON.stringify({defaultRepo}) + '\n');
    }
    return {file};
  };
  const send = async (change, p, msg, notice) => {
    const reply = await control.request({...msg, notice});
    if (reply.ok === true) {
      if (change === 'removed' || change === 'turned off') loaded.delete(p.name); else loaded.set(p.name, {key: keyOf(where, p), version: p.version, scenario: p.scenario});
      writeRun();
      history({pack: p.name, change, notice});
      say(notice);
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
      const edits = withSettingsLock(where, () => reportOutsideEdits(where, readSettings(where), {say, host, pid: io.pid, refusal: forbiddenBy(ceiling)}), {waitMs: 0});
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
      const why = kept.length === 0 ? null : busy
        ? `the settings are being changed by another writer: ${kept.join(', ')} not loosened yet; the values in effect are kept`
        : `the operator's ceiling file ${ceiling.file} cannot be trusted (${ceiling.problem}): ${kept.join(', ')} not loosened; the values in effect are kept`;
      if (why != null && ceilingSaid !== why) say(why);
      ceilingSaid = why;
      return settings;
    }
    ceilingSaid = null;
    const bounded = startUnderCeiling(settings, ceiling, {platform});
    const values = bounded.values;
    for (const name of Object.keys(values).filter((k) => /^pack\./.test(k))) {
      if (valueOf(applied, name) !== false || values[name] !== true) continue;
      const refusal = ceilingRefusal(ceiling, name, true);
      if (refusal == null) continue;
      values[name] = false;
      bounded.notes.push(`${name.slice(5)} not loaded: ${refusal.message.replace(/; nothing was changed$/, '')}`);
    }
    for (const note of bounded.notes) if (!notesSaid.has(note)) { say(note); notesSaid.add(note); }
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
    const packs = installedPacks(where, record);
    // the operator's allowlist of packs (cached: ceilingFor): an unlisted pack
    // never loads, and one loaded before the list named it is unloaded
    const ceilingNow = ceilingFor(where, {platform: io.platform || process.platform, env: io.env});
    const off = new Set(packs.filter((p) => valueOf(settings, `pack.${p.name}`) === false || !packAllowed(ceilingNow, p.name)).map((p) => p.name));
    const {load} = loadablePacks(packs.filter((p) => !off.has(p.name)), env);
    const target = new Map(load.map((p) => [p.name, p]));
    for (const name of [...loaded.keys()]) {
      if (target.has(name)) continue;
      const scenario = loaded.get(name).scenario != null ? loaded.get(name).scenario : name;
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
        say(`${name} set to ${now}: your client passes --${name} itself, so its value stands`);
        continue;
      }
      // in the runtime's unit (requestTimeout: seconds), as start passes it
      const reply = await control.request({type: 'set', name, value: runtimeValue(name, now)});
      const notice = reply.ok === true ? `${name} set to ${now}` : `${name} set to ${now}: applies at the next start (${reply.code || 'not applied now'})`;
      history({setting: name, change: 'set', notice, ...(reply.ok === true ? {} : {problem: reply.code || 'failed'})});
      say(notice);
    }
    for (const name of ['moduleSandbox']) {
      if (valueOf(applied, name) !== valueOf(settings, name)) say(`${name} set to ${valueOf(settings, name)}: applies at the next start`);
    }
    applied = settings;
    for (const p of load) {
      const was = loaded.get(p.name);
      const key = keyOf(where, p);
      if (was != null && was.key === key) continue;
      if (runtimeChanged) continue;   // the next start loads it, with its runtime
      const creds = credentialsFor(p);
      if (creds.problem != null) {
        const notice = `${p.name} not loaded: ${creds.problem}`;
        history({pack: p.name, change: was == null ? 'added' : 'changed', notice, problem: creds.problem});
        say(notice);
        continue;
      }
      const msg = {name: p.scenario, scenario: p.dir, remoteCredentials: creds.file, deviceConfigDir: configDir};
      if (was == null) {
        await send('added', p, {type: 'load', ...msg}, `${p.name} added ${p.version}`);
      } else {
        const how = newer(p.version, was.version) ? 'upgraded' : newer(was.version, p.version) ? 'rolled back' : 'updated';
        await send(how, p, {type: 'reload', ...msg}, `${p.name} ${how} ${was.version} → ${p.version}`);
      }
    }
  };
  const safe = () => apply().catch((err) => say(`a change could not be applied in place (${err.message}); restart your client to apply it`));
  let chain = Promise.resolve();
  const run = () => { chain = chain.then(safe, safe); return chain; };
  state.reapply = run;
  return {apply: run};
}

module.exports = {inPlace};
