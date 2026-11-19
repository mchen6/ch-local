'use strict';
require('./tmp-dirs');
// Every test file loads test/tmp-dirs.js itself, near its top, so a file
// run on its own (node --test test/x.test.js, a memory-capped one-file run)
// removes the ch-* temporary directories it makes, as under npm test. Local
// one-file runs skipped scripts/test.js's preload and filled /tmp again
// (the Reviewer, 11-19).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// (its second line, right after 'use strict': before any other require, so
// nothing takes an unwrapped mkdtemp first: the medium, 1 and 2)
test('every test file requires ./tmp-dirs as its second line, before anything else', () => {
  const dir = __dirname;
  const missing = fs.readdirSync(dir).filter((n) => n.endsWith('.test.js'))
    .filter((n) => { const lines = fs.readFileSync(path.join(dir, n), 'utf8').split('\n'); return lines[0] !== "'use strict';" || lines[1] !== "require('./tmp-dirs');"; });
  assert.deepStrictEqual(missing, [], `'use strict' then require('./tmp-dirs') as the first two lines of: ${missing.join(', ')}`);
});
