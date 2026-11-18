'use strict';
// The module store (module-level install, #413 section 9.1): one directory
// per module version, replacing a tree per pack version (lib/pack-dir.js),
// where each pack had its own copy of every part.
//
//   <home>/module-store/
//     @countinghouse/ch-access-github/0.2.0/      the package, as unpacked
//     @countinghouse/ch-access-github/0.2.0.json  {name, version, integrity, placedAt}
//     weather-tool/1.2.0/  weather-tool/1.2.0.json
//
// A module's package has no npm dependencies (lib/unpack.js checkManifest),
// so a version directory is complete by itself.
// - Placing a version: its tarball, already checked against its pin, is
//   unpacked into <version>.new-<random> beside it and its manifest checked;
//   the directory is renamed into place, then its marker is written. A
//   version directory with no marker is incomplete: never loaded, and
//   collected (lib/gc.js).
// - Skipping: a version there with a marker whose integrity is the pin's is
//   neither fetched nor unpacked again ("a module already installed is not
//   installed again").
// - A marker with another integrity comes only from a development install
//   (--unreleased-pins builds one version twice): the version is replaced
//   when no running start uses it, refused otherwise.
// The store is inside ch-local's home, which the file broker denies to every
// module; a module reads its own directory only. Every change here is made
// under the home's lock (the caller's).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {writeAtomic} = require('./atomic');
const {unpackOne} = require('./unpack');

const {VERSION, PACKAGE, SCOPE, storeVersion} = require('./names');
const {removeAside} = require('./aside');
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

function checkName(name, version) {
  if (typeof name !== 'string' || !PACKAGE.test(name)) throw new Error(`${JSON.stringify(name)} is not a package name`);
  if (!storeVersion(version)) throw new Error(`${name}: ${JSON.stringify(version)} is not a version`);
}

const {integrityOf} = require('./integrity');

// where: layout(). -> <store>/<name>/<version> (a scoped name is two directories)
function versionDir(where, name, version) {
  checkName(name, version);
  return path.join(where.moduleStore, ...name.split('/'), version);
}
const markerFile = (where, name, version) => `${versionDir(where, name, version)}.json`;

// The error for what could not be read: neither there nor not there. A
// reader that gets it keeps (collection) or refuses (placing): unknown is
// never taken for missing (#82's high review, 2).
const unknown = (what, err) => Object.assign(new Error(`${what} could not be read (${err.code || err.message})`), {code: err.code || 'EUNKNOWN', unknown: true});

// -> the version's marker {name, version, integrity, placedAt}, or null when
// there is none: no file (ENOENT), not a regular file (a link is no marker:
// #82's high review, 6), not JSON, or not this version's. Throws (unknown)
// on any other error.
function readMarker(where, name, version) {
  const file = markerFile(where, name, version);
  // opened without following a link where the platform can (O_NOFOLLOW),
  // and judged on what was opened, so nothing swapped in between is read
  // (#82's medium, 6); Windows has no O_NOFOLLOW: lstat first there
  const noFollow = fs.constants.O_NOFOLLOW;
  let fd;
  try {
    if (noFollow == null && !fs.lstatSync(file).isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (noFollow || 0));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    if (err.code === 'ELOOP') return null;   // a link: no marker
    throw unknown(file, err);
  }
  let raw;
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    raw = fs.readFileSync(fd, 'utf8');
  } catch (err) {
    throw unknown(file, err);
  } finally {
    fs.closeSync(fd);
  }
  let m;
  try { m = JSON.parse(raw); } catch (err) { return null; }
  if (m == null || typeof m !== 'object' || m.name !== name || m.version !== version || typeof m.integrity !== 'string' ||
    !INTEGRITY.test(m.integrity) || typeof m.placedAt !== 'string') return null;
  return {name: m.name, version: m.version, integrity: m.integrity, placedAt: m.placedAt};
}

// The version's directory: {there: whether anything is at its path, dir:
// whether that is a directory (never a link)}. Throws (unknown) on an error
// other than not there.
function dirState(where, name, version) {
  const dir = versionDir(where, name, version);
  try {
    return {there: true, dir: fs.lstatSync(dir).isDirectory()};
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return {there: false, dir: false};
    throw unknown(dir, err);
  }
}

// Whether the version is whole: its directory there, its marker this
// version's. Throws (unknown) when either cannot be read.
function isComplete(where, name, version) {
  return dirState(where, name, version).dir && readMarker(where, name, version) != null;
}

// One module version into the store, under the home's lock (the caller's).
// bytes: its tarball, read once; pin: {version, integrity}, which the bytes
// must match. inUse(name, version), required: whether a running start uses
// that version (lib/gc.js's liveness), asked only when a version there holds
// other contents. A start writes its run.json under the same lock
// (lib/start.js), so none can begin between that answer and the swap.
// -> {dir, placed: true when unpacked now, false when skipped}. Throws with
// a message naming the module; a failure leaves the store as it was, or the
// version incomplete (no marker), which is never loaded and is collected.
function placeModule(where, name, bytes, pin, {inUse, now = () => new Date()} = {}) {
  // required, so a caller that forgets it never replaces a version in use
  if (typeof inUse !== 'function') throw new Error('placeModule: inUse is required');
  const version = pin != null ? pin.version : undefined;
  const dir = versionDir(where, name, version);
  if (typeof pin.integrity !== 'string' || !INTEGRITY.test(pin.integrity)) throw new Error(`${name}@${version}: its pin has no integrity`);
  if (!Buffer.isBuffer(bytes) || integrityOf(bytes) !== pin.integrity) throw new Error(`${name}@${version}: the tarball's integrity is not the pinned one`);
  // one look at each (#82's high review, 9); unknown refuses (2)
  const state = dirState(where, name, version);
  const marker = readMarker(where, name, version);
  const whole = state.dir && marker != null;
  const there = state.there;
  if (whole && marker.integrity === pin.integrity) return {dir, placed: false};
  // anything at the path may be in use, whole or not (a failed earlier swap
  // leaves it incomplete): asked whenever it is there (#82's high review, 4)
  if (there && inUse(name, version)) {
    throw new Error(whole
      ? `${name} ${version} is installed with other contents and a running client uses it; stop it and run this again`
      : `${name} ${version} is incomplete in the module store and a running client uses it; stop it and run this again`);
  }
  const rand = () => crypto.randomBytes(4).toString('hex');
  const stage = `${dir}.new-${rand()}`;
  fs.mkdirSync(path.dirname(dir), {recursive: true});
  try {
    unpackOne(stage, bytes, name, version);
    // the old version (other contents, or incomplete) made incomplete first,
    // then set aside whole: never half of one under its name
    fs.rmSync(markerFile(where, name, version), {force: true});
    if (there) removeAside(dir);
    fs.renameSync(stage, dir);
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
  }
  writeAtomic(markerFile(where, name, version), JSON.stringify({name, version, integrity: pin.integrity, placedAt: now().toISOString()}) + '\n');
  return {dir, placed: true};
}

// A module version's manifest from the store (its role, its calls, its
// remotes). -> the parsed package.json. Throws when the version is not whole
// or its package.json cannot be read.
function readStoredManifest(where, name, version) {
  if (!isComplete(where, name, version)) throw new Error(`${name} ${version} is not in the module store; run \`ch-local install\` again`);
  try {
    return JSON.parse(fs.readFileSync(path.join(versionDir(where, name, version), 'package.json'), 'utf8'));
  } catch (err) {
    throw new Error(`${name} ${version}: its package.json in the module store is not readable`);
  }
}

// -> the version's countinghouse.role: 'scenario', 'part', or null
function roleOf(where, name, version) {
  const m = readStoredManifest(where, name, version);
  const role = m.countinghouse != null && typeof m.countinghouse === 'object' ? m.countinghouse.role : undefined;
  return role === 'scenario' || role === 'part' ? role : null;
}

module.exports = {versionDir, markerFile, readMarker, isComplete, placeModule, readStoredManifest, roleOf, storeVersion, VERSION, PACKAGE, SCOPE};
