'use strict';
// This platform's native shim, for the client's config entry (countinghouse's
// shared-runtime design, #236, section 10).
//
// Only a source checkout (dev and tests: npm-shim/ beside this lib/, which no
// published ch-local ships) looks for a shim beyond the one install placed,
// and only at fixed paths inside the checkout. Everything else -- an
// installed ch-local (<home>/app/node_modules/@countinghouse/ch-local/lib,
// or the same under <home>/previous/app after a rollback), and anything whose place can't be told -- uses only the binary
// install verified and put at <home>/shim (lib/shim-install.js). Nothing is
// ever looked up by package name: Node's lookup walks every parent
// directory's node_modules and the global folders ($NODE_PATH,
// ~/.node_modules), so a ch-shim found that way was never verified, and a
// client config would run it in every session. A shim there that fails a
// check below, or none there, runs the per-session mode, said.
const fs = require('fs');
const path = require('path');

const exeOf = (platform) => (platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');
const real = (p) => { try { return fs.realpathSync.native(p); } catch (e) { return null; } };
// as lib/start.js and the shim compare directories: case-insensitive where
// the file system usually is
const samePath = (a, b, platform) => (platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b);

// whether this code is the home's installed ch-local, by realpath: its lib/
// under <home>/app or <home>/previous/app, where install puts the package
// (lib/install.js: <app>/node_modules/<its name>); a home or app that isn't
// there is not
const SELF = require('../package.json').name;
function runsFromHome(home, {platform = process.platform, libDir = __dirname} = {}) {
  if (home == null) return false;
  const me = real(libDir);
  if (me == null) return false;
  const where = require('./home').layout({COUNTINGHOUSE_HOME: home});
  return [where.app, where.previousApp].some((app) => {
    const lib = real(path.join(app, 'node_modules', ...SELF.split('/'), 'lib'));
    return lib != null && samePath(lib, me, platform);
  });
}

// whether this code is a source checkout: its own npm-shim/ beside lib/
function isCheckout(libDir = __dirname) {
  return fs.existsSync(path.join(libDir, '..', 'npm-shim', 'ch-shim', 'index.js'));
}

// a checkout's own built shim, at fixed paths inside it: cargo's build in
// shim/target/release, or this platform's package in the checkout's own
// node_modules. No lookup by name, so nothing outside the checkout.
function defaultLocate({libDir = __dirname, platform = process.platform, arch = process.arch} = {}) {
  if (!isCheckout(libDir)) return {status: 'unsupported'};
  const root = path.join(libDir, '..');
  const target = require(path.join(root, 'npm-shim', 'targets.js')).find((t) => t.os === platform && t.cpu === arch);
  if (target == null) return {status: 'unsupported'};
  const name = `@countinghouse/ch-shim-${target.key}`;
  for (const file of [path.join(root, 'shim', 'target', 'release', exeOf(platform)), path.join(root, 'node_modules', '@countinghouse', `ch-shim-${target.key}`, 'bin', exeOf(platform))]) {
    if (fs.existsSync(file)) return {status: 'found', path: file};
  }
  return {status: 'missing', package: name};
}

// whether this release (its own lib/release-pins.json, part of the verified
// app) pins a shim for this platform. One that can't be read or parsed counts
// as pinned: the note then says reinstall, which repairs it.
function pinnedHere(platform = process.platform, arch = process.arch, libDir = __dirname) {
  let parsed;
  try {
    parsed = require('./release-pins').parseReleasePins(fs.readFileSync(path.join(libDir, 'release-pins.json')));
  } catch (e) {
    return true;
  }
  if (parsed.problem != null) return true;
  const name = parsed.pins.shim.packages[`${platform}-${arch}`];
  return name != null && Object.prototype.hasOwnProperty.call(parsed.pins.pins, name);
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
  const {checkDirPosix, checkPathWindows} = require('./private-file');
  const dir = path.join(home, 'shim');
  const file = path.join(dir, exeOf(platform));
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
    const owned = require('./home').homeOwnershipProblem(fs.realpathSync(home), platform, {fileAcl: acl != null ? acl.fileAcl : undefined});
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
// above is not used, and the note says why. Only a source checkout that is
// not a home's app asks locate (its own, or a test's).
function shimFor({home = null, locate = defaultLocate, platform = process.platform, geteuid, acl, arch = process.arch, libDir = __dirname} = {}) {
  const here = installed(home, {platform, geteuid, acl});
  if (here != null && here.file != null) return {shim: here.file, note: null};
  const passed = here != null ? `ch-local: the installed shim is not used: ${here.problem}; reinstall ch-local to put it right.\n` : '';
  if (!isCheckout(libDir) || runsFromHome(home, {platform, libDir})) {
    if (passed !== '') return {shim: null, note: `${passed}ch-local: until then each session runs its own runtime.\n`};
    if (pinnedHere(platform, arch, libDir)) {
      return {shim: null, note: `ch-local: the shared runtime's shim for this platform is not installed${home != null ? ` (${path.join(home, 'shim', exeOf(platform))})` : ''}; reinstall ch-local. Until then each session runs its own runtime.\n`};
    }
    return {shim: null, note: 'ch-local: this release installs no shared-runtime shim for this platform, so it runs one runtime per session.\n'};
  }
  const r = locate();
  if (r != null && r.status === 'found') return {shim: r.path, note: passed === '' ? null : passed};
  if (r != null && r.status === 'missing') {
    return {shim: null, note: `${passed}ch-local: the shared runtime's shim for this platform (${r.package}) is not installed or holds no binary; reinstall ch-local. Until then each session runs its own runtime.\n`};
  }
  return {shim: null, note: `${passed}ch-local: there is no shared-runtime shim for this platform, so it runs one runtime per session.\n`};
}

module.exports = {shimFor, installedShim: installed, defaultLocate, runsFromHome, isCheckout};
