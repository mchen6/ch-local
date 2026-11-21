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
// control, bidi or shell characters reach the terminal or the paste)
const shown = (p) => (/^[A-Za-z0-9_\/.~@%+=,: \\-]+$/.test(p) ? `"${p}"` : '"<its folder>"');
// home, launcher: as found by the home rule -> {problem} (the line, with the
// fix) | {launcher} (the launcher's real path, the one checked and the one to
// run: the medium on A-home-check, 3). fileAcls: a test's.
function homeProblem(home, launcher, {platform = process.platform, fileAcls = null} = {}) {
  const items = [[home, true], [path.dirname(launcher), true], [launcher, false]];
  const reals = [];
  for (const [p, directory] of items) {
    let real;
    try { real = fs.realpathSync.native(p); } catch (err) { return {problem: `${p} could not be read (${err.code || err.message})`}; }
    let st;
    try { st = fs.statSync(real); } catch (err) { return {problem: `${real} could not be read (${err.code || err.message})`}; }
    if (directory ? !st.isDirectory() : !st.isFile()) return {problem: `${real} is not a ${directory ? 'folder' : 'file'}, ${OPEN}`};
    reals.push(real);
    if (platform === 'win32') continue;
    const euid = typeof process.geteuid === 'function' ? process.geteuid() : null;
    if (euid != null && st.uid !== euid) return {problem: `${real} is owned by uid ${st.uid}, not you, ${OPEN}; use a home only you own`};
    if ((st.mode & 0o022) !== 0) return {problem: `${real} is group- or world-writable (mode ${(st.mode & 0o777).toString(8).padStart(4, '0')}), ${OPEN}; run \`chmod ${directory ? '700' : '600'} ${shown(real)}\``};
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
      const hint = /^[A-Za-z0-9_\/.~@%+=,: \\-]+$/.test(reals[i]) ? winAcl.fixHint(reals[i], acls[i]) : null;
      return {problem: `${why}, ${OPEN}; make it a ${directory ? 'folder' : 'file'} only you can change${hint != null ? `: ${hint.split('\n').map((l) => l.trim()).join(', then ')}` : ''}`};
    }
  }
  return {launcher: reals[2]};
}

function main() {
  if (!nodeOk(process.version)) fail(`needs Node 22.16 or later; this is ${process.version} (the \`node\` on the PATH Claude Code sees)`);
  const launcher = whereIs(process.env);
  if (launcher == null) fail(`COUNTINGHOUSE_HOME must be an absolute path, not "${process.env.COUNTINGHOUSE_HOME}"`);
  if (!fs.existsSync(launcher)) fail(`the launcher is not installed at ${launcher}; install it with: npx @countinghouse/ch-local install --pack ci-failure-triage`);
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

module.exports = {whereIs, nodeOk, isFullPath, canExec, homeProblem};
