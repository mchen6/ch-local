'use strict';
// ch-local uninstall [--keep-data] (spec §2, "Uninstall"): takes back the client
// entries it recorded, lists what is in its home and asks once before deleting,
// keeps the data with --keep-data, and ends by naming the credentials it was
// given, so they can be revoked.
const fs = require('node:fs');
const path = require('node:path');
const {layout} = require('./home');
const {readRecord, removeEntry} = require('./clients');
const {ALLOWLIST} = require('./allowlist');

// What --keep-data removes all the same: the program, and every secret.
const PROGRAM = (w) => [w.app, `${w.app}.new`, `${w.app}.old`, w.bin, w.node, w.identitySecret, w.auth, w.installed, w.clients, w.settings];

function credentialsOf(where) {
  try {
    const installed = JSON.parse(fs.readFileSync(where.installed, 'utf8'));
    if (Array.isArray(installed.credentials)) return installed.credentials;
  } catch { /* not installed, or unreadable: fall back to every pack's */ }
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
  const keep = new Set(PROGRAM(where));
  say(`in ${where.home}:`);
  for (const name of fs.readdirSync(where.home).sort()) {
    const full = path.join(where.home, name);
    const kept = keepData && !keep.has(full);
    say(`  ${name}${fs.statSync(full).isDirectory() ? '/' : ''}${kept ? '  (kept: --keep-data)' : ''}`);
  }
  if (keepData) say(`  (the identity secret ${where.identitySecret} is removed with the program)`);
  const answer = String(await io.ask(keepData ? 'Remove the client entries and the program, keeping the data? (yes/no) ' : `Remove the client entries and everything in ${where.home}? (yes/no) `)).trim().toLowerCase();
  if (answer !== 'yes') { say('nothing was removed'); return 1; }
  for (const e of record.entries) say(removeEntry(e));
  if (keepData) {
    for (const p of PROGRAM(where)) fs.rmSync(p, {recursive: true, force: true});
    say(`removed the program from ${where.home}; the data is kept`);
  } else {
    fs.rmSync(where.home, {recursive: true, force: true});
    say(`removed ${where.home}`);
  }
  if (credentials.length > 0) say(`Revoke the credentials you gave it: ${credentials.join(', ')}`);
  return 0;
}

module.exports = {uninstall};
