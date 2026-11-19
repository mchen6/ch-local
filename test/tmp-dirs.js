'use strict';
// Every temporary directory a test makes is removed when its test process
// ends. Preloaded into each test process (package.json's test script:
// node --require ./test/tmp-dirs.js --test), so a new test gets it for free:
// fs.mkdtemp, fs.mkdtempSync and fs.promises.mkdtemp are wrapped, and each
// directory they make directly under the temporary directory with a name
// that begins `ch-` (every test's prefix) is registered, then removed at
// the process's exit, after its last test. A test that removes its own
// first loses nothing (force).
//
// Why: tests made tens of thousands of ch-* directories on a shared /tmp
// and left them, until it ran out of inodes (the Reviewer, 11-19).
// scripts/test.js counts what a full run leaves.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const made = new Set();
const ours = (dir) => {
  try {
    const d = path.resolve(String(dir));
    return path.dirname(d) === path.resolve(os.tmpdir()) && path.basename(d).startsWith('ch-');
  } catch (err) { return false; }
};
const keep = (dir) => { if (ours(dir)) made.add(dir); return dir; };

const syncMade = fs.mkdtempSync;
fs.mkdtempSync = function(...args) { return keep(syncMade.apply(fs, args)); };
const cbMade = fs.mkdtemp;
fs.mkdtemp = function(...args) {
  const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
  return cbMade.call(fs, ...args, (err, dir) => { if (err == null) keep(dir); if (cb != null) cb(err, dir); });
};
const promiseMade = fs.promises.mkdtemp;
fs.promises.mkdtemp = async function(...args) { return keep(await promiseMade.apply(fs.promises, args)); };

// removes what this process made; a directory still in use (Windows) is
// tried a few times, and one that cannot be removed is left (scripts/test.js
// then names it)
function removeMade() {
  for (const dir of made) {
    try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}); } catch (err) { /* left: counted after the run */ }
  }
  made.clear();
}
process.on('exit', removeMade);

module.exports = {removeMade, made};
