'use strict';
// The Claude Code plugin: marketplace at the repo root, the plugin under
// clients/claude-code, its .mcp.json, the skill, and launch.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(__dirname, '..', 'clients', 'claude-code');
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const LAUNCH = path.join(PLUGIN, 'bin', 'launch.js');
const SCOPE = require('../package.json').name.split('/')[0];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, (c) => `\\${c}`);

test('the marketplace lists ch-packs from a relative source that exists', () => {
  const m = json(path.join(ROOT, '.claude-plugin', 'marketplace.json'));
  assert.strictEqual(m.name, 'ch-packs');
  assert.strictEqual(m.owner.name, 'mchen6');
  assert.deepStrictEqual(m.plugins.map((p) => p.name), ['ch-packs']);
  const source = m.plugins[0].source;
  assert.match(source, /^\.\//);
  assert.strictEqual(path.resolve(ROOT, source), PLUGIN);
  assert.strictEqual(json(path.join(PLUGIN, '.claude-plugin', 'plugin.json')).name, 'ch-packs');
});

test('the plugin\'s .mcp.json runs launch.js with node and sets no environment', () => {
  const entry = json(path.join(PLUGIN, '.mcp.json')).mcpServers['countinghouse'];
  assert.deepStrictEqual(entry, {
    command: 'node',
    args: ['${CLAUDE_PLUGIN_ROOT}/bin/launch.js', 'start', '--stdio']
  });
});

test('the skill carries the plan\'s sentence verbatim', () => {
  const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'ci-failure-triage', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: ci-failure-triage\ndescription: .+\n---\n/);
  assert.ok(skill.includes('when a CI run failed, call `ci_failure_triage` first and show its receipt line verbatim'));
});

test('launch.js without an installed launcher exits non-zero with one line naming the install command', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-launch-'));
  try {
    const r = spawnSync(process.execPath, [LAUNCH, 'start', '--stdio'], {encoding: 'utf8', env: {...process.env, COUNTINGHOUSE_HOME: home}});
    assert.strictEqual(r.status, 1);
    assert.strictEqual(r.stdout, '', 'stdout is the MCP channel: nothing on it');
    assert.strictEqual(r.stderr.trim().split('\n').length, 1);
    assert.match(r.stderr, new RegExp(esc(`npx ${SCOPE}/ch-local install --pack ci-failure-triage`)));
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('launch.js hands its arguments, stdio and exit code to the installed launcher', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-launch-'));
  try {
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin', 'ch-local.js'), "process.stdin.once('data', (d) => { process.stdout.write(JSON.stringify(process.argv.slice(2)) + ' ' + d); process.exit(7); });\n");
    const r = spawnSync(process.execPath, [LAUNCH, 'start', '--stdio'], {encoding: 'utf8', input: 'ping', env: {...process.env, COUNTINGHOUSE_HOME: home}});
    assert.strictEqual(r.status, 7, r.stderr);
    assert.strictEqual(r.stdout, '["start","--stdio"] ping');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// From /code-review medium on PR #34.
const {launcherPath} = require('../lib/home');
const launch = require(LAUNCH);

test('launch.js and lib/home.js find the launcher at the same path', () => {
  const base = {...process.env};
  delete base.COUNTINGHOUSE_HOME;
  const abs = path.join(os.tmpdir(), 'ch-home-agree');
  for (const env of [base, {...base, COUNTINGHOUSE_HOME: abs}, {...base, COUNTINGHOUSE_HOME: ''}]) {
    assert.strictEqual(launch.whereIs(env), launcherPath(env), JSON.stringify(env.COUNTINGHOUSE_HOME));
  }
});

test('launch.js refuses a relative COUNTINGHOUSE_HOME in one line', () => {
  const r = spawnSync(process.execPath, [LAUNCH, 'start'], {encoding: 'utf8', env: {...process.env, COUNTINGHOUSE_HOME: '.countinghouse'}});
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr.trim().split('\n').length, 1);
  assert.match(r.stderr, /COUNTINGHOUSE_HOME must be an absolute path/);
});

test('a launcher that fails at once makes launch.js fail, with something said', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-launch-'));
  try {
    fs.mkdirSync(path.join(home, 'bin', 'ch-local.js'), {recursive: true}); // a directory: node cannot run it
    const r = spawnSync(process.execPath, [LAUNCH, 'start'], {encoding: 'utf8', env: {...process.env, COUNTINGHOUSE_HOME: home}});
    assert.notStrictEqual(r.status, 0);
    assert.ok(r.stderr.length > 0, 'something is said');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('launch.js passes a stop on to the launcher, so no server is left running', {skip: process.platform === 'win32' ? 'Windows has no SIGTERM to forward; the child sees stdin close' : false}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-launch-'));
  const flag = path.join(home, 'stopped');
  try {
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin', 'ch-local.js'), `process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(flag)}, 'yes'); process.exit(0); }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n`);
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, [LAUNCH, 'start'], {env: {...process.env, COUNTINGHOUSE_HOME: home}, stdio: ['pipe', 'pipe', 'inherit']});
    await new Promise((resolve) => child.stdout.once('data', resolve));
    child.kill('SIGTERM');
    const code = await new Promise((resolve) => child.on('exit', (c, s) => resolve(c != null ? c : s)));
    assert.strictEqual(fs.readFileSync(flag, 'utf8'), 'yes', 'the launcher got the stop');
    assert.strictEqual(code, 0, 'launch.js exits with the launcher\'s code');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a launcher stopped by a signal stops launch.js by the same signal, not exit 1', {skip: process.platform === 'win32' ? 'no POSIX signals on Windows' : false}, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-launch-'));
  try {
    fs.mkdirSync(path.join(home, 'bin'));
    fs.writeFileSync(path.join(home, 'bin', 'ch-local.js'), "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n");
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, [LAUNCH, 'start'], {env: {...process.env, COUNTINGHOUSE_HOME: home}, stdio: ['pipe', 'pipe', 'inherit']});
    await new Promise((resolve) => child.stdout.once('data', resolve));
    child.kill('SIGTERM');
    const [code, signal] = await new Promise((resolve) => child.on('exit', (c, s) => resolve([c, s])));
    assert.deepStrictEqual([code, signal], [null, 'SIGTERM']);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('launch.js forwards a signal the platform cannot send as a plain stop, never a crash', () => {
  const src = fs.readFileSync(LAUNCH, 'utf8');
  assert.match(src, /try \{\s*child\.kill\(signal\);\s*\} catch \{\s*child\.kill\(\);\s*\}/);
});

test('launch.js loads on old Nodes far enough to say it is too old: no node: requires', () => {
  assert.ok(!/require\('node:/.test(fs.readFileSync(LAUNCH, 'utf8')));
});

test('launch.js and lib/home.js agree on what a full path is', () => {
  const {isFullPath} = require('../lib/home');
  for (const [p, platform] of [['/a', 'linux'], ['a', 'linux'], ['C:\\a', 'win32'], ['\\a', 'win32'], ['\\\\s\\h', 'win32'], ['C:a', 'win32']]) {
    assert.strictEqual(launch.isFullPath(p, platform), isFullPath(p, platform), `${platform} ${p}`);
  }
});

test('launch.js checks the Node floor, 22.16', () => {
  assert.strictEqual(launch.nodeOk('v18.19.0'), false);
  assert.strictEqual(launch.nodeOk('v22.15.9'), false);
  assert.strictEqual(launch.nodeOk('v22.16.0'), true);
  assert.strictEqual(launch.nodeOk('v24.21.0'), true);
  assert.strictEqual(launch.nodeOk(process.version), true);
  assert.match(fs.readFileSync(LAUNCH, 'utf8'), /needs Node 22\.16 or later; this is \$\{process\.version\}/);
});

test('launch.js fetches nothing', () => {
  const src = fs.readFileSync(LAUNCH, 'utf8');
  for (const word of ['fetch', 'http', 'https', 'net', 'dns', 'npx']) {
    assert.ok(!new RegExp(`require\\(['"](node:)?${word}['"]\\)|\\b${word}\\(`).test(src), word);
  }
});
