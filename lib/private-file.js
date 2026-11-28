'use strict';
// A private file in a private directory, read exactly as the native shim
// reads one (shim/src/trust.rs open_dir and open_in; countinghouse's
// shared-runtime design, #236, section 1, "The secret"):
//
// POSIX:
// - the directory is not a symlink, is a directory, is owned by the
//   effective uid, and is mode 0700 exactly;
// - the file is lstat'ed and must be a regular file; it is opened
//   O_NOFOLLOW | O_NONBLOCK (a FIFO never blocks the reader) and fstat'ed;
//   both stats must name the same file (device and inode); it is owned by
//   the effective uid and mode 0600 exactly.
// Windows: no reparse point (a symlink or a junction), and the directory's
// and the file's owner and DACL pass countinghouse's privateProblem rule
// (lib/win-acl.js).
//
// -> the file's bytes, at most `max`; throws an Error saying what failed.
const fs = require('node:fs');
const path = require('node:path');

const euid = () => (typeof process.geteuid === 'function' ? process.geteuid() : null);
const mode = (st) => st.mode & 0o7777;

function refuse(file, why) {
  const e = new Error(`${file}: ${why}`);
  e.code = 'NOT_PRIVATE';
  return e;
}

// `me` is the effective uid (a test passes another)
function checkDirPosix(dir, me = euid()) {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink()) throw refuse(dir, 'it is a symbolic link');
  if (!st.isDirectory()) throw refuse(dir, 'it is not a directory');
  if (me != null && st.uid !== me) throw refuse(dir, `it is owned by uid ${st.uid}, not this user`);
  if (mode(st) !== 0o700) throw refuse(dir, `its mode is ${mode(st).toString(8).padStart(4, '0')}, not 0700`);
}

function readPosix(dir, name, max) {
  checkDirPosix(dir);
  const file = path.join(dir, name);
  const before = fs.lstatSync(file);
  if (!before.isFile()) throw refuse(file, 'it is not a regular file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (st.dev !== before.dev || st.ino !== before.ino) throw refuse(file, 'it changed while it was checked');
    if (!st.isFile()) throw refuse(file, 'it is not a regular file');
    if (euid() != null && st.uid !== euid()) throw refuse(file, `it is owned by uid ${st.uid}, not this user`);
    if (mode(st) !== 0o600) throw refuse(file, `its mode is ${mode(st).toString(8).padStart(4, '0')}, not 0600`);
    const buf = Buffer.alloc(max + 1);
    const n = fs.readSync(fd, buf, 0, max + 1, 0);
    if (n > max) throw refuse(file, `it is larger than ${max} bytes`);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// Windows: p not a symlink or junction (what lstat reports as a link), a
// directory or a regular file as isDir says, its owner and DACL passing
// privateProblem. `acl` is {fileAcl, privateProblem} (a test passes its own).
function checkPathWindows(p, isDir, acl = require('./win-acl')) {
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) throw refuse(p, 'it is a symbolic link or another reparse point');
  if (isDir ? !st.isDirectory() : !st.isFile()) throw refuse(p, isDir ? 'it is not a directory' : 'it is not a regular file');
  const problem = acl.privateProblem(p, acl.fileAcl(p));
  if (problem != null) throw refuse(p, problem);
}

// (cold-start part 3: the folder's ACL and the file's in one PowerShell run,
// read at the moment of this read and kept for it alone, so nothing read
// earlier is used; win-acl prefetch never reads through a link, and a failed
// read gets today's single read and its error)
function readWindows(dir, name, max, acl) {
  const file = path.join(dir, name);
  // (a path the run couldn't answer: the caller's own single read)
  const reading = typeof acl.prefetch === 'function' ? Object.assign({}, acl, {fileAcl: acl.prefetch([dir, file], {single: acl.fileAcl})}) : acl;
  for (const [p, isDir] of [[dir, true], [file, false]]) checkPathWindows(p, isDir, reading);
  const data = fs.readFileSync(file);
  if (data.length > max) throw refuse(file, `it is larger than ${max} bytes`);
  return data;
}

// acl: {fileAcl, privateProblem, prefetch} on Windows, a test's (else win-acl's)
function readPrivateIn(dir, name, max, platform = process.platform, acl = null) {
  return platform === 'win32' ? readWindows(dir, name, max, acl || require('./win-acl')) : readPosix(dir, name, max);
}

module.exports = {readPrivateIn, checkDirPosix, checkPathWindows};
