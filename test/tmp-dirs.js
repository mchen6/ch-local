'use strict';
// Every temporary directory a test makes is removed when its test process
// ends. npm test (scripts/test.js) preloads this into each test process
// (node --require ./test/tmp-dirs.js --test), and the files CI runs on their
// own (acceptance, smoke) require it, so a new test gets it for free:
// fs.mkdtemp, fs.mkdtempSync and fs.promises.mkdtemp are wrapped, and each
// directory they make directly under the temporary directory with a name
// that begins `ch-` (every test's prefix) is registered, then removed when
// the process ends: at its exit, after its last test, or on SIGTERM or
// SIGINT (a file the runner kills on a timeout). A test that removes its own
// first loses nothing (force).
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
    const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    return cbMade.call(fs, ...args, (err, dir) => { if (err == null) keep(dir); if (cb != null) cb(err, dir); });
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
  // a signal: removed first, then the signal's own ending (no handler left
  // to swallow it)
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const onSignal = () => {
      removeMade();
      process.removeListener(sig, onSignal);
      process.kill(process.pid, sig);
    };
    process.on(sig, onSignal);
  }
  global[KEY] = {removeMade, made, PREFIX};
}

module.exports = global[KEY];
