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
const {readRecord: readPacks} = require('./record');

// The program and every secret: removed with or without --keep-data.
// run/ holds each start's own files; modules/ is the runtime's --modulePath.
const PROGRAM = ['app', 'app.new', 'app.old', 'bin', 'node', 'auth.json', 'installed.json', 'packs.json', 'installed-clients.json', 'settings.json', 'run', 'modules'];
// The data: the runtime's store (less its identity secret), module data, usage records, caches.
const DATA = ['store', 'module_data', 'usage', 'data'];

// Every installed pack's credential variables, once each; unreadable or
// absent, every pack this release knows.
function credentialsOf(where) {
  try {
    const record = readPacks(where);
    const named = record == null ? [] : [...new Set(Object.values(record.packs).flatMap((p) => (Array.isArray(p.credentials) ? p.credentials : [])))];
    if (named.length > 0) return named;
  } catch { /* unreadable: fall back to every pack's */ }
  return [...new Set(Object.values(ALLOWLIST.packs).flatMap((p) => p.credentials))];
}

async function uninstall({keepData = false}, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const where = layout(io.env, io.homedir);
  if (!fs.existsSync(where.home)) { say(`nothing to uninstall: ${where.home} does not exist`); return 0; }
  const record = readRecord(where);
  const credentials = credentialsOf(where);
  if (record.entries.length > 0) {
    say('client entries ch-local added:');
    for (const e of record.entries) say(`  ${e.client}: ${e.file}`);
  }
  say(`in ${where.home}:`);
  for (const name of fs.readdirSync(where.home).sort()) {
    const dir = fs.statSync(path.join(where.home, name)).isDirectory() ? '/' : '';
    const note = PROGRAM.includes(name) ? '' : DATA.includes(name) ? (keepData ? '  (kept: --keep-data)' : '') : "  (not ch-local's: left)";
    say(`  ${name}${dir}${note}`);
  }
  if (keepData) say(`  (the identity secret ${where.identitySecret} is removed with the program)`);
  const answer = String(await io.ask(keepData ? 'Remove the client entries and the program, keeping the data? (yes/no) ' : `Remove the client entries and ch-local's files in ${where.home}? (yes/no) `)).trim().toLowerCase();
  if (answer !== 'yes') { say('nothing was removed'); return 1; }
  for (const e of record.entries) say(removeEntry(e));
  for (const name of [...PROGRAM, ...(keepData ? [] : DATA)]) fs.rmSync(path.join(where.home, name), {recursive: true, force: true});
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
