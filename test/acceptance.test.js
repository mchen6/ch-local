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
