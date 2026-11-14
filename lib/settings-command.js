'use strict';
// ch-local settings [get | set <name> <value>] (packs in place, part 2, plan
// Task B4): for a user at a terminal, or an agent with a shell. set may loosen
// a guarding setting (the user's own terminal); a running start applies what
// it can at once and the rest at its next start. Every change is recorded in
// <home>/history.jsonl.
const {layout} = require('./home');
const {readRecord} = require('./record');
const {setSetting, listSettings} = require('./settings');

const shown = (v) => (v === true ? 'on' : v === false ? 'off' : String(v));

async function settings({action, name, value}, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const where = layout(io.env, io.homedir);
  if (action === 'get') {
    let packs = [];
    try { const r = readRecord(where); packs = r == null ? [] : Object.keys(r.packs); } catch (err) { packs = []; }
    for (const s of listSettings(where, packs)) say(`${s.name} = ${shown(s.value)}  (default ${shown(s.default)}; ${s.bounds}${s.guarding ? '; guarding' : ''})`);
    return 0;
  }
  try {
    const r = setSetting(where, name, value, {by: 'cli', mayLoosen: true});
    say(`${r.name}: ${shown(r.old)} -> ${shown(r.new)}${r.loosened ? ' (this loosens a guarding setting)' : ''}; a running client applies it now where it can, and at its next start otherwise`);
    return 0;
  } catch (err) {
    if (typeof err.code === 'string' && err.code.startsWith('SETTING_')) { io.stderr.write(`ch-local: ${err.message}\n`); return 2; }
    if (err.code === 'SETTINGS_BUSY' || err.code === 'SETTINGS_UNREADABLE') { io.stderr.write(`ch-local: ${err.message}\n`); return 1; }
    throw err;
  }
}

module.exports = {settings};
