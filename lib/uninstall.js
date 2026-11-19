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
const PROGRAM = ['app', 'app.new', 'app.old', 'bin', 'node', 'auth.json', 'installed.json', 'packs.json', 'modules.json', 'module-store', 'installed-clients.json', 'run', 'modules', 'packs.lock', 'packs.lock.break', 'previous', 'rollback.journal', 'packs', 'upgrade-check.json', 'upgrade-check.lock', 'shim.json', 'shim', 'credentials'];
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
      // and a variable the store still holds a key under (GitHub's earlier
      // name, not yet carried over: round 2, 6)
      try {
        const read = require('./credential-store').readStore(where.home);
        const held = read.version === 2 ? [...read.modules.values()].flatMap((vars) => [...vars.keys()]) : [...read.values.keys()];
        for (const v of held) if (require('./module-credentials').V1_GITHUB.includes(v)) named.add(v);
      } catch { /* no store, or one it cannot read: nothing more to name */ }
      if (named.size > 0) return [...named];
    }
  } catch { /* unreadable: fall back to every pack's */ }
  // (and the variables an earlier release stored GitHub's token under, which
  // a home may still hold: the medium on L5b, 7)
  return [...new Set([...Object.keys(ALLOWLIST.packs).flatMap((p) => require('./packs').packVariables(ALLOWLIST, p)), ...require('./module-credentials').V1_GITHUB])].sort();
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
  for (const e of record.entries) say(removeEntry(e));
  const asides = fs.readdirSync(where.home).filter((name) => ASIDE.test(name));
  for (const name of [...PROGRAM, ...asides, ...(keepData ? [] : DATA)]) fs.rmSync(path.join(where.home, name), {recursive: true, force: true});
  fs.rmSync(where.identitySecret, {force: true});
  if (fs.readdirSync(where.home).length === 0) {
    fs.rmdirSync(where.home);
    say(`removed ${where.home}`);
  } else {
    say(keepData ? `removed the program from ${where.home}; the data is kept` : `removed ch-local's files from ${where.home}; what is not ch-local's is left`);
  }
  if (credentials.length > 0) say(`Revoke the credentials you gave it: ${credentials.join(', ')}`);
  return 0;
}

module.exports = {uninstall};
