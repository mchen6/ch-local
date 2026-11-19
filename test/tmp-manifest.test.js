'use strict';
require('./tmp-dirs');
// test/tmp-dirs.js's manifests and scripts/test.js's watchdog (the
// Reviewer's high review of #97). A process killed by a signal never
// reaches 'exit', so what it made stayed. Each process keeps a manifest of
// the ch-* directories it made; sweepStale(dir) removes those of a process
// that is gone (on this boot, in this pid namespace, this user's), and only
// the directories it lists that are still the ones listed, then the
// manifest; a live process's are left alone. The runner ends a file past its
// time, and itself on SIGTERM, sweeping what they made.
//
// Every case works in a private temporary directory (TMPDIR for the
// children, and the sweep's argument), never on machine-wide counts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {sweepStale, MANIFEST_NAME, where, bornOf} = require('./tmp-dirs');

const ROOT = path.join(__dirname, '..');
const TMP_DIRS = path.join(__dirname, 'tmp-dirs.js');
// this file's own private temporary directory, itself a ch-* one (removed
// at this process's exit)
const PRIVATE = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-tmpmanifest-'));
const envOf = (extra = {}) => ({...process.env, TMPDIR: PRIVATE, TEMP: PRIVATE, TMP: PRIVATE, ...extra});
const chDirs = () => fs.readdirSync(PRIVATE).filter((n) => n.startsWith('ch-'));
const manifests = () => fs.readdirSync(PRIVATE).filter((n) => MANIFEST_NAME.test(n));
// a process's manifest directory, found by its pid (null: none)
const manifestOf = (pid) => {
  const name = manifests().find((n) => Number(MANIFEST_NAME.exec(n)[1]) === pid);
  return name == null ? null : path.join(PRIVATE, name);
};
const listed = (pid) => fs.readFileSync(path.join(manifestOf(pid), 'dirs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.dir != null).map((e) => e.dir);
// a pid no system gives out (Linux's pid_max is at most 2^22): gone, never
// reused while the test runs
const DEAD = 2147483646;

// a child that makes n ch-* directories in PRIVATE, says their paths, then
// waits (or exits)
function child(n, {wait}) {
  const script = `
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    const dirs = []; for (let i = 0; i < ${n}; i++) dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-child-')));
    process.stdout.write(JSON.stringify(dirs) + '\\n');
    ${wait ? 'setInterval(() => {}, 1000);' : ''}`;
  return spawn(process.execPath, ['--require', TMP_DIRS, '-e', script], {env: envOf(), stdio: ['ignore', 'pipe', 'inherit']});
}
const dirsOf = (c) => new Promise((resolve, reject) => {
  let out = '';
  c.stdout.on('data', (d) => { out += d; const i = out.indexOf('\n'); if (i >= 0) resolve(JSON.parse(out.slice(0, i))); });
  c.once('error', reject);
  // (a child that ends without saying its directories fails the case at once)
  c.once('exit', (code, signal) => reject(new Error(`the child ended (${code}, ${signal}) without saying its directories`)));
});
const ended = (c) => new Promise((resolve) => (c.exitCode != null || c.signalCode != null ? resolve() : c.once('exit', resolve)));
const entry = (dir) => { const st = fs.lstatSync(dir, {bigint: true}); return {dir, dev: String(st.dev), ino: String(st.ino), born: bornOf(st)}; };
// whether this system can tell a directory's birth time (the sweep removes
// nothing it cannot prove)
const canTell = (() => { const d = fs.mkdtempSync(path.join(PRIVATE, 'probe-')); const b = bornOf(fs.lstatSync(d, {bigint: true})); fs.rmSync(d, {recursive: true}); return b != null; })();
// the sweep in a process of its own, as the runner runs it (it never makes
// a directory: it probes for itself)
const freshSweep = () => {
  const r = spawnSync(process.execPath, ['-e', `process.stdout.write(String(require(${JSON.stringify(TMP_DIRS)}).sweepStale(${JSON.stringify(PRIVATE)})))`], {env: envOf(), encoding: 'utf8'});
  assert.strictEqual(r.status, 0, r.stderr);
  return Number(r.stdout);
};
// a manifest written by hand for pid, with this sweeper's own where
function staleManifest(pid, lines, {meta = {}} = {}) {
  const at = path.join(PRIVATE, `.ch-local-tmp-${pid}-hand${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(at);
  const head = {meta: {pid, where: where(), tmpdir: PRIVATE, ...meta}};
  fs.writeFileSync(path.join(at, 'dirs.jsonl'), [JSON.stringify(head), ...lines].join('\n'));
  return at;
}

test('a file that ends normally leaves no ch-* directory and no manifest', async () => {
  const c = child(3, {wait: false});
  const dirs = await dirsOf(c).catch(() => null) || [];
  await ended(c);
  assert.strictEqual(dirs.length, 3);
  assert.deepStrictEqual(chDirs(), [], 'every directory it made is gone');
  assert.strictEqual(manifestOf(c.pid), null, 'and its manifest');
});

test('a process killed by a signal mid-file: its manifest names what it made, and the sweep removes exactly that', async () => {
  const c = child(2, {wait: true});
  const dirs = await dirsOf(c);
  assert.deepStrictEqual(listed(c.pid).sort(), dirs.map((d) => path.resolve(d)).sort());
  const manifest = manifestOf(c.pid);
  c.kill('SIGKILL');
  await ended(c);
  assert.ok(dirs.every((d) => fs.existsSync(d)), 'no exit handler ran: they stayed');
  assert.strictEqual(freshSweep(), canTell ? 1 : 0);
  if (canTell) {
    assert.ok(dirs.every((d) => !fs.existsSync(d)), 'removed by the sweep');
    assert.ok(!fs.existsSync(manifest), 'and the manifest with them');
  }
});

test('a dead pid\'s manifest is swept: its listed ch-* directories that are still the ones listed; nothing else it names is touched', () => {
  const mine = fs.mkdtempSync(path.join(PRIVATE, 'ch-mine-'));
  const reborn = fs.mkdtempSync(path.join(PRIVATE, 'ch-reborn-'));
  const unnamed = fs.mkdtempSync(path.join(PRIVATE, 'ch-unnamed-'));
  const outside = fs.mkdtempSync(path.join(PRIVATE, 'other-'));
  // reborn: listed, then made again (another directory between, so no
  // inode is reused at once; its birth time differs where there is one)
  const was = entry(reborn);
  fs.rmSync(reborn, {recursive: true});
  const between = fs.mkdtempSync(path.join(PRIVATE, 'between-'));
  fs.mkdirSync(reborn);
  const now = entry(reborn);
  const at = staleManifest(DEAD, [JSON.stringify(entry(mine)), JSON.stringify(was), JSON.stringify(entry(outside)),
    JSON.stringify({dir: unnamed}), JSON.stringify({...entry(mine), dir: path.join(PRIVATE, '..', 'ch-elsewhere')}), '{"dir": "cut sho']);
  freshSweep();
  if (canTell) assert.ok(!fs.existsSync(mine), 'the listed ch-* directory removed');
  assert.ok(fs.existsSync(reborn), 'a directory made again at a listed path is no longer the one listed: left');
  assert.notStrictEqual(now, null);
  assert.ok(fs.existsSync(unnamed), 'a line with no device or inode: never removed');
  assert.ok(fs.existsSync(outside), 'a listed directory that is no ch-* one is left');
  if (canTell) assert.ok(!fs.existsSync(at), 'the manifest removed');
  fs.rmSync(at, {recursive: true, force: true});
  fs.rmSync(mine, {recursive: true, force: true});
  for (const d of [reborn, unnamed, outside, between]) fs.rmSync(d, {recursive: true, force: true});
});

test('a manifest from another boot or pid namespace, or with no where, is left alone', () => {
  const kept = fs.mkdtempSync(path.join(PRIVATE, 'ch-kept-'));
  const elsewhere = staleManifest(DEAD, [JSON.stringify(entry(kept))], {meta: {where: Object.fromEntries(Object.keys(where()).map((k) => [k, 'another']))}});
  const nowhere = staleManifest(DEAD, [JSON.stringify(entry(kept))], {meta: {where: {}}});
  sweepStale(PRIVATE);
  assert.ok(fs.existsSync(kept) && fs.existsSync(elsewhere) && fs.existsSync(nowhere));
  for (const d of [kept, elsewhere, nowhere]) fs.rmSync(d, {recursive: true, force: true});
});

test('a live process\'s manifest is left alone, and what it lists', async () => {
  const c = child(1, {wait: true});
  try {
    const dirs = await dirsOf(c);
    sweepStale(PRIVATE);
    assert.ok(manifestOf(c.pid) != null, 'its manifest kept');
    assert.ok(dirs.every((d) => fs.existsSync(d)), 'its directories kept');
  } finally {
    c.kill('SIGTERM');
    await ended(c);
    sweepStale(PRIVATE);
  }
});

// a test file that makes a ch-* directory, then hangs (a handle held)
function hangingFile() {
  const dir = fs.mkdtempSync(path.join(PRIVATE, 'fixture-'));
  const file = path.join(dir, 'hang.test.js');
  fs.writeFileSync(file, `
    const test = require('node:test'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    test('hangs', () => { fs.mkdtempSync(path.join(os.tmpdir(), 'ch-hang-')); setInterval(() => {}, 1000); return new Promise(() => {}); });`);
  return file;
}

test('the runner: a file past its time is ended, FAILED as timed out, and what it made is swept', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'test.js'), hangingFile()], {cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: envOf({CH_TEST_FILE_TIMEOUT_MS: '1500', CH_TEST_GRACE_MS: '500', CI: ''})});
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAILED .*hang\.test\.js: timed out after 2 s/);
  assert.strictEqual(r.stdout.match(/FAILED /g).length, 1, 'said once');
  if (process.platform !== 'win32') assert.match(r.stdout + r.stderr, /still running: hangs/, 'the test it hung in, named');
  assert.deepStrictEqual(chDirs(), [], 'its directory swept');
  assert.deepStrictEqual(manifests(), [], 'and its manifest');
});

test('the runner sent SIGTERM ends its files, sweeps what they made, and ends by that signal', async () => {
  const runner = spawn(process.execPath, [path.join(ROOT, 'scripts', 'test.js'), hangingFile()], {cwd: ROOT, env: envOf({CH_TEST_GRACE_MS: '500'}), stdio: 'ignore'});
  // (until its manifest lists it: a directory is made a moment before its
  // line is written, and one killed in between was never recorded)
  const recorded = () => manifests().some((n) => { try { return fs.readFileSync(path.join(PRIVATE, n, 'dirs.jsonl'), 'utf8').includes('ch-hang-'); } catch (e) { return false; } });
  for (const until = Date.now() + 20000; !recorded() && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
  assert.ok(recorded(), 'the file made its directory, and its manifest lists it');
  runner.kill('SIGTERM');
  const [code, signal] = await new Promise((resolve) => runner.once('exit', (c, s) => resolve([c, s])));
  // POSIX: the runner's handler ends its file, sweeps, and re-raises.
  // Windows: SIGTERM ends the runner at once, with no handler run; its file
  // sees its runner gone within a second or two and ends itself, its
  // directories removed at its own 'exit' (Windows never reparents)
  if (process.platform !== 'win32') {
    assert.strictEqual(signal, 'SIGTERM', `ended ${code} ${signal}`);
  } else {
    for (const until = Date.now() + 15000; (chDirs().length > 0 || manifests().length > 0) && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepStrictEqual(chDirs(), [], 'its file\'s directory swept');
  assert.deepStrictEqual(manifests(), [], 'and its manifest');
});

// what a file started, holding its pipes (a server, a runtime), neither
// keeps the runner waiting nor outlives the file: the file's whole process
// group (the whole tree on Windows) is ended (the medium on #97's second
// round, 1 and 2)
test('the runner: a timed-out file\'s child that holds its pipes is ended with it, and the runner still finishes', () => {
  const dir = fs.mkdtempSync(path.join(PRIVATE, 'fixture-'));
  const pidFile = path.join(dir, 'grandchild.pid');
  const file = path.join(dir, 'spawner.test.js');
  fs.writeFileSync(file, `
    const test = require('node:test'); const {spawn} = require('node:child_process'); const fs = require('node:fs');
    test('starts a server and hangs', () => {
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'inherit'});
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      setInterval(() => {}, 1000);
      return new Promise(() => {});
    });`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'test.js'), file], {cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: envOf({CH_TEST_FILE_TIMEOUT_MS: '1500', CH_TEST_GRACE_MS: '500', CI: ''})});
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAILED .*spawner\.test\.js: timed out/);
  assert.ok(Date.now() - started < 30000, 'the runner did not wait on the held pipes');
  const g = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (const until = Date.now() + 5000; alive && Date.now() < until;) { try { process.kill(g, 0); } catch (e) { alive = false; } }
  assert.strictEqual(alive, false, 'the child it started is ended with it');
});

test('a manifest with no first line: removed when its pid is gone and it names nothing; one naming directories it cannot prove is left', () => {
  const empty = path.join(PRIVATE, `.ch-local-tmp-${DEAD}-empty${process.pid}`);
  const older = path.join(PRIVATE, `.ch-local-tmp-${DEAD}-older${process.pid}`);
  const kept = fs.mkdtempSync(path.join(PRIVATE, 'ch-older-'));
  fs.mkdirSync(empty);
  fs.mkdirSync(older);
  fs.writeFileSync(path.join(older, 'dirs.jsonl'), JSON.stringify(entry(kept)) + '\n');
  freshSweep();
  assert.ok(!fs.existsSync(empty), 'the empty one removed');
  assert.ok(fs.existsSync(older) && fs.existsSync(kept), 'the earlier format left, and what it names');
  for (const d of [older, kept]) fs.rmSync(d, {recursive: true, force: true});
});

// (Linux: a pid is ended only when its start time is the one recorded)
test('a detached daemon a killed file started is ended by the sweep before what it uses is removed', {skip: process.platform !== 'linux'}, async () => {
  const pidFile = path.join(PRIVATE, `daemon-${process.pid}.pid`);
  const script = `
    const {spawn} = require('node:child_process'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    fs.mkdtempSync(path.join(os.tmpdir(), 'ch-daemonhome-'));
    const d = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore'});
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(d.pid));
    process.stdout.write('["ready"]' + String.fromCharCode(10));
    setInterval(() => {}, 1000);`;
  const c = spawn(process.execPath, ['--require', TMP_DIRS, '-e', script], {env: envOf(), stdio: ['ignore', 'pipe', 'inherit']});
  await dirsOf(c);
  const daemon = Number(fs.readFileSync(pidFile, 'utf8'));
  c.kill('SIGKILL');
  await ended(c);
  let alive = true;
  try { process.kill(daemon, 0); } catch (e) { alive = false; }
  assert.strictEqual(alive, true, 'the daemon outlived its file');
  freshSweep();
  for (const until = Date.now() + 5000; alive && Date.now() < until;) { try { process.kill(daemon, 0); await new Promise((r) => setTimeout(r, 50)); } catch (e) { alive = false; } }
  assert.strictEqual(alive, false, 'ended by the sweep');
  fs.rmSync(pidFile, {force: true});
  for (const n of chDirs()) if (n.startsWith('ch-daemonhome-')) fs.rmSync(path.join(PRIVATE, n), {recursive: true, force: true});
});

// The runner killed outright (SIGKILL, an OOM kill: no handler runs): its
// file sees it gone and ends itself, its directories removed at its own
// 'exit' (the Reviewer's second high review of #97, 5)
test('the runner killed outright: its file ends itself within seconds, what it made removed', async () => {
  const runner = spawn(process.execPath, [path.join(ROOT, 'scripts', 'test.js'), hangingFile()], {cwd: ROOT, env: envOf(), stdio: 'ignore'});
  const recorded = () => manifests().some((n) => { try { return fs.readFileSync(path.join(PRIVATE, n, 'dirs.jsonl'), 'utf8').includes('ch-hang-'); } catch (e) { return false; } });
  for (const until = Date.now() + 20000; !recorded() && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
  assert.ok(recorded(), 'the file made its directory, and its manifest lists it');
  runner.kill('SIGKILL');
  await new Promise((resolve) => runner.once('exit', resolve));
  for (const until = Date.now() + 15000; (chDirs().length > 0 || manifests().length > 0) && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(chDirs(), [], 'the file ended itself, its directory removed');
  assert.deepStrictEqual(manifests(), [], 'and its manifest');
});
