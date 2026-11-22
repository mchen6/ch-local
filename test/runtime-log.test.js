'use strict';
require('./tmp-dirs');
// C-daemon-log: the shared runtime's log, <home>/run/daemon/runtime.log
// (lib/runtime-log.js): lines land whole, the runtime's marked; private,
// never through a link, a FIFO or into a loosened, hard-linked or swapped
// file; bounded by size alone (rotated only by the daemon that has the
// home, one .1 kept, a rename that fails is not fatal, a hard cap); a log
// removed meanwhile comes back; never in the runtime's way (a writer that
// throws, never returns, stalls or writes short).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {spawn, spawnSync} = require('node:child_process');
const {openRuntimeLog} = require('../lib/runtime-log');
const {tmp} = require('./fake-io');

const WIN = process.platform === 'win32';
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const runDir = () => { const d = path.join(tmp('ch-rtlog-'), 'run', 'daemon'); fs.mkdirSync(d, {recursive: true, mode: 0o700}); return d; };
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
// (a bounded wait on what can be seen, never a fixed sleep)
const until = async(what, ok, ms = 5000) => {
  const by = Date.now() + ms;
  while (!ok() && Date.now() < by) await tick();
  assert.ok(ok(), what);
};
// a fake win-acl: one file it is told about is not private; it counts the
// PowerShell runs (createPrivate, fileAcl) it is asked for
const fakeAcl = (loose = new Set()) => ({
  created: [], read: [],
  createPrivate(file, data) { this.created.push(file); fs.writeFileSync(file, data); },
  fileAcl(file) { this.read.push(file); return {file}; },
  privateProblem(what, acl) { return loose.has(acl.file) ? `${what} is accessible by S-1-5-11` : null; }
});
const platformOpts = () => (WIN ? {platform: 'win32', acl: fakeAcl()} : {});
const POSIX_SKIP = WIN && 'POSIX';
// a stat with one field changed
const changed = (s, k, v) => Object.assign(Object.create(Object.getPrototypeOf(s)), s, {[k]: v});

test('the daemon\'s own lines, stamped, and a runtime\'s lines, whole and marked [runtime], land in the file', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, platformOpts());
  log.write('ch-local daemon: started\n');
  const s = new EventEmitter();
  log.forward(s);
  s.emit('data', 'one {"msg":"module remote: ');
  s.emit('data', 'tools/list 3 tools"}\r\ntwo\n');
  s.emit('data', 'three');
  s.emit('end');
  await log.close();
  const lines = read(log.file).trim().split('\n');
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT[^ ]+ ch-local daemon: started$/);
  assert.deepStrictEqual(lines.slice(1), ['[runtime] one {"msg":"module remote: tools/list 3 tools"}', '[runtime] two', '[runtime] three']);
});

test('a runtime\'s line can\'t pass for the daemon\'s, nor move a terminal\'s cursor: marked, control characters but tab as "?"', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, platformOpts());
  const s = new EventEmitter();
  log.forward(s);
  s.emit('data', '2026-11-22T00:00:00.000Z ch-local daemon: forged\n\u001b[2J\tcleared\u0007\u2028x\n\u202erev\u2066\n');
  await log.close();
  assert.deepStrictEqual(read(log.file).trim().split('\n'), ['[runtime] 2026-11-22T00:00:00.000Z ch-local daemon: forged', '[runtime] ?[2J\tcleared??x', '[runtime] ?rev?']);
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
  assert.match(text, /^\[runtime\] to stdout$/m);
  assert.match(text, /^\[runtime\] to stderr$/m);
});

test('through bin\'s real spawn: a shared runtime\'s stdout and stderr, piped, land in the log', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, platformOpts());
  const io = require('../bin/ch-local').realIo();
  const child = io.spawn(process.execPath, ['-e', 'console.log("bin out"); console.error("bin err"); if (process.disconnect) process.disconnect();'],
    {env: process.env, control: true, output: log});
  assert.strictEqual(await child.exited, 0);
  // (the pipes' last data may come just after the exit: waited for, bounded)
  await until('both lines in the log', () => /^\[runtime\] bin out$/m.test(read(log.file)) && /^\[runtime\] bin err$/m.test(read(log.file)));
  await log.close();
});

test('private: POSIX 0600, made by this user', {skip: POSIX_SKIP}, async() => {
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
  assert.ok(fs.lstatSync(`${log.file}.1`).isSymbolicLink(), 'the link set aside as .1');
  assert.match(read(log.file), /\[runtime log\] the earlier runtime\.log was set aside as runtime\.log\.1, unread: it is not a plain file/);
});

// (the lstat sees nothing there: what is at the name lands between it and
// the open)
const unseenOnce = (name) => {
  let first = true;
  return Object.assign({}, fs, {lstatSync(p, o) { if (p === name && first) { first = false; throw Object.assign(new Error('none'), {code: 'ENOENT'}); } return fs.lstatSync(p, o); }});
};

test('POSIX: O_NOFOLLOW itself refuses a link swapped in after the lstat: nothing made at its target', {skip: POSIX_SKIP}, async() => {
  const dir = runDir();
  const target = path.join(path.dirname(dir), 'never-made.txt');
  const name = path.join(dir, 'runtime.log');
  fs.symlinkSync(target, name);
  const log = openRuntimeLog(dir, {fsx: unseenOnce(name)});
  log.write('ours');
  await log.close();
  assert.strictEqual(fs.existsSync(target), false, 'O_CREAT never followed the link');
  assert.match(read(log.file), /set aside as runtime\.log\.1, unread: it could not be opened \(ELOOP\)/);
});

test('POSIX: a FIFO swapped in after the lstat never blocks the open (O_NONBLOCK): set aside', {skip: (WIN || spawnSync('mkfifo', ['--version']).error != null) && 'POSIX mkfifo'}, async() => {
  const dir = runDir();
  const name = path.join(dir, 'runtime.log');
  assert.strictEqual(spawnSync('mkfifo', [name]).status, 0);
  const log = openRuntimeLog(dir, {fsx: unseenOnce(name)});
  log.write('ours');
  await log.close();
  assert.ok(fs.lstatSync(`${name}.1`).isFIFO(), 'the FIFO set aside');
  assert.match(read(name), /ours/);
});

test('a name swapped as it was opened, a file owned by another user, a failing fstat: never written to, never fatal', {skip: POSIX_SKIP}, async() => {
  const name = (dir) => path.join(dir, 'runtime.log');
  // swapped: the name, once open, names another file
  let dir = runDir();
  fs.writeFileSync(name(dir), '', {mode: 0o600});
  let calls = 0;
  let fsx = Object.assign({}, fs, {lstatSync(p, o) { const s = fs.lstatSync(p, o); return (p === name(dir) && ++calls === 2) ? changed(s, 'ino', s.ino + 1) : s; }});
  let log = openRuntimeLog(dir, {fsx});
  assert.match(log.note, /it changed as it was opened/);
  await log.close();
  // owned by another user
  dir = runDir();
  fs.writeFileSync(name(dir), 'old\n', {mode: 0o600});
  let once = true;
  fsx = Object.assign({}, fs, {fstatSync(fd) { const s = fs.fstatSync(fd); if (once) { once = false; return changed(s, 'uid', s.uid + 1); } return s; }});
  log = openRuntimeLog(dir, {fsx});
  assert.match(log.note, /it is owned by another user/);
  await log.close();
  assert.strictEqual(read(`${name(dir)}.1`), 'old\n');
  // a failing fstat: a problem, said; no throw
  dir = runDir();
  fsx = Object.assign({}, fs, {fstatSync() { throw Object.assign(new Error('io'), {code: 'EIO'}); }});
  log = openRuntimeLog(dir, {fsx});
  assert.match(log.problem, /it could not be read once open \(EIO\)/);
  log.write('nowhere');
  await log.close();
});

test('POSIX: an existing runtime.log with mode bits wider than 600 is never appended to', {skip: POSIX_SKIP}, async() => {
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

test('POSIX: a hard link at runtime.log (a 0600 file of this user\'s, with another name) is never appended to', {skip: POSIX_SKIP}, async() => {
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

test('Windows: an existing runtime.log whose DACL is loosened is never appended to; the fresh one is made exclusively, with no createPrivate', async() => {
  const dir = runDir();
  const f = path.join(dir, 'runtime.log');
  fs.writeFileSync(f, 'old\n');
  const acl = fakeAcl(new Set([f]));
  const log = openRuntimeLog(dir, {platform: 'win32', acl});
  log.write('new');
  await log.close();
  assert.deepStrictEqual(acl.created, [], 'no createPrivate');
  assert.deepStrictEqual(acl.read, [f], 'the existing one\'s DACL read, once');
  assert.doesNotMatch(read(f), /^old$/m);
  assert.match(read(f), /set aside as runtime\.log\.1, unread: runtime\.log is accessible by S-1-5-11/);
  assert.strictEqual(read(`${f}.1`), 'old\n');
});

test('Windows: two daemons making it at once: the one that loses opens the one there, through its DACL check', async() => {
  const dir = runDir();
  const f = path.join(dir, 'runtime.log');
  const acl = fakeAcl();
  // (the exclusive create finds it made a moment ago by the other daemon)
  const fsx = Object.assign({}, fs, {openSync(p, flags, mode) { if (p === f && flags === 'ax') { fs.writeFileSync(f, 'the other daemon\n'); throw Object.assign(new Error('exists'), {code: 'EEXIST'}); } return fs.openSync(p, flags, mode); }});
  const log = openRuntimeLog(dir, {platform: 'win32', acl, fsx});
  assert.strictEqual(log.problem, null);
  log.write('this one');
  await log.close();
  assert.deepStrictEqual(acl.read, [f], 'judged as an existing file');
  assert.match(read(f), /^the other daemon\n.* this one\n$/);
});

test('one line is cut at the line cap, on a character\'s boundary, with a marker; a run of data with no newline too', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, {...platformOpts(), lineCap: 100});
  const s = new EventEmitter();
  log.forward(s);
  s.emit('data', `${'a'.repeat(250)}\nshort\n`);
  s.emit('data', 'b'.repeat(300));
  s.emit('data', 'b'.repeat(300));
  s.emit('data', 'tail-of-b\nafter\n');
  log.write('é'.repeat(60));
  await log.close();
  const lines = read(log.file).trim().split('\n');
  assert.deepStrictEqual(lines.slice(0, 4), [`[runtime] ${'a'.repeat(90)} …[cut: 160 more bytes]`, '[runtime] short', `[runtime] ${'b'.repeat(90)} …[cut: 210 more bytes]`, '[runtime] after']);
  assert.doesNotMatch(lines[4], /�/, 'no character split');
  assert.match(lines[4], /é …\[cut: \d+ more bytes\]$/);
});

test('past the size cap, the daemon that has the home moves it to runtime.log.1 (one kept) and goes on in a fresh one', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, {...platformOpts(), cap: 200});
  log.own();
  for (let i = 0; i < 30; i++) log.write(`line ${i} ${'x'.repeat(20)}`);
  await log.close();
  const names = fs.readdirSync(dir).filter((n) => n.startsWith('runtime.log')).sort();
  assert.deepStrictEqual(names, ['runtime.log', 'runtime.log.1']);
  assert.ok(fs.statSync(path.join(dir, 'runtime.log')).size <= 200);
  assert.ok(fs.statSync(path.join(dir, 'runtime.log.1')).size <= 200);
  assert.match(read(path.join(dir, 'runtime.log')), /line 29 /);
});

test('only the daemon that has the home rotates: another opener appends, and stops at twice the cap', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, {...platformOpts(), cap: 200});
  for (let i = 0; i < 30; i++) log.write(`line ${i} ${'x'.repeat(20)}`);
  await log.close();
  assert.strictEqual(fs.existsSync(path.join(dir, 'runtime.log.1')), false, 'never rotated');
  assert.ok(fs.statSync(path.join(dir, 'runtime.log')).size <= 400);
});

test('opened again (a restart, a hand-over, a second daemon), a log goes on in the same file: nothing rotated at a start', async() => {
  const dir = runDir();
  for (const who of ['first daemon', 'the new daemon, handed over', 'a later start']) {
    const log = openRuntimeLog(dir, platformOpts());
    log.own();
    log.write(who);
    await log.close();
  }
  assert.match(read(path.join(dir, 'runtime.log')), /first daemon[\s\S]*handed over[\s\S]*a later start/);
  assert.strictEqual(fs.existsSync(path.join(dir, 'runtime.log.1')), false);
});

test('a rename that fails (Windows: a file another process holds) is not fatal: lines go on, and it is tried again', async() => {
  const dir = runDir();
  let fail = 3;
  let tried = 0;
  const fsx = Object.assign({}, fs, {renameSync(a, b) { tried++; if (fail > 0) { fail--; throw Object.assign(new Error('busy'), {code: 'EBUSY'}); } return fs.renameSync(a, b); }});
  const log = openRuntimeLog(dir, {...platformOpts(), fsx, cap: 150});
  log.own();
  // (two lines fill the cap; the next three find the rename failing and go on
  // into the same file; the sixth finds it working)
  for (let i = 0; i < 6; i++) log.write(`line ${i} ${'y'.repeat(20)}`);
  await log.close();
  assert.strictEqual(tried, 4, 'tried again at each line');
  assert.match(read(path.join(dir, 'runtime.log.1')), /line 0 [\s\S]*line 4 /, 'kept through the failures, then set aside');
  assert.match(read(path.join(dir, 'runtime.log')), /^[^\n]* line 5 y+\n$/, 'a fresh file once it worked');
});

test('a rename that keeps failing: past twice the cap, lines are dropped, never appended', async() => {
  const dir = runDir();
  const fsx = Object.assign({}, fs, {renameSync() { throw Object.assign(new Error('busy'), {code: 'EBUSY'}); }});
  const log = openRuntimeLog(dir, {...platformOpts(), fsx, cap: 200});
  log.own();
  for (let i = 0; i < 40; i++) log.write(`line ${i} ${'q'.repeat(20)}`);
  await log.close();
  assert.ok(fs.statSync(log.file).size <= 400, `bounded: ${fs.statSync(log.file).size}`);
});

test('a log removed (or moved) while the daemon runs comes back at its name at the next check', async() => {
  const dir = runDir();
  let t = 0;
  const log = openRuntimeLog(dir, {...platformOpts(), clock: () => t, checkMs: 1000});
  log.write('before');
  await until('the first line written', () => /before/.test(read(log.file)));
  fs.rmSync(log.file);
  t = 2000;
  log.write('after');
  await log.close();
  assert.match(read(log.file), /after/, 'opened again');
  assert.doesNotMatch(read(log.file), /before/);
});

test('a rotation whose rename finds nothing there (removed meanwhile) goes on in a fresh file', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, {...platformOpts(), cap: 120});
  log.own();
  log.write(`one ${'z'.repeat(40)}`);
  await until('the first line written', () => /one /.test(read(log.file)));
  fs.rmSync(log.file);
  log.write(`two ${'z'.repeat(40)}`);
  log.write(`three ${'z'.repeat(40)}`);
  await log.close();
  assert.match(read(log.file), /three /);
});

test('Windows: a rotation while running never goes through PowerShell', async() => {
  const dir = runDir();
  const acl = fakeAcl();
  const log = openRuntimeLog(dir, {platform: 'win32', acl, cap: 200});
  log.own();
  for (let i = 0; i < 20; i++) log.write(`line ${i} ${'w'.repeat(20)}`);
  await log.close();
  assert.deepStrictEqual([acl.created, acl.read], [[], []], 'no createPrivate, no fileAcl');
  assert.ok(fs.existsSync(`${log.file}.1`), 'rotated');
});

test('a writer that throws: the lines are dropped, counted, and said in their place', async() => {
  const dir = runDir();
  let throwing = 2;
  const sink = (fd, buf, cb) => { if (throwing > 0) { throwing--; throw new Error('disk full'); } fs.write(fd, buf, 0, buf.length, null, (e) => cb(e)); };
  const log = openRuntimeLog(dir, {...platformOpts(), sink});
  log.write('lost 1');
  log.write('lost 2');
  await until('both tried', () => throwing === 0);
  log.write('kept');
  await log.close();
  const text = read(log.file);
  assert.doesNotMatch(text, /lost [12]/);
  assert.match(text, /\[runtime log\] 2 lines dropped\n.* kept$/m);
});

test('a short write goes on from where it stopped: every byte written', async() => {
  const dir = runDir();
  const fsx = Object.assign({}, fs, {write(fd, buf, off, len, pos, cb) { return fs.write(fd, buf, off, Math.min(len, 5), pos, cb); }});
  const log = openRuntimeLog(dir, {...platformOpts(), fsx});
  log.write('a line longer than five bytes');
  await log.close();
  assert.match(read(log.file), / a line longer than five bytes\n$/);
});

test('a writer that never returns: every line is still taken at once, the queue stays bounded, nothing waits', async() => {
  const dir = runDir();
  let calls = 0;
  const sink = () => { calls++; };   // never calls back
  const log = openRuntimeLog(dir, {...platformOpts(), sink, pendingMax: 1024});
  const s = new EventEmitter();
  log.forward(s);
  for (let i = 0; i < 5000; i++) s.emit('data', `line ${i} ${'z'.repeat(50)}\n`);
  assert.strictEqual(calls, 1, 'one write outstanding, never more');
  await log.close(100);
  assert.strictEqual(s.listenerCount('data'), 1, 'still read');
});

test('a writer that stalls, then recovers: what queued past the bound is dropped and said in its place; the rest written', async() => {
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
  await until('the queue drained', () => read(log.file).split('\n').length > 10);
  s.emit('data', 'after the stall\n');
  await log.close();
  const lines = read(log.file).trim().split('\n');
  assert.ok(lines.length < 40, `bounded: ${lines.length} lines written of 5000`);
  const at = lines.findIndex((l) => /\[runtime log\] \d+ lines dropped$/.test(l));
  assert.ok(at > 0 && Number(lines[at].match(/(\d+) lines dropped/)[1]) > 4900, lines[at]);
  assert.match(lines[at - 1], /^\[runtime\] line \d+ z+$/, 'after the lines queued ahead of the drops');
  assert.strictEqual(lines[at + 1], '[runtime] after the stall', 'and before the next line kept');
});

test('a log that can\'t be opened: problem said, lines taken and dropped', async() => {
  const dir = runDir();
  const fsx = Object.assign({}, fs, {openSync() { throw Object.assign(new Error('no'), {code: 'EACCES'}); }, lstatSync() { throw Object.assign(new Error('gone'), {code: 'ENOENT'}); }});
  const log = openRuntimeLog(dir, {fsx, acl: fakeAcl()});
  assert.match(log.problem, /runtime\.log is not used: it could not be (opened|made) \(EACCES\)/);
  log.write('nowhere');
  await log.close();
});

test('close destroys the streams it read, so none keeps the daemon up; a stream that ended is let go of first', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, platformOpts());
  let destroyed = 0;
  const live = new EventEmitter();
  live.destroy = () => { destroyed++; };
  log.forward(live);
  for (let i = 0; i < 3; i++) {
    const s = new EventEmitter();
    s.destroy = () => { destroyed += 10; };
    log.forward(s);
    s.emit('end');
    s.emit('close');
  }
  await log.close();
  assert.strictEqual(destroyed, 1, 'the live one destroyed, the ended ones forgotten');
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
  await until('closed once it returned', () => closed.length === 1);
  assert.match(read(log.file), /held/);
});

test('through bin\'s real spawn: a runtime that can\'t be started is said in the log too', async() => {
  const dir = runDir();
  const log = openRuntimeLog(dir, platformOpts());
  const io = require('../bin/ch-local').realIo();
  const child = io.spawn(path.join(dir, 'no-such-node'), [], {env: process.env, control: true, output: log});
  assert.strictEqual(await child.exited, 1);
  await log.close();
  assert.match(read(log.file), /ch-local: could not start the runtime \(ENOENT\)/);
});

test('Windows: on the running path, a file found at the name (a recheck, a rotation meeting one) is set aside and made anew, never through PowerShell', async() => {
  const dir = runDir();
  const acl = fakeAcl();
  let t = 0;
  const log = openRuntimeLog(dir, {platform: 'win32', acl, clock: () => t, checkMs: 1000, cap: 300});
  log.own();
  log.write('first');
  await until('written', () => /first/.test(read(log.file)));
  // the name now names another file (an editor's save by rename)
  fs.rmSync(log.file);
  fs.writeFileSync(log.file, 'theirs\n');
  t = 2000;
  log.write('after the swap');
  await until('written after the swap', () => /after the swap/.test(read(log.file)));
  assert.strictEqual(read(`${log.file}.1`), 'theirs\n', 'the file found set aside, unread');
  // and rotations past the cap
  for (let i = 0; i < 12; i++) log.write(`line ${i} ${'v'.repeat(20)}`);
  await log.close();
  assert.deepStrictEqual([acl.created, acl.read], [[], []], 'no createPrivate, no fileAcl while running');
});

test('a rotation whose fresh file could not be made renames nothing again: only the fresh file is tried next', async() => {
  const dir = runDir();
  let failMake = 1;
  let renames = 0;
  const excl = (flags) => flags === 'ax' || (typeof flags === 'number' && (flags & fs.constants.O_EXCL) !== 0);
  const fsx = Object.assign({}, fs, {
    renameSync(a, b) { renames++; return fs.renameSync(a, b); },
    openSync(p, flags, mode) { if (excl(flags) && failMake-- > 0) throw Object.assign(new Error('no'), {code: 'EMFILE'}); return fs.openSync(p, flags, mode); }
  });
  const log = openRuntimeLog(dir, {...platformOpts(), fsx, cap: 120});
  log.own();
  for (let i = 0; i < 4; i++) log.write(`line ${i} ${'r'.repeat(20)}`);
  await log.close();
  assert.strictEqual(renames, 1, 'renamed once, then the fresh file made');
  const all = read(`${log.file}.1`) + read(log.file);
  for (let i = 0; i < 4; i++) assert.match(all, new RegExp(`line ${i} `), `line ${i} kept`);
});

test('drops not yet said are said at close (under the hard cap; past it nothing more is written)', async() => {
  const dir = runDir();
  let n = 0;
  const sink = (fd, buf, cb) => { if (++n === 2) throw new Error('disk full'); fs.write(fd, buf, 0, buf.length, null, (e) => cb(e)); };
  const log = openRuntimeLog(dir, {...platformOpts(), sink});
  log.write('kept');
  log.write('lost at the end');
  await until('both tried', () => n >= 2);
  await log.close();
  assert.match(read(log.file), / kept\n.*\[runtime log\] 1 lines dropped\n$/);
});
