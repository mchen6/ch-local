'use strict';
// <home>/run/daemon/requests (countinghouse's shared-runtime design, #236,
// section 6, "Upgrade"): an install or upgrade that changed the home appends
// one JSON line, {"op": "upgrade", "at": <epoch ms>}, which a running daemon
// watches. It then restarts its runtime, or itself, onto what was installed.
//
// - Written only into a private daemon directory (0700, this user's, not a
//   link), appended at 0600, opened O_NOFOLLOW, so never through a link.
// - Read with the same private-file checks as the secret (lib/private-file.js),
//   from an offset. A line not yet ended waits, and a bad line or an unknown op
//   is skipped.
const fs = require('node:fs');
const path = require('node:path');
// (as the module, so the read can be counted: test/daemon-requests.test.js)
const privateFile = require('./private-file');

const NAME = 'requests';
const MAX_BYTES = 1024 * 1024;
// upgrade: what is installed changed; restart: a stored credential changed,
// or `ch-local restart` (A5)
const OPS = ['upgrade', 'restart'];

// on Windows the directory's owner and DACL by privateProblem, as a
// directory (the review of #39); platform and fileAcl: for the tests
function privateDir(dir, {platform = process.platform, fileAcl = null} = {}) {
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (platform === 'win32') {
      const winAcl = require('./win-acl');
      return winAcl.privateProblem(dir, (fileAcl || winAcl.fileAcl)(dir), {directory: true}) == null;
    }
    return (st.mode & 0o777) === 0o700 && (typeof process.geteuid !== 'function' || st.uid === process.geteuid());
  } catch (e) {
    return false;
  }
}

// -> Promise<whether the request was written> (no daemon directory: nothing
// to tell). Appended under start.lock, which the daemon holds while it
// empties the file, so a request is never lost between its read and the
// truncation.
// signal: ends a wait on start.lock (a command's bound: the reviewer's high
// on #147, L3); underLock: run after the line is appended, still under the
// lock (restart reads its baseline there: M2). -> whether it was written
async function requestUpgrade(home, {now = () => Date.now(), io = {stderr: {write: () => {}}}, op = 'upgrade', platform, fileAcl, signal = null, underLock = null} = {}) {
  const dir = path.join(home, 'run', 'daemon');
  if (!privateDir(dir, {platform, fileAcl})) return false;
  const {withLockFile} = require('./lock');
  let written = false;
  await withLockFile(path.join(dir, 'start.lock'), dir, io, async() => {
    written = append(dir, now, op);
    if (written && typeof underLock === 'function') underLock();
    return 0;
  }, {wait: true, what: 'to finish its start or stop', signal});
  return written;
}

function append(dir, now, op = 'upgrade') {
  let fd = null;
  try {
    fd = fs.openSync(path.join(dir, NAME), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, `${JSON.stringify({op: OPS.includes(op) ? op : 'upgrade', at: now()})}\n`);
    return true;
  } catch (e) {
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

// the daemon, under start.lock, once it has read every whole line: the file
// emptied (only if nothing was appended after `offset`) -> whether it was
function emptyRequests(home, offset) {
  const file = path.join(home, 'run', 'daemon', NAME);
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW || 0));
    if (fs.fstatSync(fd).size !== offset) return false;
    fs.ftruncateSync(fd, 0);
    return true;
  } catch (e) {
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

// -> {requests: [{op, at}], offset, size}: the whole lines after `offset`;
// on any check that fails, none, and the offset unchanged. size: the file's,
// as stat saw it; seen: the size the last read saw, when its read was
// refused or left a partial line (the daemon passes it back) -- a file at
// that size again isn't read again until it changes (the medium on A2, 1)
function readRequests(home, offset, seen = null) {
  // (a stat first: the daemon polls every second, and on Windows each
  // private read is two synchronous PowerShell runs -- A2. A file not there,
  // at the offset, or at the size the last read already saw is not read;
  // any other size is read by every check. A stat decides only whether to
  // read: a same-size replacement waits for its next append, as before)
  let st;
  try { st = fs.lstatSync(path.join(home, 'run', 'daemon', NAME)); } catch (e) { return {requests: [], offset, size: null}; }
  if (st.size === offset || st.size === seen) return {requests: [], offset, size: st.size};
  let bytes;
  try {
    bytes = privateFile.readPrivateIn(path.join(home, 'run', 'daemon'), NAME, MAX_BYTES);
  } catch (e) {
    return {requests: [], offset, size: st.size};
  }
  let replaced = false;
  if (bytes.length < offset) { offset = 0; replaced = true; }   // the file was replaced
  // (lines found in the bytes themselves, so every offset is a byte
  // position whatever a line holds -- the medium on #147's last round, 9)
  const end = bytes.lastIndexOf(0x0a);
  if (end < offset) return {requests: [], offset, size: st.size};
  // (each request with the byte offset its line ends at: the daemon tells a
  // request written before its runtime last started without a clock -- the
  // reviewer's high on #147, R3)
  const requests = [];
  for (let from = offset; from <= end;) {
    const nl = bytes.indexOf(0x0a, from);
    const line = bytes.subarray(from, nl).toString('utf8');
    from = nl + 1;
    let m = null;
    try { m = JSON.parse(line); } catch (e) { continue; }
    if (m != null && typeof m === 'object' && OPS.includes(m.op) && Number.isSafeInteger(m.at)) requests.push({op: m.op, at: m.at, end: from});
  }
  return {requests, offset: end + 1, size: st.size, replaced};
}

// a running daemon restarts its runtime (a credential stored or removed)
const requestRestart = (home, opts = {}) => requestUpgrade(home, {...opts, op: 'restart'});

module.exports = {requestUpgrade, requestRestart, readRequests, emptyRequests, NAME};
