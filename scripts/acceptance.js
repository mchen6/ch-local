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
//   4. speaks MCP: tools/list is exactly ci_failure_triage and
//      countinghouse_usage_report; one ci_failure_triage call answers with a
//      receipt marked "(acceptance stand-in)"; the usage report counts one
//      server call per receipt call;
//   5. after the server exits, checks that the token (generated per run,
//      never a real one) is in no file under the home;
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
// JSON answers. A request without exactly the run's token is refused (401).
// Every call it has no recording for is an isError answer, and counted.
function startStandIn({fixtures, token}) {
  const tools = JSON.parse(fs.readFileSync(path.join(fixtures, 'tools-list.json'), 'utf8')).tools;
  const state = {requests: 0, refused: 0, calls: [], unexpected: []};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      state.requests += 1;
      if (req.headers.authorization !== `Bearer ${token}`) {
        state.refused += 1;
        res.writeHead(401, {'content-type': 'text/plain'});
        return res.end('the acceptance stand-in takes only this run\'s token');
      }
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      let msg;
      try { msg = JSON.parse(body); } catch (err) { res.writeHead(400); return res.end(); }
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

// The environment for every launcher command: no token of this shell's, the dev switches.
function launcherEnv(home, extra = {}) {
  const env = {...process.env, COUNTINGHOUSE_HOME: home, CH_LOCAL_DEV: '1', ...extra};
  for (const name of ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']) if (!(name in extra)) delete env[name];
  return env;
}

async function main(argv, io = {stdout: process.stdout, stderr: process.stderr}) {
  const say = (s) => io.stdout.write(s + '\n');
  const report = {startedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, node: process.version, sources: [], checks: [], timings: {}, ok: false};
  const check = (name, ok, detail) => { report.checks.push({name, ok: ok === true, ...(detail != null ? {detail: String(detail).slice(0, 2000)} : {})}); say(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail != null ? `: ${String(detail).slice(0, 500)}` : ''}`); return ok; };
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
  const token = `chacc_${crypto.randomBytes(24).toString('hex')}`;
  const node = process.execPath;
  const launcher = path.join(home, 'bin', 'ch-local.js');
  let standIn = null;
  let child = null;
  try {
    const built = await dogfood.buildRelease(planned.sources, work, say);
    if (built.problem != null) { check('build from tarballs', false, built.problem); return 1; }
    report.sources = planned.sources.map((s) => ({repo: s.repo, ref: s.ref, commit: s.commit}));
    report.versions = Object.fromEntries(Object.entries(built.pins).map(([n, p]) => [n, p.version]));
    mark('built');
    check('build from tarballs', true);

    const installIo = {env: launcherEnv(home), node, version: process.version, platform: process.platform, homedir: os.homedir,
      stdout: {write: () => {}}, stderr: io.stderr, exec: async (cmd, a, {cwd}) => dogfood.run(cmd, a, {cwd}),
      fetch: async () => { throw new Error('acceptance: install makes no network call of its own'); }};
    const code = await require('../lib/install').install({pack: dogfood.PACK, from: built.release, unreleasedPins: built.pinsFile}, installIo);
    mark('installed');
    if (!check('install into a clean home', code === 0, `exit ${code}`)) return 1;

    const off = spawnSync(node, [launcher, 'start', '--stdio', '--moduleSandbox', 'off'], {env: launcherEnv(home, {COUNTINGHOUSE_GITHUB_TOKEN: token}), input: '', encoding: 'utf8', timeout: 30000});
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
    standIn = await startStandIn({fixtures, token});
    const repo = path.join(work, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), {recursive: true});
    fs.writeFileSync(path.join(repo, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/${RECORDED_REPO}.git\n`);
    let stderr = '';
    child = spawn(node, [launcher, 'start', '--stdio'], {cwd: repo, stdio: ['pipe', 'pipe', 'pipe'],
      env: launcherEnv(home, {COUNTINGHOUSE_GITHUB_TOKEN: token, CH_LOCAL_REMOTE_MAP: `${GITHUB}=http://127.0.0.1:${standIn.port}`, COUNTINGHOUSE_ACCEPTANCE: '1'})});
    child.stderr.on('data', (d) => {
      stderr += d;
      // Every composition verdict delivered (the runtime's ready line).
      if (report.timings.ready == null && /countinghouse ready/.test(stderr)) mark('ready');
    });
    mark('started');
    const exited = new Promise((resolve) => child.on('exit', (c) => resolve(c)));
    const mcp = session(child);
    const init = await mcp.request('initialize', {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'ch-local-acceptance', version: '1'}});
    if (!check('the server answers initialize', init.result != null, stderr.slice(-2000))) return 1;
    mcp.notify('notifications/initialized', {});
    check('the sandbox is enforced', /module sandbox: mode enforce/.test(stderr), stderr.slice(-1000));
    check('the GitHub origin goes to the stand-in, logged as acceptance only', /remote origin mapped: https:\/\/api\.githubcopilot\.com -> http:\/\/127\.0\.0\.1:\d+ \(acceptance only\)/.test(stderr), stderr.slice(-1000));

    let tools = [];
    for (const until = Date.now() + 60000; Date.now() < until;) {
      tools = ((await mcp.request('tools/list', {})).result.tools || []).map((x) => x.name).sort();
      if (tools.includes('ci_failure_triage')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    mark('listed');
    check('tools/list is exactly ci_failure_triage and countinghouse_usage_report', JSON.stringify(tools) === JSON.stringify(['ci_failure_triage', 'countinghouse_usage_report']), JSON.stringify(tools));

    const called = await mcp.request('tools/call', {name: 'ci_failure_triage', arguments: {repo: RECORDED_REPO}});
    mark('firstResult');
    const result = called.result || {};
    const receipt = result._meta != null ? result._meta['countinghouse/receipt'] : null;
    const sentence = Array.isArray(result.content) && result.content[1] != null ? result.content[1].text : '';
    check('ci_failure_triage answers with summary and coverage', result.isError === false && result.structuredContent != null && typeof result.structuredContent.summary === 'string' && result.structuredContent.coverage != null,
      `${JSON.stringify(called).slice(0, 1200)}\n--- runtime stderr ---\n${stderr.split('\n').filter((l) => /ready|composition|loaded|spawn walk|error|refused/i.test(l)).slice(-25).join('\n')}`);
    check('the receipt counts the calls to github', receipt != null && receipt.calls > 0 && JSON.stringify(receipt.servers) === '["github"]' && ['linesIn', 'bytesIn', 'linesOut', 'bytesOut'].every((k) => Number.isInteger(receipt[k])), JSON.stringify(receipt));
    check('the receipt\'s sentence marks the acceptance stand-in', RECEIPT.test(sentence), sentence);
    check('the stand-in saw only this run\'s token, and every call was recorded', standIn.state.refused === 0 && standIn.state.unexpected.length === 0, JSON.stringify(standIn.state));
    check('install to first result in under 5 minutes', report.timings.firstResult - report.timings.built < LIMIT_MS, `${report.timings.firstResult - report.timings.built} ms`);

    const usage = await mcp.request('tools/call', {name: 'countinghouse_usage_report', arguments: {}});
    const totals = usage.result && usage.result.structuredContent ? usage.result.structuredContent.totals : null;
    check('the usage report counts one server call per receipt call', totals != null && receipt != null && totals.serverCalls === receipt.calls, JSON.stringify(totals));

    child.stdin.end();
    const code2 = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 30000))]);
    // The runtime's log, kept when a check failed (it holds no token: the scan below checks the home).
    if (report.checks.some((c) => !c.ok)) report.runtimeLog = stderr.split('\n').slice(-400).join('\n');
    child = null;
    check('the server exits when the client closes stdin', code2 !== 'timeout', String(code2));
    const leaks = filesContaining(home, token);
    check('the token is in no file under the home', leaks.length === 0, leaks.join(', '));
    const usageFiles = fs.existsSync(path.join(home, 'store', 'usage')) ? fs.readdirSync(path.join(home, 'store', 'usage'), {recursive: true}).filter((f) => String(f).endsWith('.jsonl')) : [];
    const records = usageFiles.flatMap((f) => fs.readFileSync(path.join(home, 'store', 'usage', String(f)), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
    const serverRecords = records.filter((r) => r.server != null && r.bytesIn !== undefined);
    check('every server-call usage record is marked mapped', serverRecords.length > 0 && serverRecords.every((r) => r.mapped === true), `${serverRecords.length} records`);

    const un = spawnSync(node, [launcher, 'uninstall'], {env: launcherEnv(home), input: 'yes\n', encoding: 'utf8', timeout: 60000});
    mark('uninstalled');
    check('uninstall leaves nothing', un.status === 0 && !fs.existsSync(home), `${un.status} ${un.stderr.slice(-500)}`);
    report.ok = report.checks.every((c) => c.ok);
    return report.ok ? 0 : 1;
  } catch (err) {
    check('the run completed', false, err.stack || err.message);
    return 1;
  } finally {
    if (child != null) child.kill('SIGKILL');
    if (standIn != null) await standIn.close();
    report.finishedAt = new Date().toISOString();
    report.ok = report.checks.length > 0 && report.checks.every((c) => c.ok);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    say(`report: ${reportFile} (${report.ok ? 'passed' : 'FAILED'})`);
    fs.rmSync(work, {recursive: true, force: true});
  }
}

// Run only when executed, never when required: test/acceptance.test.js requires it.
if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(`acceptance: ${err.message}\n`); process.exitCode = 1; });
}

module.exports = {main, startStandIn, recordedAnswer, filesContaining, launcherEnv, RECEIPT};
