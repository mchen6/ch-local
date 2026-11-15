'use strict';
// A file in the home that only this user can have written, read and written
// so (the review of #48): what the automatic upgrade keeps between runs
// (upgrade-check.json) decides when new code runs, so it is not taken from a
// file another user could have planted or a link to one.
// - read: missing is null. Otherwise it must not be a link (on Windows, no
//   reparse point), must be a regular file, and at most `max` bytes. On
//   POSIX it is opened O_NOFOLLOW, both stats must name the same file, and it
//   must be owned by this user with nothing for group or others
//   (mode & 0o077 == 0). On Windows its owner and DACL pass privateProblem
//   (lib/win-acl.js). Anything else throws NOT_PRIVATE.
// - write: a temp file beside it, created exclusively (never through a
//   link), 0600, then renamed over it (a link there is replaced, not
//   followed).
const fs = require('node:fs');
const path = require('node:path');

const refuse = (file, why) => Object.assign(new Error(`${file}: ${why}`), {code: 'NOT_PRIVATE'});
const euid = () => (typeof process.geteuid === 'function' ? process.geteuid() : null);

function readOwnFile(file, {max = 1024 * 1024, platform = process.platform} = {}) {
  let before;
  try { before = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (before.isSymbolicLink()) throw refuse(file, 'it is a link');
  if (!before.isFile()) throw refuse(file, 'it is not a regular file');
  if (platform === 'win32') {
    const {fileAcl, privateProblem} = require('./win-acl');
    const problem = privateProblem(file, fileAcl(file));
    if (problem != null) throw refuse(file, problem);
    const data = fs.readFileSync(file);
    if (data.length > max) throw refuse(file, `it is larger than ${max} bytes`);
    return data;
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (st.dev !== before.dev || st.ino !== before.ino) throw refuse(file, 'it changed while it was checked');
    if (!st.isFile()) throw refuse(file, 'it is not a regular file');
    if (euid() != null && st.uid !== euid()) throw refuse(file, `it is owned by uid ${st.uid}, not this user`);
    if ((st.mode & 0o077) !== 0) throw refuse(file, `its mode is ${(st.mode & 0o777).toString(8).padStart(4, '0')}: group or others have access`);
    const buf = Buffer.alloc(max + 1);
    const n = fs.readSync(fd, buf, 0, max + 1, 0);
    if (n > max) throw refuse(file, `it is larger than ${max} bytes`);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function writeOwnFile(file, data) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let placed = false;
  try {
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    try {
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    placed = true;
  } finally {
    if (!placed) { try { fs.unlinkSync(temp); } catch (e) { /* gone */ } }
  }
}

module.exports = {readOwnFile, writeOwnFile};
