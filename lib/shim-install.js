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
const {readOwnFile, writeOwnFile} = require('./own-file');

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
function readVersions(file, platform = process.platform) {
  try {
    const bytes = readOwnFile(file, {max: 64 * 1024, platform});
    if (bytes == null) return {};
    const doc = JSON.parse(bytes.toString('utf8'));
    if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) return {};
    return Object.fromEntries(Object.entries(doc).filter(([k, v]) => /^[0-9a-f]{128}$/.test(k) && typeof v === 'string'));
  } catch (e) {
    return {};
  }
}
function writeVersions(file, map) {
  writeOwnFile(file, JSON.stringify(map, null, 2) + '\n');
}
// A shim binary's bytes, read only as a regular file under one name, never
// through a link and never blocking (a FIFO), bounded: lstat, then an
// O_NOFOLLOW | O_NONBLOCK descriptor judged and read on its own. -> Buffer,
// or null for anything else (the reviewer's high on #120, 2 and 3: every
// read of ch-shim and ch-shim.previous).
const MAX_BINARY = 64 * 1024 * 1024;
function readPlain(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return null; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_BINARY) return null;
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)); } catch (e) { return null; }
  try {
    const at = fs.fstatSync(fd);
    if (!at.isFile() || at.size > MAX_BINARY) return null;
    return fs.readFileSync(fd);
  } catch (e) {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
// the version of the binary at file, by its content -> version, or null
// (a link, a FIFO or anything but a plain file: none)
function versionAt(file, versions) {
  const bytes = readPlain(file);
  if (bytes == null) return null;
  const v = versions[digest(bytes)];
  return typeof v === 'string' ? v : null;
}
// versions.json keeps only the binaries there
function prune(p, platform) {
  const map = readVersions(p.versions, platform);
  const keep = new Set([p.target, p.previous].map((f) => { const b = readPlain(f); return b != null ? digest(b) : null; }).filter((d) => d != null));
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

// The local half, under the home's lock: a prepared shim put in place.
// ready: prepareShim's 'ready' or 'current' -> {status: 'installed', path,
// version}. Throws SHIM_DIR (the folder is not this user's private one),
// SHIM_STALE (a 'current' one no longer the version's), SHIM_BUSY (the one
// before can't be moved: a session still runs it, on Windows), or an fs error.
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
    if (versionAt(p.target, versions) !== ready.version) throw failure('SHIM_STALE', `${p.target} is no longer the verified shim ${ready.version}`);
    return {status: 'installed', path: p.target, version: ready.version};
  }
  clearStale(p.dir);
  const binary = ready.binary;
  const hex = digest(binary);
  // known before it is placed, so what is on disk can always be told apart
  writeVersions(p.versions, Object.assign(readVersions(p.versions, platform), {[hex]: ready.version}));
  // (never through a link, never a FIFO: readPlain)
  const there = readPlain(p.target);
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

module.exports = {installShim, prepareShim, placeShim, alignShim, setAside, PREVIOUS};
