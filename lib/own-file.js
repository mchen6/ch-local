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

// platform: as the caller sees it; the checks are the Windows ones whenever
// either it or the system this runs on is Windows (a POSIX mode on Windows
// means nothing, and a caller's platform can be a test's)
// fileAcl: the caller's reader of a path's ACL (Windows: a session's, read
// once for every path it checks -- the medium on A3, 1), else win-acl's
function readOwnFile(file, {max = 1024 * 1024, platform = process.platform, fileAcl = null} = {}) {
  let before;
  try { before = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (before.isSymbolicLink()) throw refuse(file, 'it is a link');
  if (!before.isFile()) throw refuse(file, 'it is not a regular file');
  if (platform === 'win32' || process.platform === 'win32') {
    const winAcl = require('./win-acl');
    const problem = winAcl.privateProblem(file, (fileAcl || winAcl.fileAcl)(file));
    if (problem != null) throw refuse(file, problem);
    const data = fs.readFileSync(file);
    if (data.length > max) throw refuse(file, `it is larger than ${max} bytes`);
    return data;
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (st.dev !== before.dev || st.ino !== before.ino) throw Object.assign(refuse(file, 'it changed while it was checked'), {raced: true});
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

// A file read whole, at most `max` bytes, that need not be private (an
// app's own files: lib/installed-description.js reads the home's own
// release's pins so): a regular file, not a link, the one checked (dev and
// inode as bigints: Windows file ids exceed a double), opened without
// following a link or blocking on a FIFO swapped in, read to its end (a
// short read is never taken for the whole). The file itself is never a
// link; links in the directories above it are followed, as the launcher
// that runs those files follows them. -> its bytes, or null when it is
// missing, not a regular file, a link (found at the check, or swapped in
// before the open: ELOOP), under a path that is not a directory (ENOTDIR),
// swapped (a socket swapped in: ENXIO), or over max. Any other I/O error
// (EACCES, say) throws.
// (the codes each step can give for a path that is not a readable file)
const REFUSED_LSTAT = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);
const REFUSED_OPEN = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR', 'ENXIO']);
function readBoundedFile(file, {max}) {
  let before;
  try { before = fs.lstatSync(file, {bigint: true}); } catch (e) { if (REFUSED_LSTAT.has(e.code)) return null; throw e; }
  if (before.isSymbolicLink() || !before.isFile()) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (e) {
    if (REFUSED_OPEN.has(e.code)) return null;
    throw e;
  }
  try {
    const st = fs.fstatSync(fd, {bigint: true});
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) return null;
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (;;) {
      const got = fs.readSync(fd, buf, n, max + 1 - n, n);
      if (got === 0) break;
      n += got;
      if (n > max) return null;
    }
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// beforeRename: called once the temporary file is whole, just before it is
// renamed into place; a throw leaves the file as it was (the stored
// credentials' lock checked there: post-rel cred-race)
function writeOwnFile(file, data, {beforeRename = null} = {}) {
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
    if (typeof beforeRename === 'function') beforeRename();
    fs.renameSync(temp, file);
    placed = true;
  } finally {
    if (!placed) { try { fs.unlinkSync(temp); } catch (e) { /* gone */ } }
  }
}

module.exports = {readOwnFile, readBoundedFile, writeOwnFile};
