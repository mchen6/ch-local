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
const {readPrivateIn} = require('./private-file');

const NAME = 'requests';
const MAX_BYTES = 1024 * 1024;
const OPS = ['upgrade'];

function privateDir(dir) {
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    if (process.platform === 'win32') return true;
    return (st.mode & 0o777) === 0o700 && (typeof process.geteuid !== 'function' || st.uid === process.geteuid());
  } catch (e) {
    return false;
  }
}

// -> whether the request was written (no daemon directory: nothing to tell)
function requestUpgrade(home, {now = () => Date.now()} = {}) {
  const dir = path.join(home, 'run', 'daemon');
  if (!privateDir(dir)) return false;
  let fd = null;
  try {
    fd = fs.openSync(path.join(dir, NAME), fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
    if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, `${JSON.stringify({op: 'upgrade', at: now()})}\n`);
    return true;
  } catch (e) {
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

// -> {requests: [{op, at}], offset}: the whole lines after `offset`; on any
// check that fails, none, and the offset unchanged
function readRequests(home, offset) {
  let bytes;
  try {
    bytes = readPrivateIn(path.join(home, 'run', 'daemon'), NAME, MAX_BYTES);
  } catch (e) {
    return {requests: [], offset};
  }
  if (bytes.length < offset) offset = 0;   // the file was replaced
  const text = bytes.subarray(offset).toString('utf8');
  const end = text.lastIndexOf('\n');
  if (end < 0) return {requests: [], offset};
  const requests = [];
  for (const line of text.slice(0, end).split('\n')) {
    let m = null;
    try { m = JSON.parse(line); } catch (e) { continue; }
    if (m != null && typeof m === 'object' && OPS.includes(m.op) && Number.isSafeInteger(m.at)) requests.push({op: m.op, at: m.at});
  }
  return {requests, offset: offset + Buffer.byteLength(text.slice(0, end + 1))};
}

module.exports = {requestUpgrade, readRequests, NAME};
