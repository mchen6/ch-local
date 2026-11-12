'use strict';
// ch-local start --stdio (plan Task 11): runs the installed runtime over stdio
// with every installed pack whose credential is present. The profile is LM1's
// single-identity one: the local store in the one per-user store directory,
// the sandbox enforced (audit may be asked for, off never), no auth file, no
// usage directory and no port. stdout is the client's MCP channel, so start
// writes only to stderr. What one start writes for its runtime (the remote
// credentials and the device configs) lives in <home>/run/<pid>, so starts
// from several clients at once never see each other's.
const fs = require('node:fs');
const path = require('node:path');
const {layout} = require('./home');
const {writeAtomic} = require('./atomic');
const {ALLOWED_ORIGINS} = require('./allowlist');
const {pickCredential} = require('./credential');
const {installedPacks, declaredRemotes, credentialUnion, loadablePacks} = require('./packs');

const SANDBOX_MODES = ['enforce', 'audit'];
// The options the profile sets or forbids; a client entry may not pass them.
const OWNED = ['--store', '--storePath', '--moduleDataPath', '--remoteCredentials', '--deviceConfigPath', '--loadModule', '--modulePath',
  '--workerThread', '--authConfigPath', '--usageDir', '--port', '--stdio', '--debug'];

// owner/name from a GitHub remote URL (https, git, ssh or scp form), else null.
function repoFromRemote(url) {
  const s = String(url || '').trim();
  const host = '(?:www\\.)?github\\.com';
  const m = new RegExp(`^(?:(?:https?|git|ssh)://(?:[^@/]+@)?${host}(?::\\d+)?/|[^@/\\s]+@${host}:)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\\.git)?/?$`, 'i').exec(s);
  return m == null ? null : `${m[1]}/${m[2]}`;
}

// The pass-through checked: {problem} or {mode, rest}. --moduleSandbox in
// either form, audit or enforce only; an option the profile owns, in any form
// (--x v, --x=v, --no-x), is refused.
function checkPassThrough(passThrough) {
  const rest = [];
  let mode = null;
  for (let i = 0; i < passThrough.length; i++) {
    const a = passThrough[i];
    const base = a.replace(/=.*$/s, '').replace(/^--no-/, '--');
    if (OWNED.includes(base)) return {problem: `${base} is set by ch-local start and cannot be passed`};
    if (a === '--moduleSandbox') { mode = passThrough[i + 1] === undefined ? '' : passThrough[++i]; continue; }
    if (a.startsWith('--moduleSandbox=')) { mode = a.slice('--moduleSandbox='.length); continue; }
    if (base === '--moduleSandbox') return {problem: `${a} is not allowed; a pack runs under --moduleSandbox enforce, or audit to diagnose`};
    rest.push(a);
  }
  if (mode != null && !SANDBOX_MODES.includes(mode)) return {problem: `--moduleSandbox ${mode || '(no value)'} is not allowed; a pack runs under enforce, or audit to diagnose`};
  return {mode, rest};
}

// Removes run/<pid> directories whose start has died (a SIGKILL leaves one).
// Only all-digit names: anything else in run/ is not ch-local's.
function sweepRuns(runDir, alive) {
  let names = [];
  try { names = fs.readdirSync(runDir); } catch (err) { return; }
  for (const name of names) {
    if (/^\d+$/.test(name) && !alive(Number(name))) fs.rmSync(path.join(runDir, name), {recursive: true, force: true});
  }
}

// The runtime's environment: this one, less any credential variable that is
// present but blank or an unresolved ${...}, so the runtime (which takes the
// first non-empty allowed variable) sends the one start named.
function childEnv(env, variables) {
  const out = {...env};
  for (const name of variables) {
    if (Object.prototype.hasOwnProperty.call(out, name) && pickCredential(out, [name]) == null) delete out[name];
  }
  return out;
}

async function start({passThrough}, io) {
  const fail = (s, code = 1) => { io.stderr.write(`ch-local: ${s}\n`); return code; };
  const say = (s) => io.stderr.write(`ch-local: ${s}\n`);
  const options = checkPassThrough(passThrough);
  if (options.problem != null) return fail(options.problem, 2);

  const where = layout(io.env, io.homedir);
  const packs = installedPacks(where);
  if (packs.length === 0) return fail('no pack is installed; run `ch-local install --pack <name>`');

  const {load, missing} = loadablePacks(packs, io.env);
  for (const m of missing) say(`not loading ${m.name}: set ${m.variables.join(' or ')} in the environment your client starts from`);
  if (load.length === 0) return fail('no installed pack has its credential; nothing to start');

  let declared;
  try {
    declared = declaredRemotes(where.app, load.flatMap((p) => p.packages));
  } catch (err) {
    return fail(`${err.message}; run \`ch-local install\` again`);
  }
  const {credentials, refused} = credentialUnion(declared, ALLOWED_ORIGINS);
  if (refused.length > 0) {
    for (const r of refused) {
      say(r.variable != null
        ? `${r.from} declares the variable ${r.variable} for ${r.origin}, which this launcher does not allow to receive it`
        : `${r.from} declares a remote at ${r.origin == null ? 'an unreadable URL' : r.origin}, which this launcher does not allow`);
    }
    return fail('refusing to start: a pack would send a credential somewhere not allowed');
  }

  sweepRuns(where.run, io.alive);
  const runDir = path.join(where.run, String(io.pid));
  fs.rmSync(runDir, {recursive: true, force: true});
  fs.mkdirSync(path.join(runDir, 'config'), {recursive: true});
  try {
    const remoteCredentials = path.join(runDir, 'remote-credentials.json');
    const configDir = path.join(runDir, 'config');
    writeAtomic(remoteCredentials, JSON.stringify(credentials, null, 2) + '\n');
    const origin = await io.exec('git', ['remote', 'get-url', 'origin'], {cwd: io.cwd || undefined});
    const defaultRepo = origin.status === 0 ? repoFromRemote(origin.stdout) : null;
    // The runtime reads <deviceConfigPath>/<package name>.json.
    if (defaultRepo != null) {
      for (const p of load) {
        const file = path.join(configDir, ...`${p.scenario}.json`.split('/'));
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, JSON.stringify({defaultRepo}) + '\n');
      }
    }
    for (const p of load) say(`loading ${p.name}${p.credential != null ? ` with ${p.credential}` : ''}`);
    const args = [
      path.join(where.app, 'node_modules', 'countinghouse', 'bin', 'countinghouse-stdio.js'),
      '--workerThread',
      '--store', 'local',
      '--storePath', where.store,
      '--moduleSandbox', options.mode || 'enforce',
      '--moduleDataPath', where.moduleData,
      '--remoteCredentials', remoteCredentials,
      '--deviceConfigPath', configDir,
      ...load.flatMap((p) => ['--loadModule', path.join(where.app, 'node_modules', ...p.scenario.split('/'))]),
      ...options.rest
    ];
    return await io.spawn(io.node, args, {env: childEnv(io.env, Object.values(credentials).flat())});
  } finally {
    fs.rmSync(runDir, {recursive: true, force: true});
  }
}

module.exports = {start, repoFromRemote, checkPassThrough};
