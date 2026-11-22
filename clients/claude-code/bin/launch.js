#!/usr/bin/env node
'use strict';
// The plugin's entry: runs the installed launcher, <home>/bin/ch-local.js, with
// this process's arguments and stdio. On POSIX it becomes the launcher
// (process.execve), so a session is one process (the launcher then becomes
// the shim): no Node of this script stays beside it (the Reviewer on #123).
// Elsewhere, or on a Node with no execve, it runs the launcher as a child,
// passes a stop on to it, and ends the way it ended. It fetches and installs nothing. The plugin is copied on its own,
// so the home rule is repeated from lib/home.js (a test checks they agree).
// Plain require names, so a Node too old for 'node:' still gets the one-line
// message below.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const FLOOR = [22, 16];

function nodeOk(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > FLOOR[0] || (major === FLOOR[0] && minor >= FLOOR[1]);
}

function isFullPath(p, platform = process.platform) {
  if (platform === 'win32') return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p);
  return path.posix.isAbsolute(p);
}

function whereIs(env) {
  const set = env.COUNTINGHOUSE_HOME;
  if (typeof set !== 'string' || set === '') return path.join(os.homedir(), '.countinghouse', 'bin', 'ch-local.js');
  if (!isFullPath(set)) return null;
  return path.join(path.normalize(set), 'bin', 'ch-local.js');
}

// POSIX, a Node with execve, and its own executable runnable -> true
function canExec(platform, execve, execPath) {
  if (platform === 'win32' || typeof execve !== 'function') return false;
  try { fs.accessSync(execPath, fs.constants.X_OK); return true; } catch { return false; }
}

const fail = (line, code = 1) => { process.stderr.write(`ch-packs: ${line}\n`); process.exit(code); };

// A home, its bin/ or the launcher itself that another user could change ->
// the line that says so, with the fix; null when all three are this user's
// alone (the reviewer's pre-work high, A-home-check, 1). Checked here, before
// anything of the home runs: the home's own code can't vouch for itself.
// POSIX: each this user's, and not group- or world-writable. Windows: each
// with a private DACL, by the plugin's own copy of lib/win-acl.js (a test
// checks the two agree). fileAcl: a test's.
const OPEN = 'so another user could change what runs from it';
// a path for a command to copy: quoted when plain, else the placeholder (no
// control, bidi or shell characters reach the terminal or the paste). The
// rule is lib/command-line.js UNSAFE_ANY's, copied (a test checks the two
// agree: the reviewer's high on #126, L8); built when used, so a Node too old
// for its \p{} still gets the one-line message below.
const UNSAFE_SOURCE = "[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\"`$\\\\%!^\\u2018-\\u201f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2069\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb\\u{e0000}-\\u{e007f}]|[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]";
const plain = (p, platform = process.platform) => !new RegExp(UNSAFE_SOURCE, 'u').test(platform === 'win32' ? p.replace(/\\/g, '/') : p);
const shown = (p, platform = process.platform) => (plain(p, platform) ? `"${p}"` : '"<its folder>"');
// The folders above a home (POSIX, as lib/home.js aboveProblem says it; the reviewer on #126 (a)), by countinghouse
// #520's rule for its sqlite store's: along the path as given and its real
// path, each this user's or root's, writable by no other unless sticky (as
// /tmp: no one else can rename what this user owns there), nor by a group
// other than this user's own primary group (a user-private group, as a umask
// of 0002 leaves a home's folders). Otherwise another user could move the
// home away and put one of theirs in its place. Windows: the ancestors' DACLs
// are not checked. -> {why, fix} | null
function aboveProblemWith(home, QUOTE) {
  const given = path.resolve(home);
  // (a home not made yet: the path as given, its folders that are there)
  let real = null;
  try { real = fs.realpathSync.native(given); } catch (e) { if (e.code !== 'ENOENT') return {why: `it could not be read (${e.code || e.message})`, fix: null}; }
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  const gid = typeof process.getegid === 'function' ? process.getegid() : null;
  for (const start of real != null ? [given, real] : [given]) {
    for (let at = path.dirname(start); ; at = path.dirname(at)) {
      let st;
      try { st = fs.statSync(at); } catch (e) {
        if (real == null && e.code === 'ENOENT' && path.dirname(at) !== at) continue;
        return {why: `it is under ${at}, which could not be checked (${e.code || e.message})`, fix: null};
      }
      if (uid != null && st.uid !== uid && st.uid !== 0) return {why: `it is under ${at}, which is not yours (nor root's); another user could move the home away and put theirs in its place`, fix: null};
      const sticky = (st.mode & 0o1000) !== 0;
      const others = (st.mode & 0o002) !== 0 && !sticky;
      const group = (st.mode & 0o020) !== 0 && !sticky && st.gid !== gid;
      if (others || group) {
        const mine = uid != null && st.uid === uid;
        const q = QUOTE(at);
        return {why: `it is under ${at}, and group or others can write in it (mode ${(st.mode & 0o7777).toString(8)}); another user could move the home away and put theirs in its place`, fix: mine && q !== '"<its folder>"' ? `run \`chmod go-w ${q}\`` : null};
      }
      if (path.dirname(at) === at) break;
    }
  }
  return null;
}
function aboveProblem(home) {
  return aboveProblemWith(home, shown);
}

// home, launcher: as found by the home rule -> {problem} (the line, with the
// fix) | {launcher} (the launcher's real path, the one checked and the one to
// run: the medium on A-home-check, 3). fileAcls: a test's.
function homeProblem(home, launcher, {platform = process.platform, fileAcls = null} = {}) {
  const items = [[home, true], [path.dirname(launcher), true], [launcher, false]];
  const reals = [];
  // (a launcher that is a link: its real folder is not the one checked, and
  // a write through it lands elsewhere: refused, L3)
  try {
    if (fs.lstatSync(launcher).isSymbolicLink()) return {problem: `${launcher} is a link, ${OPEN}; install again to put a file there`};
  } catch (err) { return {problem: `${launcher} could not be read (${err.code || err.message})`}; }
  for (let i = 0; i < items.length; i++) {
    const [p, directory] = items[i];
    let real;
    try { real = fs.realpathSync.native(p); } catch (err) { return {problem: `${p} could not be read (${err.code || err.message})`}; }
    let st;
    try { st = fs.statSync(real); } catch (err) { return {problem: `${real} could not be read (${err.code || err.message})`}; }
    // (a wrong type is a broken install, not another user's: L8)
    if (directory ? !st.isDirectory() : !st.isFile()) return {problem: `${real} is not a ${directory ? 'folder' : 'file'}; install again`};
    reals.push(real);
    if (platform === 'win32') continue;
    const euid = typeof process.geteuid === 'function' ? process.geteuid() : null;
    if (euid != null && st.uid !== euid) return {problem: `${real} is owned by uid ${st.uid}, not you, ${OPEN}; use a home only you own`};
    // (writable by others: it may already have been changed, so never
    // trusted after a chmod: moved aside and installed again, F2)
    if ((st.mode & 0o022) !== 0) {
      const homeReal = reals[0];
      const move = shown(homeReal) !== '"<its folder>"' && shown(`${homeReal}.suspect`) !== '"<its folder>"' ? ` (\`mv ${shown(homeReal)} ${shown(`${homeReal}.suspect`)}\`)` : '';
      return {problem: `${real} is group- or world-writable (mode ${(st.mode & 0o777).toString(8).padStart(4, '0')}), ${OPEN}; the home may already have been changed: move it aside${move} and install again`};
    }
    // (the home itself private, as install makes it: its app and module
    // store run with the keys, M2)
    if (i === 0 && (st.mode & 0o077) !== 0) return {problem: `${real} is open to group or others (mode ${(st.mode & 0o777).toString(8).padStart(4, '0')}), and its folders may be too, ${OPEN}; run \`chmod 700 ${shown(real)}\``};
  }
  if (platform !== 'win32') {
    const above = aboveProblem(home);
    if (above != null) return {problem: `${home}: ${above.why}, ${OPEN}${above.fix != null ? `; ${above.fix}` : ''}`};
  }
  if (platform === 'win32') {
    // (the three in one PowerShell run, which costs 1 to 10 s: the medium, 2)
    const winAcl = require('./win-acl');
    let acls;
    try { acls = (fileAcls || winAcl.fileAcls)(reals); } catch (err) { return {problem: `the access lists of ${reals[0]} could not be read (${err.code || err.message}), ${OPEN}`}; }
    for (let i = 0; i < items.length; i++) {
      const directory = items[i][1];
      const why = winAcl.privateProblem(reals[i], acls[i], {directory});
      if (why == null) continue;
      // (owned by another: never /setowner, which would take what is theirs:
      // remove it and install again, L8)
      const a = acls[i];
      if (a != null && typeof a.owner === 'string' && ![a.user, winAcl.SYSTEM, winAcl.ADMINISTRATORS].includes(a.owner)) return {problem: `${why}, ${OPEN}; remove it and install again`};
      const hint = plain(reals[i], 'win32') ? winAcl.fixHint(reals[i], acls[i], {directory}) : null;
      return {problem: `${why}, ${OPEN}; make it a ${directory ? 'folder' : 'file'} only you can change${hint != null ? `: ${hint.split('\n').map((l) => l.trim()).join(', then ')}` : ''}`};
    }
  }
  return {launcher: reals[2]};
}

function main() {
  if (!nodeOk(process.version)) fail(`needs Node 22.16 or later; this is ${process.version} (the \`node\` on the PATH Claude Code sees)`);
  const launcher = whereIs(process.env);
  if (launcher == null) fail(`COUNTINGHOUSE_HOME must be an absolute path, not "${process.env.COUNTINGHOUSE_HOME}"`);
  // (COUNTINGHOUSE_HOME set: the home in words, on every platform, or the
  // install goes to the default home -- the closing pass on release 1, L3)
  // (normalized; not said for the default home; one a terminal would
  // misshow -- a control, bidi or invisible character -- said as the folder
  // it names, never printed: the medium on the closing pass, 4)
  const set = process.env.COUNTINGHOUSE_HOME != null && process.env.COUNTINGHOUSE_HOME !== '' ? path.normalize(process.env.COUNTINGHOUSE_HOME) : null;
  const isDefault = set != null && path.resolve(set) === path.resolve(path.join(os.homedir(), '.countinghouse'));
  const shown = set == null || isDefault ? null : /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/.test(set) ? 'the folder it names now' : set;
  const named = shown != null ? ` (with COUNTINGHOUSE_HOME set to ${shown})` : '';
  if (!fs.existsSync(launcher)) fail(`the launcher is not installed at ${launcher}; install it with: npx @countinghouse/ch-local install --pack ci-failure-triage${named}`);
  // (nothing runs from a home another user could change: exit 2)
  const checked = homeProblem(path.dirname(path.dirname(launcher)), launcher);
  if (checked.problem != null) fail(`${checked.problem}; nothing was started`, 2);
  // (the path checked is the one run)
  const run = checked.launcher;
  // (a failed execve ends Node 22 and 24 outright, so only a call that can't
  // fail is made: POSIX, this Node's own executable, runnable from where it
  // is. And nothing touches stdin, stdout or stderr before it, so the pipes
  // reach the launcher, and the shim after it, as the client gave them.)
  if (canExec(process.platform, process.execve, process.execPath)) {
    process.execve(process.execPath, [process.execPath, run, ...process.argv.slice(2)], process.env);
  }
  const child = spawn(process.execPath, [run, ...process.argv.slice(2)], {stdio: 'inherit'});
  child.on('error', (err) => fail(`could not start ${launcher} (${err.code || err.message})`));
  const forward = (signal) => {
    if (child.exitCode != null || child.signalCode != null) return;
    // Windows cannot send every signal (SIGHUP throws ENOSYS): stop it plainly.
    try { child.kill(signal); } catch { child.kill(); }
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, forward);
  child.on('exit', (code, signal) => {
    if (signal != null) {
      // End the way the launcher ended, so a clean stop does not read as a failure.
      process.removeAllListeners(signal);
      try { process.kill(process.pid, signal); } catch { /* fall through */ }
    }
    process.exit(code != null ? code : 1);
  });
}

if (require.main === module) main();

module.exports = {whereIs, nodeOk, isFullPath, canExec, homeProblem, aboveProblem, UNSAFE_SOURCE};
