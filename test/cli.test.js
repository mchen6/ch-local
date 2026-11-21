'use strict';
require('./tmp-dirs');
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
    assert.strictEqual(r.stdout, snippet('cursor', {node: process.execPath, launcher: path.join(home, 'bin', 'ch-local.js'), home}).text);
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

// the reviewer on the install hints: `install` with no --pack says, in its
// help, that it never adds a pack and never moves to another release
test('the usage says what install with no --pack does, and what it never does', () => {
  const r = run(['frobnicate'], {});
  assert.ok(r.stderr.includes(`       ch-local install [--from <directory of tarballs>]
                reinstalls what this home lists, at this ch-local's own release:
                it never adds a pack, and never moves to another release
`), r.stderr);
});

// The real io's question (bin/ch-local.js realIo.ask): the answer is resolved
// before readline closes, since close() fires the 'close' listener at once.
// Every yes/no answer was read as empty, on a terminal and over a pipe alike.
test('a yes answered on stdin reaches the command: uninstall over a pipe removes the home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-ask-'));
  fs.mkdirSync(path.join(home, 'bin'));
  fs.writeFileSync(path.join(home, 'settings.json'), '{}');
  const r = spawnSync(process.execPath, [BIN, 'uninstall'], {encoding: 'utf8', input: 'yes\n', env: {...process.env, COUNTINGHOUSE_HOME: home}});
  try {
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(!fs.existsSync(home), 'removed on yes');
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// B-own-add: add-module is the user's own act at a terminal; over a pipe it
// is refused before anything is read or asked, a "y" on stdin included.
test('add-module over a pipe is refused, naming the command; without a folder, usage', () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-own-')));
  try {
    const home = path.join(base, 'home');
    // (private, as install makes a home)
    fs.mkdirSync(home, {mode: 0o700});
    fs.chmodSync(home, 0o700);
    const r = spawnSync(process.execPath, [BIN, 'add-module', path.join(base, 'mine')], {encoding: 'utf8', input: 'y\n', env: {...process.env, COUNTINGHOUSE_HOME: home}});
    assert.strictEqual(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /add-module asks you, in your own terminal: run `.*add-module ".+mine"` there\./);
    assert.ok(!fs.existsSync(path.join(home, 'own.json')));
    const u = run(['add-module'], {COUNTINGHOUSE_HOME: home});
    assert.strictEqual(u.status, 2);
    assert.match(u.stderr, /ch-local add-module <directory of your own module>/);
    // remove-module: an own module it doesn't know is refused; no name, usage
    const rm = run(['remove-module', 'nothing-here'], {COUNTINGHOUSE_HOME: home});
    assert.strictEqual(rm.status, 2, rm.stdout + rm.stderr);
    assert.match(rm.stderr, /nothing-here is not one of your own modules/);
    assert.strictEqual(run(['remove-module'], {COUNTINGHOUSE_HOME: home}).status, 2);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

// The Reviewer on A-own-skill: add-module's yes is the user's own, at a
// terminal both ways (B-own-add). The one io that claims a terminal in what
// ch-local ships (bin/ and lib/; scripts/ and test/ are not shipped) is
// bin/ch-local.js's, and it reads both from the process's real terminals. A
// harness that stands the terminal in (the acceptance run's Windows step)
// lives outside it.
test('only bin/ch-local.js builds an io that claims a terminal, and only from the real ones', () => {
  const ROOT = path.join(__dirname, '..');
  // (every shipped directory: package.json's files, bin/, lib/ and clients/)
  const shipped = (d) => fs.readdirSync(path.join(ROOT, d), {recursive: true}).filter((f) => String(f).endsWith('.js')).map((f) => path.join(ROOT, d, String(f)));
  const files = [...shipped('bin'), ...shipped('lib'), ...shipped('clients')];
  assert.deepStrictEqual(require('../package.json').files, ['bin/', 'lib/', 'clients/'], 'the pin covers what is shipped');
  const claims = [];
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      // (an object's key -- at a line's start, or after { or , -- whose
      // value is anything but false: an io that says it has no terminal
      // only adds a refusal)
      for (const m of line.matchAll(/(?:^|[{,])\s*(interactive|stdoutTTY|stdinIsTTY|terminal)\s*:\s*([^,}\n]+)/g)) {
        if (m[2].trim() !== 'false') claims.push(`${path.relative(ROOT, file).split(path.sep).join('/')}: ${m[1]}: ${m[2].trim()}`);
      }
      // (an assignment, or a shorthand key, claims one too)
      for (const m of line.matchAll(/\.(interactive|stdoutTTY|stdinIsTTY|terminal)\s*=(?!=)\s*([^;\n]+)/g)) claims.push(`${path.relative(ROOT, file).split(path.sep).join('/')}: ${m[1]} = ${m[2].trim()}`);
      for (const m of line.matchAll(/[{,]\s*(interactive|stdoutTTY|stdinIsTTY)\s*[,}]/g)) claims.push(`${path.relative(ROOT, file).split(path.sep).join('/')}: ${m[1]} (shorthand)`);
      // (and a getter: bin/ch-local.js reads the real ones only when asked,
      // so `session` never opens a stdio pipe before the shim runs: #120)
      for (const m of line.matchAll(/\bget\s+(interactive|stdoutTTY|stdinIsTTY|terminal)\s*\(\)\s*\{\s*return\s+([^;}]+?)\s*;?\s*\}/g)) {
        if (m[2].trim() !== 'false') claims.push(`${path.relative(ROOT, file).split(path.sep).join('/')}: ${m[1]}: ${m[2].trim()}`);
      }
    }
  }
  assert.deepStrictEqual(claims.sort(), [
    'bin/ch-local.js: interactive: Boolean(process.stdin.isTTY)',
    'bin/ch-local.js: stdinIsTTY: Boolean(process.stdin.isTTY)',
    'bin/ch-local.js: stdoutTTY: Boolean(process.stdout.isTTY)',
    'bin/ch-local.js: terminal: Boolean(process.stdin.isTTY && process.stderr.isTTY)'
  ], claims.join('\n'));
});

test('add-module run with no terminal (pipes both ways) is refused, naming the command, and asks nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-'));
  try {
    const r = spawnSync(process.execPath, [BIN, 'add-module', path.join(home, 'mine')], {encoding: 'utf8', input: 'y\n', env: {...process.env, COUNTINGHOUSE_HOME: home}});
    assert.strictEqual(r.status, 2, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /add-module asks you, in your own terminal: run `.*add-module .*mine.*` there\./);
    assert.ok(!/Add it\?/.test(r.stdout + r.stderr), 'nothing asked');
    assert.ok(!fs.existsSync(path.join(home, 'own.json')));
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// the medium on the install hints, 6: one rule, one answer
test('install --unreleased-pins with no --pack says why, not the whole usage', () => {
  const r = run(['install', '--unreleased-pins', 'f'], {});
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /--unreleased-pins reinstalls only with the pack it is for: pass --pack <name> with it/);
  assert.doesNotMatch(r.stderr, /usage:/);
});

// the reviewer's Fable high on #126, F5: every command that acts on a home
// (but snippet, and those with their own check: install, session, start,
// daemon, conditions) refuses one another user could change, at one place
test('a command acting on a home another user could change refuses it, exit 2, nothing changed', {skip: process.platform === 'win32' && 'POSIX modes'}, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-open-'));
  fs.chmodSync(home, 0o777);
  try {
    for (const args of [['status'], ['rollback', '--yes'], ['settings', 'set', 'requestTimeout', '30000'], ['credentials', 'list'], ['uninstall'], ['upgrade', '--check'], ['remove-pack', 'x']]) {
      const r = run(args, {COUNTINGHOUSE_HOME: home});
      assert.strictEqual(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /so another user could change what runs from it/, args.join(' '));
      assert.match(r.stderr, /nothing was changed/, args.join(' '));
    }
    assert.deepStrictEqual(fs.readdirSync(home), [], 'nothing written into it');
  } finally {
    fs.chmodSync(home, 0o700);
    fs.rmSync(home, {recursive: true, force: true});
  }
});

// the medium on #126's round 2: the background check (upgrade --apply-auto)
// says its own paused line on an open home, exit 0, never the gate's exit 2,
// which its parent would take for a failed check and retry
test('upgrade --apply-auto on a home another user could change: paused, said, exit 0', {skip: process.platform === 'win32' && 'POSIX modes'}, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-local-open-auto-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {autoUpgrade: true}}));
  fs.chmodSync(home, 0o777);
  try {
    const r = run(['upgrade', '--apply-auto'], {COUNTINGHOUSE_HOME: home});
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^automatic upgrades are paused: this home is group- or world-writable/m);
  } finally {
    fs.chmodSync(home, 0o700);
    fs.rmSync(home, {recursive: true, force: true});
  }
});
