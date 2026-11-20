'use strict';
// The modules this start holds back, and why, for the runtime's
// countinghouse_overview (countinghouse #490, --heldBackFile; A-firstrun d1).
// Written by start before the runtime starts, and by the applier (lib/in-place.js)
// whenever the set changes, then re-read by the runtime on
// {type: 'reread', what: 'held-back'}.
//
// The file, in start's private run directory, private itself (the runtime
// uses it only as a regular file under one name, this user's, 0600 or a
// private ACL; lib/private-write.js):
//   {"v": 1, "modules": [{"name", "reason", "root"?, "via"?}], "launcher"?}
// - name: a top-level module's package name;
// - reason: availability's kind: credential, off, ceiling, missing, pin,
//   withdrawn or calls;
// - root and via, on calls only, together: the kind at the bottom of the
//   chain (or not-installed) and the module there (or, not installed, the
//   name called);
// - launcher: the kernel's real path of <home>/bin/ch-local.js, so the
//   overview names a command that runs as printed; absent when there is none.
// Package names and reason classes only: never a credential, a variable, an
// address or whether a value is stored.
const fs = require('node:fs');
const path = require('node:path');
const {writePrivate} = require('./private-write');

const FILE = 'held-back.json';
const MAX = 256;
const REASONS = new Set(['credential', 'off', 'ceiling', 'missing', 'pin', 'withdrawn', 'calls']);
const ROOTS = new Set(['credential', 'off', 'ceiling', 'missing', 'pin', 'withdrawn', 'not-installed']);
// npm's name rule, as the runtime checks it: lower case, an optional scope,
// never starting with - or ~ (#490), at most 214 characters
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const named = (n) => typeof n === 'string' && n.length <= 214 && NAME.test(n);

// The file's text for availability's verdict (lib/availability.js
// unavailable: top-level modules only).
function contentOf(where, av) {
  const modules = [];
  for (const [name, u] of av.unavailable) {
    if (modules.length >= MAX) break;
    if (!named(name) || !REASONS.has(u.kind)) continue;
    const entry = {name, reason: u.kind};
    if (u.kind === 'calls') {
      const root = u.root === 'not installed' ? 'not-installed' : u.root;
      // (both or neither: a chain it can't name is said as calls alone)
      if (ROOTS.has(root) && named(u.via)) Object.assign(entry, {root, via: u.via});
    }
    modules.push(entry);
  }
  const doc = {v: 1, modules};
  try { doc.launcher = fs.realpathSync.native(where.launcher); } catch (e) { /* none installed: the overview's bare form */ }
  return `${JSON.stringify(doc)}\n`;
}

// Written whole into the run directory -> its path
function write(runDir, text) {
  writePrivate(runDir, FILE, text);
  return path.join(runDir, FILE);
}

module.exports = {contentOf, write, FILE};
