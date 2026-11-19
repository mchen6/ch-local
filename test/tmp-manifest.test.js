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
const {sweepStale, manifestOf} = require('./tmp-dirs');

const TMP_DIRS = path.join(__dirname, 'tmp-dirs.js');
// the child's own prefix, so its directories are counted alone
const PREFIX = 'ch-tmpmanifest-';
const count = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(PREFIX)).length;

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
});
const ended = (c) => new Promise((resolve) => (c.exitCode != null || c.signalCode != null ? resolve() : c.once('exit', resolve)));

test('a file that ends normally leaves no ch-* directory and no manifest', async () => {
  const before = count();
  const c = child(3, {wait: false});
  const dirs = await dirsOf(c);
  await ended(c);
  assert.strictEqual(dirs.length, 3);
  assert.strictEqual(count(), before, 'every directory it made is gone');
  assert.ok(!fs.existsSync(manifestOf(c.pid)), 'and its manifest');
});

test('a process killed by a signal mid-file: its manifest names what it made, and the sweep removes exactly that', async () => {
  const c = child(2, {wait: true});
  const dirs = await dirsOf(c);
  assert.ok(dirs.every((d) => fs.existsSync(d)));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(manifestOf(c.pid), 'utf8')).dirs.sort(), dirs.map((d) => path.resolve(d)).sort());
  c.kill('SIGKILL');
  await ended(c);
  assert.ok(dirs.every((d) => fs.existsSync(d)), 'no exit handler ran: they stayed');
  assert.ok(sweepStale() >= 2);
  assert.ok(dirs.every((d) => !fs.existsSync(d)), 'removed by the sweep');
  assert.ok(!fs.existsSync(manifestOf(c.pid)), 'and the manifest with them');
});

test('a stale manifest from a dead pid is swept, its listed ch-* directories only; nothing else it names is touched', async () => {
  // a pid that is gone: a process that has exited
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {encoding: 'utf8'});
  const pid = Number(dead.stdout);
  const listed = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'));
  try {
    fs.writeFileSync(manifestOf(pid), JSON.stringify({pid, dirs: [listed, outside, path.join(listed, '..', '..')]}));
    sweepStale();
    assert.ok(!fs.existsSync(listed), 'the listed ch-* directory removed');
    assert.ok(fs.existsSync(outside), 'a listed directory that is no ch-* one is left');
    assert.ok(!fs.existsSync(manifestOf(pid)), 'the manifest removed');
  } finally {
    fs.rmSync(outside, {recursive: true, force: true});
  }
});

test('a live process\'s manifest is left alone, and what it lists', async () => {
  const c = child(1, {wait: true});
  try {
    const dirs = await dirsOf(c);
    sweepStale();
    assert.ok(fs.existsSync(manifestOf(c.pid)), 'its manifest kept');
    assert.ok(dirs.every((d) => fs.existsSync(d)), 'its directories kept');
  } finally {
    c.kill('SIGTERM');
    await ended(c);
    sweepStale();
  }
});
