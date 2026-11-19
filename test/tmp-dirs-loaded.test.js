'use strict';
require('./tmp-dirs');   // its ch-* temporary directories removed at its end, under any runner
// Every test file loads test/tmp-dirs.js itself, near its top, so a file
// run on its own (node --test test/x.test.js, a memory-capped one-file run)
// removes the ch-* temporary directories it makes, as under npm test. Local
// one-file runs skipped scripts/test.js's preload and filled /tmp again
// (the Reviewer, 11-19).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('every test file requires ./tmp-dirs in its first lines', () => {
  const dir = __dirname;
  const missing = fs.readdirSync(dir).filter((n) => n.endsWith('.test.js'))
    .filter((n) => !fs.readFileSync(path.join(dir, n), 'utf8').split('\n').slice(0, 5).some((l) => /^require\('\.\/tmp-dirs'\);/.test(l)));
  assert.deepStrictEqual(missing, [], `require('./tmp-dirs') near the top of: ${missing.join(', ')}`);
});
