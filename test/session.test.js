'use strict';
require('./tmp-dirs');
// `ch-local session` (lib/session.js): every client entry's one decision
// between the shared runtime's shim and the session's own runtime, made in
// the home's code at each start (the reviewer's high on #120, 1 (a)).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {spawn, spawnSync} = require('node:child_process');
const {sessionChoice, runShim, formatProblem} = require('../lib/session');
const {layout} = require('../lib/home');
const {snippet} = require('../lib/snippets');

const ROOT = path.join(__dirname, '..');
const POSIX = process.platform !== 'win32';
const EXE = process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim';
const roots = [];
test.after(() => { for (const d of roots) fs.rmSync(d, {recursive: true, force: true}); });

// A native program for this machine, built here from C (the session checks
// the shim's first bytes, so a script won't do): it says its pid, its
// arguments, and whether each of fds 0-2 arrived O_NONBLOCK. CI's Linux and
// macOS runners have cc; without one, a local run skips these, CI fails.
const PROBE_C = [
  '#include <stdio.h>',
  '#include <unistd.h>',
  '#include <fcntl.h>',
  'int main(int argc, char **argv) {',
  '  printf("SHIM pid=%ld args=", (long)getpid());',
  '  for (int i = 1; i < argc; i++) printf(i > 1 ? " %s" : "%s", argv[i]);',
  '  printf("\\n");',
  '  for (int f = 0; f < 3; f++) { int fl = fcntl(f, F_GETFL); printf("fd%d nonblock=%d\\n", f, fl >= 0 && (fl & O_NONBLOCK) ? 1 : 0); }',
  '  return 0;',
  '}',
  ''
].join('\n');
let probe;
function nativeProbe() {
  if (probe !== undefined) return probe;
  probe = null;
  if (!POSIX) return probe;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-probe-')));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, 'probe.c'), PROBE_C);
  const r = spawnSync('cc', ['-o', path.join(dir, 'probe'), path.join(dir, 'probe.c')], {encoding: 'utf8', timeout: 60000});
  if (r.status === 0) probe = fs.readFileSync(path.join(dir, 'probe'));
  else if (process.env.CI) assert.fail(`cc could not build the probe: ${r.error || r.stderr}`);
  return probe;
}
const NO_PROBE = !POSIX || (process.env.CI == null && spawnSync('cc', ['--version']).status !== 0);

// a home of this user's (0700) holding a valid record, with or without a
// shim recorded, and the shim placed as install places it (or not)
const sha512 = (b) => require('node:crypto').createHash('sha512').update(b).digest('hex');
// <home>/shim.json naming this Node and <home>/bin/ch-local.js, there, as
// install writes them; fields: what to put in their place
function writeShimJsonFor(h, fields = {}) {
  // (0700, as install makes it: the home's checks refuse a loose bin/)
  if (!fs.existsSync(path.join(h, 'bin'))) fs.mkdirSync(path.join(h, 'bin'), {mode: 0o700});
  fs.chmodSync(path.join(h, 'bin'), 0o700);
  if (!fs.existsSync(path.join(h, 'bin', 'ch-local.js'))) fs.writeFileSync(path.join(h, 'bin', 'ch-local.js'), '', {mode: 0o600});
  const body = Object.assign(require('../lib/shim-config').shimJsonFor({node: process.execPath, home: h, env: process.env}), fields);
  fs.writeFileSync(path.join(h, 'shim.json'), JSON.stringify(body), {mode: 0o600});
  fs.chmodSync(path.join(h, 'shim.json'), 0o600);
}
function home({recorded = true, placed = true, body = null, version = '0.5.0', shimJson = true} = {}) {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-session-')));
  roots.push(h);
  fs.chmodSync(h, 0o700);
  const record = {v: 2, runtime: {versions: {}}, release: null, unreleased: true, packs: {}, modules: {}, withdrawn: [], at: new Date().toISOString()};
  if (recorded) record.shim = {package: `@countinghouse/ch-shim-${process.platform}-${process.arch}`, version: '0.5.0'};
  fs.writeFileSync(path.join(h, 'modules.json'), JSON.stringify(record, null, 2) + '\n');
  if (placed) {
    fs.mkdirSync(path.join(h, 'shim'), {mode: 0o700});
    fs.chmodSync(path.join(h, 'shim'), 0o700);
    const bin = body != null ? Buffer.from(body) : nativeProbe();
    fs.writeFileSync(path.join(h, 'shim', EXE), bin, {mode: 0o755});
    fs.chmodSync(path.join(h, 'shim', EXE), 0o755);
    // (which version it is, by its content, as install writes it)
    fs.writeFileSync(path.join(h, 'shim', 'versions.json'), JSON.stringify({[sha512(bin)]: version}) + '\n', {mode: 0o600});
    fs.chmodSync(path.join(h, 'shim', 'versions.json'), 0o600);
  }
  // shim.json as install writes it: this Node, the home's launcher (A3)
  if (shimJson) writeShimJsonFor(h);
  return h;
}
const choose = (h) => sessionChoice({where: layout({COUNTINGHOUSE_HOME: h}, os.homedir)});

test('the shim only when the record names it and the file in place passes the checks; else the session\'s own runtime', {skip: NO_PROBE}, () => {
  const ok = home();
  assert.deepStrictEqual(choose(ok), {shim: path.join(ok, 'shim', EXE), note: null});
  // set aside (SHIM_BUSY; a rollback to a release with none): the record names none
  assert.deepStrictEqual(choose(home({recorded: false})), {shim: null, note: null});
  // no record at all, or one that can't be read: start reports it
  const none = home({recorded: false, placed: false});
  fs.rmSync(path.join(none, 'modules.json'));
  assert.deepStrictEqual(choose(none), {shim: null, note: null});
  const bad = home();
  fs.writeFileSync(path.join(bad, 'modules.json'), '{');
  assert.deepStrictEqual(choose(bad), {shim: null, note: null});
  // recorded but not there: said, and never named
  const gone = home({placed: false});
  const g = choose(gone);
  assert.strictEqual(g.shim, null);
  assert.match(g.note, /the shared runtime's shim is not used: .*ch-shim is not there; this session runs its own runtime/);
  // the checks, now: a loose folder, a loose file, a link in its place
  const loose = home();
  fs.chmodSync(path.join(loose, 'shim'), 0o755);
  assert.strictEqual(choose(loose).shim, null);
  assert.match(choose(loose).note, /0700|mode/);
  const writable = home();
  fs.chmodSync(path.join(writable, 'shim', EXE), 0o775);
  assert.strictEqual(choose(writable).shim, null);
  assert.match(choose(writable).note, /writable by group or others/);
  const linked = home();
  const elsewhere = path.join(linked, 'elsewhere');
  fs.renameSync(path.join(linked, 'shim', EXE), elsewhere);
  fs.symlinkSync(elsewhere, path.join(linked, 'shim', EXE));
  assert.strictEqual(choose(linked).shim, null);
  assert.match(choose(linked).note, /not a regular file \(or is a link\)/);
  // a script, or a program for another machine: never exec'd (Node 22 and
  // 24 abort on ENOEXEC), the fixed line
  const script = home({body: '#!/bin/sh\necho hi\n'});
  assert.strictEqual(choose(script).shim, null);
  assert.match(choose(script).note, new RegExp(`the shared runtime's shim is not a program this machine runs \\(${process.platform}-${process.arch}\\); this session runs its own runtime\\. Run \`.*install\` to put it right`));
});

// A3 (the final pass): shim.json names the Node install ran under; after a
// Node upgrade that moves it (brew, nvm) the shim could start nothing. The
// shim is picked only when shim.json is this user's own, valid, its node
// runnable and its chLocal readable; else the session's own runtime, in this
// Node, and a fixed note naming which field and the errno, never a path.
test('A3: the shim only when shim.json\'s node and chLocal are there; else the own runtime and the install line', {skip: NO_PROBE}, () => {
  const ok = home();
  assert.strictEqual(choose(ok).shim, path.join(ok, 'shim', EXE));
  const note = (which, code) => new RegExp(`^ch-local: the shared runtime's settings \\(shim\\.json\\) name a ${which} that can't be used \\(${code}\\); this session runs its own runtime\\. Run \`[^\`]+ install\` to put it right\\.\\n$`);
  const node = home();
  writeShimJsonFor(node, {node: path.join(node, 'gone', 'node')});
  assert.deepStrictEqual([choose(node).shim, note('Node', 'node: ENOENT').test(choose(node).note)], [null, true], choose(node).note);
  assert.ok(!choose(node).note.includes(path.join(node, 'gone')), 'shim.json\'s path not named (the install line names the launcher, as every note does)');
  const cl = home();
  fs.rmSync(path.join(cl, 'bin', 'ch-local.js'));
  assert.deepStrictEqual([choose(cl).shim, note('ch-local', 'chLocal: ENOENT').test(choose(cl).note)], [null, true], choose(cl).note);
  const missing = home({shimJson: false});
  assert.strictEqual(choose(missing).shim, null);
  assert.match(choose(missing).note, /^ch-local: the shared runtime's settings \(shim\.json\) can't be used \(missing\); this session runs its own runtime\. Run `[^`]+ install` to put it right\.\n$/);
  const loose = home();
  fs.chmodSync(path.join(loose, 'shim.json'), 0o644);
  assert.strictEqual(choose(loose).shim, null, 'not this user\'s own file');
  assert.match(choose(loose).note, /\(shim\.json\) can't be used \(NOT_PRIVATE\)/);
  const invalid = home();
  fs.writeFileSync(path.join(invalid, 'shim.json'), JSON.stringify({node: 'relative/node'}), {mode: 0o600});
  assert.match(choose(invalid).note, /\(shim\.json\) can't be used \(invalid\)/);
  // (a directory where node was: access passes it, the check doesn't)
  const dir = home();
  fs.mkdirSync(path.join(dir, 'a-node-dir'));
  writeShimJsonFor(dir, {node: path.join(dir, 'a-node-dir')});
  assert.strictEqual(choose(dir).shim, null);
  assert.match(choose(dir).note, /name a Node that can't be used \(node: not a file\)/);
});

test('formatProblem: ELF for this architecture on Linux, Mach-O (thin or fat) on macOS; anything else refused', () => {
  const elf = (cls, data, machine) => { const b = Buffer.alloc(64); b.writeUInt32BE(0x7f454c46, 0); b[4] = cls; b[5] = data; b.writeUInt16LE(machine, 18); return b; };
  assert.strictEqual(formatProblem(elf(2, 1, 0x3e), 'linux', 'x64'), null);
  assert.strictEqual(formatProblem(elf(2, 1, 0xb7), 'linux', 'arm64'), null);
  assert.match(formatProblem(elf(2, 1, 0xb7), 'linux', 'x64'), /not an ELF program for x64/);
  assert.match(formatProblem(elf(1, 1, 0x3e), 'linux', 'x64'), /for x64/, '32-bit');
  assert.match(formatProblem(elf(2, 2, 0x3e), 'linux', 'x64'), /for x64/, 'big-endian');
  assert.match(formatProblem(elf(2, 1, 0x3e), 'linux', 'ia32'), /for ia32/, 'no shim for that architecture');
  assert.match(formatProblem(Buffer.from('#!/bin/sh\n'), 'linux', 'x64'), /not an ELF program/);
  assert.match(formatProblem(Buffer.alloc(0), 'linux', 'x64'), /not an ELF program/);
  const thin = (cpu) => { const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeInt32LE(cpu, 4); return b; };
  assert.strictEqual(formatProblem(thin(0x01000007), 'darwin', 'x64'), null);
  assert.strictEqual(formatProblem(thin(0x0100000c), 'darwin', 'arm64'), null);
  assert.match(formatProblem(thin(0x0100000c), 'darwin', 'x64'), /not a Mach-O program for x64/);
  const fat = (magic, cpus) => {
    const size = magic === 0xcafebabe ? 20 : 32;
    const b = Buffer.alloc(8 + cpus.length * size);
    b.writeUInt32BE(magic, 0); b.writeUInt32BE(cpus.length, 4);
    cpus.forEach((c, i) => b.writeInt32BE(c, 8 + i * size));
    return b;
  };
  assert.strictEqual(formatProblem(fat(0xcafebabe, [0x01000007, 0x0100000c]), 'darwin', 'arm64'), null, 'universal');
  assert.strictEqual(formatProblem(fat(0xcafebabf, [0x0100000c]), 'darwin', 'arm64'), null, 'fat 64');
  assert.match(formatProblem(fat(0xcafebabe, [0x01000007]), 'darwin', 'arm64'), /for arm64/);
  // (a Java class file shares the fat magic: its "count" is out of range)
  const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x41]);
  assert.match(formatProblem(javaClass, 'darwin', 'arm64'), /not a Mach-O program/);
  assert.match(formatProblem(elf(2, 1, 0x3e), 'darwin', 'x64'), /not a Mach-O program/);
  assert.match(formatProblem(elf(2, 1, 0x3e), 'freebsd', 'x64'), /no shim runs on freebsd/);
  // Windows spawns (a refusal there is an error to catch)
  assert.strictEqual(formatProblem(Buffer.from('MZ'), 'win32', 'x64'), null);
});

const runIt = (cmd, args, env) => new Promise((resolve) => {
  const child = spawn(cmd, args, {env, stdio: ['pipe', 'pipe', 'pipe']});
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.end();
  const t = setTimeout(() => child.kill('SIGKILL'), 60000);
  child.on('close', (code) => { clearTimeout(t); resolve({pid: child.pid, code, out, err}); });
});
const envWith = (extra) => {
  const e = {...process.env, ...extra};
  delete e.NODE_OPTIONS;
  return e;
};

test('POSIX: the shim replaces the launcher\'s process (no Node left beside it), with --home, and its stdio as the client gave it', {skip: NO_PROBE}, async() => {
  const h = home();
  const r = await runIt(process.execPath, [path.join(ROOT, 'bin', 'ch-local.js'), 'session', '--home', h], envWith({}));
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^SHIM pid=${r.pid} args=--home ${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), 'the same pid: the process was replaced');
  assert.deepStrictEqual([...r.out.matchAll(/^fd(\d) nonblock=(\d)$/gm)].map((m) => `${m[1]}:${m[2]}`), ['0:0', '1:0', '2:0'], `no stdio reaches the shim O_NONBLOCK: ${r.out}`);
});

test('the plugin\'s path (launch.js session, the home rule) and the entry clients add (session --home) make the same choice', {skip: NO_PROBE}, async() => {
  const launch = path.join(ROOT, 'clients', 'claude-code', 'bin', 'launch.js');
  const stub = (h) => {
    // the home's launcher, as an install leaves it: this checkout's
    fs.mkdirSync(path.join(h, 'bin'), {recursive: true, mode: 0o700});
    fs.writeFileSync(path.join(h, 'bin', 'ch-local.js'), `require(${JSON.stringify(path.join(ROOT, 'bin', 'ch-local.js'))}).run();\n`, {mode: 0o600});
  };
  for (const [label, h] of [['shim recorded and in place', home()], ['shim set aside', home({recorded: false})]]) {
    stub(h);
    const entry = JSON.parse(snippet('cursor', {node: process.execPath, launcher: path.join(h, 'bin', 'ch-local.js'), home: h}).text).mcpServers['countinghouse'];
    const added = await runIt(entry.command, entry.args, envWith({COUNTINGHOUSE_HOME: ''}));
    const plugin = await runIt(process.execPath, [launch, 'session'], envWith({COUNTINGHOUSE_HOME: h}));
    const said = (r) => `${r.code} ${/^SHIM /m.test(r.out) ? 'shim' : 'own'} ${r.err.trim()}`;
    assert.strictEqual(said(plugin), said(added), label);
    assert.match(said(added), label === 'shim set aside' ? /^1 own ch-local: no pack is installed/ : /^0 shim $/, label);
    if (label !== 'shim set aside') assert.match(plugin.out, new RegExp(`args=--home ${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  }
});

// The Reviewer on #123: the plugin's path ends as ONE process per session.
// launch.js execs the home's launcher (POSIX), which execs the shim, so no
// launch.js Node stays beside it; and nothing touched stdio before either
// exec, so the shim's pipes are as the client gave them.
test('POSIX: the plugin\'s path (launch.js session) ends as one process, the shim, with its stdio blocking', {skip: NO_PROBE}, async() => {
  const launch = path.join(ROOT, 'clients', 'claude-code', 'bin', 'launch.js');
  const h = home();
  fs.mkdirSync(path.join(h, 'bin'), {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(h, 'bin', 'ch-local.js'), `require(${JSON.stringify(path.join(ROOT, 'bin', 'ch-local.js'))}).run();\n`, {mode: 0o600});
  const r = await runIt(process.execPath, [launch, 'session'], envWith({COUNTINGHOUSE_HOME: h}));
  assert.strictEqual(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^SHIM pid=${r.pid} args=--home `, 'm'), `the same pid: launch.js became the session, which became the shim: ${r.out}`);
  assert.deepStrictEqual([...r.out.matchAll(/^fd(\d) nonblock=(\d)$/gm)].map((m) => `${m[1]}:${m[2]}`), ['0:0', '1:0', '2:0'], `no stdio reaches the shim O_NONBLOCK: ${r.out}`);
});

// Windows, and a Node with no execve: a child with this process's stdio,
// its exit code the session's; one that can't start at all hands back to
// the session's own runtime
test('runShim without execve: the child\'s exit code; a shim that cannot start is null, said on stderr', async() => {
  const calls = [];
  const fakeSpawn = (outcome) => (cmd, args, opts) => {
    calls.push({cmd, args, stdio: opts.stdio});
    const child = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {};
    setImmediate(() => {
      if (outcome === 'enoent') { child.emit('error', Object.assign(new Error('spawn ENOENT'), {code: 'ENOENT'})); return; }
      child.emit('spawn');
      child.exitCode = 7;
      child.emit('exit', 7, null);
    });
    return child;
  };
  const before = Object.fromEntries(['SIGTERM', 'SIGINT', 'SIGHUP'].map((sig) => [sig, process.listenerCount(sig)]));
  assert.strictEqual(await runShim('C:\\h\\shim\\ch-shim.exe', 'C:\\h', {platform: 'win32', spawn: fakeSpawn('exit'), execve: () => assert.fail('no execve on Windows')}), 7);
  assert.deepStrictEqual(calls[0], {cmd: 'C:\\h\\shim\\ch-shim.exe', args: ['--home', 'C:\\h'], stdio: 'inherit'});
  assert.strictEqual(await runShim('/h/shim/ch-shim', '/h', {platform: 'linux', spawn: fakeSpawn('exit'), execve: null}), 7, 'a Node with no execve spawns');
  assert.strictEqual(await runShim('C:\\h\\shim\\ch-shim.exe', 'C:\\h', {platform: 'win32', spawn: fakeSpawn('enoent')}), null);
  // (no signal forwarder outlives a shim that never started, nor one that ended)
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) assert.strictEqual(process.listenerCount(sig), before[sig], sig);
  // an execve that fails (ENOEXEC, EACCES): the session's own runtime
  assert.strictEqual(await runShim('/h/shim/ch-shim', '/h', {platform: 'linux', execve: () => { throw Object.assign(new Error('nope'), {code: 'EACCES'}); }, spawn: () => assert.fail('no spawn after a failed execve')}), null);
});

test('the session\'s own runtime takes the entry\'s home as the client\'s environment would name it, not as the shim\'s hand-over (no confinement of its own)', async() => {
  const session = require('../lib/session');
  const start = require('../lib/start');
  const real = start.start;
  let got = null;
  start.start = async(opts, io) => { got = {opts, home: io.env.COUNTINGHOUSE_HOME, stderr: io.stderr}; return 0; };
  try {
    const h = home({recorded: false, placed: false});
    const io = {env: {PATH: '/usr/bin'}, homedir: () => '/nowhere', platform: process.platform, get stderr() { return 'lazy'; }};
    assert.strictEqual(await session.session({home: h}, io), 0);
    assert.deepStrictEqual(got.opts, {passThrough: [], home: null, ownRuntime: null}, 'start\'s --home is the shim\'s hand-over alone');
    assert.strictEqual(got.home, h);
    assert.strictEqual(got.stderr, 'lazy', 'io\'s getters carried');
    assert.strictEqual(io.env.COUNTINGHOUSE_HOME, undefined, 'the caller\'s env untouched');
  } finally {
    start.start = real;
  }
});

test('session takes --home once: a second is refused, never the last one taken', async() => {
  const r = await runIt(process.execPath, [path.join(ROOT, 'bin', 'ch-local.js'), 'session', '--home', os.tmpdir(), '--home', os.tmpdir()], envWith({}));
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /usage: ch-local/);
});

// the reviewer, on #120's high round: a home made under a umask of 0002 is
// 0775, which the shared runtime's daemon refuses (lib/home.js
// homeOwnershipProblem). The reviewer's pre-work high (A-home-check, 2): such
// a home lets another user change what runs from it -- the runtime that is
// given every stored key -- so it is refused, exit 2, with the chmod that puts
// it right; never a runtime of the session's own from it.
test('a home another user could change (0775 under umask 0002): refused, exit 2, nothing started, the chmod said', {skip: NO_PROBE}, async() => {
  const saved = process.umask(0o002);
  let h;
  try {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-session-open-')));
    roots.push(parent);
    h = path.join(parent, 'home');
    fs.mkdirSync(h);
  } finally {
    process.umask(saved);
  }
  assert.strictEqual(fs.statSync(h).mode & 0o777, 0o775, 'made as an install under umask 0002 makes it');
  // a record naming the shim, and the shim in place, as a good home's
  const good = home();
  fs.copyFileSync(path.join(good, 'modules.json'), path.join(h, 'modules.json'));
  fs.mkdirSync(path.join(h, 'shim'), {mode: 0o700});
  fs.chmodSync(path.join(h, 'shim'), 0o700);
  fs.copyFileSync(path.join(good, 'shim', EXE), path.join(h, 'shim', EXE));
  fs.chmodSync(path.join(h, 'shim', EXE), 0o755);
  fs.copyFileSync(path.join(good, 'shim', 'versions.json'), path.join(h, 'shim', 'versions.json'));
  fs.chmodSync(path.join(h, 'shim', 'versions.json'), 0o600);
  assert.strictEqual(require('../lib/home').homeOwnershipProblem(h) != null, true, 'the daemon\'s check refuses it');
  const c = choose(h);
  assert.strictEqual(c.shim, null);
  assert.match(c.refuse, new RegExp(`${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: it is group- or world-writable \\(mode 0775\\), so another user could change what runs from it; it may already have been changed: move it aside \\(\`mv "${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" "${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.suspect"\`\\) and install again$`));
  // and the entry itself: refused, exit 2, nothing started (no shim, no
  // runtime of the session's own)
  const r = await runIt(process.execPath, [path.join(ROOT, 'bin', 'ch-local.js'), 'session', '--home', h], envWith({}));
  assert.strictEqual(r.code, 2, r.err);
  assert.ok(!/^SHIM /m.test(r.out), r.out);
  assert.match(r.err, /so another user could change what runs from it; it may already have been changed: move it aside \(`mv "[^"]+" "[^"]+\.suspect"`\) and install again; nothing was started/);
  assert.doesNotMatch(r.err, /no pack is installed/, 'no runtime ran');
});

// the reviewer's high on #120, round 2
test('a home another user owns starts nothing, on either path (exit 2): never the shim, never the own runtime', {skip: !POSIX}, async() => {
  const session = require('../lib/session');
  const start = require('../lib/start');
  const real = start.start;
  let started = false;
  start.start = async() => { started = true; return 0; };
  try {
    const h = home();
    const other = () => fs.statSync(h).uid + 1;
    const io = {env: {COUNTINGHOUSE_HOME: h}, homedir: () => '/nowhere', platform: process.platform, geteuid: other,
      execve: () => assert.fail('no exec'), shimSpawn: () => assert.fail('no spawn')};
    // (--home's path, and the plugin's, the home rule)
    assert.strictEqual(await session.session({home: h}, io), 2);
    assert.strictEqual(await session.session({home: null}, io), 2);
    assert.strictEqual(started, false, 'no runtime of its own either');
    assert.match(session.ownerProblem(h, process.platform, {geteuid: other}), /it is owned by uid \d+, not this user/);
    assert.strictEqual(session.ownerProblem(h), null, 'this user\'s own');
    // (Windows: by the owner's SID)
    const sid = (owner) => ({fileAcl: () => ({owner, user: 'S-1-5-21-9', otherAces: false, rules: []})});
    assert.strictEqual(session.ownerProblem(h, 'win32', {acl: sid('S-1-5-21-9')}), null);
    assert.strictEqual(session.ownerProblem(h, 'win32', {acl: sid('S-1-5-32-544')}), null, 'Administrators');
    assert.match(session.ownerProblem(h, 'win32', {acl: sid('S-1-5-21-7')}), /owned by S-1-5-21-7, not this user/);
  } finally {
    start.start = real;
  }
});

test('the shim in place must be the version the record names (versions.json, by sha512): a rollback between its record and its alignShim runs no other release\'s shim', {skip: NO_PROBE}, () => {
  // (the restored record names 0.4.0; the shim in place is still 0.5.0's)
  const h = home({version: '0.5.0'});
  const rec = JSON.parse(fs.readFileSync(path.join(h, 'modules.json'), 'utf8'));
  rec.shim.version = '0.4.0';
  fs.writeFileSync(path.join(h, 'modules.json'), JSON.stringify(rec));
  const c = choose(h);
  assert.strictEqual(c.shim, null);
  assert.match(c.note, /the shared runtime's shim in place is not the one the installed release records \(0\.4\.0\); this session runs its own runtime/);
  // no versions.json (or one that is not this user's own): none is known
  const bare = home();
  fs.rmSync(path.join(bare, 'shim', 'versions.json'));
  assert.strictEqual(choose(bare).shim, null);
  const loose = home();
  fs.chmodSync(path.join(loose, 'shim', 'versions.json'), 0o644);
  assert.strictEqual(choose(loose).shim, null);
});

test('a shim that can\'t be run from where it is (a noexec mount: EACCES at access X_OK) is never exec\'d: the own runtime, said', {skip: NO_PROBE}, () => {
  const h = home();
  const c = sessionChoice({where: layout({COUNTINGHOUSE_HOME: h}, os.homedir), access: () => { throw Object.assign(new Error('noexec'), {code: 'EACCES'}); }});
  assert.strictEqual(c.shim, null);
  assert.match(c.note, /the shared runtime's shim can't be run from .*shim \(EACCES; a folder mounted noexec\?\); this session runs its own runtime/);
  assert.strictEqual(choose(h).shim, path.join(h, 'shim', EXE), 'and with access, the shim');
});

// the reviewer on #126 (a): the folders above a home are checked too, by
// countinghouse #520's rule for its sqlite store, along the path as given and
// its real path: each this user's or root's, writable by no other unless
// sticky, nor by a group other than this user's own primary group (a
// user-private group, as a umask of 0002 leaves them). Otherwise another user
// could move the home away and put one of theirs in its place.
test('a home under a folder another user could write in is refused; a sticky one, or your own group\'s, is not', {skip: !POSIX && 'POSIX modes'}, async() => {
  const {homeOpenProblem} = require('../lib/home');
  const under = (mode) => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-above-')));
    roots.push(parent);
    const h = path.join(parent, 'home');
    fs.mkdirSync(h, {mode: 0o700});
    fs.chmodSync(h, 0o700);
    fs.chmodSync(parent, mode);
    return {parent, h};
  };
  const open = under(0o777);
  const p = homeOpenProblem(open.h);
  assert.ok(p != null, 'refused');
  assert.match(p.why, new RegExp(`it is under ${open.parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, and group or others can write in it \\(mode 777\\); another user could move the home away and put theirs in its place`));
  assert.strictEqual(p.fix, `run \`chmod go-w "${open.parent}"\``);
  assert.strictEqual(homeOpenProblem(under(0o1777).h), null, 'sticky, as /tmp');
  assert.strictEqual(homeOpenProblem(under(0o775).h), null, 'writable by this user\'s own primary group (umask 0002)');
  // (a folder whose path can't be quoted safely: no fix to paste, the medium on the round, 4)
  const odd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-above-$x-')));
  roots.push(odd);
  fs.mkdirSync(path.join(odd, 'home'), {mode: 0o700});
  fs.chmodSync(odd, 0o777);
  const q = homeOpenProblem(path.join(odd, 'home'));
  assert.ok(q != null && q.fix === null, JSON.stringify(q));
  fs.chmodSync(odd, 0o700);
  // and the session refuses it, exit 2, nothing started
  const r = await runIt(process.execPath, [path.join(ROOT, 'bin', 'ch-local.js'), 'session', '--home', open.h], envWith({}));
  assert.strictEqual(r.code, 2, r.err);
  assert.match(r.err, /group or others can write in it \(mode 777\); another user could move the home away/);
  assert.match(r.err, /nothing was started/);
});

// the reviewer's high on #126, L9: on Windows a session reads its home's ACL
// once, for both of its checks (each read is a PowerShell run)
test('Windows: session reads its home\'s ACL once for its owner and its DACL checks (ACLs given)', {skip: process.platform !== 'win32' && 'the home is judged by this machine\'s own platform'}, async() => {
  // (no shim: the C probe is built on POSIX only, and this is a home check)
  const h = home({placed: false});
  const ME = 'S-1-5-21-1-2-3-1001';
  const OPEN = {user: ME, owner: ME, otherAces: false, rules: [{sid: 'S-1-1-0', rights: 1245631, type: 'Allow', inheritOnly: false}]};
  let reads = 0;
  const said = [];
  const io = {env: {}, homedir: os.homedir, platform: 'win32', winAcl: {fileAcl: () => { reads++; return OPEN; }}, stderr: {write: (s) => said.push(s)}, stdout: {write: () => true}};
  const {session} = require('../lib/session');
  assert.strictEqual(await session({home: h}, io), 2);
  assert.strictEqual(reads, 1, said.join(''));
});
