'use strict';
// `ch-local session [--home <abs>]`: what every client entry runs (clients
// add and the snippets; the Claude Code plugin's launch.js once its
// .mcp.json says `session`, A's follow-up to #120), so the choice
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
//   owner), AND its content is the version the record names (versions.json,
//   by sha512: a rollback between its record and its alignShim, or one whose
//   alignShim threw, runs no other release's shim), AND it is a program for
//   this machine that can be run from where it is (not a noexec mount).
// - a home another user owns starts nothing (exit 2): its record and its
//   shim are theirs to change.
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

// The one decision. ({where, platform, arch, geteuid, acl}) -> {shim:
// absolute path} | {shim: null, note: line | null}. A record that can't be
// read is the per-session runtime's to report (start reads it too).
function sessionChoice({where, platform = process.platform, arch = process.arch, geteuid, acl, access = fs.accessSync} = {}) {
  // a home another user could change runs nothing, the session's own runtime
  // included: what runs from it is given every stored key (the reviewer's
  // pre-work high, A-home-check, 2; it was a fallback to start). First, and
  // whatever the record says. -> refuse: its line
  const {homeOpenProblem, HOME_OPEN} = require('./home');
  // (this machine's own platform, as start judges it: the medium on #126's round, 8)
  const open = homeOpenProblem(where.home, {fileAcl: process.platform === 'win32' && acl != null ? acl.fileAcl : null});
  if (open != null) return {shim: null, note: null, refuse: `${where.home}: ${open.why}, ${HOME_OPEN}${open.fix != null ? `; ${open.fix}${open.final ? '' : ', then start again'}` : ''}`};
  let record = null;
  try { record = require('./module-record').readModulesRecord(where); } catch (err) { return {shim: null, note: null}; }
  if (record == null || record.shim == null) return {shim: null, note: null};
  const here = require('./shim-binary').installedShim(where.home, {platform, geteuid, acl});
  const installLine = () => require('./command-line').chLocal(where, 'install', platform);
  if (here != null && here.file != null) {
    // (read whole, as the shim's files are: lib/plain-read.js)
    const {readPlain, readVersions} = require('./plain-read');
    const bin = readPlain(here.file);
    // the version the record names, by its content (versions.json, as
    // install and rollback write it): a rollback that wrote the restored
    // record but has not aligned the shim yet, or whose alignShim threw,
    // never has a session run the release rolled back from (the reviewer's
    // high on #120, round 2, 2)
    const versions = bin.bytes != null ? readVersions(path.join(where.home, 'shim', 'versions.json'), platform) : {};
    const at = bin.bytes != null ? versions[require('node:crypto').createHash('sha512').update(bin.bytes).digest('hex')] : undefined;
    if (at !== record.shim.version) {
      return {shim: null, note: `ch-local: the shared runtime's shim in place is not the one the installed release records (${record.shim.version}); this session runs its own runtime. Run \`${installLine()}\` to put it right.\n`};
    }
    if (formatProblem(bin.bytes.subarray(0, 4096), platform, arch) != null) {
      return {shim: null, note: `ch-local: the shared runtime's shim is not a program this machine runs (${platform}-${arch}); this session runs its own runtime. Run \`${installLine()}\` to put it right.\n`};
    }
    // (runnable here: a noexec mount passes every check above, and its
    // execve would abort Node 22 and 24 -- round 2, 3; a security module's
    // refusal at exec stays a limit, the header's)
    if (platform !== 'win32') {
      try { access(here.file, fs.constants.X_OK); } catch (err) {
        return {shim: null, note: `ch-local: the shared runtime's shim can't be run from ${path.dirname(here.file)} (${err.code || 'refused'}; a folder mounted noexec?); this session runs its own runtime.\n`};
      }
    }
    return {shim: here.file, note: null};
  }
  const why = here == null ? `${path.join(where.home, 'shim', require('./shim-binary').exeOf(platform))} is not there` : here.problem;
  return {shim: null, note: `ch-local: the shared runtime's shim is not used: ${why}; this session runs its own runtime. Run \`${installLine()}\` to put it right.\n`};
}

// Whether a home is another user's: POSIX by its owner's uid, Windows by
// its owner's SID (this user, Administrators or SYSTEM are this user's
// own, as lib/win-acl.js privateProblem has them). A home not there yet is
// none of this: start says what to do. -> null | why
function ownerProblem(home, platform = process.platform, {geteuid = process.geteuid, acl} = {}) {
  let real;
  // (only a home not there yet is no home: the reviewer's high on #126, L4)
  try { real = fs.realpathSync(home); } catch (err) { return err.code === 'ENOENT' ? null : `it could not be read (${err.code || err.message})`; }
  if (platform === 'win32') {
    const winAcl = require('./win-acl');
    let a;
    try { a = ((acl != null && acl.fileAcl) || winAcl.fileAcl)(real); } catch (err) { return `its owner could not be read (${err.code || err.message})`; }
    if (a == null || typeof a.owner !== 'string' || typeof a.user !== 'string') return 'its owner could not be read';
    return [a.user, winAcl.SYSTEM, winAcl.ADMINISTRATORS].includes(a.owner) ? null : `it is owned by ${a.owner}, not this user`;
  }
  let st;
  try { st = fs.statSync(real); } catch (err) { return `it could not be read (${err.code || err.message})`; }
  const me = typeof geteuid === 'function' ? geteuid() : null;
  return me != null && st.uid !== me ? `it is owned by uid ${st.uid}, not this user` : null;
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
    const forward = (signal) => {
      if (child.exitCode != null || child.signalCode != null) return;
      try { child.kill(signal); } catch (e) { child.kill(); }
    };
    const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    const done = (code) => {
      // (no forwarder outlives the child: the session's own runtime, after
      // a shim that never started, traps its own -- the medium on #120)
      for (const signal of SIGNALS) process.removeListener(signal, forward);
      resolve(code);
    };
    child.on('error', (err) => {
      if (started) return;
      say(`ch-local: the shared runtime's shim could not be started (${err.code || err.message}); this session runs its own runtime\n`);
      done(null);
    });
    for (const signal of SIGNALS) process.on(signal, forward);
    child.on('exit', (code) => done(code != null ? code : 1));
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
  // a home another user owns runs nothing, either way: its record, its
  // shim and its app are theirs to change (the reviewer's high on #120,
  // round 2, 1; only how open a home of this user's is falls back, below)
  // (Windows: the home's ACL read once for both checks below, each read a
  // PowerShell run: the reviewer's high on #126, L9)
  let acl = io.winAcl;
  if ((io.platform || process.platform) === 'win32') {
    const base = (io.winAcl != null && io.winAcl.fileAcl) || require('./win-acl').fileAcl;
    const read = new Map();
    // (keyed by the kernel's real path: JS realpathSync keeps an 8.3 short
    // name such as RUNNER~1 that the native one expands, and the two checks
    // resolve the home each their own way: #126's Windows leg)
    const key = (p) => { try { return fs.realpathSync.native(String(p)).toLowerCase(); } catch (err) { return path.resolve(String(p)).toLowerCase(); } };
    acl = Object.assign({}, io.winAcl, {fileAcl: (p) => { if (!read.has(key(p))) read.set(key(p), base(p)); return read.get(key(p)); }});
  }
  const theirs = ownerProblem(where.home, io.platform, {geteuid: io.geteuid, acl});
  if (theirs != null) {
    say(`ch-local session: ${where.home}: ${theirs}; nothing was started\n`);
    return 2;
  }
  const choice = sessionChoice({where, platform: io.platform, acl});
  if (choice.refuse != null) {
    say(`ch-local session: ${choice.refuse}; nothing was started\n`);
    return 2;
  }
  if (choice.note != null) say(choice.note);
  if (choice.shim != null) {
    // (io.execve, io.shimSpawn: a test's; else Node's own)
    const code = await runShim(choice.shim, where.home, {platform: io.platform, env: io.env, execve: io.execve, spawn: io.shimSpawn});
    if (code != null) return code;
  }
  // (the home as the client's environment would name it, not start's
  // --home, which is the shim's own-runtime hand-over and confines every
  // path to the home: the medium on #120. io's other fields stay as they
  // are, read only when used)
  // (an own-property copy, its getters kept as getters: lib/auto-apply.js
  // copies io with Object.assign, which a prototype's fields would miss)
  const own = home != null ? Object.defineProperties({}, {...Object.getOwnPropertyDescriptors(io), env: {value: {...io.env, COUNTINGHOUSE_HOME: home}, enumerable: true, writable: true, configurable: true}}) : io;
  return await require('./start').start({passThrough: [], home: null, ownRuntime: null}, own);
}

module.exports = {session, sessionChoice, runShim, formatProblem, ownerProblem};
