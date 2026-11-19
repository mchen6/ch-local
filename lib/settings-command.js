'use strict';
// ch-local settings [get | set <name> <value> | reset] (packs in place, part
// 2, plan Task B4), and a module's settings (L3: `modules [<m>]`,
// `set <m>.<setting> [<value>]`, `reset <m>[.<setting>]`): for a user at a
// terminal, or an agent with a shell. set may loosen
// a guarding setting (the user's own terminal); a running start applies what
// it can at once and the rest at its next start. Every change is recorded in
// <home>/history.jsonl.
const {layout} = require('./home');
const {resetSettings, planReset, listSettings, readSettings, shown: shownOf} = require('./settings');
const {ceilingFor, ceilingRefusal} = require('./ceiling');
const {cliSet} = require('./cli-change');

const shown = (v) => shownOf(null, v);

async function settings({action, name, value}, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const where = layout(io.env, io.homedir);
  // a module's settings (#413 section 4.3; lib/module-values.js)
  const mv = require('./module-values');
  if (action === 'modules') return mv.listModuleSettings(where, io, name == null ? null : name);
  if (action === 'set' && mv.isModuleName(name)) return mv.setModuleSetting(where, io, name, value);
  if (action === 'reset' && name != null) return mv.resetModuleSetting(where, io, name);
  if (action === 'set' && value === undefined) { io.stderr.write(`ch-local: ${name} needs a value; nothing was changed\n`); return 2; }
  if (action === 'reset') {
    // a reset is the loosenings it implies (a pack turned off comes back on,
    // a tightened cap goes back up): each bound by the operator's ceiling,
    // then one question at a terminal listing them; one that only tightens
    // is made at once
    const plan = planReset(where);
    const ceiling = ceilingFor(where, {platform: io.platform, env: io.env});
    const refused = plan.loosens.map((l) => ceilingRefusal(ceiling, l.name, l.new)).filter((r) => r != null);
    if (refused.length > 0 || (plan.unknown && ceiling.state === 'untrusted')) {
      io.stderr.write(`ch-local: the reset is not made: ${refused.length > 0 ? refused.map((r) => r.message.replace(/; nothing was changed$/, '')).join('; ') : `the operator's ceiling file ${ceiling.file} cannot be trusted (${ceiling.problem})`}\n`);
      return 2;
    }
    const what = plan.unknown ? ['the settings file is not valid, so what it holds is not known'] : plan.loosens.map((l) => `${l.name} ${shownOf(l.name, l.old)} -> ${shownOf(l.name, l.new)}`);
    if (what.length > 0) {
      if (io.interactive !== true) { io.stderr.write('ch-local: a reset that loosens a guarding setting is confirmed at a terminal: run it in one; nothing was changed\n'); return 2; }
      const answer = String(await io.ask(`Reset every setting to its default? This loosens: ${what.join(', ')}. (A module's settings are kept.) [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') { io.stderr.write('ch-local: nothing was changed\n'); return 1; }
    }
    let done;
    try {
      done = resetSettings(where, {by: 'cli', expect: plan.expect, confirmed: what.length > 0 ? 'cli' : undefined});
    } catch (err) {
      if (typeof err.code === 'string' && err.code.startsWith('SETTING')) { io.stderr.write(`ch-local: ${err.message}\n`); return 1; }
      throw err;
    }
    // (a module's settings, and names a newer runtime wrote, are not ch-local's
    // to reset: kept, and said)
    const keptLine = done.kept > 0 ? `; ${done.kept} setting${done.kept === 1 ? '' : 's'} of modules or of a newer runtime kept as they were` : '';
    say(`every setting is back to its default${keptLine}; a running client applies it now where it can, and at its next start otherwise`);
    return 0;
  }
  if (action === 'get') {
    // a file that is not valid is said, never listed as defaults
    const read = readSettings(where);
    if (read.error != null) {
      io.stderr.write(`ch-local: ${read.error}; ch-local start refuses to start until it is fixed\n`);
      return 1;
    }
    if (read.warning != null) io.stderr.write(`ch-local: ${read.warning}\n`);
    for (const s of listSettings(where)) say(`${s.name} = ${shown(s.value)}  (default ${shown(s.default)}; ${s.bounds}${s.guarding ? '; guarding' : ''})`);
    return 0;
  }
  // a loosening: bound by the operator's ceiling, and asked at a terminal (lib/cli-change.js)
  const {code, result: r} = await cliSet(where, name, value, io);
  if (code === 0) say(`${r.name}: ${shownOf(r.name, r.old)} -> ${shownOf(r.name, r.new)}${r.loosened ? ' (this loosens a guarding setting)' : ''}; a running client applies it now where it can, and at its next start otherwise`);
  return code;
}

module.exports = {settings};
