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

// A run's failure as the assertion says it: the failed checks first (each
// FAIL line with the start of its detail), then the run's tail. CI keeps
// neither a run's report file nor its whole output.
function failureText(text) {
  const lines = text.split('\n');
  const failed = [];
  for (let i = 0; i < lines.length; i++) if (/^FAIL /.test(lines[i])) failed.push(lines.slice(i, i + 4).join('\n').slice(0, 1500));
  return `${failed.join('\n')}\n--- the run's last lines ---\n${text.slice(-2500)}`;
}
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

test('stopTree ends the launcher and what it started, which holds the same pipes (on Windows, taskkill /T)', async () => {
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
  assert.strictEqual(code, 0, failureText(out.text));
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

// M17 (b), 2026-11-16: a run under a home whose .claude held the person's
// plugins answered "no" for the tested client, and (b) read as declined.
test('shared: the client\'s repository goes in the runner\'s temporary directory on CI, else /tmp on POSIX, never the run\'s TMPDIR', () => {
  assert.strictEqual(shared.clientRepoRoot({RUNNER_TEMP: '/runner/_temp'}, 'linux'), '/runner/_temp');
  assert.strictEqual(shared.clientRepoRoot({TMPDIR: '/home/someone/tmp'}, 'linux'), '/tmp');
  assert.strictEqual(shared.clientRepoRoot({TMPDIR: '/home/someone/tmp'}, 'darwin'), '/tmp');
  assert.strictEqual(shared.clientRepoRoot({RUNNER_TEMP: 'relative'}, 'linux'), '/tmp', 'a relative RUNNER_TEMP is not one');
  assert.strictEqual(shared.clientRepoRoot({}, 'win32'), os.tmpdir());
});

test('shared: every .claude at or above the client\'s repository is found, except the client\'s own configuration', () => {
  const top = tmp('ch-shared-stray-');
  const repo = path.join(top, 'a', 'b', 'repo');
  fs.mkdirSync(repo, {recursive: true});
  const config = path.join(top, 'config');
  fs.mkdirSync(config);
  // only what is inside this test's directory: the machine's own may sit higher
  const ours = (found) => found.filter((d) => d.startsWith(top + path.sep));
  assert.deepStrictEqual(ours(shared.strayClaudeDirs(repo, config)), []);
  fs.mkdirSync(path.join(top, 'a', '.claude'));
  fs.mkdirSync(path.join(repo, '.claude'));
  assert.deepStrictEqual(ours(shared.strayClaudeDirs(repo, config)), [path.join(repo, '.claude'), path.join(top, 'a', '.claude')]);
  assert.deepStrictEqual(ours(shared.strayClaudeDirs(repo, path.join(top, 'a', '.claude'))), [path.join(repo, '.claude')], 'the client\'s own configuration is not a stray');
  fs.rmSync(top, {recursive: true, force: true});
});

test('shared: the client\'s configuration directory must be an absolute path to an existing, empty directory', () => {
  const top = tmp('ch-shared-config-');
  assert.match(shared.configProblem(''), /not an absolute path/);
  assert.match(shared.configProblem(undefined), /not an absolute path/);
  assert.match(shared.configProblem('relative/config'), /not an absolute path/);
  assert.match(shared.configProblem(path.join(top, 'missing')), /ENOENT/);
  fs.writeFileSync(path.join(top, 'file'), '');
  assert.match(shared.configProblem(path.join(top, 'file')), /not a directory/);
  fs.mkdirSync(path.join(top, 'full'));
  fs.writeFileSync(path.join(top, 'full', 'settings.json'), '{}');
  assert.match(shared.configProblem(path.join(top, 'full')), /not empty/);
  fs.mkdirSync(path.join(top, 'empty'));
  assert.strictEqual(shared.configProblem(path.join(top, 'empty')), null);
  assert.strictEqual(shared.configProblem(shared.claudeHarness(path.join(top, 'client')).config), null, 'the harness\'s own');
  fs.rmSync(top, {recursive: true, force: true});
});

test('shared: the shim goes in a private <home>/shim, its owner\'s only (POSIX modes; on Windows a DACL of this user and SYSTEM)', () => {
  const home = tmp('ch-shared-home-');
  const bin = path.join(home, 'built');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const to = shared.installShim(home, bin);
  if (process.platform === 'win32') {
    const winAcl = require('../lib/win-acl');
    assert.strictEqual(to, path.join(home, 'shim', 'ch-shim.exe'));
    // private as ch-local's secrets are, and made so here: the temporary
    // directory's inherited rules (Administrators among them) are gone, and
    // only this user and SYSTEM are allowed anything
    for (const [what, acl, opts] of [['the shim\'s directory', winAcl.fileAcl(path.join(home, 'shim')), {directory: true}], ['the shim', winAcl.fileAcl(to), {}]]) {
      assert.strictEqual(winAcl.privateProblem(what, acl, opts), null, JSON.stringify(acl));
      const rules = (Array.isArray(acl.rules) ? acl.rules : [acl.rules]).filter((r) => r != null && r.type === 'Allow' && r.inheritOnly !== true);
      assert.deepStrictEqual([...new Set(rules.map((r) => r.sid))].sort(), [acl.user, winAcl.SYSTEM].sort(), `${what}: ${JSON.stringify(acl)}`);
    }
  } else {
    assert.strictEqual(to, path.join(home, 'shim', 'ch-shim'));
    assert.strictEqual(fs.statSync(path.join(home, 'shim')).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(to).mode & 0o777, 0o700);
  }
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

// A failed run explains itself in CI (#54): with no live daemon, one is
// started exactly as the shim would start it, and what it says is shown.
test('shared: daemonDiagnosis starts the daemon as shim.json says and shows its output, ended within its bound', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-shared-diag-'));
  try {
    assert.match(await shared.daemonDiagnosis(home), /no shim\.json/);
    const fake = path.join(home, 'fake-ch-local.js');
    // real paths: on macOS the temporary directory is a link (/var ->
    // /private/var), and a child's cwd is where it leads (#54's macOS leg)
    fs.writeFileSync(fake, "console.log('args', process.argv.slice(2).join(' '), 'cwd', process.cwd() === require('fs').realpathSync(process.env.HOME_WANTED), 'env', process.env.CH_DIAG_X);\n" +
      // never process.exit(): on macOS a pipe is written asynchronously, and
      // an exit can drop what was written (#54's macOS run); exitCode lets the
      // output drain first
      "console.error('refusing: something'); if (process.env.CH_DIAG_STAY === '1') setInterval(() => {}, 1000); else process.exitCode = 3;\n");
    const shimJson = (env) => fs.writeFileSync(path.join(home, 'shim.json'), JSON.stringify({node: process.execPath, chLocal: fake, env: Object.assign({PATH: process.env.PATH, HOME_WANTED: home}, env)}));
    shimJson({CH_DIAG_X: 'seen'});
    const out = await shared.daemonDiagnosis(home);
    assert.match(out, /args daemon --home .* cwd true env seen/);
    assert.match(out, /refusing: something/);
    assert.match(out, /exit 3/);
    shimJson({CH_DIAG_STAY: '1'});
    const started = Date.now();
    const stayed = await shared.daemonDiagnosis(home, 1500);
    assert.ok(Date.now() - started < 8000, 'ended at its bound');
    assert.match(stayed, /still running after 1500 ms; ended/);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('shared: treeOf lists a process and its descendants, and nothing else (on Windows through WMI)', async () => {
  const {spawn} = require('node:child_process');
  const parent = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {stdio: 'ignore'}); setTimeout(()=>{}, 60000)"], {stdio: 'ignore'});
  try {
    let tree = [];
    for (const until = Date.now() + (process.platform === 'win32' ? 30000 : 5000); Date.now() < until && tree.length < 2;) {
      tree = shared.treeOf(parent.pid) || [];
      await new Promise((r) => setTimeout(r, 50));
    }
    // its node child, by its command line (on Windows a console-less node
    // may also have a conhost.exe below it, which is its descendant too)
    const nodes = tree.filter((p) => p.pid !== parent.pid && /setTimeout/.test(p.args));
    if (process.platform !== 'win32') assert.strictEqual(tree.length, 2, JSON.stringify(tree));
    assert.ok(tree.some((p) => p.pid === parent.pid), JSON.stringify(tree));
    assert.strictEqual(nodes.length, 1, JSON.stringify(tree));
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
  assert.strictEqual(code, 0, failureText(out.text));
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.strictEqual(report.ok, true, JSON.stringify(report.checks.filter((c) => !c.ok)));
});

// (b-latched), the checks the gated run makes against two sessions
// (countinghouse #337), here against stand-ins: what a refusal must say to
// pass, and what each wrong answer fails on.
test('shared: (b-latched) a latched session is refused as the latch, with the handed-over reason; never as a decline', async () => {
  const why = {reason: 'client hook present', at: '~/x/.claude/settings.json'};
  const run = async (loosening, {firstValue = 10000, handed = why} = {}) => {
    const checks = [];
    const check = (name, ok, detail) => { checks.push({name, ok: ok === true, detail}); return ok === true; };
    const second = async (a) => (a.action === 'set' && a.value === '60s' ? loosening
      : {result: {structuredContent: {new: 20000, applies: 'this session'}}});
    const first = async () => ({result: {structuredContent: {settings: [{name: 'requestTimeout', value: firstValue}]}}});
    await shared.latchedChecks({second, first, why: handed, reason: 'client hook present', check});
    return checks;
  };
  const refusal = (code, text) => ({result: {isError: true, _meta: {'countinghouse/code': code}, content: [{type: 'text', text}]}});
  const good = refusal('SETTING_CLIENT_NOT_CONFIRMED', 'Loosening requestTimeout is not asked in this session: this client\'s configuration could answer forms by itself (client hook present: ~/x/.claude/settings.json); nothing was changed. To allow it, run `ch-local settings set requestTimeout 60s` in a terminal yourself.');
  assert.ok((await run(good)).every((c) => c.ok), JSON.stringify(await run(good)));
  const failed = async (...a) => (await run(...a)).filter((c) => !c.ok).map((c) => c.name);
  assert.strictEqual((await failed(refusal('SETTING_DECLINED_THIS_SESSION', good.result.content[0].text))).length, 1, 'a decline is not the latch');
  assert.strictEqual((await failed(refusal('SETTING_CLIENT_NOT_CONFIRMED', 'this client could not be confirmed; run `ch-local settings set requestTimeout 60s`'))).length, 1, 'the reason must be the handed-over one');
  assert.strictEqual((await failed(good, {firstValue: 20000})).length, 1, 'the first session\'s own value');
  assert.strictEqual((await failed(good, {handed: {reason: 'plugin hook present'}})).length, 2, 'a hand-over with another reason fails both');
});

// Not yet through the real shim (scripts/shared-acceptance.js says where it
// is covered meanwhile): a todo, never a skip, so the acceptance workflow's
// "skipped 0" still holds.
test('shared: (b1) the settings confirmation form round trip, through the shim', {todo: 'once a tested Claude Code range is in countinghouse lib/elicitation-clients.json (the maintainer\'s hand test before release)'});

// (a), (c) and (b2): the checks the gated run makes through the shim, with
// the acceptance fixture pack turned on from the terminal, here against
// stand-ins: a good run passes every check, and each wrong one fails its own.
const checksOf = async (fn) => {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({name, ok: ok === true, detail}); return ok === true; };
  await fn(check);
  return {all: checks, failed: checks.filter((c) => !c.ok).map((c) => c.name)};
};

test('shared: (a) progress frames before an answer, through the shim: the checks', async () => {
  const token = 'tok';
  const frame = (progress, t = token) => ({jsonrpc: '2.0', method: 'notifications/progress', params: {progressToken: t, progress}});
  const answer = {jsonrpc: '2.0', id: 7, result: {structuredContent: {hopped: true, said: 'back'}}};
  const run = (r) => (check) => shared.progressChecks({token, check, run: async () => Object.assign({response: answer, before: [frame(25), frame(75)], after: []}, r)});
  assert.deepStrictEqual((await checksOf(run({}))).failed, []);
  assert.ok((await checksOf(run({before: []}))).failed.some((n) => /before its answer/.test(n)), 'no frame before the answer');
  assert.ok((await checksOf(run({before: [frame(75), frame(25)]}))).failed.some((n) => /rises/.test(n)), 'progress that falls');
  assert.ok((await checksOf(run({after: [frame(90)]}))).failed.some((n) => /after the answer/.test(n)), 'a frame after the answer');
  assert.ok((await checksOf(run({before: [frame(25, 'other')]}))).failed.some((n) => /token/.test(n)), 'another call\'s frame');
  assert.ok((await checksOf(run({response: {jsonrpc: '2.0', id: 7, result: {structuredContent: {hopped: false}}}}))).failed.some((n) => /through its part/.test(n)), 'no hop');
});

test('shared: (c) a cancelled call leaves no in-flight entry, through the shim: the checks', async () => {
  const holdMs = 20000;
  const controlHoldMs = 5000;
  // the control's own answer, waited for at the close (within the grace)
  const answered = [{jsonrpc: '2.0', id: 3, result: {structuredContent: {waited: controlHoldMs}}}];
  const crash = [{jsonrpc: '2.0', id: 3, error: {code: -32603, message: 'countinghouse\'s runtime restarted before answering; the call may have run', data: {'countinghouse/code': 'RUNTIME_RESTARTED'}}}];
  const run = (c, k) => (check) => shared.cancelChecks({holdMs, controlHoldMs, check,
    cancelled: async () => Object.assign({exitMs: 300, answers: []}, c), control: async () => Object.assign({exitMs: 3200, answers: answered}, k)});
  assert.deepStrictEqual((await checksOf(run({}, {}))).failed, []);
  assert.ok((await checksOf(run({answers: answered}, {}))).failed.some((n) => /never answered/.test(n)), 'a cancelled call answered');
  assert.ok((await checksOf(run({answers: crash}, {}))).failed.some((n) => /never answered/.test(n)), 'a cancelled call crash-answered');
  assert.ok((await checksOf(run({exitMs: 19000}, {}))).failed.some((n) => /promptly/.test(n)), 'the shim waited on the cancelled call');
  assert.ok((await checksOf(run({exitMs: null}, {}))).failed.some((n) => /promptly/.test(n)), 'the shim never ended');
  // the control is what makes the check sensitive: a call in flight at the close must get its own answer
  assert.ok((await checksOf(run({}, {answers: []}))).failed.some((n) => /control/.test(n)), 'a control left unanswered');
  assert.ok((await checksOf(run({}, {exitMs: 5, answers: crash}))).failed.some((n) => /control/.test(n)), 'a control crash-answered (the bye sent at the close)');
  assert.ok((await checksOf(run({}, {exitMs: 10500}))).failed.some((n) => /control/.test(n)), 'a control ended past the grace');
});

test('shared: (b2) ctx.ask through the shim: the checks', async () => {
  const what = 'acceptance';
  // a state as countinghouse mints it (#412, F2-4): v2, its payload sealed
  const state = `v2.${Buffer.alloc(64, 0xa5).toString('base64url')}.${'b'.repeat(43)}`;
  const question = {result: {resultType: 'input_required', requestState: state,
    inputRequests: {answer: {method: 'elicitation/create', params: {mode: 'form', message: `ch-pack-accept: Proceed with ${what}?`, requestedSchema: {type: 'object'}}}}}};
  const refused = (code) => ({result: {isError: true, _meta: {'countinghouse/code': code}, content: [{type: 'text', text: code}]}});
  // the runtime as it should answer: the question, the answer once, then the state used
  const runtime = (over) => {
    const used = new Set();
    return async (extra) => {
      if (extra.requestState == null) return over.first || question;
      if (extra.requestState !== state) return over.forged || refused('ASK_STATE_INVALID');
      if (used.has(state)) return over.again || refused('ASK_STATE_INVALID');
      used.add(state);
      return over.retry || {result: {structuredContent: {asked: true, answer: extra.inputResponses.answer.content}}};
    };
  };
  const run = (over) => (check) => shared.askChecks({what, check, call: runtime(over)});
  assert.deepStrictEqual((await checksOf(run({}))).failed, []);
  // the state must be opaque, whatever its version: one whose payload a
  // client can read (v1's JSON in the clear), or that shows the question's
  // name, fails the first check
  const firstWith = (requestState) => ({first: {result: Object.assign({}, question.result, {requestState})}});
  const st = (bytes) => `v1.${Buffer.from(bytes).toString('base64url')}.${'b'.repeat(43)}`;
  const cases = [
    [st(JSON.stringify({n: 'x', r: 1})), 'a payload readable as JSON'],
    [st(Buffer.concat([Buffer.alloc(28, 0xa5), Buffer.from(JSON.stringify({n: 'x', e: 1}))])), 'JSON in the clear after a binary prefix (sealed but not encrypted)'],
    [st('\u0000answer\u0001'), 'the question\'s name in the payload'],
    [st('\u0000ch-pack-accept\u0001'), 'the asking module\'s name in the payload'],
    ['opaque', 'no version'],
  ];
  for (const [s, why] of cases) {
    const c = await checksOf(run(firstWith(s)));
    assert.ok(c.failed.some((n) => /InputRequiredResult/.test(n)), why);
  }
  const v7 = await checksOf(run(firstWith(`v7.${'a'.repeat(40)}.${'b'.repeat(43)}`)));
  assert.ok(!v7.failed.some((n) => /InputRequiredResult/.test(n)), 'another version, opaque: accepted (the privacy is pinned, not the number)');
  const none = await checksOf(run({first: {result: {structuredContent: {asked: false, code: 'ASK_UNAVAILABLE'}}}}));
  assert.deepStrictEqual([none.all.length, none.failed.length], [1, 1], 'no question: the rest is not tried');
  assert.ok((await checksOf(run({retry: {result: {structuredContent: {asked: true, answer: {yes: false}}}}}))).failed.some((n) => /gets it/.test(n)), 'the wrong answer');
  assert.ok((await checksOf(run({again: {result: {structuredContent: {asked: true, answer: {yes: true}}}}}))).failed.some((n) => /used once/.test(n)), 'a state used twice');
  assert.ok((await checksOf(run({forged: {result: {structuredContent: {asked: true, answer: {yes: true}}}}}))).failed.some((n) => /tampered/.test(n)), 'a tampered state served');
});

// The acceptance fixture pack is the run's own: never in a shipped allowlist,
// release-pins.json or the published package (the reviewer's condition).
test('shared: the acceptance fixture pack is in no shipped allowlist, release pin or published file, and npm refuses to publish it', () => {
  const {ALLOWLIST} = require('../lib/allowlist');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(ALLOWLIST.packs, shared.ACCEPT), false);
  const shipped = new Set([...ALLOWLIST.runtime.packages, ...Object.values(ALLOWLIST.packs).flatMap((p) => p.packages), ...Object.keys(ALLOWLIST.pins || {})]);
  for (const name of shared.ACCEPT_PACKAGES) assert.strictEqual(shipped.has(name), false, name);
  const pinsText = fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8');
  for (const name of [...shared.ACCEPT_PACKAGES, 'fixtures']) assert.ok(!pinsText.includes(name), name);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(Array.isArray(pkg.files) && pkg.files.every((f) => !/^test\b/.test(f)), JSON.stringify(pkg.files));
  for (const dir of shared.ACCEPT_DIRS) {
    assert.ok(dir.startsWith(path.join(__dirname, 'fixtures')), dir);
    const own = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(own.private, true, `${own.name}: npm refuses to publish it`);
    assert.ok(shared.ACCEPT_PACKAGES.includes(own.name), own.name);
  }
  // the release the run adds it with only adds it: the shipped packs unchanged
  const added = shared.acceptRelease(ALLOWLIST);
  assert.deepStrictEqual(Object.keys(added.packs).filter((k) => k !== shared.ACCEPT), Object.keys(ALLOWLIST.packs));
  assert.deepStrictEqual(added.packs[shared.ACCEPT].credentials, []);
});
