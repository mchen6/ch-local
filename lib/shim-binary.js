'use strict';
// This platform's native shim, for the client's config entry (countinghouse's
// shared-runtime design, #236, section 10): @countinghouse/ch-shim's
// locate(). Until that package is published (release gating: no npm
// publish before Matt's), a source checkout finds it beside this file
// (npm-shim/ch-shim). No binary for the platform runs the per-session mode,
// and says so; a missing one is said as a reinstall, never fallen back on
// silently.
function defaultLocate() {
  for (const id of ['@countinghouse/ch-shim', '../npm-shim/ch-shim']) {
    let mod = null;
    try {
      mod = require(id);
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
    if (mod != null && typeof mod.locate === 'function') return mod.locate();
  }
  return {status: 'unsupported'};
}

// The binary install puts beside the app (<home>/shim/ch-shim, by its pin
// and verified; the install step is on top of the auto-upgrade build) wins
// over any other lookup, once it and the directories above it are this
// user's alone: a client config names that file, and whoever can replace it,
// or anything in its directory, runs as this user in every session.
// - <home>: lib/home.js homeOwnershipProblem (a directory; on POSIX this
//   user's, not group- or world-writable).
// - <home>/shim: lib/private-file.js's rule for a private directory, the one
//   the native shim applies (POSIX: not a link, this user's (effective uid),
//   mode 0700 exactly; Windows: not a link or junction, owner and DACL by
//   privateProblem).
// - ch-shim: a regular file, not a link; on POSIX owned by this user, no
//   group or other write, no setuid or setgid, executable by its owner; on
//   Windows owner and DACL by privateProblem (an unreadable DACL fails
//   closed).
// Which release it is stays install's to keep right (it replaces it with the
// app). (home, {platform, geteuid, acl}) -> {file} | {problem} | null (no
// file there).
function installed(home, {platform = process.platform, geteuid = process.geteuid, acl} = {}) {
  if (home == null) return null;
  const fs = require('fs');
  const path = require('path');
  const {checkDirPosix, checkPathWindows} = require('./private-file');
  const dir = path.join(home, 'shim');
  const file = path.join(dir, platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');
  let fst;
  try {
    fst = fs.lstatSync(file);
  } catch (e) {
    // only an absent file is "none there"; anything else is said
    if (e.code === 'ENOENT') return null;
    return {problem: `${file} could not be read (${e.code || e.message})`};
  }
  const me = platform === 'win32' || typeof geteuid !== 'function' ? null : geteuid();
  try {
    const owned = require('./home').homeOwnershipProblem(fs.realpathSync(home), platform);
    if (owned != null) return {problem: `${home}: ${owned}`};
    if (platform === 'win32') {
      checkPathWindows(dir, true, acl);
      checkPathWindows(file, false, acl);
      return {file};
    }
    checkDirPosix(dir, me);
  } catch (e) {
    return {problem: e.code === 'NOT_PRIVATE' ? e.message : `${dir} could not be checked (${e.code || e.message})`};
  }
  const m = fst.mode & 0o7777;
  if (fst.isSymbolicLink() || !fst.isFile()) return {problem: `${file}: it is not a regular file (or is a link)`};
  if (me != null && fst.uid !== me) return {problem: `${file}: it is owned by uid ${fst.uid}, not this user`};
  if ((m & 0o022) !== 0) return {problem: `${file}: it is writable by group or others (mode ${m.toString(8).padStart(4, '0')})`};
  if ((m & 0o6000) !== 0) return {problem: `${file}: it is setuid or setgid (mode ${m.toString(8).padStart(4, '0')})`};
  if ((m & 0o100) === 0) return {problem: `${file}: it is not executable by its owner`};
  return {file};
}

// {home?, locate?, platform?, geteuid?, acl?} -> {shim: absolute path | null,
// note: a line for the user | null}. An installed shim that fails the checks
// above is not used, and the note says why (beside whatever is used instead).
function shimFor({home = null, locate = defaultLocate, platform, geteuid, acl} = {}) {
  const here = installed(home, {platform, geteuid, acl});
  if (here != null && here.file != null) return {shim: here.file, note: null};
  const passed = here != null ? `ch-local: the installed shim is not used: ${here.problem}; reinstall ch-local to put it right.\n` : '';
  const r = locate();
  if (r != null && r.status === 'found') return {shim: r.path, note: passed === '' ? null : passed};
  if (r != null && r.status === 'missing') {
    return {shim: null, note: `${passed}ch-local: the shared runtime's shim for this platform (${r.package}) is not installed or holds no binary; reinstall ch-local. Until then each session runs its own runtime.\n`};
  }
  return {shim: null, note: `${passed}ch-local: there is no shared-runtime shim for this platform, so it runs one runtime per session.\n`};
}

module.exports = {shimFor, defaultLocate};
