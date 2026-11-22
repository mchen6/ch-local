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
const {withLock, withLockFile} = require('./lock');
const {chLocal} = require('./command-line');

// The program and every secret: removed with or without --keep-data.
// run/ holds each start's own files; modules/ is the runtime's --modulePath;
// credentials/ the tokens stored with `ch-local credentials add`, never left
// behind.
const PROGRAM = ['app', 'app.new', 'app.old', 'bin', 'node', 'auth.json', 'installed.json', 'packs.json', 'modules.json', 'module-store', 'installed-clients.json', 'run', 'modules', 'packs.lock', 'packs.lock.break', 'previous', 'rollback.journal', 'packs', 'upgrade-check.json', 'upgrade-available.json', 'upgrade-check.lock', 'shim.json', 'shim', 'credentials', 'credentials.lock', 'credentials.lock.break',
  // the user's own modules' copies and record (B-own-add; their folders
  // are the user's, elsewhere, and their data is DATA)
  'own', 'own.json'];
// An interrupted rollback's aside directory (lib/rollback.js), which can hold a whole release.
const ASIDE = /^previous\.[0-9a-f]{8}$/;
const isProgram = (name) => PROGRAM.includes(name) || ASIDE.test(name);
// The data: the runtime's store (less its identity secret), module data, usage records, caches.
// settings.json with the history: a reinstall keeps the user's own
// tightenings (the review of #18)
const DATA = ['store', 'module_data', 'usage', 'data', 'history.jsonl', 'settings.json'];

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
  // (A9: three phases, so a shared runtime is never removed from under:
  // the listing and the yes under packs.lock; then start.lock, where no
  // daemon is starting, restarting or in its backoff, and a serving one
  // refuses the removal; then, still under start.lock, packs.lock -- the
  // daemon's own order, so a runtime starting under start.lock never waits
  // on this -- and the removal)
  const asked = await withLock(where, io, () => uninstallAsk({keepData}, io, where, say));
  if (asked !== 0) return asked;
  // (packs.lock waited for here: a short holder between the phases, a start's
  // record read, never undoes the yes -- the medium on A9's round, 6)
  return underStartLock(where, io, () => withLock(where, io, () => uninstallLocked({keepData}, io, where, say), {wait: true}));
}

// start.lock (<home>/run/daemon/start.lock: the daemon's), waited for at most
// the daemon's longest hold (a restart's last backoff, its ready wait and an
// abandon's stop) and 20 s; under it a daemon that may be serving this home
// (lib/daemon.js daemonServing: its socket proves the secret, or its pid
// lives) refuses the removal, which it would outlive; a daemon.json whose pid
// is gone is stale. fn runs under it. -> fn's code, or 1 (said)
async function underStartLock(where, io, fn) {
  const d = require('./daemon');
  const runDir = path.join(where.home, 'run', 'daemon');
  const refuse = (why) => { io.stderr.write(`ch-local uninstall: ${why}; nothing was removed\n`); return 1; };
  // (the lock needs its directory: made, private, each on its own, never the
  // home -- one removed meanwhile is not made again; one that can't be made
  // refuses, never a check without the lock: the medium on A9's round, 3, 4)
  if (!fs.existsSync(where.home)) return refuse(`${where.home} is gone`);
  for (const dir of [path.join(where.home, 'run'), runDir]) {
    try { fs.mkdirSync(dir, {mode: 0o700}); } catch (err) { if (err.code !== 'EEXIST') return refuse(`its run directory ${dir} could not be made (${err.code || err.message})`); }
  }
  const bound = Number.isInteger(io.uninstallLockMs) ? io.uninstallLockMs : Math.max(...d.BACKOFF_MS) + d.READY_MS + d.STOP_MS + 20000;
  let ran = false;
  const code = await withLockFile(path.join(runDir, 'start.lock'), runDir, io, async() => {
    ran = true;
    let serving = true;
    // (a check that can't be made counts as serving: refused, nothing removed)
    try { serving = (await d.daemonServing(where.home, {platform: io.platform, probePipe: io.probePipe || null, ...(typeof io.alive === 'function' ? {alive: io.alive} : {})})).serving; } catch (err) { serving = true; }
    if (serving) {
      io.stderr.write(`ch-local uninstall: the shared runtime is still serving; nothing was removed. Close the clients that use countinghouse; it stops 10 minutes after the last one closes. Then run \`${chLocal(where, 'uninstall')}\` again.\n`);
      return 1;
    }
    return fn();
  }, {wait: true, what: 'to finish starting or restarting the shared runtime', signal: AbortSignal.timeout(bound),
    missing: () => refuse(`its run directory ${runDir} is gone`)});
  if (!ran) {
    io.stderr.write(`ch-local uninstall: the shared runtime has been starting or restarting for ${bound / 1000} s; nothing was removed. Run \`${chLocal(where, 'uninstall')}\` again in a minute.\n`);
    return 1;
  }
  return code;
}

async function uninstallAsk({keepData}, io, where, say) {
  const record = readRecord(where);
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
  return 0;
}

// after the yes, under start.lock and packs.lock: the home read again (an
// install may have run between the two), then removed
async function uninstallLocked({keepData}, io, where, say) {
  const record = readRecord(where);
  const credentials = credentialsOf(where, require('./packs').releaseOf(io));
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
    io.stderr.write(`ch-local uninstall: ${what} could not be removed (${e.code || e.message}). Close what has ${target} open and run \`${chLocal(where, 'uninstall')}\` again${named.length > 0 ? `; meanwhile revoke the credentials you gave it: ${named.join(', ')}` : ''}\n`);
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
  // (the own modules' copies are read-only: writable again before they go)
  try { require('./own-tree').unlockTree(path.join(where.home, 'own')); } catch (e) { /* the removal says it */ }
  const asides = fs.readdirSync(where.home).filter((name) => ASIDE.test(name));
  // (never the store's lock: one there now is a waiter's, which finds
  // nothing installed and removes its own)
  // (a removal that fails -- a file a process still holds open, on
  // Windows -- is said with the way on, never thrown: the medium on A9, 2)
  // (run last: it holds start.lock, which keeps a daemon from starting
  // until everything else is gone -- the medium on A9's round, 2)
  const order = [...PROGRAM.filter((n) => n !== 'run'), ...asides, ...(keepData ? [] : DATA), 'run'];
  for (const name of order) {
    if (name === store.LOCK) continue;
    try { fs.rmSync(path.join(where.home, name), {recursive: true, force: true, maxRetries: 5}); } catch (e) { return failed(name, path.join(where.home, name), e); }
  }
  try { fs.rmSync(where.identitySecret, {force: true}); } catch (e) { return failed('the identity secret', where.identitySecret, e); }
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
  // (the plugin is Claude Code's own install: the feature audit, F14)
  say('If you added the Claude Code plugin, remove it in Claude Code too: `claude plugin uninstall ch-packs@ch-packs`');
  return 0;
}

module.exports = {uninstall};
