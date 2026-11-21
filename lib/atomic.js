'use strict';
// Writes that never leave a half-written file: temp file and rename, atomic on
// Linux, macOS and Windows. A file that is a symlink is written through to its
// target, and an existing file keeps its permissions (a client config may be a
// link into a dotfiles repository, or mode 0600). createExclusive is the
// first-start create of a file never changed after (the HTTP mode's auth.json).
const fs = require('node:fs');
const path = require('node:path');

function writeAtomic(file, data) {
  let target = file;
  let mode;
  try {
    target = fs.realpathSync(file);
    mode = fs.statSync(target).mode & 0o7777;
  } catch { /* a new file */ }
  // (a directory it makes is the user's alone, whatever the umask: it may be
  // the home itself, if a command writes before install has run)
  fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, data, mode !== undefined ? {mode} : undefined);
    if (mode !== undefined) fs.chmodSync(temp, mode);
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, {force: true});
  }
}

// true when this call created the file; false when it already existed.
function createExclusive(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  try {
    fs.writeFileSync(file, data, {flag: 'wx'});
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

module.exports = {writeAtomic, createExclusive};
