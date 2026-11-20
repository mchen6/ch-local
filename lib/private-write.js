'use strict';
// A small file only this user may read, written whole (the daemon's
// daemon.json and failed.json; start's held-back file, A-firstrun d1).
const fs = require('node:fs');
const path = require('node:path');

// dir/name, written whole: through a temporary file created exclusively, 0600
// (on Windows with an owner-only DACL, in the call that creates it), then
// renamed in place
function writePrivate(dir, name, text) {
  const file = path.join(dir, name);
  const temp = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`);
  let placed = false;
  try {
    if (process.platform === 'win32') require('./win-acl').createPrivate(temp, text);
    else {
      const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      try {
        fs.fchmodSync(fd, 0o600);
        fs.writeSync(fd, text);
      } finally {
        fs.closeSync(fd);
      }
    }
    fs.renameSync(temp, file);
    placed = true;
  } finally {
    if (!placed) { try { fs.unlinkSync(temp); } catch (e) { /* gone */ } }
  }
}

module.exports = {writePrivate};
