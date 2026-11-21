#!/usr/bin/env node
'use strict';
// Acceptance from tarballs (plan Task 13; reviewer, 2026-11-12), built now so
// the release-gating run after R2-1 is a button press. It builds every package
// from its current main as scripts/dogfood.js does, then, in a clean home:
//   1. installs pack 1 from the tarballs (CH_LOCAL_DEV=1, --unreleased-pins);
//   2. checks that `start --moduleSandbox off` is refused and starts nothing;
//   3. starts the server as a client does (<home>/bin/ch-local.js start
//      --stdio), its GitHub calls sent to a local stand-in that answers from
//      the triage pack's recorded GitHub MCP results: CH_LOCAL_REMOTE_MAP plus
//      the runtime's own COUNTINGHOUSE_ACCEPTANCE=1, so the declared origin,
//      the allowance and the variable stay the real ones;
//   4. speaks MCP: tools/list is exactly ci_failure_triage,
//      countinghouse_load_module, countinghouse_overview (countinghouse
//      #490), countinghouse_settings, countinghouse_usage_report,
//      countinghouse_validate_module and countinghouse_validate_plan (the
//      three for building your own module: countinghouse #499); one
//      ci_failure_triage call answers with a receipt marked "(acceptance
//      stand-in)", its standIn naming github; the
//      usage report counts those calls in its standIn section, none as real;
//      then the user's own module (A-own-skill; ch-local#113): added
//      before the start -- through add-module's question answered y on a
//      pseudo-terminal (test/pty-answer.py) on Linux and macOS; on Windows,
//      which has none, by the installed ch-local's own placeCopy and
//      writeOwnRecord, the calls add-module makes after its yes ("the yes
//      stood in") -- with a key of its own for GitHub's origin; its tool is
//      listed and called, the code start loads is the copy confirmed, and
//      each token reached the stand-in only on its own module's calls;
//   5. after the server exits, checks that the tokens (generated per run,
//      never real ones) are in no file under the home;
//   6. uninstalls, answering yes, and checks that nothing is left;
//   7. writes the timings and every check into a JSON report.
//
//   node scripts/acceptance.js [--report <file>] [--src <dir of clones>]
//                              [--clone <repo>=<path>]... [--ref <repo>=<ref>]...
//
// The token goes only to the stand-in, which refuses any other value. The
// only network calls are the npm registry's (the runtime's dependencies) and,
// for repositories without a clone, git clone from GitHub.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const dogfood = require('./dogfood');
const {ALLOWLIST} = require('../lib/allowlist');

const GITHUB = 'https://api.githubcopilot.com';
const RECORDED_REPO = 'mchen6/countinghouse';
const RECEIPT = /^read [\d,]+ lines? \([\d.]+ [KM]?B\) in \d+ calls? to github \(acceptance stand-in\); [\d,]+ lines? \([\d.]+ [KM]?B\) reached the model\.$/;
const LIMIT_MS = 300000;

// The recorded answers, as the triage pack's own tests serve them
// (ch-pack-ci-failure-triage test/github.js recordedServer).
function recordedAnswer(fixtures, tool, args) {
  const recorded = (name) => JSON.parse(fs.readFileSync(path.join(fixtures, `${name}.json`), 'utf8')).result;
  if (tool === 'actions_list' && args.method === 'list_workflow_runs') return recorded('list_workflow_runs');
  if (tool === 'actions_list' && args.method === 'list_workflow_jobs' && String(args.resource_id) === '42775507169') return recorded('list_workflow_jobs');
  if (tool === 'get_job_logs' && /^\d+$/.test(String(args.job_id)) && fs.existsSync(path.join(fixtures, `get_job_logs-${args.job_id}.json`))) return recorded(`get_job_logs-${args.job_id}`);
  if (tool === 'list_commits') return recorded('list_commits');
  return null;
}

// The GitHub stand-in: a streamable-HTTP MCP server on 127.0.0.1, stateless,
// JSON answers. A request without exactly one of the run's tokens is refused
// (401); each call is recorded with whose token it carried (tokens: {who:
// token}). Every call it has no recording for is an isError answer, and
// counted.
function startStandIn({fixtures, token, tokens = {pack: token}}) {
  const tools = JSON.parse(fs.readFileSync(path.join(fixtures, 'tools-list.json'), 'utf8')).tools;
  // (seen: every authorised request -- handshakes too -- with whose token it
  // carried and the module header it came with, OWN_HEADER's value or null)
  const state = {requests: 0, refused: 0, calls: [], by: [], seen: [], unexpected: []};
  const whose = (header) => { for (const [who, t] of Object.entries(tokens)) if (header === `Bearer ${t}`) return who; return null; };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d) => { body += d; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      state.requests += 1;
      const who = whose(req.headers.authorization);
      if (who == null) {
        state.refused += 1;
        res.writeHead(401, {'content-type': 'text/plain'});
        return res.end('the acceptance stand-in takes only this run\'s tokens');
      }
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      let msg;
      try { msg = JSON.parse(body); } catch (err) { res.writeHead(400); return res.end(); }
      const module = req.headers[OWN_HEADER.toLowerCase()];
      state.seen.push({method: msg != null ? msg.method : null, who, module: typeof module === 'string' ? module : null});
      const answer = (result) => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({jsonrpc: '2.0', id: msg.id, result})); };
      if (msg.id === undefined) { res.writeHead(202); return res.end(); }
      if (msg.method === 'initialize') {
        return answer({protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'acceptance-stand-in', version: '1'}});
      }
      if (msg.method === 'tools/list') return answer({tools});
      if (msg.method === 'tools/call') {
        const name = msg.params && msg.params.name;
        const args = (msg.params && msg.params.arguments) || {};
        state.calls.push(name);
        state.by.push(who);
        const result = recordedAnswer(fixtures, name, args);
        if (result != null) return answer(result);
        state.unexpected.push({tool: name, args});
        return answer({isError: true, content: [{type: 'text', text: `the acceptance stand-in has no recording for ${name}`}]});
      }
      return answer({});
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({port: server.address().port, state, close: () => new Promise((r) => server.close(() => r()))}));
  });
}

// Every file under `dir` whose bytes contain `needle` -> [relative paths].
function filesContaining(dir, needle) {
  const hits = [];
  const want = Buffer.from(needle);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, {withFileTypes: true})) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p).includes(want)) hits.push(path.relative(dir, p));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return hits;
}

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
    request: (method, params, ms = 120000) => new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} in ${ms} ms`)), ms);
      waiting.set(n, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: n, method, params}) + '\n');
    }),
    notify: (method, params) => child.stdin.write(JSON.stringify({jsonrpc: '2.0', method, params}) + '\n')
  };
}

// The environment for every launcher command: no credential of this shell's
// (every variable the pack's allowlist names), the dev switches.
function launcherEnv(home, extra = {}) {
  const env = {...process.env, COUNTINGHOUSE_HOME: home, CH_LOCAL_DEV: '1', ...extra};
  for (const name of require('../lib/packs').packVariables(ALLOWLIST, dogfood.PACK)) if (!(name in extra)) delete env[name];
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Whether get() comes to match re within ms: stderr and stdout are separate
// pipes, so a log line may arrive after the answer that followed it.
async function waitForText(get, re, ms) {
  for (const until = Date.now() + ms; ;) {
    if (re.test(get())) return true;
    if (Date.now() >= until) return false;
    await sleep(50);
  }
}

// Windows: a process tree from its root, ended at once (taskkill /T /F),
// bounded; taskkill by its path in the Windows directory (lib/win-acl.js
// windowsDir, a drive path), never by name: a program search looks in the
// current directory first. -> whether taskkill could be run.
function endTree(pid, ms = 10000) {
  try {
    const r = spawnSync(path.win32.join(require('../lib/win-acl').windowsDir(), 'System32', 'taskkill.exe'), ['/pid', String(pid), '/T', '/F'],
      {stdio: 'ignore', timeout: ms, windowsHide: true});
    return r.error == null;
  } catch (e) {
    return false;
  }
}
const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return false; } };

// Ends the launcher and everything it started (the runtime holds the same
// pipes): its process group, SIGTERM and then SIGKILL after ms; on Windows,
// taskkill of the tree, then waits for the launcher to be gone (TerminateProcess
// returns before it is), killing it directly at the bound. Safe after the
// launcher has exited. (On Windows a child whose launcher already ended is
// out of the tree taskkill sees: orphans are not re-parented there.)
async function stopTree(child, ms = 5000) {
  if (child == null || child.pid == null) return;
  if (process.platform === 'win32') {
    endTree(child.pid, ms);
    for (const until = Date.now() + ms; isAlive(child.pid) && Date.now() < until;) await sleep(100);
    if (isAlive(child.pid)) { try { child.kill(); } catch (e) { /* gone */ } }
    return;
  }
  const group = (sig) => { try { process.kill(-child.pid, sig); return true; } catch (err) { return false; } };
  if (!group('SIGTERM')) return;
  for (const until = Date.now() + ms; Date.now() < until;) {
    if (!group(0)) return;
    await sleep(100);
  }
  group('SIGKILL');
}

// The report's text, once the run's token is checked for: in no line the
// launcher or the runtime wrote (`logs`), and in nothing the report holds. The
// report is uploaded (CI keeps it as an artifact), so a token in it fails the
// run and is replaced, never written.
function reportText(report, token, logs) {
  // (token: the run's token, or a list of them: the own module's too)
  const all = Array.isArray(token) ? token : [token];
  const inLogs = logs.some((l) => typeof l === 'string' && all.some((t) => l.includes(t)));
  report.checks.push({name: 'the run\'s token is in no log line', ok: !inLogs});
  report.ok = report.checks.length > 0 && report.checks.every((c) => c.ok);
  const redactAll = (text) => all.reduce((x, t) => x.split(t).join('[the run\'s token]'), text);
  let text = JSON.stringify(report, null, 2) + '\n';
  if (all.some((t) => text.includes(t))) {
    report.checks.push({name: 'the run\'s token is in nothing the report holds', ok: false});
    report.ok = false;
    text = redactAll(JSON.stringify(report, null, 2) + '\n');
  }
  return text;
}

// An interrupted run (Ctrl-C, a cancelled job) still ends what it started and
// removes its work directory: on SIGINT or SIGTERM, cleanup() once, then
// exit(130 or 143). -> untrap(), which removes the handlers.
function trapSignals(cleanup, exit = (code) => process.exit(code)) {
  let caught = false;
  const handlers = {};
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    handlers[signal] = () => {
      if (caught) return;
      caught = true;
      Promise.resolve().then(cleanup).catch(() => {}).then(() => exit(code));
    };
    process.on(signal, handlers[signal]);
  }
  return () => { for (const [signal, h] of Object.entries(handlers)) process.removeListener(signal, h); };
}

// The user's own module for the run (A-own-skill): a scenario with no
// dependencies whose one tool reads GitHub's origin through a remote of its
// own, with a key of its own (variable OWN_GITHUB_TOKEN), and counts the
// commits it is given. Written to `dir`, outside the home. -> {dir, name}
const OWN_NAME = 'own-acceptance';
const OWN_TOOL = 'own_commit_count';
// (a header the own module's remote declares, so the stand-in knows each
// request's module -- handshakes too -- apart from the token it carried)
const OWN_HEADER = 'X-CH-Acceptance-Module';
function writeOwnModule(dir) {
  const svc = 'urn:ch-local-acceptance:serviceID:ownService';
  fs.mkdirSync(path.join(dir, 'handlers', 'ownService'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: OWN_NAME, version: '1.0.0', private: true, countinghouse: {role: 'scenario',
    remotes: [{name: 'github', transport: 'streamable-http', url: `${GITHUB}/mcp/`, headers: {[OWN_HEADER]: OWN_NAME}, credential: {env: 'OWN_GITHUB_TOKEN', header: 'Authorization', scheme: 'Bearer'}}]}}, null, 2));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: OWN_NAME, manufacturer: 'ch-local-acceptance', modelDescription: 'The acceptance run\'s own module: counts a repository\'s recent commits through GitHub\'s origin.',
    serviceList: {[svc]: {actionList: [{name: OWN_TOOL, description: 'Counts the recent commits of a repository (owner/name).', input: {schema: `/ownService/${OWN_TOOL}/input`}, output: {schema: `/ownService/${OWN_TOOL}/output`}}]}}}}, null, 2));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    ownService: {[OWN_TOOL]: {input: {type: 'object', properties: {repo: {type: 'string', pattern: '^[^/]+/[^/]+$', maxLength: 200}}, required: ['repo'], additionalProperties: false},
      output: {type: 'object', properties: {commits: {type: 'integer'}}, required: ['commits'], additionalProperties: false}}}}, null, 2));
  fs.writeFileSync(path.join(dir, 'handlers', 'ownService', `${OWN_TOOL}.js`), [
    '\'use strict\';',
    'module.exports = async (input, ctx) => {',
    '  const [owner, repo] = input.repo.split(\'/\');',
    '  const result = await ctx.call(\'remote:github/list_commits\', {owner, repo, perPage: 5});',
    '  const text = Array.isArray(result && result.content) && result.content[0] != null ? result.content[0].text : null;',
    '  if (result == null || result.isError === true || typeof text !== \'string\') throw ctx.error(\'REMOTE_FAILED\', \'GitHub\\\'s server did not list the commits\');',
    '  const list = JSON.parse(text);',
    '  return {output: {commits: Array.isArray(list) ? list.length : 0}};',
    '};',
    ''].join('\n'));
  return {dir: fs.realpathSync.native(dir), name: OWN_NAME};
}

// The own module added as the user adds it (A-own-skill). Linux and macOS:
// `add-module` itself, its question answered y on a pseudo-terminal
// (test/pty-answer.py). Windows has no pseudo-terminal here, so the yes is
// stood in: the installed ch-local's own addModule, run in this process with
// an io that answers y -- every check add-module makes before and after its
// yes, its lock and its record, only the terminal stood in (no variable and
// no flag loosens add-module itself). -> {name (the check's), ok, hash (the
// short hash added), output}
async function addOwn({home, node, launcher, dir, env, platform = process.platform}) {
  const added = (out) => new RegExp(`Added ${OWN_NAME} \\(own, ([0-9a-f]{12})\\): your clients see it now\\.`).exec(out);
  if (platform !== 'win32') {
    const r = spawnSync('python3', [path.join(__dirname, '..', 'test', 'pty-answer.py'), 'y', 'Add it? [y/N]', node, launcher, 'add-module', dir], {env, encoding: 'utf8', timeout: 120000});
    const out = `${r.stdout || ''}${r.stderr || ''}${r.error != null ? r.error.message : ''}`;
    const m = added(out);
    return {name: 'add-module: the own module added, its question answered y at a terminal', ok: r.status === 0 && m != null && /^It runs inside the same countinghouse runtime as your packs\.\r?$/m.test(out),
      hash: m != null ? m[1] : null, output: out};
  }
  const lib = (n) => require(path.join(home, 'app', 'node_modules', '@countinghouse', 'ch-local', 'lib', n));
  const name = 'the yes stood in (no pty on Windows): the installed add-module, answered y';
  let out = '';
  const asked = [];
  try {
    const io = {stdout: {write: (t) => { out += t; }}, stderr: {write: (t) => { out += t; }}, env, node, version: process.version, platform: process.platform, homedir: os.homedir,
      pid: process.pid, alive: lib('run-liveness.js').processAlive, hostname: os.hostname(), interactive: true, stdoutTTY: true,
      ask: async (q) => { asked.push(q); return 'y'; }};
    const code = await lib('own-command.js').addModule({dir}, io, {where: lib('home.js').layout(env, os.homedir)});
    const m = added(out);
    return {name, ok: code === 0 && m != null && asked.length === 1 && asked[0] === 'Add it? [y/N] ', hash: m != null ? m[1] : null, output: out};
  } catch (err) {
    return {name, ok: false, hash: null, output: `${out}${err.stack || err.message}`};
  }
}

// The work directory removed, the home's read-only copies of own modules
// too (ch-local#113): <home>/own made writable first by ch-local's own
// unlockTree (by lstat, never through a link), as uninstall does, then the
// tree removed. Never throws (it runs in a finally, where a throw would hide
// the run's own failure) -> null, or what could not be removed.
function removeTree(dir, home = path.join(dir, 'home')) {
  try { require('../lib/own-tree').unlockTree(path.join(home, 'own')); } catch (e) { /* the removal says it */ }
  try {
    fs.rmSync(dir, {recursive: true, force: true});
    return null;
  } catch (e) {
    return `${dir} was not removed (${e.code || e.message})`;
  }
}

async function main(argv, io = {stdout: process.stdout, stderr: process.stderr}) {
  const say = (s) => io.stdout.write(s + '\n');
  // generated per run, never a real one; redacted from every check's detail
  const token = `chacc_${crypto.randomBytes(24).toString('hex')}`;
  // the own module's key, a token of its own (A-own-skill)
  const ownToken = `chacc_${crypto.randomBytes(24).toString('hex')}`;
  const redact = (v) => String(v).split(token).join('[the run\'s token]').split(ownToken).join('[the run\'s token]');
  const report = {startedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, sources: [], checks: [], timings: {}, ok: false};
  const check = (name, ok, detail) => { report.checks.push({name, ok: ok === true, ...(detail != null ? {detail: redact(detail).slice(0, 2000)} : {})}); say(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail != null ? `: ${redact(detail).slice(0, 500)}` : ''}`); return ok; };
  const t0 = Date.now();
  const mark = (name) => { report.timings[name] = Date.now() - t0; };
  let reportFile = path.resolve('acceptance-report.json');
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--report') { if (argv[i + 1] == null) { io.stderr.write('acceptance: --report takes a file\n'); return 2; } reportFile = path.resolve(argv[++i]); } else rest.push(argv[i]);
  }
  let args;
  try { args = dogfood.parseArgs(rest); } catch (err) { io.stderr.write(err.message); return 2; }
  if (args.home != null) { io.stderr.write('acceptance: it always uses a clean home of its own; --home is not taken\n'); return 2; }
  const planned = dogfood.planSources(args);
  if (planned.problem != null) { io.stderr.write(`acceptance: ${planned.problem}\n`); return 1; }
  const refProblem = dogfood.resolveRefs(planned.sources);
  if (refProblem != null) { io.stderr.write(`acceptance: ${refProblem}\n`); return 1; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-acceptance-'));
  const home = path.join(work, 'home');
  const node = process.execPath;
  const launcher = path.join(home, 'bin', 'ch-local.js');
  let standIn = null;
  let child = null;
  let stderr = '';
  let offStderr = '';
  // (add-module's and the own key's output: checked for the tokens too)
  const ownLogs = [];
  report.work = work;
  // Ends what the run started, writes the report and removes the work
  // directory: once, whether the run ends, throws or is interrupted.
  let finished = null;
  const finish = (interrupted) => finished || (finished = (async () => {
    if (interrupted != null) check('the run was not interrupted', false, interrupted);
    // Whether or not the server exited on its own (a timeout leaves it running).
    if (child != null) await stopTree(child);
    if (standIn != null) await standIn.close();
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.length > 0 && report.checks.every((c) => c.ok);
    // The runtime's log on any failure, an early one included.
    if (!report.ok && stderr !== '') report.runtimeLog = stderr.split('\n').slice(-400).join('\n');
    try {
      fs.writeFileSync(reportFile, reportText(report, [token, ownToken], [stderr, offStderr, ...ownLogs]));
      say(`report: ${reportFile} (${report.ok ? 'passed' : 'FAILED'})`);
    } finally {
      const left = removeTree(work, home);
      if (left != null) io.stderr.write(`acceptance: ${left}\n`);
    }
  })());
  const untrap = trapSignals(() => finish('interrupted by a signal'));
  const run = async () => {
    const built = await dogfood.buildRelease(planned.sources, work, say);
    if (built.problem != null) { check('build from tarballs', false, built.problem); return 1; }
    report.sources = planned.sources.map((s) => ({repo: s.repo, ref: s.ref, commit: s.commit}));
    report.versions = Object.fromEntries(Object.entries(built.pins).map(([n, p]) => [n, p.version]));
    mark('built');
    check('build from tarballs', true);

    const installIo = {env: launcherEnv(home), node, version: process.version, platform: process.platform, homedir: os.homedir,
      alive: require('../lib/run-liveness').processAlive, hostname: os.hostname(),
      stdout: {write: () => {}}, stderr: io.stderr, exec: async (cmd, a, {cwd}) => dogfood.run(cmd, a, {cwd}),
      fetch: async () => { throw new Error('acceptance: install makes no network call of its own'); }};
    const code = await require('../lib/install').install({pack: dogfood.PACK, from: built.release, unreleasedPins: built.pinsFile}, installIo);
    mark('installed');
    if (!check('install into a clean home', code === 0, `exit ${code}`)) return 1;

    // The run's token is ch-access-github's credential, stored as a user
    // with no terminal would (#413 sections 6.2 and 6.9; L5a): piped on
    // standard input only, to the origin the module declares. It is never an
    // argument, never in an environment, never echoed or logged; the
    // command's own output names no value.
    const added = spawnSync(node, [launcher, 'credentials', 'add', 'ch-access-github', '--to', GITHUB],
      {env: launcherEnv(home), input: `${token}\n`, encoding: 'utf8', timeout: 30000});
    if (!check('the run\'s token stored for ch-access-github, piped on standard input', added.status === 0 && !String(added.stdout + added.stderr).includes(token),
      `exit ${added.status}: ${String(added.stderr).split(token).join('<token>').slice(-500)}`)) return 1;

    // The user's own module (A-own-skill), added before the start.
    const own = writeOwnModule(path.join(work, 'own-acceptance'));
    const ownAdded = await addOwn({home, node, launcher, dir: own.dir, env: launcherEnv(home)});
    ownLogs.push(ownAdded.output);
    if (!check(ownAdded.name, ownAdded.ok, ownAdded.output)) return 1;
    const ownKey = spawnSync(node, [launcher, 'credentials', 'add', own.name, '--to', GITHUB],
      {env: launcherEnv(home), input: `${ownToken}\n`, encoding: 'utf8', timeout: 30000});
    ownLogs.push(String(ownKey.stdout) + String(ownKey.stderr));
    if (!check('the own module\'s own token stored for it, piped on standard input', ownKey.status === 0 && !String(ownKey.stdout + ownKey.stderr).includes(ownToken),
      `exit ${ownKey.status}: ${redact(String(ownKey.stderr)).slice(-500)}`)) return 1;

    const off = spawnSync(node, [launcher, 'start', '--stdio', '--moduleSandbox', 'off'], {env: launcherEnv(home), input: '', encoding: 'utf8', timeout: 30000});
    offStderr = String(off.stderr);
    check('start --moduleSandbox off is refused and starts no runtime', off.status === 2 && /--moduleSandbox off is not allowed/.test(off.stderr) && !/countinghouse serves MCP/.test(off.stderr), off.stderr);

    // Before the pack starts: the installed runtime must know --remoteOriginMap
    // and gate it. A runtime that ignored the option would send the pack's
    // listing at load to GitHub itself (with the generated token, but still).
    const probeStore = path.join(work, 'probe-store');
    const probe = spawnSync(node, [path.join(home, 'app', 'node_modules', 'countinghouse', 'bin', 'countinghouse-stdio.js'), '--store', 'local', '--storePath', probeStore,
      '--remoteOriginMap', `${GITHUB}=http://127.0.0.1:1`], {env: launcherEnv(home, {COUNTINGHOUSE_ACCEPTANCE: ''}), input: '', encoding: 'utf8', timeout: 30000});
    fs.rmSync(probeStore, {recursive: true, force: true});
    if (!check('the runtime knows --remoteOriginMap and gates it (else nothing is started)', probe.status === 2 && /--remoteOriginMap needs COUNTINGHOUSE_ACCEPTANCE=1/.test(probe.stderr), `exit ${probe.status}: ${String(probe.stderr).slice(-500)}`)) return 1;

    const fixtures = path.join(work, 'src', 'ch-pack-ci-failure-triage', 'test', 'fixtures', 'mcp-results');
    standIn = await startStandIn({fixtures, tokens: {pack: token, own: ownToken}});
    const repo = path.join(work, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), {recursive: true});
    fs.writeFileSync(path.join(repo, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/${RECORDED_REPO}.git\n`);
    // In a process group of its own, so the runtime it starts ends with it (stopTree).
    child = spawn(node, [launcher, 'start', '--stdio'], {cwd: repo, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: launcherEnv(home, {CH_LOCAL_REMOTE_MAP: `${GITHUB}=http://127.0.0.1:${standIn.port}`, COUNTINGHOUSE_ACCEPTANCE: '1'})});
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr += d;
      // Every composition verdict delivered (the runtime's ready line), looked
      // for in the new text only.
      if (report.timings.ready == null && /countinghouse ready/.test(stderr.slice(-(d.length + 64)))) mark('ready');
    });
    mark('started');
    const exited = new Promise((resolve) => child.on('exit', (c) => resolve(c)));
    const mcp = session(child);
    const init = await mcp.request('initialize', {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'ch-local-acceptance', version: '1'}});
    if (!check('the server answers initialize', init.result != null, stderr.slice(-2000))) return 1;
    mcp.notify('notifications/initialized', {});
    check('the sandbox is enforced', await waitForText(() => stderr, /module sandbox: mode enforce/, 10000), stderr.slice(-1000));
    check('the GitHub origin goes to the stand-in, logged as acceptance only', await waitForText(() => stderr, /remote origin mapped: https:\/\/api\.githubcopilot\.com -> http:\/\/127\.0\.0\.1:\d+ \(acceptance only\)/, 10000), stderr.slice(-1000));

    let tools = [];
    for (const until = Date.now() + 60000; Date.now() < until;) {
      tools = ((await mcp.request('tools/list', {})).result.tools || []).map((x) => x.name).sort();
      if (tools.includes('ci_failure_triage') && tools.includes(OWN_TOOL)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    mark('listed');
    // exactly these, sorted: the pack's one tool and the runtime's six
    // built-ins (the overview in every mode, countinghouse #490; the usage
    // report; and, in the single-identity profile with --settingsFile, the
    // settings tool and the three for building your own module, countinghouse
    // #499), and the user's own module's tool (A-own-skill); anything else fails
    const TOOLS = ['ci_failure_triage', 'countinghouse_load_module', 'countinghouse_overview', 'countinghouse_settings', 'countinghouse_usage_report', 'countinghouse_validate_module', 'countinghouse_validate_plan', OWN_TOOL];
    check(`tools/list is exactly ${TOOLS.join(', ')}`, JSON.stringify(tools) === JSON.stringify(TOOLS), JSON.stringify(tools));

    const called = await mcp.request('tools/call', {name: 'ci_failure_triage', arguments: {repo: RECORDED_REPO}});
    mark('firstResult');
    const result = called.result || {};
    const receipt = result._meta != null ? result._meta['countinghouse/receipt'] : null;
    const sentence = Array.isArray(result.content) && result.content[1] != null ? result.content[1].text : '';
    check('ci_failure_triage answers with summary and coverage', result.isError !== true && result.structuredContent != null && typeof result.structuredContent.summary === 'string' && result.structuredContent.coverage != null,
      `${JSON.stringify(called).slice(0, 1200)}\n--- runtime stderr ---\n${stderr.split('\n').filter((l) => /ready|composition|loaded|spawn walk|error|refused/i.test(l)).slice(-25).join('\n')}`);
    check('the receipt counts the calls to github, marked as the stand-in\'s', receipt != null && receipt.calls > 0 && JSON.stringify(receipt.servers) === '["github"]' && JSON.stringify(receipt.standIn) === '["github"]' && ['linesIn', 'bytesIn', 'linesOut', 'bytesOut'].every((k) => Number.isInteger(receipt[k])), JSON.stringify(receipt));
    check('the receipt\'s sentence marks the acceptance stand-in', RECEIPT.test(sentence), sentence);
    check('the stand-in saw only this run\'s tokens, and every call was recorded', standIn.state.refused === 0 && standIn.state.unexpected.length === 0, JSON.stringify(standIn.state));
    const packCalls = standIn.state.calls.length;
    check('install to first result in under 5 minutes', report.timings.firstResult - report.timings.built < LIMIT_MS, `${report.timings.firstResult - report.timings.built} ms`);

    const usage = await mcp.request('tools/call', {name: 'countinghouse_usage_report', arguments: {}});
    // The stand-in's calls are no measurement: in no total, only in standIn (countinghouse #128).
    const report1 = usage.result && usage.result.structuredContent ? usage.result.structuredContent : null;
    check('the usage report counts every receipt call as the stand-in\'s, and none as a real server call',
      report1 != null && receipt != null && report1.totals.serverCalls === 0 && report1.standIn != null && report1.standIn.serverCalls === receipt.calls &&
      JSON.stringify(Object.keys(report1.standIn.servers)) === '["github"]', JSON.stringify(report1 != null ? {totals: report1.totals, standIn: report1.standIn} : null));

    // The own module's tool (A-own-skill): the code start loads is the copy
    // confirmed, and it reaches GitHub's origin (the stand-in) with its own
    // token, never the pack's; the pack's calls carried the pack's, never
    // its (bucket 1: one module's key is never another's).
    const ownRecord = JSON.parse(fs.readFileSync(path.join(home, 'own.json'), 'utf8')).modules[own.name];
    const {copyIntact} = require(path.join(home, 'app', 'node_modules', '@countinghouse', 'ch-local', 'lib', 'own-tree.js'));
    const {layout} = require(path.join(home, 'app', 'node_modules', '@countinghouse', 'ch-local', 'lib', 'home.js'));
    check('the copy start loads is the one confirmed: its hash, the record\'s and start\'s line agree',
      ownRecord != null && ownRecord.tree.startsWith(ownAdded.hash) && copyIntact(layout(launcherEnv(home)), own.name, ownRecord.tree) &&
      new RegExp(`own modules: ${own.name} ${ownAdded.hash}\\b`).test(stderr), `added ${ownAdded.hash}, recorded ${ownRecord != null ? ownRecord.tree : null}`);
    const ownCalled = await mcp.request('tools/call', {name: OWN_TOOL, arguments: {repo: RECORDED_REPO}});
    const ownResult = ownCalled.result || {};
    check('the own module\'s tool answers through GitHub\'s origin', ownResult.isError !== true && ownResult.structuredContent != null && Number.isInteger(ownResult.structuredContent.commits) && ownResult.structuredContent.commits > 0,
      `${JSON.stringify(ownCalled).slice(0, 1200)}\n--- runtime stderr ---\n${stderr.split('\n').filter((l) => /own|error|refused/i.test(l)).slice(-25).join('\n')}`);
    const packBy = standIn.state.by.slice(0, packCalls);
    const ownBy = standIn.state.by.slice(packCalls);
    // (every request, handshakes too, by the module it came from: the own
    // module's remote alone sends OWN_HEADER)
    const seenOwn = standIn.state.seen.filter((r) => r.module === OWN_NAME);
    const seenPack = standIn.state.seen.filter((r) => r.module == null);
    check('each token reached the stand-in only on its own module\'s requests: the pack\'s the pack\'s, the own module\'s its own, handshakes included',
      packBy.length > 0 && packBy.every((w) => w === 'pack') && ownBy.length > 0 && ownBy.every((w) => w === 'own') &&
      seenOwn.length > 0 && seenOwn.every((r) => r.who === 'own') && seenPack.length > 0 && seenPack.every((r) => r.who === 'pack') &&
      seenOwn.length + seenPack.length === standIn.state.seen.length && standIn.state.refused === 0 && standIn.state.unexpected.length === 0,
      JSON.stringify({calls: standIn.state.calls, by: standIn.state.by, seen: standIn.state.seen, unexpected: standIn.state.unexpected}));

    // the own module's server calls, like the pack's: the stand-in's, none
    // as a real server call
    const usage2 = await mcp.request('tools/call', {name: 'countinghouse_usage_report', arguments: {}});
    const report2 = usage2.result && usage2.result.structuredContent ? usage2.result.structuredContent : null;
    check('the usage report counts the own module\'s calls as the stand-in\'s too, and none as a real server call',
      report2 != null && report1 != null && report2.totals.serverCalls === 0 && report2.standIn != null && report2.standIn.serverCalls > report1.standIn.serverCalls,
      JSON.stringify(report2 != null ? {totals: report2.totals, standIn: report2.standIn} : null));

    child.stdin.end();
    const code2 = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 30000))]);
    check('the server exits when the client closes stdin', code2 !== 'timeout', String(code2));
    // the store holds it (readable by this user only); no other file does
    const leaks = filesContaining(home, token);
    check('the token is in no file under the home but the credential store', leaks.length === 1 && leaks[0] === path.join('credentials', 'credentials.json'), leaks.join(', '));
    const ownLeaks = filesContaining(home, ownToken);
    check('the own module\'s token is in no file under the home but the credential store', ownLeaks.length === 1 && ownLeaks[0] === path.join('credentials', 'credentials.json'), ownLeaks.join(', '));
    const usageFiles = fs.existsSync(path.join(home, 'store', 'usage')) ? fs.readdirSync(path.join(home, 'store', 'usage'), {recursive: true}).filter((f) => String(f).endsWith('.jsonl')) : [];
    const records = usageFiles.flatMap((f) => fs.readFileSync(path.join(home, 'store', 'usage', String(f)), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const serverRecords = records.filter((r) => r.server != null && r.bytesIn !== undefined);
    check('every server-call usage record is marked mapped', serverRecords.length > 0 && serverRecords.every((r) => r.mapped === true), `${serverRecords.length} records`);

    const un = spawnSync(node, [launcher, 'uninstall'], {env: launcherEnv(home), input: 'yes\n', encoding: 'utf8', timeout: 60000});
    mark('uninstalled');
    check('uninstall leaves nothing', un.status === 0 && !fs.existsSync(home), `${un.status} ${un.stderr.slice(-500)}`);
    return report.checks.every((c) => c.ok) ? 0 : 1;
  };
  let code = 1;
  try {
    code = await run();
  } catch (err) {
    check('the run completed', false, err.stack || err.message);
    code = 1;
  } finally {
    untrap();
    await finish();
  }
  // the token checks run in finish(): a leak there fails the run too
  return code === 0 && !report.ok ? 1 : code;
}

// Run only when executed, never when required: test/acceptance.test.js requires it.
if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(`acceptance: ${err.message}\n`); process.exitCode = 1; });
}

module.exports = {main, reportText, trapSignals, startStandIn, recordedAnswer, filesContaining, launcherEnv, waitForText, stopTree, endTree, writeOwnModule, addOwn, removeTree, RECEIPT};
