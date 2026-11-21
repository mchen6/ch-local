'use strict';
// `ch-local session [--home <abs>]`: what every client entry runs (clients
// add, the snippets, and the Claude Code plugin's launch.js), so the choice
// between the shared runtime and this session's own is made in one place,
// in the home's own code, at every session start (the reviewer's high on
// #120, 1 (a)):
//
// - the shared runtime, through the native shim at <home>/shim/ch-shim,
//   when the home's record names the shim install placed (install records it
//   only once it is in place: lib/install.js shimStep) AND that file passes
//   lib/shim-binary.js's checks now (<home> this user's; <home>/shim this
//   user's, 0700, not a link; ch-shim a regular file of this user's, not a
//   link, no group or other write, no setuid or setgid, executable by its
//   owner). The record is read, not the binary's hash: install and rollback
//   keep the two together under packs.lock.
// - else this session's own runtime (start --stdio), with a line on stderr
//   when a recorded shim fails a check.
//
// So a set-aside shim (one still in use, SHIM_BUSY; a rollback to a release
// with none) never leaves an entry naming a file that is not there: the
// entry is this launcher, which is always there.
//
// POSIX: the shim replaces this process (process.execve, in Node since
// 22.15 and 23.11; experimental), so a session costs no Node of its own
// beside it. An execve that fails ends this process on Node 22 and 24 (it
// aborts, exit 134: nothing to catch) and throws on 26, where the session
// falls back to its own runtime. The checks above run just before it, and
// the file's first bytes must be a program for this platform and
// architecture (formatProblem), so what is left is a file swapped since, by
// this user, or the kernel refusing for a reason of its own.
// Windows has no execve: the shim runs as a child with this process's stdio,
// and this Node waits for it (one more Node per session there: a 1.1 row).
//
// Nothing here touches process.stdin, stdout or stderr before the shim runs:
// Node opening a stdio pipe makes it O_NONBLOCK, and the shim would inherit
// that across the exec. A line goes out by fs.writeSync(2) instead.
const fs = require('node:fs');
const path = require('node:path');

const exeOf = (platform) => (platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');

// Whether a file's first bytes are a program this machine runs: ELF (64-bit,
// little-endian) on Linux, Mach-O (64-bit, or a fat file holding one) on
// macOS, each for this architecture -- so a binary the kernel would refuse
// (ENOEXEC, which aborts Node 22 and 24's execve) is never exec'd, and the
// session runs its own runtime instead (the reviewer's high on #120, 1 (a)).
// Windows spawns, where a refusal is an error to catch: not checked here.
// (head: Buffer, platform, arch) -> null | why not
const ELF_MACHINE = {x64: 0x3e, arm64: 0xb7};
const MACHO_CPU = {x64: 0x01000007, arm64: 0x0100000c};
function formatProblem(head, platform, arch) {
  if (platform === 'win32') return null;
  if (platform === 'linux') {
    if (head.length < 20 || head.readUInt32BE(0) !== 0x7f454c46) return 'not an ELF program';
    const want = Object.prototype.hasOwnProperty.call(ELF_MACHINE, arch) ? ELF_MACHINE[arch] : null;
    return head[4] === 2 && head[5] === 1 && want != null && head.readUInt16LE(18) === want ? null : `not an ELF program for ${arch}`;
  }
  if (platform === 'darwin') {
    const want = Object.prototype.hasOwnProperty.call(MACHO_CPU, arch) ? MACHO_CPU[arch] : null;
    if (head.length < 8) return 'not a Mach-O program';
    if (head.readUInt32LE(0) === 0xfeedfacf) return want != null && head.readInt32LE(4) === want ? null : `not a Mach-O program for ${arch}`;
    const fat = head.readUInt32BE(0);
    if (fat !== 0xcafebabe && fat !== 0xcafebabf) return 'not a Mach-O program';
    const n = head.readUInt32BE(4);
    const size = fat === 0xcafebabe ? 20 : 32;
    if (n < 1 || n > 30 || 8 + n * size > head.length) return 'not a Mach-O program';
    for (let i = 0; i < n; i++) if (want != null && head.readInt32BE(8 + i * size) === want) return null;
    return `not a Mach-O program for ${arch}`;
  }
  return `no shim runs on ${platform}`;
}

// a file's first bytes, read as lib/shim-install.js reads a shim: never
// through a link, never blocking on a FIFO, a regular file only -> Buffer | null
function headOf(file, max = 4096) {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)); } catch (e) { return null; }
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(max);
    let got = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, got, max - got, null);
      if (n <= 0) break;
      got += n;
      if (got >= max) break;
    }
    return buf.subarray(0, got);
  } catch (e) {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// The one decision. ({where, platform, arch, geteuid, acl}) -> {shim:
// absolute path} | {shim: null, note: line | null}. A record that can't be
// read is the per-session runtime's to report (start reads it too).
function sessionChoice({where, platform = process.platform, arch = process.arch, geteuid, acl} = {}) {
  let record = null;
  try { record = require('./module-record').readModulesRecord(where); } catch (err) { return {shim: null, note: null}; }
  if (record == null || record.shim == null) return {shim: null, note: null};
  const here = require('./shim-binary').installedShim(where.home, {platform, geteuid, acl});
  const install = () => require('./command-line').chLocal(where, 'install', platform);
  if (here != null && here.file != null && here.file === path.join(where.home, 'shim', exeOf(platform))) {
    const head = headOf(here.file);
    const bad = head == null ? 'it could not be read' : formatProblem(head, platform, arch);
    if (bad == null) return {shim: here.file, note: null};
    return {shim: null, note: `ch-local: the shared runtime's shim is not a program this machine runs (${platform}-${arch}); this session runs its own runtime. Run \`${install()}\` to put it right.\n`};
  }
  const why = here == null ? `${path.join(where.home, 'shim', exeOf(platform))} is not there` : here.problem;
  return {shim: null, note: `ch-local: the shared runtime's shim is not used: ${why}; this session runs its own runtime. Run \`${install()}\` to put it right.\n`};
}

// Runs the shim in place of this process (POSIX) or as a child with this
// process's stdio (Windows, or a Node with no execve). -> exit code (the
// child's), or null when it could not be started at all (then the caller
// runs the per-session runtime).
async function runShim(shim, home, {platform = process.platform, env = process.env, execve = process.execve, spawn = require('node:child_process').spawn} = {}) {
  const args = ['--home', home];
  if (platform !== 'win32' && typeof execve === 'function') {
    try {
      execve.call(process, shim, [shim, ...args], env);
    } catch (err) {
      // (Node 26 on: a failed execve throws; 22 and 24 abort, see the header)
      say(`ch-local: the shared runtime's shim could not be started (${err.code || err.message}); this session runs its own runtime\n`);
      return null;
    }
  }
  return await new Promise((resolve) => {
    let started = false;
    const child = spawn(shim, args, {stdio: 'inherit', env, windowsHide: true});
    child.on('spawn', () => { started = true; });
    child.on('error', (err) => {
      if (started) return;
      say(`ch-local: the shared runtime's shim could not be started (${err.code || err.message}); this session runs its own runtime\n`);
      resolve(null);
    });
    const forward = (signal) => {
      if (child.exitCode != null || child.signalCode != null) return;
      try { child.kill(signal); } catch (e) { child.kill(); }
    };
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, forward);
    child.on('exit', (code) => {
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.removeListener(signal, forward);
      resolve(code != null ? code : 1);
    });
  });
}

// a line on stderr without opening it as a Node stream (see the header)
function say(line) {
  try { fs.writeSync(2, line); } catch (e) { /* no stderr: nothing to say it on */ }
}

// ({home}, io) -> exit code. home: --home's (checked by the caller), else
// the home rule.
async function session({home = null}, io) {
  const {layout} = require('./home');
  const where = home != null ? layout({...io.env, COUNTINGHOUSE_HOME: home}, io.homedir) : layout(io.env, io.homedir);
  const choice = sessionChoice({where, platform: io.platform});
  if (choice.note != null) say(choice.note);
  if (choice.shim != null) {
    // (io.execve, io.shimSpawn: a test's; else Node's own)
    const code = await runShim(choice.shim, where.home, {platform: io.platform, env: io.env, execve: io.execve, spawn: io.shimSpawn});
    if (code != null) return code;
  }
  return await require('./start').start({passThrough: [], home, ownRuntime: null}, io);
}

module.exports = {session, sessionChoice, runShim, formatProblem};
