'use strict';
// The native shim for this platform (agreed with A and the Reviewer): the
// one @countinghouse/ch-shim-<os>-<arch> a release's shim.packages names for
// ${platform}-${arch}, fetched by its pin from the registry
// (lib/npm-fetch.js), checked by its provenance (lib/provenance.js
// verifyRelease: shim.yml, shim-v<version>), its one file bin/<exe> read by
// the strict tar reader (a regular file: the reader refuses links and
// devices), and put at <home>/shim/ch-shim (ch-shim.exe on Windows), 0755.
// - <home>/shim is checked, not only set: on POSIX it is opened without
//   following a link and must be a directory this user owns, then
//   fchmod 0700; on Windows it must not be a link or junction, and it is
//   given an owner-only DACL, read back and checked (lib/win-acl.js).
// - No shim for the platform: 'unsupported'; none pinned in this release:
//   'unpinned'. Nothing is fetched, and the platform runs the per-session
//   mode, as today.
// - The binary goes in by renames: the new one written beside it, the one
//   there moved to ch-shim.previous (no .exe: it is never launched), then the
//   new one renamed into place. The same binary again moves nothing.
// - Which version each binary is goes by its content: versions.json maps
//   each binary's sha512 to its version, written before a binary is placed,
//   read and written as this user's own file (lib/own-file.js: no link,
//   owned by this user, nothing for group or others; one that isn't counts
//   as knowing no version, so nothing is put in place by it). alignShim and
//   setAside check <home>/shim as installShim does before moving anything.
//   So alignShim (rollback) puts the restored release's shim in place by
//   what is on disk, and running it twice (a resumed rollback) moves nothing
//   the second time.
// - setAside: a shim that is not this release's (install from --from, or
//   from npm with none for the platform, or one that could not be installed)
//   is moved to ch-shim.previous, so a stale shim is never the one used.
// - Anything refused places nothing.
// Only a test's own code passes a fake registry and trust, as the rest of
// the arguments, which go on untouched.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const npmFetch = require('./npm-fetch');
const provenance = require('./provenance');
const {readMember} = require('./tar');
const {writeOwnFile} = require('./own-file');

const failure = (code, message) => Object.assign(new Error(message), {code});
const exe = (platform) => (platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');
const PREVIOUS = 'ch-shim.previous';
const VERSIONS = 'versions.json';
const paths = (home, platform) => {
  const dir = path.join(home, 'shim');
  return {dir, target: path.join(dir, exe(platform)), previous: path.join(dir, PREVIOUS), versions: path.join(dir, VERSIONS)};
};
const exists = (p) => { try { fs.lstatSync(p); return true; } catch (e) { return false; } };
const digest = (bytes) => crypto.createHash('sha512').update(bytes).digest('hex');

// <home>/shim, made if missing, and checked: a directory, not a link, this
// user's, private
function ownedDir(dir, platform) {
  try {
    fs.mkdirSync(dir, {mode: 0o700});
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw failure('SHIM_DIR', `${dir} is not a directory (a link is refused)`);
  // Windows' checks whenever the caller's platform or this system is Windows
  // (a test's platform can be another's; POSIX modes mean nothing on Windows)
  if (platform === 'win32' || process.platform === 'win32') {
    const winAcl = require('./win-acl');
    const [acl] = winAcl.makePrivateDirs([dir], [dir]);
    const why = winAcl.privateProblem(dir, acl, {directory: true});
    if (why != null) throw failure('SHIM_DIR', why);
    return;
  }
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const at = fs.fstatSync(fd);
    if (!at.isDirectory()) throw failure('SHIM_DIR', `${dir} is not a directory`);
    if (typeof process.getuid === 'function' && at.uid !== process.getuid()) throw failure('SHIM_DIR', `${dir} belongs to another user (uid ${at.uid})`);
    fs.fchmodSync(fd, 0o700);
  } finally {
    fs.closeSync(fd);
  }
}

// versions.json: {sha512 hex: version}; anything unreadable, or not this
// user's own, is empty
// (one reader with lib/session.js: lib/plain-read.js)
const readVersions = (file, platform = process.platform) => require('./plain-read').readVersions(file, platform);
function writeVersions(file, map) {
  writeOwnFile(file, JSON.stringify(map, null, 2) + '\n');
}
// every read of ch-shim and ch-shim.previous: never through a link, never
// blocking on a FIFO (lib/plain-read.js; the reviewer's high on #120, 2, 3)
const plain = (file) => require('./plain-read').readPlain(file).bytes;
// the version of the binary at file, by its content -> version, or null
// (a link, a FIFO or anything but a plain file: none)
function versionAt(file, versions) {
  const bytes = plain(file);
  if (bytes == null) return null;
  const v = versions[digest(bytes)];
  return typeof v === 'string' ? v : null;
}
// versions.json keeps only the binaries there
function prune(p, platform) {
  const map = readVersions(p.versions, platform);
  const keep = new Set([p.target, p.previous].map((f) => { const b = plain(f); return b != null ? digest(b) : null; }).filter((d) => d != null));
  writeVersions(p.versions, Object.fromEntries(Object.entries(map).filter(([d]) => keep.has(d))));
}

// the shim there, moved to ch-shim.previous (the one before that goes). A
// ch-shim.previous that cannot be removed (on Windows, a session started
// before the last install still running it) leaves the shim moved aside
// under another name, so it is never the one used. -> whether one moved
function setAside(home, {platform = process.platform} = {}) {
  const p = paths(home, platform);
  if (!exists(p.target)) return false;
  ownedDir(p.dir, platform);
  try {
    fs.rmSync(p.previous, {force: true});
    fs.renameSync(p.target, p.previous);
  } catch (e) {
    fs.renameSync(p.target, path.join(p.dir, `.stale-${process.pid}-${Date.now()}`));
  }
  return true;
}

// what earlier set-asides left: removed when they can be (one still running
// on Windows can't, until its session exits)
function clearStale(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  // (a .swap-* is what an interrupted swap left: its binary is set aside)
  for (const n of names.filter((x) => x.startsWith('.stale-') || x.startsWith('.swap-'))) { try { fs.rmSync(path.join(dir, n), {force: true}); } catch (e) { /* held */ } }
}

// The network half, before the home's lock (the medium on B-shim-allow: the
// shim is placed and recorded inside install's one locked record write).
// {data (parsed release pins), record (the home's record before this
// install), home, io, platform, arch, ...fromNpm} -> never throws:
//   {status: 'unsupported'} | {status: 'unpinned', package}
//   | {status: 'current', name, version}: the record names this package at
//     this pin and the binary there is that version's (versions.json, by
//     content) -- not fetched again; placeShim checks it again under the lock
//   | {status: 'ready', name, version, binary}: fetched, provenance verified
//   | {status: 'failed', name, version, error}
async function prepareShim({data, record = null, home, io, platform = process.platform, arch = process.arch, ...fromNpm}) {
  const key = `${platform}-${arch}`;
  const name = Object.prototype.hasOwnProperty.call(data.shim.packages, key) ? data.shim.packages[key] : null;
  if (name == null) return {status: 'unsupported'};
  const pin = data.pins[name];
  if (pin == null) return {status: 'unpinned', package: name};
  if (home != null && record != null && record.shim != null && record.shim.package === name && record.shim.version === pin.version) {
    const p = paths(home, platform);
    if (versionAt(p.target, readVersions(p.versions, platform)) === pin.version) return {status: 'current', name, version: pin.version};
  }
  try {
    const {bytes} = await npmFetch.fetchTarball(name, pin.version, io, Object.assign({pin}, fromNpm));
    const attestations = await npmFetch.attestations(name, pin.version, io, fromNpm);
    provenance.verifyRelease(Object.assign({name, version: pin.version, pin, attestations}, fromNpm));
    let binary;
    try {
      binary = readMember(bytes, `bin/${exe(platform)}`);
    } catch (e) {
      throw failure('SHIM_TARBALL', `${name}@${pin.version}'s tarball was refused (${e.message})`);
    }
    if (binary == null) throw failure('SHIM_NO_BINARY', `${name}@${pin.version} holds no bin/${exe(platform)}`);
    return {status: 'ready', name, version: pin.version, binary};
  } catch (error) {
    // (always an Error with a code: the install reads both -- the medium's
    // round 3, 2)
    const err = error instanceof Error && error.code != null ? error
      : failure(error != null && error.code != null ? error.code : 'SHIM_FETCH', `the shim could not be fetched (${error instanceof Error ? error.message : String(error)})`);
    return {status: 'failed', name, version: pin.version, error: err};
  }
}

// The same half for a prepared folder (install --from: A-shim-from, the
// reviewer, 11-21). The folder's shim tarball is trusted by the sha512 its
// pins name, exactly as its packs are (lib/install.js loadTarballs): no
// registry, no provenance, and no other bytes read. {data (the effective
// allowlist's {shim, pins}), record, home, from, platform, arch} -> never
// throws:
//   null: the folder brings no shim for this platform (no package named for
//     it, none pinned, or no tarball of it there): install sets the one
//     there aside, as before
//   | {status: 'current' | 'ready', ...}: prepareShim's answers, placed by
//     placeShim under the lock
//   | {status: 'refused', error}: install refuses, as for a pack -- a shim
//     tarball there for another platform, bytes other than the pin's, no
//     binary, or a binary this machine doesn't run
function prepareShimFrom({data, record = null, home, from, platform = process.platform, arch = process.arch}) {
  const {tarballName} = require('./unpack');
  const key = `${platform}-${arch}`;
  const packages = data.shim != null && data.shim.packages != null ? data.shim.packages : {};
  const name = Object.prototype.hasOwnProperty.call(packages, key) ? packages[key] : null;
  const refused = (code, message) => ({status: 'refused', error: failure(code, message)});
  let files;
  try { files = fs.readdirSync(from); } catch (e) { return null; }
  // (a shim tarball for another platform is refused, never ignored: the
  // reviewer's (a). Judged by the pins' versions, as loadTarballs judges
  // what a folder holds)
  for (const [k, other] of Object.entries(packages)) {
    if (other === name || data.pins[other] == null) continue;
    if (files.includes(tarballName(other, data.pins[other].version))) return refused('SHIM_PLATFORM', `${other}@${data.pins[other].version} is the shim for ${k}, not for this machine (${key})`);
  }
  if (name == null) return null;
  const pin = data.pins[name];
  if (pin == null || !files.includes(tarballName(name, pin.version))) return null;
  const at = `${name}@${pin.version}`;
  if (home != null && record != null && record.shim != null && record.shim.package === name && record.shim.version === pin.version) {
    const p = paths(home, platform);
    if (versionAt(p.target, readVersions(p.versions, platform)) === pin.version) return {status: 'current', name, version: pin.version};
  }
  let bytes;
  try { bytes = fs.readFileSync(require('node:path').join(from, tarballName(name, pin.version))); } catch (e) {
    return refused('SHIM_TARBALL', `${at}: cannot read ${tarballName(name, pin.version)} (${e.code || e.message})`);
  }
  if (require('./integrity').integrityOf(bytes) !== pin.integrity) return refused('SHIM_INTEGRITY', `${at}: the tarball's integrity is not the pinned one`);
  let binary;
  try { binary = readMember(bytes, `bin/${exe(platform)}`); } catch (e) {
    return refused('SHIM_TARBALL', `${at}'s tarball was refused (${e.message})`);
  }
  if (binary == null) return refused('SHIM_NO_BINARY', `${at} holds no bin/${exe(platform)}`);
  // (what session would refuse to exec is refused here, before anything is
  // placed: lib/session.js formatProblem)
  const why = require('./session').formatProblem(binary.subarray(0, 4096), platform, arch);
  if (why != null) return refused('SHIM_PLATFORM', `${at}'s bin/${exe(platform)} is not a program this machine runs (${key}: ${why})`);
  return {status: 'ready', name, version: pin.version, binary};
}

// The local half, under the home's lock: a prepared shim put in place.
// ready: prepareShim's 'ready' or 'current' -> {status: 'installed', path,
// version}. Throws SHIM_DIR (the folder is not this user's private one),
// SHIM_STALE (a 'current' one no longer the version's), SHIM_BUSY (the one
// before can't be moved: a session still runs it, on Windows), or an fs error.
// fsync a directory (its entries' renames on disk). Windows can't open one
// to sync it (EPERM): judged by the host, never the platform a caller
// passes for its logic (shim-install.test on a Windows runner, #120's CI)
function syncDir(dir) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function placeShim(home, ready, {platform = process.platform} = {}) {
  const p = paths(home, platform);
  ownedDir(p.dir, platform);
  if (ready.status === 'current') {
    // (checked again under the lock, the folder now known this user's own:
    // a regular file, never a link, still that version's binary)
    // (opened without following a link, judged and hashed on that one
    // descriptor: nothing swapped in between -- the medium's round 3, 6)
    // (by lstat and an O_NOFOLLOW descriptor: a link, a FIFO, anything but
    // a plain file is not it -- Windows has no O_NOFOLLOW, lstat refuses there)
    const versions = readVersions(p.versions, platform);
    if (Object.keys(versions).length === 0) throw failure('SHIM_UNREADABLE', `${p.versions} could not be read as this user's own, so the shim in place can't be checked`);
    // (one there that can't be read is said as such, with its errno: not
    // "changed", which a rerun would never put right -- the medium on #120's
    // high round)
    const there = require('./plain-read').readPlain(p.target);
    if (there.code != null) throw failure('SHIM_UNREADABLE', `${p.target} could not be read (${there.code})`);
    const at = there.bytes != null ? versions[digest(there.bytes)] : undefined;
    if (at !== ready.version) throw failure('SHIM_STALE', `${p.target} is no longer the verified shim ${ready.version}`);
    return {status: 'installed', path: p.target, version: ready.version};
  }
  clearStale(p.dir);
  const binary = ready.binary;
  const hex = digest(binary);
  // known before it is placed, so what is on disk can always be told apart
  writeVersions(p.versions, Object.assign(readVersions(p.versions, platform), {[hex]: ready.version}));
  // (never through a link, never a FIFO: plain)
  const there = plain(p.target);
  const same = there != null && digest(there) === hex;
  if (!same) {
    const temp = path.join(p.dir, `.${exe(platform)}.${process.pid}.tmp`);
    try {
      const fd = fs.openSync(temp, 'wx', 0o700);
      try {
        // (every byte written, and on disk before the rename: the
        // reviewer's high on #120, 5)
        for (let off = 0; off < binary.length;) off += fs.writeSync(fd, binary, off, binary.length - off);
        fs.fchmodSync(fd, 0o755);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const had = exists(p.target);
      if (had) {
        try {
          fs.rmSync(p.previous, {force: true});
        } catch (e) {
          throw failure('SHIM_BUSY', `${p.previous} could not be removed (${e.code || e.message}); on Windows a session started before the last install may still be running it, and the new shim installs once that session exits`);
        }
        fs.renameSync(p.target, p.previous);
      }
      try {
        fs.renameSync(temp, p.target);
      } catch (e) {
        // the one there goes back
        if (had && exists(p.previous) && !exists(p.target)) fs.renameSync(p.previous, p.target);
        throw e;
      }
      // (the renames on disk before install writes the record naming this
      // shim: the directory too, where it can be opened -- not on Windows)
      syncDir(p.dir);
    } finally {
      fs.rmSync(temp, {force: true});
    }
  }
  prune(p, platform);
  return {status: 'installed', path: p.target, version: ready.version};
}

// {home, data (parsed release pins), io, platform, arch, ...fromNpm} ->
// {status: 'installed', path, version} | {status: 'unsupported' | 'unpinned'};
// throws as before: the two halves at once (no record: always fetched)
async function installShim({home, data, io, platform = process.platform, arch = process.arch, ...fromNpm}) {
  const ready = await prepareShim(Object.assign({data, home, io, platform, arch}, fromNpm));
  if (ready.status === 'unsupported' || ready.status === 'unpinned') return ready.status === 'unpinned' ? {status: 'unpinned', package: ready.package} : {status: 'unsupported'};
  if (ready.status === 'failed') throw ready.error;
  return placeShim(home, ready, {platform});
}

// rollback: the restored release's shim ({version}, or null for none) put in
// place by what is on disk. Already in place: nothing moves (so a resumed
// rollback, or the same release reinstalled, never swaps back). At
// ch-shim.previous: the two swap. Not there, or none wanted: the shim there
// is set aside, so the restored release runs per session rather than with
// another release's shim. -> what it did
function alignShim(home, {restored, platform = process.platform}) {
  const p = paths(home, platform);
  const want = restored != null && typeof restored.version === 'string' ? restored.version : null;
  if (!exists(p.dir)) return 'nothing';
  ownedDir(p.dir, platform);
  clearStale(p.dir);
  const versions = readVersions(p.versions, platform);
  const current = exists(p.target) ? versionAt(p.target, versions) : null;
  if (want == null) return setAside(home, {platform}) ? 'set aside' : 'nothing';
  if (current === want) return 'nothing';
  if (exists(p.previous) && versionAt(p.previous, versions) === want) {
    if (!exists(p.target)) { fs.renameSync(p.previous, p.target); return 'restored'; }
    const aside = path.join(p.dir, `.swap-${process.pid}-${Date.now()}`);
    fs.renameSync(p.target, aside);
    try {
      fs.renameSync(p.previous, p.target);
    } catch (e) {
      fs.renameSync(aside, p.target);
      throw e;
    }
    fs.renameSync(aside, p.previous);
    return 'swapped';
  }
  return setAside(home, {platform}) ? 'set aside' : 'nothing';
}

module.exports = {installShim, prepareShim, prepareShimFrom, placeShim, alignShim, setAside, PREVIOUS};
