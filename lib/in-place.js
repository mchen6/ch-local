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
const {readSettings, valueOf} = require('./settings');

// The settings a running runtime takes at once (countinghouse_settings'
// "now" ones); the rest apply at the next start.
const LIVE = ['locale', 'maxOutputBytes', 'requestTimeout'];

const nums = (v) => String(v).split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
function compare(a, b) {
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
const keyOf = (where, p) => (p.base === where.app ? 'flat' : path.basename(p.base));

// state: {where, io, runDir, configDir, env (start's, with any token),
// childEnv (what the runtime was given), control, loaded: Map name ->
// {key, version}, defaultRepo, say, host}. -> {apply() -> Promise}
function inPlace(state) {
  const {where, io, runDir, configDir, env, childEnv, control, loaded, defaultRepo, say, host} = state;
  let applied = readSettings(where);
  const history = (entry) => {
    try { fs.appendFileSync(path.join(where.home, 'history.jsonl'), JSON.stringify({at: new Date().toISOString(), by: 'start', host, pid: io.pid, ...entry}) + '\n'); } catch (err) { /* the change stands */ }
  };
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
      if (change === 'removed' || change === 'turned off') loaded.delete(p.name); else loaded.set(p.name, {key: keyOf(where, p), version: p.version});
      writeRun();
      history({pack: p.name, change, notice});
      say(notice);
      return;
    }
    history({pack: p.name, change, notice, problem: `${reply.code || 'failed'}: ${reply.message || ''}`.slice(0, 300)});
    say(`${notice}: not applied in place (${reply.code || 'failed'}); restart your client to apply it`);
  };
  const apply = async () => {
    let record;
    try { record = readRecord(where); } catch (err) { say(`the home cannot be read (${err.message}); nothing applied`); return; }
    const settings = readSettings(where);
    const packs = installedPacks(where, record);
    const off = new Set(packs.filter((p) => valueOf(settings, `pack.${p.name}`) === false).map((p) => p.name));
    const {load} = loadablePacks(packs.filter((p) => !off.has(p.name)), env);
    const target = new Map(load.map((p) => [p.name, p]));
    for (const name of [...loaded.keys()]) {
      if (target.has(name)) continue;
      await send(off.has(name) ? 'turned off' : 'removed', {name}, {type: 'unload', name}, off.has(name) ? `${name} turned off` : `${name} removed`);
    }
    // a setting the runtime takes at once is sent; any other waits for the
    // next start, and is said so
    for (const name of LIVE) {
      const was = valueOf(applied, name);
      const now = valueOf(settings, name);
      if (was === now) continue;
      const reply = await control.request({type: 'set', name, value: now});
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
      const creds = credentialsFor(p);
      if (creds.problem != null) {
        const notice = `${p.name} not loaded: ${creds.problem}`;
        history({pack: p.name, change: was == null ? 'added' : 'changed', notice, problem: creds.problem});
        say(notice);
        continue;
      }
      const msg = {name: p.name, scenario: p.dir, remoteCredentials: creds.file, deviceConfigDir: configDir};
      if (was == null) {
        await send('added', p, {type: 'load', ...msg}, `${p.name} added ${p.version}`);
      } else {
        const c = compare(p.version, was.version);
        const how = c > 0 ? 'upgraded' : c < 0 ? 'rolled back' : 'updated';
        await send(how, p, {type: 'reload', ...msg}, `${p.name} ${how} ${was.version} → ${p.version}`);
      }
    }
  };
  let chain = Promise.resolve();
  return {apply: () => { chain = chain.then(apply, apply); return chain; }};
}

module.exports = {inPlace};
