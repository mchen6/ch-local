'use strict';
// ch-local uninstall [--keep-data] (spec §2, "Uninstall"): takes back the client
// entries it recorded, lists what is in its home and asks once before deleting,
// keeps the data with --keep-data, and ends by naming the credentials it was
// given, so they can be revoked. It removes only the names it owns, so a home
// set to a shared directory by mistake keeps everything else.
const fs = require('node:fs');
const path = require('node:path');
const {layout} = require('./home');
const {readRecord, removeEntry} = require('./clients');
const {ALLOWLIST} = require('./allowlist');
const {readModulesRecord} = require('./module-record');
const {withLock} = require('./lock');

// The program and every secret: removed with or without --keep-data.
// run/ holds each start's own files; modules/ is the runtime's --modulePath;
// credentials/ the tokens stored with `ch-local credentials add`, never left
// behind.
const PROGRAM = ['app', 'app.new', 'app.old', 'bin', 'node', 'auth.json', 'installed.json', 'packs.json', 'modules.json', 'module-store', 'installed-clients.json', 'run', 'modules', 'packs.lock', 'packs.lock.break', 'previous', 'rollback.journal', 'packs', 'upgrade-check.json', 'upgrade-check.lock', 'shim.json', 'shim', 'credentials', 'credentials.lock', 'credentials.lock.break', 'dev-auth'];
// An interrupted rollback's aside directory (lib/rollback.js), which can hold a whole release.
const ASIDE = /^previous\.[0-9a-f]{8}$/;
const isProgram = (name) => PROGRAM.includes(name) || ASIDE.test(name);
// The data: the runtime's store (less its identity secret), module data, usage records, caches.
// settings.json with the history: a reinstall keeps the user's own
// tightenings (the review of #18)
// dev/: the user's own modules and the dev server's store (A-ownuse); its key
// is dev-auth/, a secret, in PROGRAM above
const DATA = ['store', 'module_data', 'usage', 'data', 'history.jsonl', 'settings.json', 'dev'];

// Every recorded pack's credential variables (installed or held), once
// each: what the running release's pins give the pack, and what its stored
// modules' remotes declare (the pins take theirs from the same manifests;
// L5 names the stored credentials by module). Unreadable or absent, every
// pack this release knows.
function credentialsOf(where, release) {
  // every variable the store holds a key under (a removed pack's kept key,
  // an earlier name), whether or not the record reads (the Reviewer's cut on
  // #98's round 3; the medium on it, 5)
  let stored = [];
  try {
    const read = require('./credential-store').readStore(where.home);
    stored = read.version === 2 ? [...read.modules.values()].flatMap((vars) => [...vars.keys()]) : [...read.values.keys()];
  } catch { /* no store, or one it cannot read: nothing more to name */ }
  try {
    const record = readModulesRecord(where);
    if (record != null) {
      const {declaredVariables} = require('./describe-module');
      const named = new Set();
      for (const [name, p] of [...Object.entries(record.packs), ...Object.entries(record.held || {})]) {
        for (const v of require('./packs').packVariables(release, name)) named.add(v);
        for (const [m, v] of Object.entries(p.modules)) {
          try {
            // (the store's own reader: the medium on #98's high round, 8)
            const manifest = require('./module-store').readStoredManifest(where, m, v);
            for (const x of declaredVariables(manifest != null && manifest.countinghouse != null ? manifest.countinghouse.remotes : [])) named.add(x);
          } catch { /* not in the store: nothing declared to name */ }
        }
      }
      for (const v of stored) named.add(v);
      if (named.size > 0) return [...named];
    }
  } catch { /* unreadable: fall back to every pack's */ }
  // (and the variables an earlier release stored GitHub's token under, which
  // a home may still hold: the medium on L5b, 7)
  return [...new Set([...Object.keys(ALLOWLIST.packs).flatMap((p) => require('./packs').packVariables(ALLOWLIST, p)), ...require('./module-credentials').V1_GITHUB, ...stored])].sort();
}

async function uninstall({keepData = false}, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const where = layout(io.env, io.homedir);
  if (!fs.existsSync(where.home)) { say(`nothing to uninstall: ${where.home} does not exist`); return 0; }
  // Not while an install, add-pack or remove-pack is changing the home; the
  // lock file itself goes with the program.
  return withLock(where, io, () => uninstallLocked({keepData}, io, where, say));
}

async function uninstallLocked({keepData}, io, where, say) {
  const record = readRecord(where);
  const credentials = credentialsOf(where, require('./packs').releaseOf(io));
  if (record.entries.length > 0) {
    say('client entries ch-local added:');
    for (const e of record.entries) say(`  ${e.client}: ${e.file}`);
  }
  say(`in ${where.home}:`);
  for (const name of fs.readdirSync(where.home).sort()) {
    const dir = fs.statSync(path.join(where.home, name)).isDirectory() ? '/' : '';
    const note = name === 'credentials' ? '  (the stored credentials: removed, with or without --keep-data)' : isProgram(name) ? '' : DATA.includes(name) ? (keepData ? '  (kept: --keep-data)' : '') : "  (not ch-local's: left)";
    say(`  ${name}${dir}${note}`);
  }
  if (keepData) say(`  (the identity secret ${where.identitySecret} is removed with the program)`);
  const answer = String(await io.ask(keepData ? 'Remove the client entries and the program, keeping the data? (yes/no) ' : `Remove the client entries and ch-local's files in ${where.home}? (yes/no) `)).trim().toLowerCase();
  if (answer !== 'yes') { say('nothing was removed'); return 1; }
  // First, under the stored credentials' lock (inside packs.lock: always
  // that order; post-rel cred-race), one short section: the store's
  // variables read again and named, then the store removed, then the record
  // (the keys first; one that can't be removed leaves the record, so the
  // uninstall can be run again: the reviewer's high on #102, 3).
  // So a `credentials add` beside it either lands first, and is removed and
  // named here, or comes after, finds nothing installed and stores nothing.
  // Short, so its heartbeat never goes stale (the medium on cred-race, 1);
  // the rest is removed after, no add able to store anything by then.
  let named = credentials;
  const store = require('./credential-store');
  let first;
  // a removal that failed in the section is said there, with the keys to
  // revoke (some may be gone already, and a second run can no longer read
  // them: the medium on round 1, 1 and 2), and is never an unhandled error
  let said = false;
  const failed = (what, target, e) => {
    said = true;
    io.stderr.write(`ch-local uninstall: ${what} could not be removed (${e.code || e.message}). Close what has ${target} open and run \`ch-local uninstall\` again${named.length > 0 ? `; meanwhile revoke the credentials you gave it: ${named.join(', ')}` : ''}\n`);
    return 1;
  };
  try {
    first = await store.withStoreLock(where.home, io, 'ch-local uninstall', async(held) => {
      named = [...new Set([...credentials, ...credentialsOf(where, require('./packs').releaseOf(io))])];
      store.checkHeld(held, where.home);
      const dir = path.join(where.home, 'credentials');
      // (a reader with the store open, on Windows: a short retry)
      try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 5}); } catch (e) { return failed('the stored credentials', dir, e); }
      try { fs.rmSync(where.modulesRecord, {force: true, maxRetries: 5}); } catch (e) { return failed('the record (the stored credentials are removed)', where.modulesRecord, e); }
      return 0;
    }, {missing: () => 0});
  } catch (e) {
    if (!(e instanceof store.StoreProblem)) throw e;
    io.stderr.write(`ch-local uninstall: ${e.message.replace(/[;.]? *[Nn]othing was (changed|stored)\.?$/, '')}; nothing was removed\n`);
    return 1;
  }
  if (said) return 1;
  if (first !== 0) { say('nothing was removed'); return 1; }
  for (const e of record.entries) say(removeEntry(e));
  const asides = fs.readdirSync(where.home).filter((name) => ASIDE.test(name));
  // (never the store's lock: one there now is a waiter's, which finds
  // nothing installed and removes its own)
  for (const name of [...PROGRAM, ...asides, ...(keepData ? [] : DATA)]) if (name !== store.LOCK) fs.rmSync(path.join(where.home, name), {recursive: true, force: true});
  fs.rmSync(where.identitySecret, {force: true});
  // a waiter's lock, or the temporary file it is made from, goes in a
  // moment (the medium on cred-race, 3)
  const waiter = (name) => name === store.LOCK || name.startsWith(`${store.LOCK}.`);
  for (const until = Date.now() + 2000; Date.now() < until && fs.readdirSync(where.home).some(waiter) && fs.readdirSync(where.home).every(waiter);) {
    await new Promise((r) => setTimeout(r, 50));
  }
  // (a waiter's lock made between the check and the removal leaves the
  // home: said, never an unhandled error after everything else is gone; the
  // reviewer's high on #102, 2)
  let emptied = false;
  let kept = null;
  if (fs.readdirSync(where.home).length === 0) {
    try { fs.rmdirSync(where.home); emptied = true; } catch (e) { kept = e.code || e.message; }
  }
  if (emptied) {
    say(`removed ${where.home}`);
  } else if (kept != null) {
    // (said as what it is: an empty home that could not be removed, the
    // medium on round 1, 7)
    say(`removed ch-local's files; ${where.home} itself could not be removed (${kept}) and is left`);
  } else {
    say(keepData ? `removed the program from ${where.home}; the data is kept` : `removed ch-local's files from ${where.home}; what is not ch-local's is left`);
  }
  if (named.length > 0) say(`Revoke the credentials you gave it: ${named.join(', ')}`);
  return 0;
}

module.exports = {uninstall};
