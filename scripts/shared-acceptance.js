#!/usr/bin/env node
'use strict';
// The shared runtime through the native shim, end to end (MCP completeness
// M17, countinghouse's spec section 10; the reviewer's plan, 2026-11-16). It
// builds every package as scripts/acceptance.js does, installs pack 1 into a
// clean home, builds the native shim from this checkout and installs it at
// <home>/shim/ch-shim, then runs the shim as a client's MCP server would be
// run, under a parent named `claude` with the tested client's session
// variables and an empty configuration of its own, in a repository under the
// system's temporary directory (never the run's TMPDIR, which may sit in a
// home whose .claude the conditions would read as a project's: the run
// refuses to start with any .claude above the repository), so its conditions
// are "yes" and it attaches to the daemon it starts. Then, over the shim's
// stdio:
//   - initialize, and that the session really attached: daemon.json names a
//     live daemon outside the client's process tree, and nothing in that tree
//     is a per-session runtime (`start --stdio --own-runtime`), so the
//     fallback can never pass for the shared path;
//   - (b) settings through the shim: a loosening, with no tested client on
//     countinghouse's list yet, refused with the terminal command; a
//     tightening applied to this session;
//   - (d) a paged list (countinghouse M1): one page with no nextCursor, a
//     cursor the client sends carried and answered, a bad one -32602.
// On win32 the shared runtime's socket is a named pipe, a new one at each
// start (C4c): the run checks that daemon.json names a live daemon and its
// pipe, and no per-session runtime in the client's tree; (b) and (d) run as
// elsewhere.
//
// Not yet here, and where each is covered meanwhile (the reviewer's ruling):
//   - (a) progress frames before an answer and (c) a cancelled call: they
//     need a pack whose calls hop, and none can reach the shared runtime in
//     an acceptance run (pack 1's credential comes only from gh there, and a
//     test pack would need the shipped allowlist). They join once per-session
//     packs (B3/B5) bring a sanctioned path. Covered in pieces: countinghouse's
//     session-runtime 01 and mcp-contract 11 and 19 over the session
//     transport, and the shim relay's unit tests (progress frames written as
//     they arrive; the `cancelled` op).
//   - (b1) the confirmation form round trip, once a tested Claude Code range
//     is in countinghouse's lib/elicitation-clients.json (the maintainer's
//     hand test before release): until then no client gets a form.
//   - (b2) ctx.ask through the shim, once M13 is on countinghouse's master.
//
// Every child has a hard timeout, and the run's end stops the shim's tree and
// the daemon (which outlives the shim by design), awaiting the daemon's exit
// by its pid, before the work directory is removed: whether the run passed,
// failed, threw or was interrupted.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const dogfood = require('./dogfood');
const fixtures = require('../lib/client-conditions-fixtures');
const {launcherEnv, stopTree, endTree, trapSignals, outboundOf, traceCommand, canTrace, onCi, TRACE_SKIPPED} = require('./acceptance');
// The debugging aid that starts the daemon here, untraced, for its log
// (CH_SHARED_ACCEPTANCE_DAEMON_LOG=1, POSIX): a second way to leave the
// daemon out of the no-outbound-connection check, so a local one only, as
// CH_ACCEPTANCE_NO_TRACE is: refused on CI, and with it the trace's checks
// are listed as skipped, never a pass -> {on} | {on: false, problem}
const DAEMON_LOG_SKIPPED = 'not checked: daemon started untraced for its log (CH_SHARED_ACCEPTANCE_DAEMON_LOG=1)';
// The shared path's trace, once strace has ended (its last tracee, the
// daemon, exited) -> the checks to record, [{name, ok, detail}]: none whole
// (strace had to be stopped) fails; the socket reached is asked only of a run
// that attached (sessionSocket read), so an earlier failure is not said twice
const TRACE_SAW = 'the trace saw a connection to the shared runtime\'s socket (strace, the shim, the daemon and the runtime followed)';
const TRACE_NONE_LEFT = 'no connection of the shim, the daemon or the shared runtime left the machine (strace, every process)';
// (text null: no trace file, which fails as one not whole does; a failure's
// detail shows the trace's first connects, as CI keeps no file)
// whether a process is being traced (Linux: its TracerPid) -> true, false,
// or null when it can't be read
function traced_(pid) {
  try { const m = /^TracerPid:\s*(\d+)$/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); return m != null ? m[1] !== '0' : null; } catch (e) { return null; }
}
function traceVerdict({text, whole, sessionSocket, daemon = null}) {
  // (the daemon that served: traced, and the same one to the end -- one an
  // untraced shim started again would go unseen)
  if (daemon != null && daemon.problem != null) return [{name: TRACE_NONE_LEFT, ok: false, detail: daemon.problem}];
  if (!whole) return [{name: TRACE_NONE_LEFT, ok: false, detail: 'the trace is not whole: strace did not end with the daemon, and was stopped'}];
  if (text == null) return [{name: TRACE_NONE_LEFT, ok: false, detail: 'the trace is missing: strace wrote no file'}];
  const seen = outboundOf(text);
  const connects = String(text).split('\n').filter((l) => /\bconnect\(/.test(l));
  const shown = `${connects.length} connects${connects.length > 0 ? `:\n${connects.slice(0, 20).map((l) => l.slice(0, 200)).join('\n')}` : ''}`;
  const out = [];
  if (typeof sessionSocket === 'string') {
    out.push({name: TRACE_SAW, ok: text.includes(`sun_path="${sessionSocket}"`), detail: `socket ${JSON.stringify(sessionSocket)}; ${shown}`});
  }
  out.push({name: TRACE_NONE_LEFT, ok: seen.away.length === 0, detail: `${seen.away.join(', ')}; ${shown}`});
  return out;
}
function daemonLogMode(env, platform) {
  if (env.CH_SHARED_ACCEPTANCE_DAEMON_LOG !== '1' || platform === 'win32') return {on: false};
  if (onCi(env)) return {on: false, problem: 'CH_SHARED_ACCEPTANCE_DAEMON_LOG=1 is refused on CI: it starts the daemon untraced, leaving it out of the no-outbound-connection check'};
  return {on: true};
}

const ROOT = path.resolve(__dirname, '..');
const SHIM_BUILD_MS = 20 * 60 * 1000;
const STEP_MS = 120000;
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {elicitation: {}},
  'io.modelcontextprotocol/clientInfo': {name: 'claude-code', version: '2.1.323'}};

// One MCP session over a child's stdio: newline-delimited JSON-RPC.
// Every message it writes is kept, in order, in `log` (progress frames and
// answers alike: (a) reads which came first, (c) whether an id was answered).
function session(child) {
  let buf = '';
  const waiting = new Map();
  const log = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) !== -1;) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === '') continue;
      let msg;
      try { msg = JSON.parse(line); } catch (err) { continue; }
      log.push(msg);
      if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  let id = 0;
  return {
    log,
    // the id the next request() gets
    nextId: () => id + 1,
    request: (method, params, ms = STEP_MS) => new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} in ${ms} ms`)), ms);
      waiting.set(n, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id: n, method, params})}\n`);
    }),
    notify: (method, params) => child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', method, params})}\n`)
  };
}

// The native shim, built from this checkout -> {file} | {problem}
function buildShim({timeoutMs = SHIM_BUILD_MS} = {}) {
  const dir = path.join(ROOT, 'shim');
  const r = spawnSync('cargo', ['build', '--release', '--locked'], {cwd: dir, encoding: 'utf8', timeout: timeoutMs});
  if (r.error != null) return {problem: `cargo could not run: ${r.error.message}`};
  if (r.status !== 0) return {problem: `cargo build failed (${r.status}): ${String(r.stderr).split('\n').slice(-20).join('\n')}`};
  const file = path.join(dir, 'target', 'release', process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');
  return fs.existsSync(file) ? {file} : {problem: `no binary at ${file}`};
}

// Puts the shim where install does: <home>/shim, a private directory (0700),
// the binary this user's and executable only by its owner.
function installShim(home, file) {
  const dir = path.join(home, 'shim');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  // on Windows its DACL: protected, this user and SYSTEM only, which the
  // shim copied in takes (lib/win-acl.js, as ch-local's own secrets' are)
  else require('../lib/win-acl').makePrivateDirs([dir], [dir]);
  const to = path.join(dir, process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');
  fs.copyFileSync(file, to);
  if (process.platform !== 'win32') fs.chmodSync(to, 0o700);
  return to;
}

// Where the simulated client's repository goes: never below the run's
// working directory, which follows TMPDIR and may sit in a home whose
// .claude holds the person's own settings. The client's conditions read
// every .claude above its project as a project's (lib/client-conditions.js),
// so a run under such a home read the person's plugins and answered "no",
// and (b) read as a declined session (M17, 2026-11-16). The repository is a
// few bytes: the system's own temporary directory on POSIX (/tmp), the
// runner's on CI (RUNNER_TEMP).
function clientRepoRoot(env = process.env, platform = process.platform) {
  if (typeof env.RUNNER_TEMP === 'string' && path.isAbsolute(env.RUNNER_TEMP)) return env.RUNNER_TEMP;
  return platform === 'win32' ? os.tmpdir() : '/tmp';
}

const realOr = (p) => { try { return fs.realpathSync(p); } catch (e) { return path.resolve(p); } };

// Every .claude directory at or above `dir` other than the client's own
// configuration directory: what the client's conditions would read as a
// project's settings. A run must have none.
function strayClaudeDirs(dir, configDir) {
  const out = [];
  const own = realOr(configDir);
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const c = path.join(d, '.claude');
    if (fs.existsSync(c) && realOr(c) !== own) out.push(c);
    if (path.dirname(d) === d) return out;
  }
}

// The client's configuration directory must be its own: an absolute path to
// an existing, empty directory, never unset or "" (which a client may read as
// its default, the person's). -> null, or what is wrong.
function configProblem(config) {
  if (typeof config !== 'string' || config === '' || !path.isAbsolute(config)) return `not an absolute path: ${JSON.stringify(config)}`;
  let st;
  try { st = fs.statSync(config); } catch (e) { return `${config}: ${e.code || e.message}`; }
  if (!st.isDirectory()) return `${config}: not a directory`;
  if (fs.readdirSync(config).length !== 0) return `${config}: not empty`;
  return null;
}

// The tested client's shape, in the run's own directory and nowhere else:
// a `claude` link to node, which runs a script that spawns the shim with the
// client's stdio. The shim's conditions read its parent's command line.
function claudeHarness(dir) {
  fs.mkdirSync(dir, {recursive: true});
  const claude = path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  // a link where the platform has them (its name is what the conditions
  // read); a copy on Windows
  if (process.platform === 'win32') fs.copyFileSync(process.execPath, claude);
  else fs.symlinkSync(process.execPath, claude);
  const script = path.join(dir, 'client.js');
  fs.writeFileSync(script, [
    "'use strict';",
    "const {spawn} = require('node:child_process');",
    'const [shim, home] = process.argv.slice(2);',
    // the home is passed bare: a flag on this, the client's own command line,
    // is one the client's conditions don't know, and so a "no"
    "const child = spawn(shim, ['--home', home], {stdio: 'inherit'});",
    "for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => child.kill(sig));",
    "child.on('exit', (code, signal) => process.exit(code != null ? code : 1));",
    ''].join('\n'));
  const config = path.join(dir, 'claude-config');
  fs.mkdirSync(config, {recursive: true});
  return {claude, script, config};
}

// daemon.json's pid, or null
function daemonPid(home) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(home, 'run', 'daemon', 'daemon.json'), 'utf8'));
    return Number.isInteger(d.pid) ? d.pid : null;
  } catch (e) {
    return null;
  }
}
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};
// Stops the daemon (SIGTERM, then SIGKILL after ms) and awaits its end.
async function stopDaemon(home, ms = 10000) {
  const pid = daemonPid(home);
  if (pid == null || !alive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return; }
  for (const until = Date.now() + ms; Date.now() < until && alive(pid);) await new Promise((r) => setTimeout(r, 100));
  if (alive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ }
    for (const until = Date.now() + 5000; Date.now() < until && alive(pid);) await new Promise((r) => setTimeout(r, 100));
  }
}
// A failed run explains itself (#54): the shim discards its daemon's output,
// so with no live daemon one is started exactly as the shim would start it
// (shim.json's node, ch-local and environment, the home its working
// directory), for at most ms, and what it said is returned. At the bound
// its tree is ended (POSIX: its process group; Windows: taskkill /T), and
// whatever happens the answer comes within a few seconds more.
function daemonDiagnosis(home, ms = 10000) {
  let sj;
  try { sj = JSON.parse(fs.readFileSync(path.join(home, 'shim.json'), 'utf8')); } catch (e) { return Promise.resolve(`no shim.json: ${e.message}`); }
  return new Promise((resolve) => {
    let out = '';
    let ended = false;
    const add = (b) => { out = (out + b).slice(-20000); };
    let d;
    try {
      d = spawn(sj.node, [sj.chLocal, 'daemon', '--home', home], {cwd: home, env: sj.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true});
    } catch (e) {
      return resolve(`the daemon could not be started: ${e.message}`);
    }
    d.stdout.on('data', add);
    d.stderr.on('data', add);
    let answered = false;
    const answer = (text) => { if (!answered) { answered = true; resolve(text); } };
    const timer = setTimeout(() => {
      ended = true;
      if (process.platform === 'win32') endTree(d.pid);
      else { try { process.kill(-d.pid, 'SIGTERM'); } catch (e) { /* gone */ } }
      // never left waiting: past 3 s more, killed directly, its pipes let go
      setTimeout(() => {
        if (process.platform !== 'win32') { try { process.kill(-d.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
        try { d.kill('SIGKILL'); } catch (e) { /* gone */ }
        d.stdout.destroy();
        d.stderr.destroy();
        answer(`${out}\n(still running after ${ms} ms; ended)`);
      }, 3000).unref();
    }, ms);
    d.on('error', (e) => { clearTimeout(timer); answer(`${out}\n(the daemon could not be started: ${e.message})`); });
    d.on('close', (code, signal) => {
      clearTimeout(timer);
      answer(`${out}\n(${ended ? `still running after ${ms} ms; ended` : `exit ${code}${signal != null ? ` ${signal}` : ''}`})`);
    });
  });
}
// every process: {pid, ppid, args}; null when they can't be read. POSIX: ps.
// Windows: WMI (Win32_Process), as client-conditions reads a client's
// ancestry: no cmdlet, PowerShell by its path, within the same 30 s (a cold
// start on the runner takes seconds); a command line as base64, '-' unread
const PROCESSES_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[void][System.Reflection.Assembly]::LoadWithPartialName('System.Management')",
  "$s=[System.Management.ManagementObjectSearcher]::new('SELECT ProcessId,ParentProcessId,CommandLine FROM Win32_Process')",
  "foreach($o in $s.Get()){$c=[string]$o['CommandLine']; if($c -eq ''){$c='-'}else{$c=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($c))}; [Console]::Out.WriteLine([string]$o['ProcessId']+' '+[string]$o['ParentProcessId']+' '+$c)}"
].join(';');
function processes(platform = process.platform) {
  if (platform === 'win32') {
    const winAcl = require('../lib/win-acl');
    let out;
    try {
      const root = winAcl.windowsDir();
      out = require('node:child_process').execFileSync(winAcl.powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROCESSES_SCRIPT],
        {cwd: path.win32.join(root, 'System32'), env: {SystemRoot: root, windir: root}, timeout: 30000, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024});
    } catch (e) {
      return null;
    }
    return String(out).split(/\r?\n/).map((l) => l.trim().match(/^(\d+) (\d+) (\S+)$/)).filter(Boolean)
      .map((m) => ({pid: Number(m[1]), ppid: Number(m[2]), args: m[3] === '-' ? '' : Buffer.from(m[3], 'base64').toString('utf8')}));
  }
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], {encoding: 'utf8', timeout: 10000});
  if (r.status !== 0) return null;
  return String(r.stdout).split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({pid: Number(m[1]), ppid: Number(m[2]), args: m[3]}));
}
// The command lines of `root` and every descendant: {pid, ppid, args}.
function treeOf(root) {
  const rows = processes();
  if (rows == null) return null;
  const inTree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (inTree.has(row.ppid) && !inTree.has(row.pid)) { inTree.add(row.pid); grew = true; }
  }
  return rows.filter((row) => inTree.has(row.pid));
}

// A terminal command as a refusal names it since countinghouse #536: the
// launcher of this run's own home (its real path), never a bare `ch-local`,
// which is on no PATH; as it reads in JSON.stringify'd content, where its
// quotes (and a Windows path's backslashes) are escaped.
const terminalInJson = (launcher, args) => JSON.stringify(`node "${launcher}" ${args}`).slice(1, -1);

// (b-latched), the countinghouse #337 and #545 contract: a session whose
// client's conditions latched "no" is, while no client is on the tested list,
// refused a loosening word for word as any session is, never as the user's
// decline; that it is latched, and the other is not, is in each session's own
// history; the conditions handed over say why; a tightening still applies to
// it; and another session's settings are its own. (With a client on the list
// the latch has a refusal of its own again: the (b1) todo.)
// second, first: each session's tools/call of countinghouse_settings; why:
// the conditions line's `why` ({reason, at?}) for the second client; reason:
// the fixture's own expected reason. -> nothing; each finding via check().
const LOCKED = 'not confirmed (locked in this session)';
async function latchedChecks({second, first, why, reason, launcher, check}) {
  check('(b-latched) the conditions handed over for the second client say no, with the fixture\'s reason', why != null && why.reason === reason, JSON.stringify(why));
  const ask = {action: 'set', name: 'requestTimeout', value: '60s'};
  const loosen = await second(ask);
  const answer = (r) => (r.result == null ? null : {isError: r.result.isError, code: r.result._meta != null ? r.result._meta['countinghouse/code'] : null, content: r.result.content, structuredContent: r.result.structuredContent});
  const a = answer(loosen);
  check('(b-latched) a loosening is refused with the terminal command; never as a decline',
    a != null && a.isError === true && a.code === 'SETTING_NEEDS_CONFIRMATION' && JSON.stringify(a.content).includes(terminalInJson(launcher, 'settings set requestTimeout 60s')),
    JSON.stringify(loosen).slice(0, 1000));
  const unlatched = await first(ask);
  check('(b-latched) word for word as the first session\'s, which is not latched', a != null && JSON.stringify(a) === JSON.stringify(answer(unlatched)), JSON.stringify({second: a, first: answer(unlatched)}).slice(0, 1500));
  const asked = async (call) => { const got = await call({action: 'get'}); return got.result != null && got.result.structuredContent != null ? got.result.structuredContent : null; };
  const changes = (got) => (got == null ? null : (got.history || []).filter((h) => h.setting === 'requestTimeout').map((h) => h.change));
  const here = changes(await asked(second));
  const there = await asked(first);
  check('(b-latched) the second session\'s history says it is locked', here != null && here.includes(LOCKED), JSON.stringify(here));
  check('(b-latched) the first session\'s does not', changes(there) != null && changes(there).length > 0 && !changes(there).includes(LOCKED), JSON.stringify(changes(there)));
  const tighten = await second({action: 'set', name: 'requestTimeout', value: '20s'});
  const t = tighten.result != null ? tighten.result.structuredContent : null;
  check('(b-latched) a tightening still applies to that session', t != null && t.new === 20000 && t.applies === 'this session', JSON.stringify(tighten).slice(0, 1000));
  const value = there != null ? (there.settings || []).find((x) => x.name === 'requestTimeout') : null;
  check('(b-latched) the first session\'s settings are its own (its 10 s kept)', value != null && value.value === 10000, JSON.stringify(there).slice(0, 1000));
}

// The acceptance fixture pack (test/fixtures/ch-pack-accept): built into
// this run's own release only, and added with a release that lists it beside
// the shipped one (the reviewer's route (B)). The shipped allowlist
// (lib/release-pins.json) never names it, nothing publishes it (its
// packages are private), and ch-local's package carries no test/.
const ACCEPT = 'accept';
const ACCEPT_DIRS = ['back', 'front'].map((d) => path.join(ROOT, 'test', 'fixtures', 'ch-pack-accept', d));
const ACCEPT_PACKAGES = ['ch-pack-accept', 'ch-accept-back'];
// (version 2: a pack lists its modules; their descriptions come with the
// development pins file the run writes, lib/pins.js)
const acceptRelease = (release) => ({...release, packs: {...release.packs, [ACCEPT]: {modules: ACCEPT_PACKAGES}}});
const toolOf = (names, action) => names.find((n) => new RegExp(`(^|[^A-Za-z0-9])${action}$`).test(n)) || null;

// (a) progress frames before an answer (MCP completeness M21), through the
// shim. run() -> {response, before, after}: the call's answer, and the
// notifications/progress frames carrying its token before and after it.
async function progressChecks({run, token, check}) {
  const {response, before, after} = await run();
  const out = response != null && response.result != null ? response.result.structuredContent : null;
  check('(a) the hopping call answers, through its part', response != null && response.result != null && response.result.isError !== true &&
    out != null && out.hopped === true && out.said === 'back', JSON.stringify(response).slice(0, 1000));
  check('(a) progress frames carrying the call\'s token arrive before its answer', before.length >= 1 && before.every((f) => f.params != null && f.params.progressToken === token),
    JSON.stringify(before).slice(0, 1000));
  const values = before.map((f) => f.params.progress);
  check('(a) their progress only rises', values.every((v, i) => typeof v === 'number' && (i === 0 || v > values[i - 1])), JSON.stringify(values));
  check('(a) none comes after the answer', after.length === 0, JSON.stringify(after).slice(0, 1000));
}

// (c) a cancelled call leaves no in-flight entry, through the shim. The
// relay's table is not exposed (no status op, no debug output: the reviewer's
// ruling), so the check is its behaviour at the close of its stdin: the shim
// waits, within its closing grace (10 s), for every call still in flight,
// then says bye (ch-local's fix: before it the bye went at the close, and the
// runtime, which ends a session at once on its bye, left those calls only
// crash answers). A cancelled call was settled by the runtime's `cancelled`
// op, so nothing is left to wait for: the shim ends at once, and the call is
// never answered. The control, a call not cancelled that ends inside the
// grace, gets its own answer before the shim ends, which is what makes the
// check sensitive. cancelled, control -> {exitMs, answers}: how long after
// the close the shim exited, and the lines answering that id. holdMs: the
// cancelled call's hold; controlHoldMs: the control's (inside the grace).
const CLOSING_GRACE_MS = 10000;
async function cancelChecks({cancelled, control, holdMs, controlHoldMs, check}) {
  const c = await cancelled();
  check('(c) a cancelled call is never answered through the shim, nor crash-answered at the close', c.answers.length === 0, JSON.stringify(c.answers).slice(0, 1000));
  check('(c) with it cancelled, the shim ends promptly at the close: nothing is left in flight', c.exitMs != null && c.exitMs < holdMs / 2, `exited ${c.exitMs} ms after the close; the call holds ${holdMs} ms`);
  const k = await control();
  // the control: the same call, not cancelled and ending inside the grace, is waited for and gets its own answer
  const a = k.answers.length === 1 ? k.answers[0] : null;
  check('(c, control) not cancelled, the call in flight at the close gets its own answer (not a crash answer), and the shim ends after it, within the grace',
    a != null && a.result != null && a.error === undefined && a.result.structuredContent != null && a.result.structuredContent.waited === controlHoldMs &&
    k.exitMs != null && k.exitMs < CLOSING_GRACE_MS,
    `exited ${k.exitMs} ms after the close; answers ${JSON.stringify(k.answers).slice(0, 600)}`);
}

// A requestState as the runtime mints it: versioned (`v<n>.<payload>.<mac>`)
// and opaque. Its payload is sealed (countinghouse #412, F2-4), so a client
// cannot read it: no JSON object in it (v1's payload was JSON in the clear),
// and none of `names` (the question's, the asking module's). This pins the
// privacy, not the version number. The padding (a payload's length tells
// nothing of who asked) is countinghouse's own test (mcp-contract 10).
function opaqueState(state, names) {
  const m = typeof state === 'string' ? /^v\d+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(state) : null;
  if (m == null) return false;
  const text = Buffer.from(m[1], 'base64url').toString('latin1');
  return !/\{"[a-z]+"\s*:/.test(text) && !names.some((n) => text.includes(n));
}

// (b2) ctx.ask through the shim (MCP completeness M13). call(extra) -> the
// answer to tools/call of the fixture's ask, with `extra` in its params (a
// retry's requestState and inputResponses).
async function askChecks({call, what, check}) {
  const first = await call({});
  const r = first != null ? first.result : null;
  const asked = r != null && r.inputRequests != null ? r.inputRequests.answer : null;
  const ok = check('(b2) the handler\'s declared question comes back through the shim as an InputRequiredResult (a form)', r != null && r.resultType === 'input_required' &&
    asked != null && asked.method === 'elicitation/create' && asked.params != null && asked.params.mode === 'form' &&
    typeof asked.params.message === 'string' && asked.params.message.includes(`Proceed with ${what}?`) && opaqueState(r.requestState, ['answer'].concat(ACCEPT_PACKAGES)),
    JSON.stringify(first).slice(0, 1000));
  if (!ok) return;
  const accept = (state) => ({requestState: state, inputResponses: {answer: {action: 'accept', content: {yes: true}}}});
  const retry = await call(accept(r.requestState));
  const out = retry != null && retry.result != null ? retry.result.structuredContent : null;
  check('(b2) the retry with the answer runs the handler again, which gets it', retry != null && retry.result != null && retry.result.isError !== true &&
    out != null && out.asked === true && JSON.stringify(out.answer) === JSON.stringify({yes: true}), JSON.stringify(retry).slice(0, 1000));
  const codeOf = (x) => (x != null && x.result != null && x.result._meta != null ? x.result._meta['countinghouse/code'] : null);
  const again = await call(accept(r.requestState));
  check('(b2) the state is used once: the same retry again is refused', codeOf(again) === 'ASK_STATE_INVALID', JSON.stringify(again).slice(0, 1000));
  // tampered: a fresh state (never used, so only its MAC can refuse it)
  // with its last character changed
  const fresh = await call({});
  const freshState = fresh != null && fresh.result != null ? fresh.result.requestState : null;
  const tampered = typeof freshState === 'string' ? `${freshState.slice(0, -1)}${freshState.endsWith('A') ? 'B' : 'A'}` : 'none';
  const forged = await call(accept(tampered));
  check('(b2) a tampered state is refused, and nothing is answered for it', forged != null && forged.result != null && forged.result.isError === true &&
    String(codeOf(forged) || '').startsWith('ASK_STATE'), JSON.stringify(forged).slice(0, 1000));
}

async function main(argv, io = {stdout: process.stdout, stderr: process.stderr}) {
  const say = (s) => io.stdout.write(`${s}\n`);
  const report = {startedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, checks: [], ok: false};
  const indent = (t) => String(t).split('\n').map((l) => `    ${l}`).join('\n');
  const check = (name, ok, detail) => {
    report.checks.push({name, ok: ok === true, ...(detail != null ? {detail: String(detail).slice(0, 2000)} : {})});
    say(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
    // the report file isn't kept by CI: a failure's detail is said here too
    if (ok !== true && detail != null) say(indent(String(detail).slice(0, 2000)));
    return ok === true;
  };
  let reportFile = path.resolve('shared-acceptance-report.json');
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report') { if (argv[i + 1] == null) { io.stderr.write('shared-acceptance: --report takes a file\n'); return 2; } reportFile = path.resolve(argv[++i]); } else rest.push(argv[i]);
  }
  let args;
  try { args = dogfood.parseArgs(rest); } catch (err) { io.stderr.write(err.message); return 2; }
  const planned = dogfood.planSources(args);
  if (planned.problem != null) { io.stderr.write(`shared-acceptance: ${planned.problem}\n`); return 1; }
  const refProblem = dogfood.resolveRefs(planned.sources);
  if (refProblem != null) { io.stderr.write(`shared-acceptance: ${refProblem}\n`); return 1; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-shared-acc-'));
  // the client's repository, apart from the work (clientRepoRoot)
  const repoRoot = fs.mkdtempSync(path.join(clientRepoRoot(), 'ch-shared-acc-repo-'));
  const home = path.join(work, 'home');
  const node = process.execPath;
  let client = null;
  let client2 = null;
  // the first client under strace on Linux (traceCommand): -f follows the
  // shim into the daemon it starts and the shared runtime the daemon runs;
  // read once strace has ended, with the same rules as the per-session run's
  let traced = null;
  let clientExited = null;
  const traceFile = path.join(work, 'shared.trace');
  let sessionSocket = null;
  // the daemon at attach, and whether strace traced it
  let tracedDaemon = null;
  // the debugging aid's log (CH_SHARED_ACCEPTANCE_DAEMON_LOG=1), when on
  let daemonLog = null;
  // (c)'s clients: each stopped in finish, as the others are
  const more = [];
  let stderr = '';
  let finished = null;
  const finish = (interrupted) => finished || (finished = (async () => {
    let daemonStopped = false;
    try {
      if (interrupted != null) check('the run was not interrupted', false, interrupted);
      // The traced client ends as a client does (its stdin closed: the
      // harness and its shim exit) while strace goes on tracing the daemon,
      // which outlives the shim; the daemon is stopped last, so strace ends with
      // it and its trace is whole. Never strace stopped first: under
      // --seccomp-bpf a process it traced and left running has its network
      // calls fail.
      const tracing = traced != null && traced.traced && client != null;
      // this run's processes but strace and this one, by the run's own folder
      // in their arguments (the daemon's and the runtime's name the home),
      // with strace's own tree: what strace traces
      const tracees = () => {
        const rows = processes() || [];
        const tree = new Set((treeOf(client.pid) || []).map((r) => r.pid));
        return rows.filter((r) => r.pid !== client.pid && r.pid !== process.pid && (tree.has(r.pid) || r.args.includes(work))).map((r) => r.pid);
      };
      const kill = (pids, sig) => { for (const pid of pids) { try { process.kill(pid, sig); } catch (e) { /* gone */ } } };
      // (an interrupted run: short bounds, so a CI cancel's SIGKILL finds
      // nothing left)
      const bound = (ms) => (interrupted != null ? Math.min(ms, 1000) : ms);
      // the untraced clients first: none of their shims is left to start a
      // daemon again once the traced one's stops
      if (client2 != null) await stopTree(client2);
      for (const c of more) await stopTree(c);
      // the daemon serving now: the one traced at attach, or the trace missed it
      const servingDaemon = daemonPid(home);
      if (tracing) {
        try { client.stdin.end(); } catch (e) { /* gone */ }
        // (the harness and its shim gone: strace's tree is strace and the
        // daemon's alone; one not read is not known to be, and waited for to
        // the bound; at the bound, the harness and the shim are ended, never
        // the daemon)
        const daemonTree = () => new Set(servingDaemon != null ? (treeOf(servingDaemon) || []).map((r) => r.pid) : []);
        const left = () => { const t = treeOf(client.pid); if (t == null) return null; const d = daemonTree(); return t.filter((r) => r.pid !== client.pid && !d.has(r.pid)).map((r) => r.pid); };
        for (const until = Date.now() + bound(10000); Date.now() < until;) { const l = left(); if (l != null && l.length === 0) break; await new Promise((r) => setTimeout(r, 100)); }
        const still = left();
        if (still == null || still.length > 0) { kill(still || [], 'SIGTERM'); await new Promise((r) => setTimeout(r, bound(1000))); }
      } else if (client != null) await stopTree(client);
      if (report.checks.some((c) => !c.ok) && interrupted == null) await diagnose();
      await stopDaemon(home, bound(10000));
      daemonStopped = true;
      if (tracing) {
        let timer = null;
        const exit = await Promise.race([clientExited, new Promise((r) => { timer = setTimeout(() => r('timeout'), bound(15000)); })]);
        clearTimeout(timer);
        // (whole: strace ended in time, and not by a signal -- one killed cut its trace short)
        const whole = exit !== 'timeout' && exit != null && exit.signal == null;
        // (strace did not end: every process it may still trace is killed
        // first -- its process group, the daemon's tree and anything naming the
        // run's folder -- then strace, so none is left running under its filter)
        if (exit === 'timeout') {
          try { process.kill(-client.pid, 'SIGKILL'); } catch (e) { /* gone */ }
          kill([...(servingDaemon != null ? [servingDaemon] : []), ...tracees()], 'SIGKILL');
          await stopTree(client);
        }
        const daemon = tracedDaemon == null ? null
          : tracedDaemon.traced !== true ? {problem: `the daemon (pid ${tracedDaemon.pid}) was not traced at attach (TracerPid ${tracedDaemon.traced === false ? '0' : 'unreadable'})`}
          : servingDaemon !== tracedDaemon.pid ? {problem: `the daemon serving at the end (pid ${servingDaemon}) is not the one traced at attach (pid ${tracedDaemon.pid})`} : {};
        for (const c of traceVerdict({text: fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8') : null, whole, sessionSocket, daemon})) check(c.name, c.ok, c.ok ? null : c.detail);
      }
      const left = daemonPid(home);
      if (left != null) check('the daemon is stopped at the end', !alive(left), `pid ${left}`);
      report.finishedAt = new Date().toISOString();
      report.ok = report.checks.length > 0 && report.checks.every((c) => c.ok);
      if (!report.ok && stderr !== '') report.shimLog = stderr.split('\n').slice(-200).join('\n');
      try { if (!report.ok && fs.existsSync(path.join(work, 'daemon.log'))) report.daemonLog = fs.readFileSync(path.join(work, 'daemon.log'), 'utf8').split('\n').slice(-300).join('\n'); } catch (e) { /* none */ }
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
      say(`report: ${reportFile} (${report.ok ? 'passed' : 'FAILED'}${(report.skipped || []).length > 0 ? `; skipped, not passed: ${report.skipped.join('; ')}` : ''})`);
    } finally {
      // (whatever ended the run, after the daemon is stopped and checked when
      // it got that far: a folder Windows still holds is retried, and one left
      // behind is said with what names it, never thrown over the verdict; an
      // interrupted run's bounds stay short)
      // (a run that threw before the daemon was stopped: stopped now, bounded, so no folder goes from under it)
      if (!daemonStopped) { try { await stopDaemon(home, bound(10000)); } catch (e) { /* the removal says what is left */ } }
      const quick = interrupted != null;
      // (one process scan for both folders, when one is needed)
      let rows;
      const holders = (dir) => () => { if (rows === undefined) rows = processes(); if (rows == null) throw new Error('the process list could not be read'); return holdersOf(pathForms(dir), rows); };
      removeRunFolder(work, {say, quick, home, holders: holders(work)});
      removeRunFolder(repoRoot, {say, quick, holders: holders(repoRoot)});
    }
  })());
  // A failed run's diagnosis, said into the output (CI keeps no report
  // file): the shim's stderr, the daemon's files, shim.json with its
  // environment's values withheld, the debug aid's daemon log, and, with no
  // live daemon, what one started as the shim would start it says.
  const diagnose = async () => {
    const tail = (t, n) => String(t).split('\n').slice(-n).join('\n');
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return `(${e.code || e.message})`; } };
    say('--- diagnosis of the failed run ---');
    say(`the shim's stderr (its last 80 lines):\n${indent(stderr !== '' ? tail(stderr, 80) : '(none)')}`);
    for (const f of ['failed.json', 'daemon.json']) say(`run/daemon/${f}:\n${indent(read(path.join(home, 'run', 'daemon', f)))}`);
    try {
      const sj = JSON.parse(fs.readFileSync(path.join(home, 'shim.json'), 'utf8'));
      say(`shim.json: node ${sj.node}, chLocal ${sj.chLocal}, environment keys ${Object.keys(sj.env || {}).sort().join(' ')}`);
    } catch (e) {
      say(`shim.json: (${e.code || e.message})`);
    }
    if (fs.existsSync(path.join(work, 'daemon.log'))) say(`the daemon's log (its last 120 lines):\n${indent(tail(read(path.join(work, 'daemon.log')), 120))}`);
    const pid = daemonPid(home);
    if (pid != null && alive(pid)) say(`a daemon is running (pid ${pid})`);
    else if (fs.existsSync(home)) say(`no live daemon; one started as the shim would start it says:\n${indent(tail(await daemonDiagnosis(home), 80))}`);
    say('--- end of the diagnosis ---');
  };
  const untrap = trapSignals(() => finish('interrupted by a signal'));
  const run = async () => {
    // the home private, as a user's is (ch-local refuses a group- or
    // world-writable one, and so would its shim and daemon)
    fs.mkdirSync(home, {recursive: true, mode: 0o700});
    if (process.platform !== 'win32') fs.chmodSync(home, 0o700);
    const built = await dogfood.buildRelease(planned.sources, work, say);
    if (!check('build from tarballs', built.problem == null, built.problem)) return 1;
    const installIo = {env: launcherEnv(home), node, version: process.version, platform: process.platform, homedir: os.homedir,
      alive: require('../lib/run-liveness').processAlive, hostname: os.hostname(),
      stdout: {write: () => {}}, stderr: io.stderr, exec: async (cmd, a, {cwd}) => dogfood.run(cmd, a, {cwd}),
      fetch: async () => { throw new Error('shared-acceptance: install makes no network call of its own'); }};
    const code = await require('../lib/install').install({pack: dogfood.PACK, from: built.release, unreleasedPins: built.pinsFile}, installIo);
    if (!check('install into a clean home', code === 0, `exit ${code}`)) return 1;
    // (a), (c), (b2)'s fixture pack: packed into this run's release and pinned
    // there, added with a release that lists it (acceptRelease), then turned
    // off, so it is turned on from the terminal while the daemon serves
    const npmIo = {node, exec: async (cmd, a, {cwd}) => dogfood.run(cmd, a, {cwd})};
    for (const dir of ACCEPT_DIRS) {
      const p = await require('../lib/release').packInto(npmIo, dir, built.release);
      built.pins[p.name] = {version: p.version, integrity: p.integrity};
    }
    const pinsDoc = JSON.parse(fs.readFileSync(built.pinsFile, 'utf8'));
    // the fixture pack's modules described too, from their tarballs
    const modules = require('./describe-release').describePinned(acceptRelease(require('../lib/allowlist').ALLOWLIST), built.pins, built.release);
    fs.writeFileSync(built.pinsFile, JSON.stringify({...pinsDoc, pins: built.pins, modules}, null, 2));
    const added = await require('../lib/packs-command').addPack({pack: ACCEPT, from: built.release, unreleasedPins: built.pinsFile}, installIo,
      acceptRelease(require('../lib/allowlist').ALLOWLIST));
    if (!check('the acceptance fixture pack is added (this run\'s release only)', added === 0, `exit ${added}`)) return 1;
    const where = require('../lib/home').layout({COUNTINGHOUSE_HOME: home});
    // (the command a refusal must name: this run's own launcher)
    const launcher = require('../lib/home').safeLauncher(where);
    if (!check('the run\'s home has a launcher a command can name', launcher != null, where.launcher)) return 1;
    // turned off by its module (L3: enabled.<module>; set pack.* is refused)
    const acceptModule = require('../lib/packs').packScenario(require('../lib/module-record').readModulesRecord(where), ACCEPT);
    require('../lib/settings').setSetting(where, `enabled.${acceptModule}`, 'off', {by: 'cli'});
    if (process.platform !== 'win32') fs.chmodSync(home, 0o700);

    const shim = buildShim();
    if (!check('the native shim builds', shim.problem == null, shim.problem)) return 1;
    const installed = installShim(home, shim.file);
    require('../lib/shim-config').writeShimJson(home, {node, env: launcherEnv(home), platform: process.platform});
    const found = require('../lib/shim-binary').shimFor({home});
    check('ch-local uses the installed shim', found.shim === installed, `${installed}: ${found.shim} ${found.note || ''}`);

    // the client: a repository directory, and the tested client's shape
    const repo = path.join(repoRoot, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), {recursive: true});
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/example/shared-acceptance.git\n');
    const h = claudeHarness(path.join(work, 'client'));
    // The client's settings are its own, and nothing above its repository
    // is read as a project's: else its conditions answer for the machine the
    // run is on, not for the tested client, and a "no" reads as a product
    // refusal.
    const configBad = configProblem(h.config);
    if (!check('the client\'s configuration directory is its own: an existing, empty directory', configBad == null, configBad)) return 1;
    const stray = strayClaudeDirs(repo, h.config);
    if (!check('no .claude at or above the client\'s repository but its own configuration (its conditions would read one as a project\'s)',
      stray.length === 0, stray.join('\n'))) return 1;
    // A debugging aid (CH_SHARED_ACCEPTANCE_DAEMON_LOG=1): the daemon started
    // here as the shim would start it (shim.json's environment, the home its
    // working directory), its output kept in the report, and the shim attaches
    // to it. Off, the shim starts the daemon, whose output it discards.
    const logMode = daemonLogMode(process.env, process.platform);
    if (logMode.problem != null) { check('the daemon is started by the shim, as a client starts it', false, logMode.problem); return 1; }
    if (logMode.on) {
      const sj = JSON.parse(fs.readFileSync(path.join(home, 'shim.json'), 'utf8'));
      daemonLog = path.join(work, 'daemon.log');
      const fd = fs.openSync(daemonLog, 'a');
      const d = spawn(sj.node, [sj.chLocal, 'daemon', '--home', home], {cwd: home, env: sj.env, stdio: ['ignore', fd, fd], detached: true});
      d.unref();
      for (const until = Date.now() + 30000; daemonPid(home) == null && Date.now() < until;) await new Promise((r) => setTimeout(r, 200));
    }
    // (on Linux under strace: the no-outbound-connection check of the shared
    // path; with the debugging aid's daemon above, started untraced, its
    // checks are skipped)
    if (logMode.on) {
      traced = {command: h.claude, args: [h.script, installed, home], traced: false};
      // (said where the trace would have run: Linux)
      if (process.platform === 'linux') { report.skipped = [...(report.skipped || []), DAEMON_LOG_SKIPPED]; say(`SKIP ${DAEMON_LOG_SKIPPED}`); }
    } else {
      traced = traceCommand({platform: process.platform, node: h.claude, args: [h.script, installed, home], file: traceFile, env: process.env, has: () => canTrace(h.claude)});
      if (traced.problem != null) { check('on Linux the shared path runs under strace', false, traced.problem); return 1; }
      if (traced.traced) check('on Linux the shared path runs under strace', true);
      if (traced.waived === true) { report.skipped = [...(report.skipped || []), TRACE_SKIPPED]; say(`SKIP ${TRACE_SKIPPED}`); }
    }
    client = spawn(traced.command, traced.args, {cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: launcherEnv(home, {CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: h.config, CLAUDE_PROJECT_DIR: repo})});
    clientExited = new Promise((r) => client.once('exit', (code, signal) => r({code, signal})));
    client.stderr.setEncoding('utf8');
    client.stderr.on('data', (d) => { stderr = (stderr + d).slice(-200000); });
    const mcp = session(client);
    const init = await mcp.request('initialize', {protocolVersion: '2026-07-28', capabilities: {elicitation: {}}, clientInfo: {name: 'claude-code', version: '2.1.323'}});
    const failedJson = () => { try { return fs.readFileSync(path.join(home, 'run', 'daemon', 'failed.json'), 'utf8'); } catch (e) { return ''; } };
    if (!check('the shim answers initialize', init.result != null, `${JSON.stringify(init).slice(0, 1000)} ${failedJson()}`)) return 1;
    mcp.notify('notifications/initialized', {});

    // the shim starts the daemon (its child until the shim ends: it outlives
    // the shim by design), which runs the shared runtime on its socket
    const pid = daemonPid(home);
    if (process.platform === 'win32') {
      // C4c: on Windows the shared runtime's socket is a named pipe, a new one
      // at each start, which daemon.json names: the daemon is live and names
      // its pipe, and the rest of this run goes through it.
      let socket = null;
      try { socket = JSON.parse(fs.readFileSync(path.join(home, 'run', 'daemon', 'daemon.json'), 'utf8')).socket; } catch (e) { socket = null; }
      check('attached to the shared runtime: a live daemon running it on its named pipe', pid != null && alive(pid) && typeof socket === 'string' && /^\\\\\.\\pipe\\countinghouse-[0-9a-f]+$/.test(socket),
        `daemon ${pid}; socket ${JSON.stringify(socket)}`);
      // and, read through WMI, no per-session runtime in the client's tree
      const tree = treeOf(client.pid);
      check('no per-session runtime in the client\'s tree', tree != null && !tree.some((p) => /\s--own-runtime\b/.test(p.args)), JSON.stringify(tree));
    } else {
      try { sessionSocket = JSON.parse(fs.readFileSync(path.join(home, 'run', 'daemon', 'daemon.json'), 'utf8')).socket; } catch (e) { sessionSocket = null; }
      if (traced != null && traced.traced && pid != null) tracedDaemon = {pid, traced: traced_(pid)};
      const tree = treeOf(client.pid);
      const runtime = pid != null ? (treeOf(pid) || []).find((p) => /framework\.js\b.*\s--sessionSocket\s/.test(p.args)) : null;
      check('attached to the shared runtime: a live daemon running it on its session socket', pid != null && alive(pid) && runtime != null,
        `daemon ${pid}; tree ${JSON.stringify(tree)}`);
      check('no per-session runtime in the client\'s tree', tree != null && !tree.some((p) => /\s--own-runtime\b/.test(p.args)), JSON.stringify(tree));
    }

    // (b) settings through the shim. countinghouse's tested-client list
    // (lib/elicitation-clients.json) has no tested Claude Code version until
    // the maintainer's hand test before release, so a loosening gets no form
    // yet: it is refused with the terminal command, as documented. A
    // tightening needs no form and applies to this session. The form round
    // trip itself joins once a tested range is listed (a todo).
    const call = (a, extra = {}) => mcp.request('tools/call', Object.assign({_meta: META, name: 'countinghouse_settings', arguments: a}, extra));
    const loosen = await call({action: 'set', name: 'requestTimeout', value: '60s'});
    const loosenCode = loosen.result != null && loosen.result._meta != null ? loosen.result._meta['countinghouse/code'] : null;
    // refused SETTING_NEEDS_CONFIRMATION, naming the terminal command. Never
    // SETTING_DECLINED_THIS_SESSION: no form was declined, and a session the
    // client's conditions latched "no" is the machine's, not the tested
    // client's (2026-11-16: a run under a home whose .claude held plugins
    // answered so; the guard above now refuses such a run). With no tested
    // client a latched session is refused in the same words: (b-latched) reads
    // in this session's history that it is not one.
    check('(b) a loosening, with no tested client yet, is refused with the terminal command', loosen.result != null && loosen.result.isError === true &&
      loosenCode === 'SETTING_NEEDS_CONFIRMATION' && JSON.stringify(loosen.result.content).includes(terminalInJson(launcher, 'settings set requestTimeout 60s')),
      JSON.stringify(loosen).slice(0, 1000));
    const tighten = await call({action: 'set', name: 'requestTimeout', value: '10s'});
    const t = tighten.result != null ? tighten.result.structuredContent : null;
    check('(b) a tightening applies to this session', t != null && t.new === 10000 && t.applies === 'this session', JSON.stringify(tighten).slice(0, 1000));
    const got = await call({action: 'get'});
    const value = got.result != null && got.result.structuredContent != null ? (got.result.structuredContent.settings || []).find((x) => x.name === 'requestTimeout') : null;
    check('(b) settings shows it', value != null && value.value === 10000, JSON.stringify(got).slice(0, 1000));

    // (d) a paged list through the shim (countinghouse M1). The runtime pages
    // tools/list at --listPageSize (250, never under 10), more than this
    // shared runtime lists, so the list is one page with no nextCursor. What
    // the shim must carry both ways is checked with a cursor the client
    // sends: one positioned after the list's first tool is answered with the
    // rest; one that names nothing is -32602. The cursor is built here as
    // the runtime builds one (base64url of {v, k, a}: lib/mcp/pages.js), the
    // one place this test leans on a format the client never needs.
    const whole = await mcp.request('tools/list', {_meta: META});
    const names = whole.result != null && Array.isArray(whole.result.tools) ? whole.result.tools.map((x) => x.name) : [];
    check('(d) the whole list is one page, with no nextCursor', whole.result != null && names.length > 0 && whole.result.nextCursor === undefined, JSON.stringify(whole).slice(0, 1000));
    const after = Buffer.from(JSON.stringify({v: 1, k: 'tools', a: names[0]})).toString('base64url');
    const rest = await mcp.request('tools/list', {_meta: META, cursor: after});
    const restNames = rest.result != null && Array.isArray(rest.result.tools) ? rest.result.tools.map((x) => x.name) : null;
    check('(d) a cursor after the first tool is answered with the rest of the list', restNames != null && JSON.stringify(restNames) === JSON.stringify(names.slice(1)),
      JSON.stringify(rest).slice(0, 1000));
    const bad = await mcp.request('tools/list', {_meta: META, cursor: 'not-a-cursor'});
    check('(d) a cursor that names nothing is -32602', bad.error != null && bad.error.code === -32602, JSON.stringify(bad).slice(0, 1000));

    // (b-latched) a second client whose own settings hold a hook (the
    // conditions fixture's 'user-settings': its reason is the fixture's),
    // on the same daemon. Everything in the run's own directories, removed
    // with them; never the user's ~/.claude.
    const root2 = path.join(work, 'client2');
    const h2 = claudeHarness(root2);
    const home2 = path.join(root2, 'home');
    const config2 = path.join(home2, '.claude');
    fs.mkdirSync(config2, {recursive: true});
    const repo2 = path.join(repoRoot, 'repo2');
    fs.mkdirSync(path.join(repo2, '.git'), {recursive: true});
    fs.writeFileSync(path.join(repo2, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/example/shared-acceptance-latched.git\n');
    const config2Bad = configProblem(config2);
    if (!check('(b-latched) the second client\'s configuration directory is its own: an existing, empty directory', config2Bad == null, config2Bad)) return 1;
    const stray2 = strayClaudeDirs(repo2, config2);
    if (!check('(b-latched) no .claude at or above the second client\'s repository but its own configuration', stray2.length === 0, stray2.join('\n'))) return 1;
    const settings2 = path.join(config2, 'settings.json');
    const within = (p, dir) => { const rel = path.relative(dir, p); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };
    if (!check('(b-latched) the hook goes inside the run\'s own directory, never the user\'s ~/.claude', within(settings2, work) && !within(settings2, path.join(os.homedir(), '.claude')), settings2)) return 1;
    const reason = fixtures.plant('user-settings', {home: home2, write: (file, value) => {
      if (path.resolve(file) !== settings2) throw new Error(`the fixture wrote ${file}, not ${settings2}`);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
      return file;
    }});
    const env2 = launcherEnv(home, {CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: config2, CLAUDE_PROJECT_DIR: repo2});
    client2 = spawn(h2.claude, [h2.script, installed, home], {cwd: repo2, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', env: env2});
    client2.stderr.setEncoding('utf8');
    client2.stderr.on('data', (d) => { stderr = (stderr + d).slice(-200000); });
    const mcp2 = session(client2);
    const init2 = await mcp2.request('initialize', {protocolVersion: '2026-07-28', capabilities: {elicitation: {}}, clientInfo: {name: 'claude-code', version: '2.1.323'}});
    if (!check('(b-latched) the second client\'s shim answers initialize', init2.result != null, JSON.stringify(init2).slice(0, 1000))) return 1;
    mcp2.notify('notifications/initialized', {});
    const tree2 = treeOf(client2.pid);
    check('(b-latched) attached to the same live daemon, with no per-session runtime in its tree', daemonPid(home) === pid && alive(pid) &&
      tree2 != null && !tree2.some((p) => /\s--own-runtime\b/.test(p.args)), `daemon ${daemonPid(home)} (was ${pid}); tree ${JSON.stringify(tree2)}`);
    // the conditions line the shim hands over for this client, as it runs
    // it: ch-local conditions for the client's pid, in its directory and
    // environment (lib/conditions-command.js)
    const sj = JSON.parse(fs.readFileSync(path.join(home, 'shim.json'), 'utf8'));
    const conds = spawnSync(sj.node, [sj.chLocal, 'conditions', '--for', String(client2.pid), '--home', home], {cwd: repo2, env: env2, encoding: 'utf8', timeout: STEP_MS});
    let why = null;
    try { why = JSON.parse(conds.stdout.trim().split('\n').pop()).why || null; } catch (e) { why = null; }
    const settingsCall = (m) => (a) => m.request('tools/call', {_meta: META, name: 'countinghouse_settings', arguments: a});
    await latchedChecks({second: settingsCall(mcp2), first: settingsCall(mcp), why, reason, launcher, check});
    // it leaves with a bye (its stdin closed), and the first session is served on
    client2.stdin.end();
    await new Promise((resolve) => { const t = setTimeout(resolve, STEP_MS); client2.once('exit', () => { clearTimeout(t); resolve(); }); });
    const stillServed = await mcp.request('tools/list', {_meta: META});
    check('(b-latched) after the second session\'s bye, the daemon still serves the first', stillServed.result != null && Array.isArray(stillServed.result.tools) &&
      stillServed.result.tools.length > 0 && alive(pid), JSON.stringify(stillServed).slice(0, 1000));

    // The fixture pack, turned on from the terminal while the daemon serves:
    // every session's (B3's all-sessions path; no form). A session's own
    // "on" needs its form, which joins with (b1).
    // `<launcher> settings set enabled.<its module> on` is a loosening, which the
    // terminal confirms (lib/cli-change.js); the run has no terminal, so it
    // calls that same path with an io that answers the question "y", as the
    // user at a terminal would
    let asked = null;
    let said = '';
    const on = await require('../lib/cli-change').cliSet(where, `enabled.${acceptModule}`, 'on',
      {interactive: true, ask: async (q) => { asked = q; return 'y'; }, stderr: {write: (s) => { said += s; }}, platform: process.platform, env: launcherEnv(home)});
    if (!check('the fixture pack is turned on from the terminal (its loosening asked and confirmed)', on.code === 0 && String(asked).startsWith(`Loosen enabled.${acceptModule} `),
      `${on.code} ${asked} ${said}`)) return 1;
    let listed = [];
    for (const until = Date.now() + STEP_MS; Date.now() < until;) {
      const l = await mcp.request('tools/list', {_meta: META});
      listed = l.result != null && Array.isArray(l.result.tools) ? l.result.tools.map((x) => x.name) : [];
      if (['relay', 'slow', 'ask'].every((a) => toolOf(listed, a) != null)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!check('the daemon loads it in place: its tools are listed to the session', ['relay', 'slow', 'ask'].every((a) => toolOf(listed, a) != null), listed.join(', '))) return 1;

    // (a) progress frames before an answer, through the shim
    const token = 'acc-progress-1';
    await progressChecks({token, check, run: async () => {
      const response = await mcp.request('tools/call', {_meta: {...META, progressToken: token}, name: toolOf(listed, 'relay'), arguments: {}});
      const at = mcp.log.indexOf(response);
      const frames = (from, to) => mcp.log.slice(from, to).filter((m) => m.method === 'notifications/progress' && m.params != null && m.params.progressToken === token);
      await new Promise((r) => setTimeout(r, 1000));   // anything that would come after
      return {response, before: frames(0, at), after: frames(at + 1)};
    }});

    // (b2) ctx.ask through the shim
    const what = 'acceptance';
    await askChecks({what, check, call: (extra) => mcp.request('tools/call', Object.assign({_meta: META, name: toolOf(listed, 'ask'), arguments: {what}}, extra))});

    // (c) a cancelled call, through a shim of its own each time (its stdin is closed)
    // the cancelled call holds past the grace; the control ends inside it
    const holdMs = 20000;
    const controlHoldMs = 5000;
    const slowRun = async (cancel) => {
      const c = spawn(h.claude, [h.script, installed, home], {cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        env: launcherEnv(home, {CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: h.config, CLAUDE_PROJECT_DIR: repo})});
      more.push(c);
      c.stderr.setEncoding('utf8');
      c.stderr.on('data', (d) => { stderr = (stderr + d).slice(-200000); });
      const m = session(c);
      const exited = new Promise((resolve) => c.once('exit', () => resolve(Date.now())));
      await m.request('initialize', {protocolVersion: '2026-07-28', capabilities: {elicitation: {}}, clientInfo: {name: 'claude-code', version: '2.1.323'}});
      m.notify('notifications/initialized', {});
      const id = m.nextId();
      m.request('tools/call', {_meta: META, name: toolOf(listed, 'slow'), arguments: {ms: cancel ? holdMs : controlHoldMs}}, holdMs * 3).catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));   // the call is in the runtime
      if (cancel) m.notify('notifications/cancelled', {requestId: id, reason: 'shared-acceptance (c)'});
      await new Promise((r) => setTimeout(r, 500));
      const closedAt = Date.now();
      c.stdin.end();
      const t = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), holdMs * 3))]);
      return {exitMs: t == null ? null : t - closedAt, answers: m.log.filter((x) => x.id === id)};
    };
    await cancelChecks({holdMs, controlHoldMs, check, cancelled: () => slowRun(true), control: () => slowRun(false)});
    return 0;
  };
  let code = 1;
  try {
    code = await run();
  } catch (err) {
    check('the run completed', false, err.stack || err.message);
  } finally {
    untrap();
    // (a finish that threw is a failed check, never a crash that hides the verdict)
    try { await finish(null); } catch (err) { check('the run finished its checks', false, (err && (err.stack || err.message)) || String(err)); }
  }
  return report.ok ? code : 1;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));

// A run's folder, removed after the daemon is gone. Windows can hold a file
// in it a moment longer (EPERM, EBUSY: an exiting process's handles, a
// scanner): an own module's read-only copies under the home are unlocked
// first (as acceptance.js's removeTree does), then Node's own retries, then a
// folder still there is said on its own line with the processes that name
// it, so the cause is learned. It never throws: the verdict already reported
// stands. quick (an interrupted run): no retries and no process scan, so a
// cancel's grace period is not spent here.
function removeRunFolder(dir, {rm = fs.rmSync, say, quick = false, home = null, platform = process.platform, holders = () => { const rows = processes(); if (rows == null) throw new Error('the process list could not be read'); return holdersOf(pathForms(dir), rows); }}) {
  if (home != null) { try { require('../lib/own-tree').unlockTree(path.join(home, 'own')); } catch (e) { /* the removal says it */ } }
  try {
    rm(dir, {recursive: true, force: true, ...(quick ? {} : {maxRetries: 5, retryDelay: 100})});
    return true;
  } catch (e) {
    say(`cleanup: ${dir} was not removed (${e.code || e.message}); the verdict above stands`);
    if (quick) { say(`cleanup: what names ${dir} was not looked for: the run was interrupted`); return false; }
    let held = [];
    try { held = holders(); } catch (err) { say(`cleanup: what names ${dir} could not be looked for: ${err.code || err.message}`); return false; }
    const none = platform === 'win32' ? 'no process names it on its command line (a working folder can\'t be read on Windows)' : 'no process names it (one may hold a file in it without naming it)';
    say(`cleanup: what names ${dir} now: ${held.length > 0 ? held.join('; ') : none}`);
    return false;
  }
}
// The processes whose command line names a path at or under one of `dirs`
// (the folder as made and as resolved; an image's path is in its command
// line) or whose working folder is under it (where it can be read: /proc on
// Linux; Windows's WMI has none, so there only this process's own):
// "pid N: <command line, cut>" or "pid N: working folder <path>". On Windows
// paths compare without case and with either slash.
// (a folder already unlinked reads "<path> (deleted)")
const LINUX_CWD = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, ''); } catch (e) { return null; } };
// a folder as made, as resolved, and (Windows) with its 8.3 short names expanded
const pathForms = (dir) => { const out = [dir, realOr(dir)]; try { out.push(fs.realpathSync.native(dir)); } catch (e) { /* gone */ } return out; };
function holdersOf(dirs, rows, cwdOf = process.platform === 'linux' ? LINUX_CWD : (pid) => (pid === process.pid ? process.cwd() : null), platform = process.platform) {
  const norm = (t) => (platform === 'win32' ? String(t).replace(/\\/g, '/').toLowerCase() : String(t));
  const forms = [...new Set((Array.isArray(dirs) ? dirs : [dirs]).filter((d) => typeof(d) === 'string' && d !== '').map(norm))];
  const under = (p) => typeof(p) === 'string' && forms.some((d) => { const n = norm(p); return n === d || n.startsWith(d + '/'); });
  // (a whole path: what is before it starts an argument, what is after it ends it or goes on into it)
  const names = (args) => {
    const a = norm(args);
    return forms.some((d) => { for (let at = a.indexOf(d); at >= 0; at = a.indexOf(d, at + 1)) { const before = at === 0 ? ' ' : a[at - 1]; const next = a[at + d.length]; if (/[\s"'=:,;]/.test(before) && (next == null || /[/\s"':,;]/.test(next))) return true; } return false; });
  };
  const cut = (t) => (t.length > 240 ? `${t.slice(0, 240)}…` : t);
  const out = [];
  for (const row of rows) {
    if (names(row.args)) { out.push(`pid ${row.pid}: ${cut(row.args)}`); continue; }
    const cwd = cwdOf(row.pid);
    if (under(cwd)) out.push(`pid ${row.pid}: working folder ${cut(cwd)}`);
  }
  return out;
}
module.exports = {main, removeRunFolder, holdersOf, daemonLogMode, DAEMON_LOG_SKIPPED, traceVerdict, TRACE_SAW, TRACE_NONE_LEFT, buildShim, installShim, claudeHarness, clientRepoRoot, strayClaudeDirs, configProblem, daemonPid, stopDaemon, daemonDiagnosis, treeOf, session, latchedChecks,
  progressChecks, cancelChecks, askChecks, ACCEPT, ACCEPT_DIRS, ACCEPT_PACKAGES, acceptRelease};
