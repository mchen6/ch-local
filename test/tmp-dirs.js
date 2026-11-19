'use strict';
// Every temporary directory a test makes is removed when its test process
// ends. Every test file requires it in its first lines (test/tmp-dirs-loaded
// checks that), so a file run on its own gets it too; npm test
// (scripts/test.js) also preloads it:
// fs.mkdtemp, fs.mkdtempSync and fs.promises.mkdtemp are wrapped, and each
// directory they make directly under the temporary directory with a name
// that begins `ch-` (every test's prefix) is registered, then removed at
// the process's exit, after its last test. A test that removes its own first
// loses nothing (force).
//
// No signal handler: a listener for SIGINT or SIGTERM changes how a process
// ends on one, and tests emit those signals themselves (acceptance's
// trapSignals test: process.emit('SIGINT')), which would remove a file's
// directories mid-run and, re-raised, end the process on Windows (ch-local
// #89's Windows legs). A file killed by a signal leaves its directories;
// scripts/test.js names them.
//
// Why at the process's end, not each test's: it covers the 40 mkdtemp
// sites and every per-file tmp() helper with no call site changed, and
// library code a test runs (a fetched release's directory) the same way.
//
// Why: tests made tens of thousands of ch-* directories on a shared /tmp
// and left them, until it ran out of inodes (the Reviewer, 11-19).
// scripts/test.js counts what a full run leaves.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREFIX = 'ch-';
const KEY = Symbol.for('ch-local.test.tmp-dirs');
if (global[KEY] == null) {
  const made = new Set();
  const ours = (dir) => {
    try {
      const d = path.resolve(String(dir));
      return path.dirname(d) === path.resolve(os.tmpdir()) && path.basename(d).startsWith(PREFIX);
    } catch (err) { return false; }
  };
  // (resolved now: a later chdir never sends the removal elsewhere)
  const keep = (dir) => { if (ours(dir)) made.add(path.resolve(String(dir))); return dir; };

  const syncMade = fs.mkdtempSync;
  fs.mkdtempSync = function(...args) { return keep(syncMade.apply(fs, args)); };
  const cbMade = fs.mkdtemp;
  fs.mkdtemp = function(...args) {
    // no callback: Node's own error, never one made up (the medium, 3)
    if (typeof args[args.length - 1] !== 'function') return cbMade.apply(fs, args);
    const cb = args.pop();
    return cbMade.call(fs, ...args, (err, dir) => { if (err == null) keep(dir); cb(err, dir); });
  };
  const promiseMade = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async function(...args) { return keep(await promiseMade.apply(fs.promises, args)); };

  // removes what this process made; a directory still in use (Windows, a
  // child still exiting) is tried for about 5 s, and one that cannot be
  // removed is left (scripts/test.js then names it)
  const removeMade = () => {
    for (const dir of made) {
      try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); } catch (err) { /* left: counted after the run */ }
    }
    made.clear();
  };
  process.on('exit', removeMade);
  global[KEY] = {removeMade, made, PREFIX};
}

module.exports = global[KEY];
