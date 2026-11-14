'use strict';
// ch-local start --stdio (plan Task 11): runs the installed runtime over stdio
// with every installed pack whose credential is present. The profile is LM1's
// single-identity one: the local store in the one per-user store directory,
// the sandbox enforced (audit may be asked for, off never), no auth file, no
// usage directory and no port. stdout is the client's MCP channel, so start
// writes only to stderr. What one start writes for its runtime (the remote
// credentials and the device configs) lives in <home>/run/<host>-<pid>-<random>,
// so starts from several clients at once never see each other's.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {layout} = require('./home');
const {writeAtomic} = require('./atomic');
const {ALLOWED_ORIGINS} = require('./allowlist');
const {pickCredential} = require('./credential');
const {ghToken} = require('./github-token');
const {installedPacks, declaredRemotes, credentialUnion, loadablePacks} = require('./packs');
const {readRecord} = require('./record');
const {UNRELEASED_LINE} = require('./pins');

// The pass-through is an allowlist (reviewer, 2026-11-12): only options known
// safe, each with its accepted values. Anything else is refused by name.
const PASS_THROUGH = {
  '--moduleSandbox': (v) => v === 'enforce' || v === 'audit',
  '--locale': (v) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(v)
};
const SIGNALS = {SIGINT: 2, SIGHUP: 1, SIGTERM: 15};
// The variables a GitHub token is consented under; gh's goes in the first.
const GITHUB_VARIABLES = ALLOWED_ORIGINS['https://api.githubcopilot.com'];

// GitHub's rules: an owner is 1-39 letters, digits or single inner hyphens; a
// repository name is 1-100 letters, digits, '.', '_' or '-', and not . or ..
const OWNER = /^(?=.{1,39}$)[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const NAME = /^(?=.{1,100}$)[A-Za-z0-9._-]+$/;

// owner/name from a GitHub remote URL (https, git, ssh or scp form), else null.
function repoFromRemote(url) {
  const s = String(url || '').trim();
  const host = '(?:www\\.)?github\\.com';
  const m = new RegExp(`^(?:(?:https?|git|ssh)://(?:[^@/]+@)?${host}(?::\\d+)?/|[^@/\\s]+@${host}:)([^/\\s]+)/([^/\\s]+?)(?:\\.git)?/?$`, 'i').exec(s);
  if (m == null) return null;
  const [, owner, name] = m;
  if (!OWNER.test(owner) || !NAME.test(name) || name === '.' || name === '..') return null;
  return `${owner}/${name}`;
}

// The url of [remote "origin"] in a git config's text, or null. Section and
// key names are case-insensitive; values may be quoted; ; and # start comments.
function originUrl(text) {
  let inOrigin = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (section != null) { inOrigin = section[1].toLowerCase() === 'remote' && section[2] === 'origin'; continue; }
    if (!inOrigin) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(line);
    if (kv == null || kv[1].toLowerCase() !== 'url') continue;
    let value = kv[2];
    if (value.startsWith('"')) {
      const q = /^"((?:[^"\\]|\\.)*)"/.exec(value);
      value = q == null ? '' : q[1].replace(/\\(.)/g, '$1');
    } else {
      value = value.replace(/\s[;#].*$/, '').trim();
    }
    return value === '' ? null : value;
  }
  return null;
}

// The origin URL of the repository holding `cwd`, read from its config file;
// no git process runs (reviewer, 2026-11-12: a git.exe in an untrusted
// repository would run with the user's environment). A worktree's .git is a
// file naming its gitdir, whose commondir names the directory with the config.
function readOrigin(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  const read = (file) => {
    try {
      const st = fs.statSync(file);
      return st.isFile() && st.size <= 1024 * 1024 ? fs.readFileSync(file, 'utf8') : null;
    } catch (err) { return null; }
  };
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    let gitDir = null;
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) gitDir = dotGit;
      else if (st.isFile()) {
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(read(dotGit) || '');
        if (m != null) gitDir = path.resolve(dir, m[1]);
      }
    } catch (err) { /* not here */ }
    if (gitDir != null) {
      const common = (read(path.join(gitDir, 'commondir')) || '').trim();
      const configDir = common !== '' ? path.resolve(gitDir, common) : gitDir;
      return originUrl(read(path.join(configDir, 'config')) || '');
    }
    if (path.dirname(dir) === dir) return null;
  }
}

// -> {problem} or {options}: the pass-through, each option known safe with
// an accepted value, in `--x v` or `--x=v` form.
function checkPassThrough(passThrough) {
  const options = [];
  for (let i = 0; i < passThrough.length; i++) {
    const a = passThrough[i];
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const check = Object.prototype.hasOwnProperty.call(PASS_THROUGH, name) ? PASS_THROUGH[name] : null;
    if (check == null) return {problem: `${name} cannot be passed to ch-local start; only ${Object.keys(PASS_THROUGH).join(' and ')} can`};
    const value = eq === -1 ? passThrough[++i] : a.slice(eq + 1);
    if (value === undefined || !check(value)) {
      return {problem: name === '--moduleSandbox'
        ? `--moduleSandbox ${value || '(no value)'} is not allowed; a pack runs under enforce, or audit to diagnose`
        : `${name} ${value === undefined ? '(no value)' : JSON.stringify(value)} is not allowed`};
    }
    options.push(...(eq === -1 ? [name, value] : [a]));
  }
  return {options, sandbox: options.includes('--moduleSandbox') || options.some((o) => o.startsWith('--moduleSandbox='))};
}

const {hostTag} = require('./gc');
const {controlClient} = require('./control');
const {watchFiles} = require('./watch');
const {inPlace} = require('./in-place');
const {readSettings, valueOf} = require('./settings');
const {autoCheck} = require('./auto-upgrade');

// Settings the runtime takes as options at start, unless the client passed
// the option itself (its pass-through wins).
function settingArgs(settings, passed) {
  const out = [];
  const given = (flag) => passed.some((o) => o === flag || o.startsWith(`${flag}=`));
  const add = (flag, name) => {
    if (given(flag) || !Object.prototype.hasOwnProperty.call(settings.values, name)) return;
    out.push(flag, String(valueOf(settings, name)));
  };
  add('--locale', 'locale');
  add('--maxOutputBytes', 'maxOutputBytes');
  add('--requestTimeout', 'requestTimeout');
  if (!given('--moduleSandbox') && valueOf(settings, 'moduleSandbox') === 'audit') out.push('--moduleSandbox', 'audit');
  return out;
}

// Removes this host's run directories whose start has died (a SIGKILL leaves
// one). Other hosts' (a home on a shared disk) and names start never made stay.
function sweepRuns(runDir, host, alive) {
  let names = [];
  try { names = fs.readdirSync(runDir); } catch (err) { return; }
  for (const name of names) {
    const m = /^(.+)-(\d+)-[0-9a-f]{8}$/.exec(name);
    if (m != null && m[1] === host && !alive(Number(m[2]))) fs.rmSync(path.join(runDir, name), {recursive: true, force: true});
  }
}

// One consented variable per origin (reviewer, 2026-11-12): the first allowed
// variable with a real value. The runtime is told only that one and its
// environment loses every other allowed variable for that origin, so the
// variable start names is the one sent.
function chooseCredentials(credentials, env) {
  const chosen = {};
  const childEnv = {...env};
  for (const [origin, variables] of Object.entries(credentials)) {
    const pick = pickCredential(env, variables);
    chosen[origin] = pick == null ? [] : [pick.name];
    for (const v of variables) if (pick == null || v !== pick.name) delete childEnv[v];
  }
  return {chosen, childEnv};
}

async function start({passThrough}, io) {
  const fail = (s, code = 1) => { io.stderr.write(`ch-local: ${s}\n`); return code; };
  const say = (s) => io.stderr.write(`ch-local: ${s}\n`);

  // Before anything is written: a signal now cleans up and exits; once the
  // runtime runs, each signal is forwarded to it once.
  let child = null;
  let runDir = null;
  let stopped = null;
  const forwarded = new Set();
  const untrap = io.trapSignals((signal) => {
    if (child != null) {
      if (!forwarded.has(signal)) { forwarded.add(signal); child.kill(signal); }
      return;
    }
    if (stopped != null) return;
    stopped = 128 + (SIGNALS[signal] || 15);
    if (runDir != null) fs.rmSync(runDir, {recursive: true, force: true});
    io.exit(stopped);
  });
  try {
    const checked = checkPassThrough(passThrough);
    if (checked.problem != null) return fail(checked.problem, 2);

    const where = layout(io.env, io.homedir);
    let record;
    try { record = readRecord(where); } catch (err) { return fail(err.message); }
    const packs = installedPacks(where, record);
    if (packs.length === 0) return fail('no pack is installed; run `ch-local install --pack <name>`');
    if (record.unreleased) say(UNRELEASED_LINE);

    // The GitHub token, asked only when an installed pack takes one: a
    // COUNTINGHOUSE_GITHUB_TOKEN set in the client's environment is the
    // user's explicit choice (often a narrow, read-only token) and is used
    // as is; otherwise gh's, held in memory; otherwise GITHUB_TOKEN from the
    // environment, the fallback for headless and CI use. A value from the
    // environment is plaintext in that client's config, and start says so.
    let env = io.env;
    const githubPacks = packs.filter((p) => p.credentials.some((v) => GITHUB_VARIABLES.includes(v)));
    if (githubPacks.length > 0) {
      const explicit = pickCredential(io.env, [GITHUB_VARIABLES[0]]);
      const gh = explicit == null ? await ghToken(io) : null;
      if (explicit != null) {
        say(`GitHub: using ${explicit.name} from the environment; if a client's config sets it, it is stored there in plaintext`);
      } else if (gh.token != null) {
        // under every GitHub variable, so a pack that takes either gets it
        env = {...io.env, ...Object.fromEntries(GITHUB_VARIABLES.map((v) => [v, gh.token]))};
        say('GitHub token from `gh auth token`, held in memory');
      } else {
        const plain = pickCredential(io.env, GITHUB_VARIABLES);
        if (plain != null) say(`GitHub: ${gh.why}; using ${plain.name} from the environment; if a client's config sets it, it is stored there in plaintext`);
        else say(`GitHub: ${gh.why}: run \`gh auth login\`, or for headless or CI use set ${GITHUB_VARIABLES[0]} in the client's environment (plaintext in that client's config)`);
      }
    }

    // settings (packs in place, part 2): a pack turned off is not loaded
    const settings = readSettings(where);
    const off = packs.filter((p) => valueOf(settings, `pack.${p.name}`) === false);
    for (const p of off) say(`not loading ${p.name}: it is turned off (\`ch-local settings set pack.${p.name} on\`)`);
    const {load, missing} = loadablePacks(packs.filter((p) => !off.includes(p)), env);
    for (const m of missing) {
      say(m.variables.every((v) => GITHUB_VARIABLES.includes(v))
        ? `not loading ${m.name}: it needs the GitHub token (above)`
        : `not loading ${m.name}: set ${m.variables.join(' or ')} in the environment your client starts from`);
    }
    if (load.length === 0) return fail('no installed pack has its credential; nothing to start');

    let declared;
    try {
      declared = load.flatMap((p) => declaredRemotes(p.base, p.packages));
    } catch (err) {
      return fail(`${err.message}; run \`ch-local install\` again`);
    }
    const {credentials, refused} = credentialUnion(declared, ALLOWED_ORIGINS);
    if (refused.length > 0) {
      for (const r of refused) {
        say(r.variable != null
          ? `${r.from} declares the variable ${r.variable} for ${r.origin}, which this launcher does not allow to receive it`
          : `${r.from} declares a remote at ${r.origin == null ? 'an unreadable URL, or a remote that is not an object' : r.origin}, which this launcher does not allow`);
      }
      return fail('refusing to start: a pack would send a credential somewhere not allowed');
    }
    const {chosen, childEnv} = chooseCredentials(credentials, env);

    const host = hostTag(io.hostname);
    runDir = path.join(where.run, `${host}-${io.pid}-${crypto.randomBytes(4).toString('hex')}`);
    const configDir = path.join(runDir, 'config');
    const remoteCredentials = path.join(runDir, 'remote-credentials.json');
    try {
      fs.mkdirSync(configDir, {recursive: true});
      writeAtomic(remoteCredentials, JSON.stringify(chosen, null, 2) + '\n');
      const defaultRepo = repoFromRemote(readOrigin(io.cwd));
      // The runtime reads <deviceConfigPath>/<package name>.json.
      if (defaultRepo != null) {
        for (const p of load) {
          const file = path.join(configDir, ...`${p.scenario}.json`.split('/'));
          fs.mkdirSync(path.dirname(file), {recursive: true});
          fs.writeFileSync(file, JSON.stringify({defaultRepo}) + '\n');
        }
      }
      sweepRuns(where.run, host, io.alive);
      // what this start's runtime loads, for collection (lib/gc.js): a tree a
      // live start names is never removed under it
      writeAtomic(path.join(runDir, 'run.json'), JSON.stringify({host, pid: io.pid, startedAt: Date.now(),
        loaded: Object.fromEntries(load.filter((p) => p.base !== where.app).map((p) => [p.name, path.basename(p.base)]))}) + '\n');
      if (stopped != null) return stopped;
      for (const p of load) say(`loading ${p.name}`);
      for (const [origin, [variable]] of Object.entries(chosen)) if (variable != null) say(`sends ${variable} to ${origin}`);
      const args = [
        path.join(where.app, 'node_modules', 'countinghouse', 'bin', 'countinghouse-stdio.js'),
        '--workerThread',
        '--store', 'local',
        '--storePath', where.store,
        ...(checked.sandbox || valueOf(settings, 'moduleSandbox') === 'audit' ? [] : ['--moduleSandbox', 'enforce']),
        '--modulePath', where.modules,
        '--moduleDataPath', where.moduleData,
        '--remoteCredentials', remoteCredentials,
        '--deviceConfigPath', configDir,
        ...load.flatMap((p) => ['--loadModule', p.dir]),
        // the settings the runtime takes at start, unless passed through
        ...settingArgs(settings, checked.options),
        // packs in place (part 2): the runtime's control channel; a runtime
        // older than the channel ignores the flag, and changes then need a
        // restart (lib/control.js)
        '--controlChannel', 'ipc',
        ...checked.options
      ];
      child = io.spawn(io.node, args, {env: childEnv, control: true});
      let watcher = null;
      if (typeof child.send === 'function' && typeof child.onMessage === 'function') {
        const loaded = new Map(load.map((p) => [p.name, {key: p.base === where.app ? 'flat' : path.basename(p.base), version: p.version}]));
        const applier = inPlace({where, io, runDir, configDir, env, childEnv, control: controlClient(child, {timeoutMs: io.controlTimeoutMs}), loaded, defaultRepo, say, host});
        watcher = watchFiles(where.home, ['packs.json', 'settings.json'], () => { applier.apply(); });
      }
      // the opt-in automatic upgrade check, at most daily (or weekly), in the
      // background: never in the way of the runtime
      autoCheck({where, io, say, host}).catch(() => {});
      try {
        return await child.exited;
      } finally {
        if (watcher != null) watcher.stop();
      }
    } finally {
      fs.rmSync(runDir, {recursive: true, force: true});
    }
  } finally {
    untrap();
  }
}

module.exports = {start, repoFromRemote, originUrl, readOrigin, checkPassThrough};
