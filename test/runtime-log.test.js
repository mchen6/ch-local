'use strict';
require('./tmp-dirs');
// C-daemon-log: the shared runtime's log, <home>/run/daemon/runtime.log
// (lib/runtime-log.js): lines land whole; private, never through a link or
// into a loosened file; bounded (a line cap, a size cap with one .1 kept, a
// rename that fails is not fatal); never in the runtime's way (a writer that
// throws or never returns drops lines, counted, and nothing waits on it).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {spawn} = require('node:child_process');
const {openRuntimeLog} = require('../lib/runtime-log');
const {tmp} = require('./fake-io');

const WIN = process.platform === 'win32';
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const runDir = () => { const d = path.join(tmp('ch-rtlog-'), 'run', 'daemon'); fs.mkdirSync(d, {recursive: true, mode: 0o700}); return d; };
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
// a fake win-acl: every file it made is private; one it is told about is not
const fakeAcl = (loose = new Set()) => ({
  created: [],
  createPrivate(file, data) { this.created.push(file); fs.writeFileSync(file, data); },
  fileAcl(file) { return {file}; },
  privateProblem(what, acl) { return loose.has(acl.file) ? `${what} is accessible by S-1-5-11` : null; }
});
const platformOpts = () => (WIN ? {platform: 'win32', acl: fakeAcl()} : {});

test('the daemon\'s own lines, stamped, and a runtime\'s lines, whole, land in the file', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, platformOpts());
  log.write('ch-local daemon: started\n');
  const s = new EventEmitter();
  log.forward(s);
  s.emit('data', 'one {"msg":"module remote: ');
  s.emit('data', 'tools/list 3 tools"}\ntwo\n');
  s.emit('data', 'three');
  s.emit('end');
  await log.close();
  const lines = read(log.file).trim().split('\n');
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[^ ]+ ch-local daemon: started$/);
  assert.deepStrictEqual(lines.slice(1), ['one {"msg":"module remote: tools/list 3 tools"}', 'two', 'three']);
});

test('a real child\'s stdout and stderr, read through pipes', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, platformOpts());
  const child = spawn(process.execPath, ['-e', 'console.log("to stdout"); console.error("to stderr")'], {stdio: ['ignore', 'pipe', 'pipe']});
  log.forward(child.stdout);
  log.forward(child.stderr);
  await new Promise((r) => child.on('close', r));
  await log.close();
  const text = read(log.file);
  assert.match(text, /^to stdout$/m);
  assert.match(text, /^to stderr$/m);
});

test('private: POSIX 0600, made by this user', {skip: WIN && 'POSIX modes'}, async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir);
  log.write('x');
  await log.close();
  assert.strictEqual(fs.statSync(log.file).mode & 0o777, 0o600);
  assert.strictEqual(log.problem, null);
});

test('a link at runtime.log is never followed: set aside, its target untouched, a fresh private file', {skip: WIN && 'symlinks need privilege'}, async() => {
  const dir = runDir();
  const target = path.join(path.dirname(dir), 'elsewhere.txt');
  fs.writeFileSync(target, 'theirs\n');
  fs.symlinkSync(target, path.join(dir, 'runtime.log'));
  const log = openRuntimeLog(dir);
  log.write('ours');
  await log.close();
  assert.strictEqual(fs.readFileSync(target, 'utf8'), 'theirs\n', 'the link\'s target untouched');
  assert.ok(fs.lstatSync(log.file).isFile() && !fs.lstatSync(log.file).isSymbolicLink());
  assert.strictEqual(fs.statSync(log.file).mode & 0o777, 0o600);
  assert.ok(fs.lstatSync(`${log.file}.1`).isSymbolicLink(), 'the link set aside as .1');
  assert.match(read(log.file), /the earlier runtime\.log was set aside as runtime\.log\.1, unread: it is not a plain file/);
});

test('POSIX: an existing runtime.log with mode bits wider than 600 is never appended to', {skip: WIN && 'POSIX modes'}, async() => {
  const dir = runDir();
  const f = path.join(dir, 'runtime.log');
  fs.writeFileSync(f, 'old\n', {mode: 0o644});
  fs.chmodSync(f, 0o644);
  const log = openRuntimeLog(dir);
  log.write('new');
  await log.close();
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.doesNotMatch(read(f), /^old$/m);
  assert.match(read(f), /set aside as runtime\.log\.1, unread: its mode is 644, wider than 600/);
  assert.strictEqual(read(`${f}.1`), 'old\n');
});

test('Windows: an existing runtime.log whose DACL is loosened is never appended to; a new one is made through createPrivate', async() => {
  const dir = runDir();
  const f = path.join(dir, 'runtime.log');
  fs.writeFileSync(f, 'old\n');
  const acl = fakeAcl(new Set([f]));
  // (the fake judges by name: the fresh file at the same path is private)
  acl.createPrivate = function(file, data) { this.created.push(file); acl.privateProblem = () => null; fs.writeFileSync(file, data); };
  const log = openRuntimeLog(dir, {platform: 'win32', acl});
  log.write('new');
  await log.close();
  assert.deepStrictEqual(acl.created, [f], 'made private');
  assert.doesNotMatch(read(f), /^old$/m);
  assert.match(read(f), /set aside as runtime\.log\.1, unread: runtime\.log is accessible by S-1-5-11/);
  assert.strictEqual(read(`${f}.1`), 'old\n');
});

test('one line is cut at the line cap, with a marker; a run of data with no newline too', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, {...platformOpts(), lineCap: 100});
  const s = new EventEmitter();
  log.forward(s);
  s.emit('data', `${'a'.repeat(250)}\nshort\n`);
  s.emit('data', 'b'.repeat(300));
  s.emit('data', 'b'.repeat(300));
  s.emit('data', 'tail-of-b\nafter\n');
  await log.close();
  const lines = read(log.file).trim().split('\n');
  assert.deepStrictEqual(lines, [`${'a'.repeat(100)} …[cut: 150 more bytes]`, 'short', `${'b'.repeat(100)} …[cut: 200 more bytes]`, 'after']);
});

test('past the size cap the log becomes runtime.log.1 (one kept) and a fresh one goes on', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, {...platformOpts(), cap: 200});
  for (let i = 0; i < 30; i++) log.write(`line ${i} ${'x'.repeat(20)}`);
  await log.close();
  const names = fs.readdirSync(dir).filter((n) => n.startsWith('runtime.log')).sort();
  assert.deepStrictEqual(names, ['runtime.log', 'runtime.log.1']);
  assert.ok(fs.statSync(path.join(dir, 'runtime.log')).size <= 200);
  assert.ok(fs.statSync(path.join(dir, 'runtime.log.1')).size <= 200);
  assert.match(read(path.join(dir, 'runtime.log')), /line 29 /);
});

test('a rename that fails (Windows: a file another process holds) is not fatal: lines go on, and it is tried again', async() => {
  const dir = runDir();
  let fail = 3;
  let tried = 0;
  const fsx = Object.assign({}, fs, {renameSync(a, b) { tried++; if (fail > 0) { fail--; throw Object.assign(new Error('busy'), {code: 'EBUSY'}); } return fs.renameSync(a, b); }});
  const log = openRuntimeLog(dir, {...platformOpts(), fsx, cap: 150});
  // (two lines fill the cap; the next three find the rename failing and go on
  // into the same file; the sixth finds it working)
  for (let i = 0; i < 6; i++) log.write(`line ${i} ${'y'.repeat(20)}`);
  await log.close();
  assert.strictEqual(tried, 4, 'tried again at each line');
  assert.match(read(path.join(dir, 'runtime.log.1')), /line 0 [\s\S]*line 4 /, 'kept through the failures, then set aside');
  assert.match(read(path.join(dir, 'runtime.log')), /^[^\n]* line 5 y+\n$/, 'a fresh file once it worked');
});

test('opened, a log goes on in the same file (a hand-over, a second daemon); fresh() makes the last one runtime.log.1', async() => {
  const dir = runDir();
  const first = openRuntimeLog(dir, platformOpts());
  first.write('first daemon');
  await first.close();
  const handedOver = openRuntimeLog(dir, platformOpts());
  handedOver.write('the new daemon, handed over');
  await handedOver.close();
  assert.match(read(path.join(dir, 'runtime.log')), /first daemon[\s\S]*the new daemon, handed over/);
  const fresh = openRuntimeLog(dir, platformOpts());
  fresh.fresh();
  fresh.write('a new start');
  await fresh.close();
  assert.match(read(path.join(dir, 'runtime.log.1')), /the new daemon, handed over/);
  assert.doesNotMatch(read(path.join(dir, 'runtime.log')), /first daemon/);
});

test('a writer that throws: the line is dropped, counted, and said once writing works again', async() => {
  const dir = runDir();
  let throwing = 2;
  const sink = (fd, buf, cb) => { if (throwing > 0) { throwing--; throw new Error('disk full'); } fs.write(fd, buf, 0, buf.length, null, (e) => cb(e)); };
  const log = openRuntimeLog(dir, {...platformOpts(), sink});
  log.write('lost 1');
  log.write('lost 2');
  log.write('kept');
  await log.close();
  const text = read(log.file);
  assert.doesNotMatch(text, /lost [12]/);
  assert.match(text, /ch-local daemon: 2 lines dropped\n.* kept$/m);
});

test('a writer that never returns: every line is still taken at once, the queue stays bounded, nothing waits', async() => {
  const dir = runDir();
  let calls = 0;
  const sink = () => { calls++; };   // never calls back
  const log = openRuntimeLog(dir, {...platformOpts(), sink, pendingMax: 1024});
  const s = new EventEmitter();
  log.forward(s);
  const started = Date.now();
  for (let i = 0; i < 5000; i++) s.emit('data', `line ${i} ${'z'.repeat(50)}\n`);
  assert.ok(Date.now() - started < 2000, 'taken at once');
  assert.strictEqual(calls, 1, 'one write outstanding, never more');
  await log.close(100);
  assert.strictEqual(s.listenerCount('data'), 1, 'still read');
});

test('a writer that stalls, then recovers: what queued past the bound is dropped, counted and said; the rest written', async() => {
  const dir = runDir();
  let held = null;
  const sink = (fd, buf, cb) => {
    const go = () => fs.write(fd, buf, 0, buf.length, null, (e) => cb(e));
    if (held === null) held = go; else go();
  };
  const log = openRuntimeLog(dir, {...platformOpts(), sink, pendingMax: 1024});
  const s = new EventEmitter();
  log.forward(s);
  for (let i = 0; i < 5000; i++) s.emit('data', `line ${i} ${'z'.repeat(50)}\n`);
  held();   // the stalled write returns
  s.emit('data', 'after the stall\n');
  await log.close();
  const lines = read(log.file).trim().split('\n');
  assert.ok(lines.length < 40, `bounded: ${lines.length} lines written of 5000`);
  const said = lines.find((l) => /ch-local daemon: \d+ lines dropped$/.test(l));
  assert.ok(said != null && Number(said.match(/(\d+) lines dropped/)[1]) > 4900, said);
  assert.strictEqual(lines[lines.length - 1], 'after the stall');
});

test('a log that can\'t be opened: problem said, lines taken and dropped', async() => {
  const dir = runDir();
  const fsx = Object.assign({}, fs, {openSync() { throw Object.assign(new Error('no'), {code: 'EACCES'}); }, lstatSync() { throw Object.assign(new Error('gone'), {code: 'ENOENT'}); }});
  const log = openRuntimeLog(dir, {fsx, acl: fakeAcl()});
  assert.match(log.problem, /runtime\.log is not used: it could not be opened \(EACCES\)/);
  log.write('nowhere');
  await log.close();
});

test('through bin\'s real spawn: a shared runtime\'s stdout and stderr, piped, land in the log', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, platformOpts());
  const io = require('../bin/ch-local').realIo();
  const child = io.spawn(process.execPath, ['-e', 'console.log("bin out"); console.error("bin err"); if (process.disconnect) process.disconnect();'],
    {env: process.env, control: true, output: log});
  assert.strictEqual(await child.exited, 0);
  await tick(100);
  await log.close();
  const text = read(log.file);
  assert.match(text, /^bin out$/m);
  assert.match(text, /^bin err$/m);
});

test('POSIX: a hard link at runtime.log (one 0600 file of this user\'s, with another name) is never appended to', {skip: WIN && 'POSIX'}, async() => {
  const dir = runDir();
  const other = path.join(path.dirname(dir), 'precious');
  fs.writeFileSync(other, 'mine\n', {mode: 0o600});
  fs.linkSync(other, path.join(dir, 'runtime.log'));
  const log = openRuntimeLog(dir);
  log.write('a log line');
  await log.close();
  assert.strictEqual(fs.readFileSync(other, 'utf8'), 'mine\n', 'the other name\'s file untouched');
  assert.match(read(log.file), /set aside as runtime\.log\.1, unread: it has another name \(a hard link\)/);
});

test('a rename that keeps failing: past twice the cap, lines are dropped and counted, never appended', async() => {
  const dir = runDir();
  const fsx = Object.assign({}, fs, {renameSync() { throw Object.assign(new Error('busy'), {code: 'EBUSY'}); }});
  const log = openRuntimeLog(dir, {...platformOpts(), fsx, cap: 200});
  for (let i = 0; i < 40; i++) log.write(`line ${i} ${'q'.repeat(20)}`);
  await log.close();
  assert.ok(fs.statSync(log.file).size <= 400, `bounded: ${fs.statSync(log.file).size}`);
});

test('a reopen that fails after the rename keeps writing (into .1) and makes the fresh file at a later line', async() => {
  const dir = runDir();
  let failOpen = 1;
  const fsx = Object.assign({}, fs, {openSync(f, flags, mode) { if (flags === 'ax' || (typeof flags === 'number' && (flags & fs.constants.O_EXCL))) { if (failOpen-- > 0) throw Object.assign(new Error('no'), {code: 'EMFILE'}); } return fs.openSync(f, flags, mode); }});
  const log = openRuntimeLog(dir, {...platformOpts(), fsx, cap: 120});
  for (let i = 0; i < 4; i++) log.write(`line ${i} ${'r'.repeat(20)}`);
  await log.close();
  const all = read(`${log.file}.1`) + read(log.file);
  for (let i = 0; i < 4; i++) assert.match(all, new RegExp(`line ${i} `), `line ${i} kept`);
  assert.ok(fs.existsSync(log.file), 'a fresh file made at a later line');
});

test('close destroys the streams it read, so none keeps the daemon up', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, platformOpts());
  let destroyed = 0;
  const s = new EventEmitter();
  s.destroy = () => { destroyed++; };
  log.forward(s);
  await log.close();
  assert.strictEqual(destroyed, 1);
});

test('Windows: a rotation while running never goes through PowerShell (createPrivate): the fresh file is created exclusively', async() => {
  const dir = runDir();
  const acl = fakeAcl();
  const log = openRuntimeLog(dir, {platform: 'win32', acl, cap: 200});
  for (let i = 0; i < 20; i++) log.write(`line ${i} ${'w'.repeat(20)}`);
  await log.close();
  assert.deepStrictEqual(acl.created, [log.file], 'createPrivate once, at the first open, never while running');
  assert.ok(fs.existsSync(`${log.file}.1`), 'rotated');
});

test('a stream that ends is let go of: a daemon that restarts its runtime often holds none of the old ones', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, platformOpts());
  let destroyed = 0;
  for (let i = 0; i < 3; i++) {
    const s = new EventEmitter();
    s.destroy = () => { destroyed++; };
    log.forward(s);
    s.emit('end');
    s.emit('close');
  }
  await log.close();
  assert.strictEqual(destroyed, 0, 'the ended streams were forgotten before close');
});

test('a close that times out with a write still out never closes the fd under it: it goes once the write returns', async() => {
  const dir = runDir();
  let release = null;
  const closed = [];
  const fsx = Object.assign({}, fs, {closeSync(fd) { closed.push(fd); return fs.closeSync(fd); }});
  const sink = (fd, buf, cb) => { release = () => fs.write(fd, buf, 0, buf.length, null, (e) => cb(e)); };
  const log = openRuntimeLog(dir, {...platformOpts(), fsx, sink});
  log.write('held');
  await log.close(50);
  assert.deepStrictEqual(closed, [], 'not closed while the write is out');
  release();
  await tick(50);
  assert.strictEqual(closed.length, 1, 'closed once it returned');
  assert.match(read(log.file), /held/);
});
