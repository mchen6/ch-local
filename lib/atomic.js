'use strict';
// Writes that never leave a half-written file: temp file and rename, atomic on
// Linux, macOS and Windows. createExclusive is the first-start create of a file
// that is never changed after (the HTTP mode's auth.json).
const fs = require('node:fs');
const path = require('node:path');

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, data);
    fs.renameSync(temp, file);
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
