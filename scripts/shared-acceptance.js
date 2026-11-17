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
// On win32 the daemon is not yet available (C4c): the shim runs the
// per-session runtime, and that fallback is what is checked.
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
const {launcherEnv, stopTree, trapSignals} = require('./acceptance');

const ROOT = path.resolve(__dirname, '..');
const SHIM_BUILD_MS = 20 * 60 * 1000;
const STEP_MS = 120000;
const META = {'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {elicitation: {}},
  'io.modelcontextprotocol/clientInfo': {name: 'claude-code', version: '2.1.323'}};

// One MCP session over a child's stdio: newline-delimited JSON-RPC.
function session(child) {
  let buf = '';
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) !== -1;) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === '') continue;
      let msg;
      try { msg = JSON.parse(line); } catch (err) { continue; }
      if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  let id = 0;
  return {
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
// directory), for at most ms, and what it said is returned. POSIX.
function daemonDiagnosis(home, ms = 10000) {
  let sj;
  try { sj = JSON.parse(fs.readFileSync(path.join(home, 'shim.json'), 'utf8')); } catch (e) { return Promise.resolve(`no shim.json: ${e.message}`); }
  return new Promise((resolve) => {
    let out = '';
    let ended = false;
    const add = (b) => { out = (out + b).slice(-20000); };
    let d;
    try {
      d = spawn(sj.node, [sj.chLocal, 'daemon', '--home', home], {cwd: home, env: sj.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    } catch (e) {
      return resolve(`the daemon could not be started: ${e.message}`);
    }
    d.stdout.on('data', add);
    d.stderr.on('data', add);
    const timer = setTimeout(() => {
      ended = true;
      try { process.kill(-d.pid, 'SIGTERM'); } catch (e) { /* gone */ }
      setTimeout(() => { try { process.kill(-d.pid, 'SIGKILL'); } catch (e) { /* gone */ } }, 3000).unref();
    }, ms);
    d.on('error', (e) => { clearTimeout(timer); resolve(`${out}\n(the daemon could not be started: ${e.message})`); });
    d.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(`${out}\n(${ended ? `still running after ${ms} ms; ended` : `exit ${code}${signal != null ? ` ${signal}` : ''}`})`);
    });
  });
}
// The command lines of `root` and every descendant (POSIX ps).
function treeOf(root) {
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], {encoding: 'utf8', timeout: 10000});
  if (r.status !== 0) return null;
  const rows = String(r.stdout).split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map((m) => ({pid: Number(m[1]), ppid: Number(m[2]), args: m[3]}));
  const inTree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (inTree.has(row.ppid) && !inTree.has(row.pid)) { inTree.add(row.pid); grew = true; }
  }
  return rows.filter((row) => inTree.has(row.pid));
}

// (b-latched), the countinghouse #337 contract: a session whose client's
// conditions latched "no" is refused a loosening as that latch, with the
// reason the shim handed over, never as the user's decline; a tightening
// still applies to it; and another session's settings are its own.
// second, first: each session's tools/call of countinghouse_settings; why:
// the conditions line's `why` ({reason, at?}) for the second client; reason:
// the fixture's own expected reason. -> nothing; each finding via check().
async function latchedChecks({second, first, why, reason, check}) {
  check('(b-latched) the conditions handed over for the second client say no, with the fixture\'s reason', why != null && why.reason === reason, JSON.stringify(why));
  const loosen = await second({action: 'set', name: 'requestTimeout', value: '60s'});
  const code = loosen.result != null && loosen.result._meta != null ? loosen.result._meta['countinghouse/code'] : null;
  const text = loosen.result != null ? JSON.stringify(loosen.result.content) : '';
  // the refusal states the session's own conditionsWhy, as the runtime holds
  // it from the hand-over (countinghouse lib/conditions-why.js said())
  const said = why != null ? `(${why.reason}${why.at !== undefined ? `: ${why.at}` : ''})` : '(none handed over)';
  check('(b-latched) a loosening is refused as the latch, with the handed-over reason and the terminal command; never as a decline',
    loosen.result != null && loosen.result.isError === true && code === 'SETTING_CLIENT_NOT_CONFIRMED' && text.includes(said) &&
    /ch-local settings set requestTimeout 60s/.test(text), `${said} ${JSON.stringify(loosen).slice(0, 1000)}`);
  const tighten = await second({action: 'set', name: 'requestTimeout', value: '20s'});
  const t = tighten.result != null ? tighten.result.structuredContent : null;
  check('(b-latched) a tightening still applies to that session', t != null && t.new === 20000 && t.applies === 'this session', JSON.stringify(tighten).slice(0, 1000));
  const got = await first({action: 'get'});
  const value = got.result != null && got.result.structuredContent != null ? (got.result.structuredContent.settings || []).find((x) => x.name === 'requestTimeout') : null;
  check('(b-latched) the first session\'s settings are its own (its 10 s kept)', value != null && value.value === 10000, JSON.stringify(got).slice(0, 1000));
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
  let stderr = '';
  let finished = null;
  const finish = (interrupted) => finished || (finished = (async () => {
    if (interrupted != null) check('the run was not interrupted', false, interrupted);
    if (client != null) await stopTree(client);
    if (client2 != null) await stopTree(client2);
    if (report.checks.some((c) => !c.ok)) await diagnose();
    await stopDaemon(home);
    const left = daemonPid(home);
    if (left != null) check('the daemon is stopped at the end', !alive(left), `pid ${left}`);
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.length > 0 && report.checks.every((c) => c.ok);
    if (!report.ok && stderr !== '') report.shimLog = stderr.split('\n').slice(-200).join('\n');
    try { if (!report.ok && fs.existsSync(path.join(work, 'daemon.log'))) report.daemonLog = fs.readFileSync(path.join(work, 'daemon.log'), 'utf8').split('\n').slice(-300).join('\n'); } catch (e) { /* none */ }
    try {
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
      say(`report: ${reportFile} (${report.ok ? 'passed' : 'FAILED'})`);
    } finally {
      fs.rmSync(work, {recursive: true, force: true});
      fs.rmSync(repoRoot, {recursive: true, force: true});
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
    else if (process.platform !== 'win32' && fs.existsSync(home)) say(`no live daemon; one started as the shim would start it says:\n${indent(tail(await daemonDiagnosis(home), 80))}`);
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
      stdout: {write: () => {}}, stderr: io.stderr, exec: async (cmd, a, {cwd}) => dogfood.run(cmd, a, {cwd}),
      fetch: async () => { throw new Error('shared-acceptance: install makes no network call of its own'); }};
    const code = await require('../lib/install').install({pack: dogfood.PACK, from: built.release, unreleasedPins: built.pinsFile}, installIo);
    if (!check('install into a clean home', code === 0, `exit ${code}`)) return 1;
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
    let daemonLog = null;
    if (process.env.CH_SHARED_ACCEPTANCE_DAEMON_LOG === '1' && process.platform !== 'win32') {
      const sj = JSON.parse(fs.readFileSync(path.join(home, 'shim.json'), 'utf8'));
      daemonLog = path.join(work, 'daemon.log');
      const fd = fs.openSync(daemonLog, 'a');
      const d = spawn(sj.node, [sj.chLocal, 'daemon', '--home', home], {cwd: home, env: sj.env, stdio: ['ignore', fd, fd], detached: true});
      d.unref();
      for (const until = Date.now() + 30000; daemonPid(home) == null && Date.now() < until;) await new Promise((r) => setTimeout(r, 200));
    }
    client = spawn(h.claude, [h.script, installed, home], {cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: launcherEnv(home, {CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CONFIG_DIR: h.config, CLAUDE_PROJECT_DIR: repo})});
    client.stderr.setEncoding('utf8');
    client.stderr.on('data', (d) => { stderr = (stderr + d).slice(-200000); });
    const mcp = session(client);
    const init = await mcp.request('initialize', {protocolVersion: '2026-07-28', capabilities: {elicitation: {}}, clientInfo: {name: 'claude-code', version: '2.1.323'}});
    const failedJson = () => { try { return fs.readFileSync(path.join(home, 'run', 'daemon', 'failed.json'), 'utf8'); } catch (e) { return ''; } };
    if (!check('the shim answers initialize', init.result != null, `${JSON.stringify(init).slice(0, 1000)} ${failedJson()}`)) return 1;
    mcp.notify('notifications/initialized', {});

    if (process.platform === 'win32') {
      // the daemon is POSIX only until C4c: the shim runs the per-session runtime
      check('win32: no daemon, the per-session runtime answers (C4c pending)', daemonPid(home) == null);
      return 0;
    }
    // the shim starts the daemon (its child until the shim ends: it outlives
    // the shim by design), which runs the shared runtime on its socket
    const pid = daemonPid(home);
    const tree = treeOf(client.pid);
    const runtime = pid != null ? (treeOf(pid) || []).find((p) => /framework\.js\b.*\s--sessionSocket\s/.test(p.args)) : null;
    check('attached to the shared runtime: a live daemon running it on its session socket', pid != null && alive(pid) && runtime != null,
      `daemon ${pid}; tree ${JSON.stringify(tree)}`);
    check('no per-session runtime in the client\'s tree', tree != null && !tree.some((p) => /\s--own-runtime\b/.test(p.args)), JSON.stringify(tree));

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
    // answered so; the guard above now refuses such a run)
    check('(b) a loosening, with no tested client yet, is refused with the terminal command', loosen.result != null && loosen.result.isError === true &&
      loosenCode === 'SETTING_NEEDS_CONFIRMATION' && /ch-local settings set requestTimeout 60s/.test(JSON.stringify(loosen.result.content)),
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
    await latchedChecks({second: settingsCall(mcp2), first: settingsCall(mcp), why, reason, check});
    // it leaves with a bye (its stdin closed), and the first session is served on
    client2.stdin.end();
    await new Promise((resolve) => { const t = setTimeout(resolve, STEP_MS); client2.once('exit', () => { clearTimeout(t); resolve(); }); });
    const stillServed = await mcp.request('tools/list', {_meta: META});
    check('(b-latched) after the second session\'s bye, the daemon still serves the first', stillServed.result != null && Array.isArray(stillServed.result.tools) &&
      stillServed.result.tools.length > 0 && alive(pid), JSON.stringify(stillServed).slice(0, 1000));
    return 0;
  };
  let code = 1;
  try {
    code = await run();
  } catch (err) {
    check('the run completed', false, err.stack || err.message);
  } finally {
    untrap();
    await finish(null);
  }
  return report.ok ? code : 1;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code));

module.exports = {main, buildShim, installShim, claudeHarness, clientRepoRoot, strayClaudeDirs, configProblem, daemonPid, stopDaemon, daemonDiagnosis, treeOf, session, latchedChecks};
