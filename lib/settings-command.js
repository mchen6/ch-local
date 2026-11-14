'use strict';
// ch-local settings [get | set <name> <value>] (packs in place, part 2, plan
// Task B4): for a user at a terminal, or an agent with a shell. set may loosen
// a guarding setting (the user's own terminal); a running start applies what
// it can at once and the rest at its next start. Every change is recorded in
// <home>/history.jsonl.
const {layout} = require('./home');
const {readRecord} = require('./record');
const {resetSettings, listSettings, readSettings} = require('./settings');
const {cliSet} = require('./cli-change');

const shown = (v) => (v === true ? 'on' : v === false ? 'off' : String(v));

async function settings({action, name, value}, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const where = layout(io.env, io.homedir);
  if (action === 'reset') {
    try {
      resetSettings(where, {by: 'cli'});
    } catch (err) {
      if (typeof err.code === 'string' && err.code.startsWith('SETTING')) { io.stderr.write(`ch-local: ${err.message}\n`); return 1; }
      throw err;
    }
    say('every setting is back to its default; a running client applies it now where it can, and at its next start otherwise');
    return 0;
  }
  if (action === 'get') {
    // a file that is not valid is said, never listed as defaults
    const read = readSettings(where);
    if (read.error != null) {
      io.stderr.write(`ch-local: ${read.error}; ch-local start refuses to start until it is fixed, or \`ch-local settings reset\`\n`);
      return 1;
    }
    if (read.warning != null) io.stderr.write(`ch-local: ${read.warning}\n`);
    let packs = [];
    try { const r = readRecord(where); packs = r == null ? [] : Object.keys(r.packs); } catch (err) { packs = []; }
    for (const s of listSettings(where, packs)) say(`${s.name} = ${shown(s.value)}  (default ${shown(s.default)}; ${s.bounds}${s.guarding ? '; guarding' : ''})`);
    return 0;
  }
  // a loosening: bound by the operator's ceiling, and asked at a terminal (lib/cli-change.js)
  const {code, result: r} = await cliSet(where, name, value, io);
  if (code === 0) say(`${r.name}: ${shown(r.old)} -> ${shown(r.new)}${r.loosened ? ' (this loosens a guarding setting)' : ''}; a running client applies it now where it can, and at its next start otherwise`);
  return code;
}

module.exports = {settings};
