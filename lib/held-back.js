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
// - reason: availability's kind (credential, off, ceiling, missing, pin,
//   withdrawn or calls), or the applier's: stopped or restart;
// - root and via, on calls only, together: the kind at the bottom of the
//   chain (or not-installed) and the module there (or, not installed, the
//   name called);
// - launcher: the kernel's real path of <home>/bin/ch-local.js, so the
//   overview names a command that runs as printed; absent when there is none.
// Package names and reason classes only: a module that lacks its credential
// is said as that (reason credential), which is the point; never a
// credential's value, its variable, the address it goes to, or a client's
// environment.
const fs = require('node:fs');
const path = require('node:path');
const {writePrivate} = require('./private-write');

const FILE = 'held-back.json';
const MAX = 256;
// (stopped: the runtime stopped it, kept out until its version changes;
// restart: wanted and available, but not loaded in place -- a clash, a
// refused load, or another release's record or runtime -- so the client's
// restart loads it. Both are reasons, never roots: #490 round 2)
const REASONS = new Set(['credential', 'off', 'ceiling', 'missing', 'pin', 'withdrawn', 'calls', 'stopped', 'restart']);
const ROOTS = new Set(['credential', 'off', 'ceiling', 'missing', 'pin', 'withdrawn', 'not-installed']);
// npm's name rule, as the runtime checks it: lower case, an optional scope,
// never starting with - or ~ (#490), at most 214 characters
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const named = (n) => typeof n === 'string' && n.length <= 214 && NAME.test(n);
// a callee a module declares but nothing installed: #490's isCalleeName (a
// call address's module part: 1 to 64 characters, no / or ., no control
// character). Anything else would make the runtime refuse the whole file
// (the reviewer's high on #106, 3), so the entry is said as calls alone.
const isCalleeName = (n) => typeof n === 'string' && n.length >= 1 && n.length <= 64 && !/[/.\u0000-\u001f\u007f]/.test(n);
// the runtime reads at most this much (#490 MAX_FILE_BYTES)
const MAX_BYTES = 64 * 1024;

// The file's text for what is held back: a Map of top-level module ->
// {kind, root, via} (availability's unavailable, or the applier's own view of
// what ended up loaded). Entries stop before the text would pass MAX_BYTES
// (the reviewer's high on #106, 7).
function contentOf(where, held, platform = process.platform) {
  const modules = [];
  const doc = {v: 1, modules};
  const launcher = require('./home').safeLauncher(where, platform);
  if (launcher != null) doc.launcher = launcher;
  // (a running count: the empty document's bytes, then each entry's and its
  // comma; the medium on #106's round 1, 9)
  let size = Buffer.byteLength(`${JSON.stringify(doc)}\n`);
  for (const [name, u] of held) {
    if (modules.length >= MAX) break;
    if (!named(name) || !REASONS.has(u.kind)) continue;
    const entry = {name, reason: u.kind};
    if (u.kind === 'calls') {
      const root = u.root === 'not installed' ? 'not-installed' : u.root;
      const viaOk = root === 'not-installed' ? isCalleeName(u.via) : named(u.via);
      // (both or neither: a chain it can't name is said as calls alone)
      if (ROOTS.has(root) && viaOk) Object.assign(entry, {root, via: u.via});
    }
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + (modules.length > 0 ? 1 : 0);
    if (size + bytes > MAX_BYTES) break;
    size += bytes;
    modules.push(entry);
  }
  return `${JSON.stringify(doc)}\n`;
}

// Written whole into the run directory -> its path. The file is born
// private (writePrivate: 0600, or on Windows an owner-only protected DACL
// set as it is created). Start's run directory is made in <home>/run, which
// is private once the daemon has made it (its DACL then flows to each run
// directory); until then, as on a home without a daemon, it keeps the
// home's ACL, so on a home other accounts can write, one could swap the file
// between writes:
// the runtime then refuses it (not this user's own), and the overview only
// loses its reasons, never shows another's (A-heldback-win, the reviewer
// 11-20: not worth a PowerShell call on every Windows start).
function write(runDir, text, opts) {
  writePrivate(runDir, FILE, text, opts || undefined);
  return path.join(runDir, FILE);
}

module.exports = {contentOf, write, FILE};
