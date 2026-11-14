'use strict';
// A setting changed from the terminal (`ch-local settings set`, `upgrade
// --auto`; countinghouse part 3, section 3): a tightening is made at once; a
// loosening is bound by the operator's ceiling (lib/ceiling.js) and asked
// for at a terminal, with no --yes: that stops accidents, not an agent with
// a shell, whose consent is its client's own command-approval prompt (the
// line the spec draws). Not at a terminal, a loosening is refused. The
// answer is asked before the settings lock is taken; a value changed in
// between is not overwritten. -> {code: exit code, result}
const {planSetting, setSetting} = require('./settings');
const {ceilingFor, ceilingRefusal} = require('./ceiling');

const shown = (v) => (v === true ? 'on' : v === false ? 'off' : String(v));

async function cliSet(where, name, value, io, {by = 'cli'} = {}) {
  const fail = (code, message) => { io.stderr.write(`ch-local: ${message}\n`); return {code}; };
  let plan;
  try { plan = planSetting(where, name, value); } catch (err) {
    if (err.code === 'SETTINGS_UNREADABLE') return fail(1, err.message);
    if (typeof err.code === 'string' && err.code.startsWith('SETTING_')) return fail(2, err.message);
    throw err;
  }
  if (plan.loosened) {
    const refusal = ceilingRefusal(ceilingFor(where, {platform: io.platform, env: io.env}), name, plan.next);
    if (refusal != null) return fail(2, refusal.message);
    if (io.interactive !== true) return fail(2, `changing ${name} to ${shown(plan.next)} loosens a guarding setting, which is confirmed at a terminal: run it in one; nothing was changed`);
    const answer = String(await io.ask(`Loosen ${name} from ${shown(plan.old)} to ${shown(plan.next)}? This is kept until you change it back. [y/N] `)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') return fail(1, `${name} was not changed`);
  }
  try {
    const result = setSetting(where, name, value, {by, mayLoosen: true, expect: plan.old, confirmed: plan.loosened ? 'cli' : undefined});
    return {code: 0, result};
  } catch (err) {
    if (err.code === 'SETTINGS_BUSY' || err.code === 'SETTINGS_UNREADABLE' || err.code === 'SETTINGS_CHANGED') return fail(1, err.message);
    if (typeof err.code === 'string' && err.code.startsWith('SETTING_')) return fail(2, err.message);
    throw err;
  }
}

module.exports = {cliSet};
