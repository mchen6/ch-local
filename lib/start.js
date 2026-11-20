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
const {ghToken} = require('./github-token');
const moduleCredentials = require('./module-credentials');
const heldBack = require('./held-back');
const {allowedEnv, runtimeEnv} = require('./shim-config');
const {installedPacks, withdrawnNames, releaseOf, recordRelease, staleLine, installLine, runsFromHome} = require('./packs');
const {readModulesRecord: readRecord} = require('./module-record');
const {availability} = require('./availability');
const {moduleSeams} = require('./module-seams');
const {UNRELEASED_LINE} = require('./pins');

// The pass-through is an allowlist (reviewer, 2026-11-12): only options known
// safe, each with its accepted values. Anything else is refused by name.
const PASS_THROUGH = {
  // enforce where the installed runtime can run it (lib/sandbox-support.js)
  '--moduleSandbox': (v, platform, enforceOk) => (enforceOk ? v === 'enforce' || v === 'audit' : v === 'audit'),
  '--locale': (v) => /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(v)
};
const SIGNALS = {SIGINT: 2, SIGHUP: 1, SIGTERM: 15};
// A runtime older than countinghouse#195 refuses --moduleSandbox enforce on
// Windows: said here before anything starts, with what to do.
const WINDOWS_ENFORCE = '--moduleSandbox enforce needs a countinghouse that runs it on Windows (https://github.com/mchen6/countinghouse/issues/195), and the installed one is older: run `ch-local upgrade`, or use --moduleSandbox audit until then.';
// What audit does (the maintainer's decision): countinghouse lets a pack
// read, and logs it, but refuses its writes outside its own area. Said once
// whenever the runtime runs under audit.
const AUDIT_WATCHES = 'audit watches what a pack reads and never lets it change files outside its own area';
const AUDIT_LINE = `--moduleSandbox audit: ${AUDIT_WATCHES}`;
const WINDOWS_AUDIT = `the installed countinghouse cannot run --moduleSandbox enforce on Windows (it is older than countinghouse#195): running audit; ${AUDIT_WATCHES}; \`ch-local upgrade\` installs one that can`;
// Acceptance runs only (reviewer, 2026-11-12): CH_LOCAL_REMOTE_MAP, a comma
// list of <allowed origin>=<http://127.0.0.1:port | http://[::1]:port>, under
// CH_LOCAL_DEV=1, becomes the runtime's --remoteOriginMap: the pack's calls
// to that origin go to a local stand-in. Never from a client's options. The
// runtime honours it only with COUNTINGHOUSE_ACCEPTANCE=1 in its environment,
// which start passes through as it is and never sets. Under a map, only a
// credential that is an acceptance token (chacc_...) is sent (start, below).
// -> {problem} or {args, notes}.
function remoteMap(env) {
  const raw = env.CH_LOCAL_REMOTE_MAP;
  if (raw == null || raw === '') return {args: [], notes: []};
  if (env.CH_LOCAL_DEV !== '1') return {problem: 'CH_LOCAL_REMOTE_MAP needs CH_LOCAL_DEV=1: it is for acceptance runs only'};
  const args = [];
  const notes = [];
  for (const item of raw.split(',')) {
    const m = /^(https:\/\/[^=]+)=(.*)$/.exec(item.trim());
    if (m == null) return {problem: `CH_LOCAL_REMOTE_MAP ${JSON.stringify(item)} must be <origin>=<http://127.0.0.1:port>`};
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_ORIGINS, m[1])) return {problem: `CH_LOCAL_REMOTE_MAP: ${m[1]} is not an origin this launcher allows`};
    if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(m[2])) return {problem: `CH_LOCAL_REMOTE_MAP: the target must be http://127.0.0.1:<port> or http://[::1]:<port>, not ${m[2]}`};
    args.push('--remoteOriginMap', `${m[1]}=${m[2]}`);
    notes.push(`acceptance: ${m[1]} is sent to ${m[2]} (CH_LOCAL_REMOTE_MAP)`);
  }
  return {args, notes};
}

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
function checkPassThrough(passThrough, platform = process.platform, enforceOk = platform !== 'win32') {
  const options = [];
  for (let i = 0; i < passThrough.length; i++) {
    const a = passThrough[i];
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    const check = Object.prototype.hasOwnProperty.call(PASS_THROUGH, name) ? PASS_THROUGH[name] : null;
    if (check == null) return {problem: `${name} cannot be passed to ch-local start; only ${Object.keys(PASS_THROUGH).join(' and ')} can`};
    const value = eq === -1 ? passThrough[++i] : a.slice(eq + 1);
    if (value === undefined || !check(value, platform, enforceOk)) {
      if (name === '--moduleSandbox' && value === 'enforce' && !enforceOk) return {problem: WINDOWS_ENFORCE};
      return {problem: name === '--moduleSandbox'
        ? (!enforceOk
          ? `--moduleSandbox ${value || '(no value)'} is not allowed; with the installed countinghouse a pack runs under audit on Windows (countinghouse#195)`
          : `--moduleSandbox ${value || '(no value)'} is not allowed; a pack runs under enforce, or audit to diagnose`)
        : `${name} ${value === undefined ? '(no value)' : JSON.stringify(value)} is not allowed`};
    }
    options.push(...(eq === -1 ? [name, value] : [a]));
  }
  return {options, sandbox: options.includes('--moduleSandbox') || options.some((o) => o.startsWith('--moduleSandbox='))};
}

const {hostTag, HEARTBEAT_MS} = require('./run-liveness');
const {machineId} = require('./machine');
const {withLock} = require('./lock');
const {controlClient, teller} = require('./control');
const {conditionsService} = require('./client-conditions');
const {enforceAvailable} = require('./sandbox-support');
const {watchFiles} = require('./watch');
const {inPlace} = require('./in-place');
const {readSettings, valueOf, runtimeValue, withSettingsLock} = require('./settings');
const {ceilingFor, forbiddenBy, startUnderCeiling} = require('./ceiling');
const {reportOutsideEdits, outsideEdits} = require('./outside-edits');
const {autoCheck} = require('./auto-upgrade');

// Settings the runtime takes as options at start, unless the client passed
// the option itself (its pass-through wins).
//
// The two caps are passed always: the stored value, or ch-local's own
// default when nothing is stored, as the ceiling left them
// (startUnderCeiling). So the runtime's own default never governs under
// ch-local, and the two defaults drifting apart cannot leave a ceiling that
// bounds nothing (countinghouse #283: the runtime at 16 MiB, ch-local at
// 8 MiB, a ceiling between them).
function settingArgs(settings, passed) {
  const out = [];
  const given = (flag) => passed.some((o) => o === flag || o.startsWith(`${flag}=`));
  const add = (flag, name, {always = false} = {}) => {
    if (given(flag) || (!always && !Object.prototype.hasOwnProperty.call(settings.values, name))) return;
    // in the runtime's unit (runtimeValue): --locale en-US or zh-CN,
    // --requestTimeout in seconds
    out.push(flag, String(runtimeValue(name, valueOf(settings, name))));
  };
  add('--locale', 'locale');
  add('--maxOutputBytes', 'maxOutputBytes', {always: true});
  add('--requestTimeout', 'requestTimeout', {always: true});
  // the sandbox is decided once, in sandboxArgs
  return out;
}

// The sandbox option the runtime gets, decided in one place: one passed
// through wins (checked.sandbox: it is in the pass-through already);
// otherwise the setting (audit, or enforce by default), except audit where
// the installed runtime cannot run enforce (Windows before countinghouse#195).
function sandboxArgs(checked, settings, enforceOk) {
  if (checked.sandbox) return [];
  if (!enforceOk) return ['--moduleSandbox', 'audit'];
  return ['--moduleSandbox', valueOf(settings, 'moduleSandbox') === 'audit' ? 'audit' : 'enforce'];
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


// what the shared runtime tells ch-local daemon's table (countinghouse #255,
// #262 and the idle stop)
// the runtime's explicit refusals of a restore (countinghouse restore.js)
const RESTORE_REFUSALS = ['CONTROL_BAD_RESTORE', 'CONTROL_RESTORE_DONE'];
const TABLE_TELLS = ['session-resume', 'session-state', 'session-gone', 'decline', 'idle', 'busy', 'drained'];

// a stopped session runtime's SIGTERM, then SIGKILL after this
const SESSION_KILL_MS = 10000;

// The path options a session runtime is given, and its entry: the first one
// whose real path (its nearest existing ancestor's, for one not made yet)
// is not under the home's, or null. The one exception (C4c,
// lib/session-socket.js): --sessionSocket may instead be a named pipe of the
// daemon's form (Windows has no socket path), or exactly the long-home
// fallback's socket the daemon picks ($TMPDIR/ch-<uid>/sessions.sock).
const PATH_OPTIONS = ['--sessionSocket', '--sessionDir', '--storePath', '--modulePath', '--moduleDataPath', '--remoteCredentials', '--deviceConfigPath',
  '--loadModule', '--modulesRoot', '--partDir', '--settingsFile'];
function realOrAncestor(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch (e) { /* not there yet */ }
    const up = path.dirname(cur);
    if (up === cur) return cur;
    rest.push(path.basename(cur));
    cur = up;
  }
}
function pathsOutside(args, home, {env = process.env} = {}) {
  const root = realOrAncestor(home);
  const under = (p) => { const r = realOrAncestor(p); return r === root || r.startsWith(root + path.sep); };
  const {isPipeName, fallbackSocket} = require('./session-socket');
  const socketElsewhere = (p) => (process.platform === 'win32' ? isPipeName(p) : p === fallbackSocket({env}));
  if (!under(args[0])) return `entry ${args[0]}`;
  for (let i = 1; i < args.length - 1; i++) {
    if (args[i] === '--sessionSocket' && socketElsewhere(args[i + 1])) continue;
    if (PATH_OPTIONS.includes(args[i]) && !under(args[i + 1])) return `${args[i]} ${args[i + 1]}`;
  }
  return null;
}

// session: {socket, home, signal?, onListening?} runs the shared runtime for
// ch-local daemon (countinghouse #236): framework.js on --sessionSocket
// instead of --stdio. Its clients' own inputs (the client checks, the
// repository) come per session from the native shim, so this start reads
// none of its own. In this mode (the review of ch-local #32):
// - the home is session.home, never COUNTINGHOUSE_HOME or ~/.countinghouse;
// - the runtime's environment is shim.json's allowlist of io.env and, from
//   gh, COUNTINGHOUSE_GITHUB_TOKEN, nothing else;
// - only SIGINT and SIGTERM are trapped (the daemon ignores SIGHUP), and the
//   runtime runs in its own process group, so a terminal's hang-up never
//   reaches it;
// - session.signal's abort stops the runtime (SIGTERM), and the start ends
//   with its exit;
// - the runtime's {type: 'listening', socket} goes to session.onListening;
// - session.restore() is sent as the first control request, the table's
//   tells go to session.onTold, and session.onControl is handed a sender
//   for the daemon's own requests (C3a).
// home: the home `--home` named (absolute, real), over COUNTINGHOUSE_HOME
// ownRuntime: {reason?, why?} when the native shim handed this session over
// because it can't share the daemon's runtime (bin/ch-local.js)
async function start({passThrough, session = null, home = null, ownRuntime = null}, io) {
  const fail = (s, code = 1) => { io.stderr.write(`ch-local: ${s}\n`); return code; };
  const say = (s) => io.stderr.write(`ch-local: ${s}\n`);

  // Before anything is written: a signal now cleans up and exits; once the
  // runtime runs, each signal is forwarded to it once.
  let child = null;
  let runDir = null;
  let stopped = null;
  const forwarded = new Set();
  const untrap = io.trapSignals(...[(signal) => {
    if (child != null) {
      if (!forwarded.has(signal)) { forwarded.add(signal); child.kill(signal); }
      return;
    }
    if (stopped != null) return;
    stopped = 128 + (SIGNALS[signal] || 15);
    if (runDir != null) fs.rmSync(runDir, {recursive: true, force: true});
    io.exit(stopped);
  }, ...(session != null ? [['SIGINT', 'SIGTERM']] : [])]);
  try {
    // one platform for every decision of this start
    const platform = io.platform || process.platform;
    const where = layout(session != null ? {COUNTINGHOUSE_HOME: session.home} : home != null ? {...io.env, COUNTINGHOUSE_HOME: home} : io.env, io.homedir);
    // whether the installed runtime runs enforce here (Windows: from countinghouse#195)
    const enforceOk = enforceAvailable(where, platform);
    const checked = checkPassThrough(passThrough, platform, enforceOk);
    if (checked.problem != null) return fail(checked.problem, 2);
    const mapped = remoteMap(io.env);
    if (mapped.problem != null) return fail(mapped.problem, 2);

    // The run directory and its run.json come first, the record read and
    // run.json written under the home's lock, which collection holds: no tree
    // this start reads can be collected before run.json names it (the review
    // of ch-local #13). The lock is waited for; a wait given up on (another
    // host's lock, or one that can't be read, or a holder here that stopped
    // renewing it: lib/lock.js waitRemoteMs) fails the start, which never
    // goes on without the lock (the medium on post-rel packs.lock, 1).
    const host = hostTag(io.hostname);
    runDir = path.join(where.run, `${host}-${io.pid}-${crypto.randomBytes(4).toString('hex')}`);
    const runFile = path.join(runDir, 'run.json');
    // chLocal: this start's own ch-local, so status can name a running client
    // still on another one (#413 section 9.9); null for one not run from the
    // home (a checkout), as recordRelease takes it: never called stale
    let run = {host, machine: machineId(), pid: io.pid, childPid: null, startedAt: Date.now(), loaded: {},
      chLocal: io.selfVersion !== undefined ? io.selfVersion : (runsFromHome(where) ? require('../package.json').version : null)};
    const writeRunFile = () => writeAtomic(runFile, JSON.stringify(run) + '\n');
    let record;
    let recordProblem = null;
    let locked = false;
    await withLock(where, io, async () => {
      locked = true;
      try { record = readRecord(where); } catch (err) { recordProblem = err.message; return 1; }
      if (record == null) return 0;
      fs.mkdirSync(runDir, {recursive: true});
      // every installed module version (#413 section 9.8): none of what this
      // start may load is collected meanwhile (lib/gc.js collectStore)
      run.loaded = Object.assign({}, ...installedPacks(where, record, io).map((p) => p.modules));
      writeRunFile();
      return 0;
    }, {wait: true, signal: session != null ? session.signal : null});
    if (session != null && session.signal != null && session.signal.aborted) return fail('stopped before the shared runtime started');
    // (the held line said why)
    if (!locked) return fail('the home\'s lock could not be taken; nothing was started');
    if (recordProblem != null) return fail(recordProblem);
    const installed = installedPacks(where, record, io);
    // withdrawn packs (#413 section 9.7): one this release does not list, or
    // one the record's withdrawn list names (an upgrade's own pins wrote
    // it); never started, said once the client can be told (below); nothing
    // of them is removed
    if (installed.length === 0) return fail('no pack is installed; run `ch-local install --pack <name>`');
    const gone = withdrawnNames(record, installed, releaseOf(io));
    const withdrawn = installed.filter((p) => gone.has(p.name));
    const packs = installed.filter((p) => !withdrawn.includes(p));
    if (record.unreleased) say(UNRELEASED_LINE);

    // The runtime's environment, an allowlist either way: a session runtime
    // (the daemon's) gets the daemon's keys (lib/shim-config.js allowedEnv),
    // a runtime of its own those and the locale, the CA bundle and the
    // runtime's own switches (runtimeEnv), never the client's whole
    // environment. Every credential comes from the store, bound to its
    // module, in a slot of its own (#413 section 6.4; L5a:
    // lib/module-credentials.js forStart, below), never from a client's
    // environment (section 6.9; the Reviewer's high review of L5a, 1).
    const env = session != null ? allowedEnv(io.env, platform) : runtimeEnv(io.env, platform);

    // settings (packs in place, part 2): a pack turned off is not loaded
    // A settings file that is not valid stops the start: its defaults would
    // load a pack the user turned off and loosen a limit the user tightened
    // (the review of ch-local #13).
    // Part 3, section 5, never silent: what start says about the settings and
    // the operator's ceiling (an outside edit, a clamp, a refusal) goes on
    // stderr and, once the runtime is up, to the client as notices (the next
    // result of any tool, and notifications/message): the model relays them,
    // so stderr and the history stay the record it cannot edit.
    const notices = teller(say);
    const tell = notices.tell;
    const settings = readSettings(where);
    if (settings.error != null) return fail(`${settings.error}: not starting; fix it (\`ch-local settings reset\` replaces every setting with its default, asking first if that loosens one)`);
    if (settings.warning != null) say(settings.warning);
    // part 3, section 5: a setting changed outside the tools is said and
    // recorded (under the settings lock: a change under way is not one)
    // part 3, section 4: the operator's ceiling binds the values and flags
    // this start passes; one that cannot be trusted refuses a start that
    // loosens. An outside loosening it refuses (a pack turned on, say) is not
    // applied.
    const ceiling = ceilingFor(where, {platform, env: io.env});
    try {
      const edits = withSettingsLock(where, () => reportOutsideEdits(where, readSettings(where), {say: tell, host, pid: process.pid, refusal: forbiddenBy(ceiling)}));
      for (const e of edits) {
        if (e.refused == null) continue;
        if (valueOf({values: {}}, e.setting) === e.old) delete settings.values[e.setting]; else settings.values[e.setting] = e.old;
      }
    } catch (err) {
      // a lock held (by another writer, or kept fresh on purpose) never
      // turns the checks off: a loosening the history has not recorded is
      // not applied this start, the recorded value is
      const kept = [];
      for (const e of outsideEdits(where, settings)) {
        if (!e.loosened) continue;
        if (valueOf({values: {}}, e.setting) === e.old) delete settings.values[e.setting]; else settings.values[e.setting] = e.old;
        kept.push(e.setting);
      }
      tell(`could not compare the settings with their history (${err.code || err.message})${kept.length > 0 ? `: ${kept.join(', ')} not loosened this start` : ''}`);
    }
    const bounded = startUnderCeiling(settings, ceiling, {
      forcedAudit: !enforceOk,
      passedAudit: checked.options.some((o, i) => o === '--moduleSandbox=audit' || (o === '--moduleSandbox' && checked.options[i + 1] === 'audit'))
    });
    if (bounded.problem != null) return fail(bounded.problem);
    for (const note of bounded.notes) tell(note);
    let auditSaid = false;
    if (!enforceOk && !checked.sandbox && valueOf(settings, 'moduleSandbox') !== 'audit') { tell(WINDOWS_AUDIT); auditSaid = true; }
    settings.values = bounded.values;
    // What loads, by module (#413 section 5.2; L2a): each available top-level
    // module, once, with the closure it needs; every unavailable one said
    // once, with its reason. On/off, the ceiling and the credential stay
    // today's, behind the seams L2b replaces (by the pack whose scenario the
    // module is: pack.<p>, the ceiling's packs, the release's version 1
    // credentials).
    // each installed module's credential, from the store (section 6.7): its
    // state is availability's rule 5, and a usable one gets its slot
    // the modules whose "sends" line was said (the applier says one loaded later)
    const sendsSaid = new Set();
    const decls = moduleCredentials.declarations(where, record);
    // a key read from GitHub's earlier name, said once a start; never
    // rewritten here (the Reviewer's cut on #98's round 3)
    const read = moduleCredentials.bindings(where, record, {platform, decls});
    for (const line of moduleCredentials.carriedLines(read)) tell(line);
    const creds = await moduleCredentials.forStart(where, record, {env, ghToken: () => ghToken(io, where.home), platform, acceptanceMap: mapped.args.length > 0, decls, read});
    // #413 section 10: a GitHub token a client's configuration still sets is
    // not moved and not read; said once per start (a session runtime never
    // sees a client's environment)
    const oldToken = session == null && io.env != null ? io.env.COUNTINGHOUSE_GITHUB_TOKEN : null;
    if (typeof oldToken === 'string' && oldToken.trim() !== '') {
      const gh = [...creds.decls].find(([, d]) => d.problem == null && d.origin === moduleCredentials.GH_ORIGIN);
      tell(`COUNTINGHOUSE_GITHUB_TOKEN in this client's environment is no longer read: run \`ch-local credentials add ${gh != null ? gh[0].replace(/^@[^/]+\//, '') : '<module>'}\``);
    }
    // a record of another release (a ch-local older than the record: a
    // daemon or binary still running from before an upgrade) is judged by
    // none of this start's pins, as the applier judges it (section 9.8; the
    // high review of L2a, 3)
    // whose record this is: one rule with the applier (lib/packs.js
    // recordRelease); each case said once, the applier never repeating it
    const whose = recordRelease(record, io, where);
    if (whose.state === 'stale') tell(staleLine(whose.installed, whose.how));
    if (whose.state === 'other') tell(installLine(whose.ours));
    const av = availability(where, record, {release: releaseOf(io), pins: whose.state !== 'stale', seams: Object.assign(moduleSeams({settings, ceiling, record}), {credential: moduleCredentials.credentialSeam(creds.states)})});
    // one turned off is the user's own doing: said here, never told
    for (const u of av.unavailable.values()) if (u.kind === 'off') say(u.line); else tell(u.line);
    // the modules held back, and why, for the runtime's overview: a private
    // file it reads at start, and again on the applier's reread
    // (lib/held-back.js; A-firstrun d1). Written whatever the record; under
    // another release's record (stale) it is judged as start judged it, and
    // the applier, which judges nothing new then, leaves it. If it can't be
    // written, no flag is passed and the overview has no reasons to give.
    const heldText = heldBack.contentOf(where, av);
    let heldBackFile = null;
    try { heldBackFile = heldBack.write(runDir, heldText); } catch (e) { say(`the overview will not say which modules are held back this start (${e.code || e.message})`); }
    // the withdrawn modules this start has told about (the applier's own
    // unload never repeats one)
    const withdrawnTold = new Set([...av.unavailable].filter(([, u]) => u.withdrawn).map(([m]) => m));
    let load = av.units;
    // a session the shim handed over: told why it runs its own runtime, in
    // its first result's notice (#236 section 5), never a credential's value
    if (ownRuntime != null) {
      // (token and credential: no longer produced by this ch-local's
      // conditions check, #413 section 6.9; still read from an older shim)
      if (ownRuntime.reason === 'token') tell('this session chooses a GitHub token the shared runtime doesn\'t hold, so it runs its own runtime');
      else if (ownRuntime.reason === 'credential') tell('a pack credential in this session\'s environment isn\'t the shared runtime\'s, so it runs its own runtime');
      else if (ownRuntime.reason === 'conditions-failed') tell(`the client checks could not run${ownRuntime.why ? ` (${ownRuntime.why})` : ''}, so this session runs its own runtime`);
      // a reason the shim passed that this ch-local doesn't know; with none
      // (an older shim, or the startup and failed.json fallbacks, where no
      // shared runtime refused anything) nothing is told
      else if (ownRuntime.reason != null) tell(`this session can't share the runtime${ownRuntime.reason !== 'unknown' ? ` (${ownRuntime.reason})` : ''}, so it runs its own`);
    }
    // (a module whose files are not all placed is not available: its reason
    // was said above, and the healthy ones load)
    if (load.length === 0) tell('no module is loaded this start; only ch-local\'s own tools (settings, the usage report) are served');

    // the runtime's environment, every inherited COUNTINGHOUSE_CREDENTIAL_*
    // removed and each usable binding's slot added; its --remoteCredentials,
    // version 2: per module, origin and variable, the slot (section 6.4).
    // Under an acceptance run's map only an acceptance token has a slot
    // (forStart): a real key never reaches whatever listens on the mapped port.
    const childEnv = creds.env;
    const chosen = creds.file;

    const configDir = path.join(runDir, 'config');
    const remoteCredentials = path.join(runDir, 'remote-credentials.json');
    try {
      fs.mkdirSync(configDir, {recursive: true});
      writeAtomic(remoteCredentials, JSON.stringify(chosen, null, 2) + '\n');
      // (no device config: the scenario's defaultRepo is its own setting since
      // #413 rev 3's P1 and P3; --deviceConfigPath names this empty
      // directory, so the runtime reads none from anywhere else)
      sweepRuns(where.run, host, io.alive);
      // what this start's runtime loads, for collection (lib/gc.js): a
      // version a live start names is never removed under it. Every installed
      // version was named under the home's lock above, so none of these can
      // have been collected since
      run = {...run, loaded: Object.assign({}, ...load.map((p) => p.modules)), stopped: {}};
      writeRunFile();
      if (stopped != null) return stopped;
      for (const p of load) say(`loading ${p.short}`);
      // (only for a module this start loads: a slot given for one turned on
      // later is said when it loads; the Reviewer's high review of L5a, 6)
      const loading = new Set(load.flatMap((p) => Object.keys(p.modules)));
      for (const [m, id] of creds.identities) {
        if (loading.has(m)) sendsSaid.add(m);
        if (loading.has(m)) say(`sends ${id.variable} to ${id.origin} for ${m.replace(/^@[^/]+\//, '')}${id.source === 'gh' ? ' (your gh login\'s token, held in memory)' : ''}`);
      }
      for (const note of mapped.notes) say(note);
      const args = [
        ...(session != null
          // --sessionDir (countinghouse C2): the secret's directory, which a
          // Windows pipe has none of, and the long-home fallback's apart from it
          ? [path.join(where.app, 'node_modules', 'countinghouse', 'framework.js'), '--sessionSocket', session.socket,
            ...(session.sessionDir != null ? ['--sessionDir', session.sessionDir] : [])]
          : [path.join(where.app, 'node_modules', 'countinghouse', 'bin', 'countinghouse-stdio.js')]),
        '--workerThread',
        '--store', 'local',
        '--storePath', where.store,
        ...sandboxArgs(checked, settings, enforceOk),
        '--modulePath', where.modules,
        '--moduleDataPath', where.moduleData,
        '--remoteCredentials', remoteCredentials,
        '--deviceConfigPath', configDir,
        ...load.flatMap((p) => ['--loadModule', p.dir]),
        // each part one of them needs, by its store directory (#413 section
        // 9.8): the runtime looks for a part among these only
        ...[...new Set(load.flatMap((p) => p.packages.filter((m) => m !== p.scenario).map((m) => p.dirs[m])))].flatMap((d) => ['--partDir', d]),
        // the settings the runtime takes at start, unless passed through
        ...settingArgs(settings, checked.options),
        // packs in place (part 2): the runtime's control channel; a runtime
        // older than the channel ignores the flag, and changes then need a
        // restart (lib/control.js)
        '--controlChannel', 'ipc',
        // where every module the start and the channel load lies (#413
        // section 7.2): the runtime refuses a directory whose real path is
        // outside it, or that has a link leading out
        '--modulesRoot', where.moduleStore,
        // the file countinghouse_settings changes, by the protocol in
        // docs/development/settings.md; an older runtime ignores the flag
        '--settingsFile', where.settings,
        // what this start held back (lib/held-back.js); an older runtime
        // ignores the flag
        ...(heldBackFile != null ? ['--heldBackFile', heldBackFile] : []),
        // acceptance runs only: the stand-in's origin map (CH_LOCAL_REMOTE_MAP)
        ...mapped.args,
        ...checked.options
      ];
      // under audit, however it came to be: what audit does, once
      const underAudit = args.some((a, k) => a === '--moduleSandbox=audit' || (a === '--moduleSandbox' && args[k + 1] === 'audit'));
      if (underAudit && !auditSaid) tell(AUDIT_LINE);
      // the client's conditions for a dialog, scanned at this start (a hook
      // seen now holds for the whole start)
      // (in the background: the client's ancestry takes seconds on Windows)
      const conditionArgs = {home: typeof io.homedir === 'function' ? io.homedir() : io.homedir, cwd: io.cwd, env: io.env, platform};
      // a session runtime's conditions are each session's (the shim's
      // `conditions` child); this start has no one client to scan
      const conditions = session != null
        ? {check: async() => ({mayElicit: false, why: 'a shared runtime asks each session'})}
        : conditionsService(conditionArgs, io.clientAncestry !== undefined ? {ancestry: io.clientAncestry} : {});
      // a session runtime (ch-local daemon, from the shim's shim.json), or
      // the shim's own-runtime hand-over (--home): every path it is given
      // must resolve under the home, so a link or a config can't point the
      // runtime elsewhere
      if (session != null || home != null) {
        const outside = pathsOutside(args, where.home, {env: io.env});
        if (outside != null) return fail(`the shared runtime's ${outside} resolves outside the home; nothing was started`);
      }
      if (session != null && session.signal != null && session.signal.aborted) return fail('stopped before the shared runtime started');
      child = io.spawn(io.node, args, {env: childEnv, control: true, ...(session != null ? {detached: true} : {})});
      // stopped: SIGTERM, then SIGKILL after the bound, for a runtime that
      // is hung and ignores SIGTERM
      if (session != null && session.signal != null) {
        session.signal.addEventListener('abort', () => {
          child.kill('SIGTERM');
          const t = setTimeout(() => child.kill('SIGKILL'), Number.isInteger(io.sessionKillMs) ? io.sessionKillMs : SESSION_KILL_MS);
          if (typeof t.unref === 'function') t.unref();
          child.exited.then(() => clearTimeout(t), () => clearTimeout(t));
        }, {once: true});
      }
      // the runtime's pid too: collection keeps this start's trees while
      // either lives; and a heartbeat, for a start on another machine
      if (Number.isInteger(child.pid)) { run = {...run, childPid: child.pid}; writeRunFile(); }
      const heartbeat = setInterval(() => { try { const t = new Date(); fs.utimesSync(runFile, t, t); } catch (err) { /* ending */ } }, HEARTBEAT_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
      let watcher = null;
      let credentialsWatcher = null;
      if (typeof child.send === 'function' && typeof child.onMessage === 'function') {
        const loaded = new Map(load.map((p) => [p.name, {version: p.version, scenario: p.scenario, modules: p.modules}]));
        const control = controlClient(child, {timeoutMs: io.controlTimeoutMs, readyMs: io.controlReadyMs});
        if (session != null && typeof session.onListening === 'function') {
          control.onTold('listening', (m) => session.onListening({type: 'listening', socket: m.socket}));
        }
        // the daemon's table (C3a): its restore is the first request, sent
        // as soon as the channel is ready; the table's tells go to it; and the
        // daemon gets a sender for its own requests (the idle stop)
        // a runtime that ends settles its pending requests at once
        child.exited.then(() => control.close(), () => control.close());
        if (session != null) {
          if (typeof session.onTold === 'function') {
            for (const type of TABLE_TELLS) control.onTold(type, (m) => session.onTold(m));
          }
          if (typeof session.restore === 'function') {
            control.request(session.restore()).then((reply) => {
              if (reply == null || reply.ok !== true) {
                say(`the shared runtime did not take the session table (${reply != null ? reply.code : 'no answer'})`);
                // only the runtime's own refusal: no answer, or a runtime that
                // ended (CONTROL_GONE), says nothing about the table
                if (reply != null && RESTORE_REFUSALS.includes(reply.code) && typeof session.onRestoreRefused === 'function') session.onRestoreRefused();
              }
            });
          }
          if (typeof session.onControl === 'function') session.onControl((msg) => control.request(msg));
        }
        notices.attach(control);
        // may the client be asked to confirm a loosening in a dialog
        // (countinghouse part 3 P2, Task 4)? Scanned now, latching a hook
        // seen for this whole start, and again on every request.
        control.onRequest('may-elicit', async (m) => {
          const client = m.client != null && typeof m.client.name === 'string' ? {name: m.client.name, version: String(m.client.version)} : null;
          return conditions.check(client);
        });
        const applier = inPlace({where, io, runDir, identities: creds.identities, credentialStates: creds.states, credentialSeen: creds.seen, credentialDecls: creds.decls, sendsSaid, control, loaded, say, host, withdrawnTold,
          tell, told: notices.told, settings, passed: checked.options, runtimeVersions: record.runtime.versions, record,
          // the held-back file's text start wrote (null: none was written)
          heldBack: heldBackFile != null ? heldText : null});
        // a module the runtime stopped for good (#413 section 7.3)
        control.onTold('module-stopped', (m) => { applier.moduleStopped(m).catch(() => {}); });
        watcher = watchFiles(where.home, ['modules.json', 'settings.json'], () => { applier.apply(); });
        // and the credential store (#413 section 6.4): a removed or changed
        // key unloads its module at once; a new one is said
        credentialsWatcher = watchFiles(path.join(where.home, 'credentials'), ['credentials.json'], () => { applier.apply(); });
        // a change made between reading the home and watching it
        applier.apply();
      }
      // the opt-in automatic upgrade check, at most daily (or weekly), in the
      // background: never in the way of the runtime, and abandoned when start
      // ends (a registry that never answers cannot keep start alive)
      const checking = new AbortController();
      autoCheck({where, io, say, host, signal: checking.signal}).catch(() => {});
      try {
        return await child.exited;
      } finally {
        clearInterval(heartbeat);
        checking.abort();
        if (watcher != null) watcher.stop();
        if (credentialsWatcher != null) credentialsWatcher.stop();
      }
    } finally {
      fs.rmSync(runDir, {recursive: true, force: true});
    }
  } finally {
    untrap();
    if (runDir != null) fs.rmSync(runDir, {recursive: true, force: true});
  }
}

module.exports = {start, repoFromRemote, originUrl, readOrigin, checkPassThrough};
