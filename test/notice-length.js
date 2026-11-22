'use strict';
// A notice's length as a user's home would make it (#147, M3): the launcher
// path a test's temp home puts in a command (on macOS and Windows runners,
// far longer than any user's) replaced by a fixed realistic one, 59
// characters in its `node "<path>" restart` form. Whether a command
// survives whole is asserted on the real text; only the length is measured
// here.
const path = require('node:path');

const REALISTIC = process.platform === 'win32'
  ? path.win32.join('C:\\Users\\alexandra', '.countinghouse', 'bin', 'ch-local.js')
  : path.posix.join('/home/alexandra', '.countinghouse', 'bin', 'ch-local.js');

// text -> its length in code points, every `node "<…ch-local.js>"` path in it
// taken as REALISTIC (one cut short by the runtime's own cut is left as is)
const atRealisticHome = (text) => [...String(text).replace(/node "[^"]*ch-local\.js"/g, `node "${REALISTIC}"`)].length;

module.exports = {atRealisticHome, REALISTIC};
