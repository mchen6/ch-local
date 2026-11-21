'use strict';
// A printed line with the home before each npx command left out, for a
// comparison of the rest (lib/command-line.js homePrefix). The tests' homes
// are never the default, so on POSIX every npx command must carry it: a line
// without it fails here, so the comparison still pins the home (the medium
// on the follow-up to #129, 5). Windows names no home yet (A-chlocal-func).
const assert = require('node:assert');

const PREFIX = /COUNTINGHOUSE_HOME="[^"]+" /g;
function unhomed(line) {
  const s = String(line);
  if (process.platform !== 'win32') assert.ok(!/(?<!COUNTINGHOUSE_HOME="[^"]+" )npx @countinghouse\/ch-local\b/.test(s), `an npx command without its home: ${s}`);
  return s.replace(PREFIX, '');
}

module.exports = {unhomed};
