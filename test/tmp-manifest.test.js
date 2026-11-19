'use strict';
require('./tmp-dirs');
// test/tmp-dirs.js's manifests (the Reviewer, 11-19): a process killed by a
// signal never reaches 'exit', so what it made stayed. Each process keeps a
// manifest of the ch-* directories it made; sweepStale() removes those of a
// process that is gone, and only the directories it lists, then the
// manifest; a live process's are left alone. Each case runs a real child
// process with tmp-dirs preloaded, as scripts/test.js runs a test file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {sweepStale, MANIFEST_NAME} = require('./tmp-dirs');

const TMP_DIRS = path.join(__dirname, 'tmp-dirs.js');
// the child's own prefix, so its directories are counted alone
const PREFIX = 'ch-tmpmanifest-';
const count = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(PREFIX)).length;
// a process's manifest directory, found by its pid (null: none)
const manifestOf = (pid) => {
  const name = fs.readdirSync(os.tmpdir()).find((n) => { const m = MANIFEST_NAME.exec(n); return m != null && Number(m[1]) === pid; });
  return name == null ? null : path.join(os.tmpdir(), name);
};
const listed = (pid) => fs.readFileSync(path.join(manifestOf(pid), 'dirs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).dir);
// a pid no system gives out (Linux's pid_max is at most 2^22): gone, never
// reused while the test runs
const DEAD = 2147483646;

// a child that makes n directories, says their paths, then waits (or exits)
function child(n, {wait}) {
  const script = `
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    const dirs = []; for (let i = 0; i < ${n}; i++) dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), ${JSON.stringify(PREFIX)})));
    process.stdout.write(JSON.stringify(dirs) + '\\n');
    ${wait ? 'setInterval(() => {}, 1000);' : ''}`;
  return spawn(process.execPath, ['--require', TMP_DIRS, '-e', script], {stdio: ['ignore', 'pipe', 'inherit']});
}
const dirsOf = (c) => new Promise((resolve, reject) => {
  let out = '';
  c.stdout.on('data', (d) => { out += d; const i = out.indexOf('\n'); if (i >= 0) resolve(JSON.parse(out.slice(0, i))); });
  c.once('error', reject);
  // (a child that ends without saying its directories fails the case at once)
  c.once('exit', (code, signal) => reject(new Error(`the child ended (${code}, ${signal}) without saying its directories`)));
});
const ended = (c) => new Promise((resolve) => (c.exitCode != null || c.signalCode != null ? resolve() : c.once('exit', resolve)));

test('a file that ends normally leaves no ch-* directory and no manifest', async () => {
  const before = count();
  const c = child(3, {wait: false});
  const dirs = await dirsOf(c);
  await ended(c);
  assert.strictEqual(dirs.length, 3);
  assert.strictEqual(count(), before, 'every directory it made is gone');
  assert.strictEqual(manifestOf(c.pid), null, 'and its manifest');
});

test('a process killed by a signal mid-file: its manifest names what it made, and the sweep removes exactly that', async () => {
  const c = child(2, {wait: true});
  const dirs = await dirsOf(c);
  assert.ok(dirs.every((d) => fs.existsSync(d)));
  assert.deepStrictEqual(listed(c.pid).sort(), dirs.map((d) => path.resolve(d)).sort());
  c.kill('SIGKILL');
  await ended(c);
  assert.ok(dirs.every((d) => fs.existsSync(d)), 'no exit handler ran: they stayed');
  const manifest = manifestOf(c.pid);
  assert.ok(sweepStale() >= 1);
  assert.ok(dirs.every((d) => !fs.existsSync(d)), 'removed by the sweep');
  assert.ok(!fs.existsSync(manifest), 'and the manifest with them');
});

test('a stale manifest from a dead pid is swept: its listed ch-* directories that are still the ones listed; nothing else it names is touched', async () => {
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const reborn = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'));
  const at = path.join(os.tmpdir(), `.ch-local-tmp-${DEAD}-test${process.pid}`);
  try {
    const entry = (dir) => { const st = fs.statSync(dir); return JSON.stringify({dir, dev: String(st.dev), ino: String(st.ino)}); };
    // reborn: listed, then made again by someone else (another inode)
    const was = entry(reborn);
    fs.rmSync(reborn, {recursive: true});
    fs.mkdirSync(reborn);
    fs.mkdirSync(at);
    fs.writeFileSync(path.join(at, 'dirs.jsonl'), [entry(mine), was, entry(outside), JSON.stringify({dir: path.join(mine, '..', '..')}), '{"dir": "cut sho'].join('\n'));
    sweepStale();
    assert.ok(!fs.existsSync(mine), 'the listed ch-* directory removed');
    assert.ok(fs.existsSync(reborn), 'a directory made again at a listed path is no longer the one listed: left');
    assert.ok(fs.existsSync(outside), 'a listed directory that is no ch-* one is left');
    assert.ok(!fs.existsSync(at), 'the manifest removed');
  } finally {
    for (const d of [reborn, outside, at]) fs.rmSync(d, {recursive: true, force: true});
  }
});

test('a live process\'s manifest is left alone, and what it lists', async () => {
  const c = child(1, {wait: true});
  try {
    const dirs = await dirsOf(c);
    sweepStale();
    assert.ok(manifestOf(c.pid) != null, 'its manifest kept');
    assert.ok(dirs.every((d) => fs.existsSync(d)), 'its directories kept');
  } finally {
    c.kill('SIGTERM');
    await ended(c);
    sweepStale();
  }
});
