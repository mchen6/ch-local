'use strict';
// scripts/acceptance.js (plan Task 13; reviewer, 2026-11-12): the parts that
// run without a build, and the whole run, gated on local clones
// (CH_ACCEPTANCE_SRC, with CH_ACCEPTANCE_CLONES and CH_ACCEPTANCE_REFS as
// repo=value pairs, like dogfood's).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {tmp} = require('./fake-io');
const acceptance = require('../scripts/acceptance');

// A fixtures directory in the recorded shape, small.
function fixtures() {
  const dir = tmp('ch-acc-fx-');
  const env = (result) => JSON.stringify({_recorded: 'test', request: {}, result});
  fs.writeFileSync(path.join(dir, 'tools-list.json'), JSON.stringify({_recorded: 'test', tools: [{name: 'actions_list', inputSchema: {type: 'object'}}]}));
  fs.writeFileSync(path.join(dir, 'list_workflow_runs.json'), env({content: [{type: 'text', text: '{"workflow_runs": []}'}]}));
  fs.writeFileSync(path.join(dir, 'get_job_logs-7.json'), env({content: [{type: 'text', text: 'log'}]}));
  return dir;
}
const post = async (port, token, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/mcp/`, {method: 'POST', headers: {'content-type': 'application/json', ...(token != null ? {authorization: `Bearer ${token}`} : {})}, body: JSON.stringify(body)});
  return {status: r.status, body: r.status === 200 ? await r.json() : await r.text()};
};

test('requiring the script runs nothing', () => {
  assert.strictEqual(typeof acceptance.main, 'function');
});

test('the stand-in takes only the run\'s token, lists the recorded tools and answers from the recordings', async () => {
  const s = await acceptance.startStandIn({fixtures: fixtures(), token: 'chacc_right'});
  try {
    assert.strictEqual((await post(s.port, 'chacc_wrong', {jsonrpc: '2.0', id: 1, method: 'tools/list'})).status, 401);
    assert.strictEqual((await post(s.port, null, {jsonrpc: '2.0', id: 1, method: 'tools/list'})).status, 401);
    assert.strictEqual(s.state.refused, 2);
    const init = await post(s.port, 'chacc_right', {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18'}});
    assert.strictEqual(init.body.result.protocolVersion, '2025-06-18');
    assert.deepStrictEqual((await post(s.port, 'chacc_right', {jsonrpc: '2.0', id: 2, method: 'tools/list'})).body.result.tools.map((t) => t.name), ['actions_list']);
    const runs = await post(s.port, 'chacc_right', {jsonrpc: '2.0', id: 3, method: 'tools/call', params: {name: 'actions_list', arguments: {method: 'list_workflow_runs'}}});
    assert.deepStrictEqual(runs.body.result, {content: [{type: 'text', text: '{"workflow_runs": []}'}]});
    const odd = await post(s.port, 'chacc_right', {jsonrpc: '2.0', id: 4, method: 'tools/call', params: {name: 'get_job_logs', arguments: {job_id: '../../etc/passwd'}}});
    assert.strictEqual(odd.body.result.isError, true, 'no recording, and no path from the arguments');
    assert.deepStrictEqual(s.state.unexpected.map((u) => u.tool), ['get_job_logs']);
  } finally {
    await s.close();
  }
});

test('filesContaining finds a needle in any file below a directory, and nothing in an absent one', () => {
  const dir = tmp('ch-acc-scan-');
  fs.mkdirSync(path.join(dir, 'a', 'b'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'a', 'b', 'x.jsonl'), '{"k": "chacc_123"}\n');
  fs.writeFileSync(path.join(dir, 'y'), 'nothing');
  assert.deepStrictEqual(acceptance.filesContaining(dir, 'chacc_123'), [path.join('a', 'b', 'x.jsonl')]);
  assert.deepStrictEqual(acceptance.filesContaining(path.join(dir, 'none'), 'x'), []);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('the launcher environment carries no token of this shell\'s unless given one', () => {
  const before = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_from_the_shell';
  try {
    const env = acceptance.launcherEnv('/h', {COUNTINGHOUSE_GITHUB_TOKEN: 'chacc_x'});
    assert.strictEqual(env.GITHUB_TOKEN, undefined);
    assert.strictEqual(env.COUNTINGHOUSE_GITHUB_TOKEN, 'chacc_x');
    assert.strictEqual(env.CH_LOCAL_DEV, '1');
    assert.strictEqual(env.COUNTINGHOUSE_HOME, '/h');
  } finally {
    if (before === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = before;
  }
});

test('the receipt pattern: a stand-in run, and only that', () => {
  assert.match('read 1,204 lines (88.1 KB) in 4 calls to github (acceptance stand-in); 31 lines (2.4 KB) reached the model.', acceptance.RECEIPT);
  assert.doesNotMatch('read 1,204 lines (88.1 KB) in 4 calls to github; 31 lines (2.4 KB) reached the model.', acceptance.RECEIPT);
});

// The review of the acceptance branch (2026-11-12).
test('the launcher environment drops every credential the pack\'s allowlist names', () => {
  const {ALLOWLIST} = require('../lib/allowlist');
  const names = ALLOWLIST.packs[require('../scripts/dogfood').PACK].credentials;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  try {
    for (const n of names) process.env[n] = 'from-this-shell';
    const env = acceptance.launcherEnv('/h');
    for (const n of names) assert.ok(!(n in env), n);
  } finally {
    for (const n of names) { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }
  }
});

test('waitForText waits for a line that comes later, and gives up after its time', async () => {
  let text = '';
  setTimeout(() => { text += 'module sandbox: mode enforce\n'; }, 150);
  assert.strictEqual(await acceptance.waitForText(() => text, /mode enforce/, 2000), true);
  assert.strictEqual(await acceptance.waitForText(() => text, /never/, 200), false);
});

test('stopTree ends the launcher and what it started, which holds the same pipes', {skip: process.platform === 'win32' && 'taskkill /T on Windows'}, async () => {
  const {spawn} = require('node:child_process');
  // A launcher that starts a long-lived child on inherited pipes, as start does.
  const code = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'}); console.log(c.pid); setInterval(() => {}, 1000);";
  const launcher = spawn(process.execPath, ['-e', code], {stdio: ['pipe', 'pipe', 'pipe'], detached: true});
  const grandchild = await new Promise((resolve) => launcher.stdout.once('data', (d) => resolve(parseInt(String(d), 10))));
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return false; } };
  assert.ok(alive(grandchild));
  await acceptance.stopTree(launcher, 3000);
  for (const until = Date.now() + 3000; (alive(grandchild) || alive(launcher.pid)) && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!alive(launcher.pid), 'the launcher ended');
  assert.ok(!alive(grandchild), 'what it started ended too');
});

// The report is uploaded (an artifact of the run): the run's token is in no
// line the runtime or the launcher wrote, and in nothing the report holds.
test('reportText: a token in a log fails the run, and is never written', () => {
  const token = 'chacc_00000000000000000000000000000000fake';
  const clean = {checks: [{name: 'a', ok: true}], ok: true};
  const text = acceptance.reportText(clean, token, ['no secret here']);
  assert.strictEqual(JSON.parse(text).ok, true);
  assert.ok(JSON.parse(text).checks.some((c) => c.name === 'the run\'s token is in no log line' && c.ok === true));

  const leaked = {checks: [{name: 'a', ok: true, detail: `saw Bearer ${token}`}], ok: true, runtimeLog: `x ${token} y`};
  const out = acceptance.reportText(leaked, token, [`x ${token} y`]);
  assert.ok(!out.includes(token), 'the token is never in the report text');
  const r = JSON.parse(out);
  assert.strictEqual(r.ok, false);
  assert.ok(r.checks.some((c) => c.name === 'the run\'s token is in no log line' && c.ok === false));
  assert.ok(r.checks.some((c) => c.name === 'the run\'s token is in nothing the report holds' && c.ok === false));
});

test('trapSignals: SIGINT and SIGTERM run the cleanup once, then exit 130 and 143; untrapped, nothing runs', async () => {
  for (const [signal, want] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    let cleaned = 0;
    let exited = null;
    const untrap = acceptance.trapSignals(async () => { cleaned += 1; }, (code) => { exited = code; });
    process.emit(signal, signal);
    process.emit(signal, signal);
    for (const until = Date.now() + 2000; exited == null && Date.now() < until;) await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(cleaned, 1, `${signal}: cleaned once`);
    assert.strictEqual(exited, want, signal);
    untrap();
  }
  let ran = false;
  const before = process.listenerCount('SIGTERM');
  acceptance.trapSignals(async () => { ran = true; }, () => {})();
  assert.strictEqual(process.listenerCount('SIGTERM'), before, 'untrap removes its handlers');
  assert.strictEqual(ran, false);
});

const SRC = process.env.CH_ACCEPTANCE_SRC;
test('the whole acceptance run', {timeout: 1200000, skip: SRC == null && 'CH_ACCEPTANCE_SRC is not set (a directory of clones)'}, async () => {
  const pairs = (v, flag) => (v || '').split(',').filter(Boolean).flatMap((p) => [flag, p]);
  // CI keeps the report as an artifact (.github/workflows/acceptance.yml).
  const reportFile = process.env.CH_ACCEPTANCE_REPORT != null ? path.resolve(process.env.CH_ACCEPTANCE_REPORT) : path.join(tmp('ch-acc-report-'), 'report.json');
  const out = {text: '', write(s) { this.text += s; }};
  const code = await acceptance.main(['--src', SRC, ...pairs(process.env.CH_ACCEPTANCE_CLONES, '--clone'), ...pairs(process.env.CH_ACCEPTANCE_REFS, '--ref'), '--report', reportFile], {stdout: out, stderr: out});
  // The exit code first: a preflight that fails writes no report.
  assert.strictEqual(code, 0, out.text.slice(-4000));
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.strictEqual(report.ok, true);
  assert.ok(report.checks.length >= 15, `${report.checks.length} checks`);
  assert.ok(Number.isInteger(report.timings.firstResult));
  assert.ok(typeof report.work === 'string' && !fs.existsSync(report.work), `this run's work directory is removed: ${report.work}`);
});

// The shared runtime through the native shim (MCP completeness M17;
// scripts/shared-acceptance.js has what it covers and what it does not yet).
const shared = require('../scripts/shared-acceptance');

test('shared: the client harness is a `claude` beside a script and an empty configuration, all in the run\'s directory', () => {
  const dir = path.join(tmp('ch-shared-h-'), 'client');
  const h = shared.claudeHarness(dir);
  assert.strictEqual(path.basename(h.claude).replace(/\.exe$/, ''), 'claude');
  for (const p of [h.claude, h.script, h.config]) assert.ok(p.startsWith(dir + path.sep), p);
  assert.deepStrictEqual(fs.readdirSync(h.config), []);
  fs.rmSync(path.dirname(dir), {recursive: true, force: true});
});

test('shared: the shim goes in a private <home>/shim, executable by its owner only', {skip: process.platform === 'win32' && 'POSIX modes'}, () => {
  const home = tmp('ch-shared-home-');
  const bin = path.join(home, 'built');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const to = shared.installShim(home, bin);
  assert.strictEqual(to, path.join(home, 'shim', 'ch-shim'));
  assert.strictEqual(fs.statSync(path.join(home, 'shim')).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(to).mode & 0o777, 0o700);
  fs.rmSync(home, {recursive: true, force: true});
});

test('shared: daemonPid reads daemon.json\'s pid, and null for none or a bad one', () => {
  const home = tmp('ch-shared-d-');
  assert.strictEqual(shared.daemonPid(home), null);
  fs.mkdirSync(path.join(home, 'run', 'daemon'), {recursive: true});
  fs.writeFileSync(path.join(home, 'run', 'daemon', 'daemon.json'), '{"pid": "7"}');
  assert.strictEqual(shared.daemonPid(home), null);
  fs.writeFileSync(path.join(home, 'run', 'daemon', 'daemon.json'), '{"pid": 4242}');
  assert.strictEqual(shared.daemonPid(home), 4242);
  fs.rmSync(home, {recursive: true, force: true});
});

test('shared: treeOf lists a process and its descendants, and nothing else', {skip: process.platform === 'win32' && 'POSIX ps'}, async () => {
  const {spawn} = require('node:child_process');
  const parent = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], {stdio: 'ignore'}); setTimeout(()=>{}, 5000)"], {stdio: 'ignore'});
  try {
    let tree = [];
    for (const until = Date.now() + 5000; Date.now() < until && tree.length < 2;) {
      tree = shared.treeOf(parent.pid) || [];
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.strictEqual(tree.length, 2, JSON.stringify(tree));
    assert.ok(tree.some((p) => p.pid === parent.pid));
    assert.ok(!tree.some((p) => p.pid === process.pid), 'not its parent');
  } finally {
    for (const p of shared.treeOf(parent.pid) || []) { try { process.kill(p.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
  }
});

// Gated as the whole run is. The windows acceptance leg is still the known
// non-gating red: there the daemon is not yet available (C4c), and what this
// checks is the per-session fallback, so its result there is informational.
test('the shared runtime through the native shim', {timeout: 2400000, skip: SRC == null && 'CH_ACCEPTANCE_SRC is not set (a directory of clones)'}, async () => {
  const pairs = (v, flag) => (v || '').split(',').filter(Boolean).flatMap((p) => [flag, p]);
  const reportFile = path.join(tmp('ch-shared-report-'), 'report.json');
  const out = {text: '', write(s) { this.text += s; }};
  const code = await shared.main(['--src', SRC, ...pairs(process.env.CH_ACCEPTANCE_CLONES, '--clone'), ...pairs(process.env.CH_ACCEPTANCE_REFS, '--ref'), '--report', reportFile],
    {stdout: out, stderr: out});
  assert.strictEqual(code, 0, out.text.slice(-4000));
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.strictEqual(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
});

// Not yet through the real shim (scripts/shared-acceptance.js says where each
// is covered meanwhile): todos, never skips, so the acceptance workflow's
// "skipped 0" still holds.
test('shared: (a) progress frames before an answer, through the shim', {todo: 'needs a hopping pack in the shared runtime: per-session packs (B3/B5)'});
test('shared: (c) a cancelled call leaves no in-flight entry, through the shim', {todo: 'needs a hopping pack in the shared runtime: per-session packs (B3/B5)'});
test('shared: (b2) ctx.ask through the shim', {todo: 'once M13 (ctx.ask) is on countinghouse master'});
test('shared: (d) a paged list through the shim', {todo: 'once M1 (pagination) is on countinghouse master'});
