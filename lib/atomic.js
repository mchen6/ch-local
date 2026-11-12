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
  fs.mkdirSync(path.dirname(target), {recursive: true});
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
  fs.mkdirSync(path.dirname(file), {recursive: true});
  try {
    fs.writeFileSync(file, data, {flag: 'wx'});
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

module.exports = {writeAtomic, createExclusive};
