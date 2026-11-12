'use strict';
// bin/ch-local.js snippet: stdout is the entry alone (pipe it), stderr says
// which node was pinned and how to reprint.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {snippet} = require('../lib/snippets');

const BIN = path.join(__dirname, '..', 'bin', 'ch-local.js');
const run = (args, env) => spawnSync(process.execPath, [BIN, ...args], {encoding: 'utf8', env: {...process.env, ...env}});

test('a command run from a directory that no longer exists still answers as ch-local, not with a stack', {skip: process.platform === 'win32' && 'Windows cannot remove a working directory'}, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-'));
  const gone = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-gone-'));
  try {
    const r = spawnSync('sh', ['-c', 'cd "$1" && rmdir "$1" && exec "$2" "$3" snippet cursor', 'sh', gone, process.execPath, BIN], {encoding: 'utf8', env: {...process.env, COUNTINGHOUSE_HOME: home}});
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!/at .*\(/.test(r.stderr), r.stderr);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(gone, {recursive: true, force: true});
  }
});

test('snippet prints the entry for this machine: the running node and the home\'s launcher', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-'));
  try {
    const r = run(['snippet', 'cursor'], {COUNTINGHOUSE_HOME: home, GITHUB_TOKEN: 'secret-value-123'});
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout, snippet('cursor', {node: process.execPath, launcher: path.join(home, 'bin', 'ch-local.js')}).text);
    assert.ok(r.stderr.includes(process.execPath), 'names the node it pinned');
    assert.match(r.stderr, /upgrade changes this path; run `ch-local snippet cursor` again/);
    assert.ok(!(r.stdout + r.stderr).includes('secret-value-123'), 'never a credential value');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('without COUNTINGHOUSE_HOME the home is ~/.countinghouse', () => {
  const env = {...process.env};
  delete env.COUNTINGHOUSE_HOME;
  const r = spawnSync(process.execPath, [BIN, 'snippet', 'vscode'], {encoding: 'utf8', env});
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(JSON.stringify(path.join(os.homedir(), '.countinghouse', 'bin', 'ch-local.js'))));
});

test('claude-desktop prints its note on stderr, nothing on stdout, and exits 0', () => {
  const r = run(['snippet', 'claude-desktop'], {});
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /\.mcpb bundle/);
});

// From /code-review medium on PR #34.
test('a full path is one with a root and, on Windows, a drive or a share', () => {
  const {isFullPath} = require('../lib/home');
  assert.strictEqual(isFullPath('/home/dev/.countinghouse', 'linux'), true);
  assert.strictEqual(isFullPath('.countinghouse', 'linux'), false);
  assert.strictEqual(isFullPath('C:\\Users\\dev\\.countinghouse', 'win32'), true);
  assert.strictEqual(isFullPath('\\\\server\\share\\ch', 'win32'), true);
  assert.strictEqual(isFullPath('\\countinghouse', 'win32'), false, 'rooted on whatever drive is current');
  assert.strictEqual(isFullPath('C:countinghouse', 'win32'), false);
});

test('a relative COUNTINGHOUSE_HOME is refused, never resolved against the current directory', () => {
  const r = run(['snippet', 'cursor'], {COUNTINGHOUSE_HOME: '.countinghouse'});
  assert.strictEqual(r.status, 2);
  assert.strictEqual(r.stdout, '');
  assert.match(r.stderr, /COUNTINGHOUSE_HOME must be an absolute path/);
});

test('an unknown client or command exits 2 with usage', () => {
  for (const args of [['snippet', 'emacs'], ['snippet'], ['frobnicate'], []]) {
    const r = run(args, {});
    assert.strictEqual(r.status, 2, args.join(' '));
    assert.strictEqual(r.stdout, '');
    assert.match(r.stderr, /usage: ch-local snippet <claude-code\|cursor\|vscode\|codex\|claude-desktop>/);
  }
});
