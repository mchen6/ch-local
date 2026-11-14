'use strict';
// The operator's ceiling (countinghouse part 3, section 4): read with the
// installed runtime's own reader, lib/settings-ceiling.js (one source,
// decision b), and applied to every loosening ch-local makes: `settings set`,
// `upgrade --auto on`, and the values and flags `start` passes. An older
// runtime without the reader, with a ceiling file present, fails closed:
// every loosening is refused, and says why. No file: the hard bounds.
const fs = require('node:fs');
const path = require('node:path');
const {entryOf, valueOf} = require('./settings');

const MiB = 1024 * 1024;

// -> {state: 'none'} | {state: 'trusted', file, ceiling} | {state: 'untrusted', file, problem}
// file: where to look when the runtime has no reader (a test's).
function ceilingFor(where, {platform = process.platform, env = process.env, file: given} = {}) {
  // the reader the runtime installed now (an upgrade replaces it), not one
  // this process required before
  const readerFile = path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'settings-ceiling.js');
  let reader = null;
  try { delete require.cache[require.resolve(readerFile)]; reader = require(readerFile); } catch (err) { reader = null; }
  if (reader != null && typeof reader.readCeiling === 'function') {
    let c;
    try { c = reader.readCeiling(); } catch (err) { return {state: 'untrusted', file: '(the ceiling)', problem: `it could not be read (${err.code || err.message})`}; }
    // anything but a ceiling's answer fails closed
    if (c != null && (c.state === 'none' || (c.state === 'untrusted' && typeof c.problem === 'string') ||
      (c.state === 'trusted' && c.ceiling != null && Array.isArray(c.ceiling.forbid)))) return c;
    return {state: 'untrusted', file: '(the ceiling)', problem: 'the installed countinghouse gave an answer that is not a ceiling'};
  }
  const file = given != null ? given : platform === 'win32'
    ? path.win32.join(env.ProgramData || 'C:\\ProgramData', 'countinghouse', 'ceiling.json')
    : '/etc/countinghouse/ceiling.json';
  try {
    fs.lstatSync(file);
    return {state: 'untrusted', file, problem: 'the installed countinghouse cannot read it: it is older than this ch-local; `ch-local upgrade` installs one that can'};
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return {state: 'none'};
    return {state: 'untrusted', file, problem: `it cannot be examined (${err.code || 'error'})`};
  }
}

const kindOf = (name) => (/^pack\./.test(name) ? 'packs' : name);
const shown = (name, v) => {
  if (name === 'maxOutputBytes') return v % MiB === 0 ? `${v / MiB}MiB` : `${v}B`;
  if (name === 'requestTimeout') return v % 1000 === 0 ? `${v / 1000}s` : `${v}ms`;
  return v === true ? 'on' : v === false ? 'off' : String(v);
};

// The loosening of name to next (in its stored form) against the ceiling:
// null, or {code, message}. Tightening is never refused by it.
function ceilingRefusal(ceiling, name, next) {
  if (ceiling == null || ceiling.state === 'none') return null;
  if (ceiling.state !== 'trusted') {
    return {code: 'SETTING_CEILING_UNTRUSTED', message: `the operator's ceiling file ${ceiling.file} cannot be trusted (${ceiling.problem}), so no setting is loosened; nothing was changed`};
  }
  const c = ceiling.ceiling;
  if (c.forbid.includes(kindOf(name))) {
    return {code: 'SETTING_FORBIDDEN_BY_CEILING', message: `${name} cannot be changed to ${shown(name, next)} on this machine: its operator's ceiling forbids it; nothing was changed`};
  }
  if (Number.isInteger(c[name]) && Number.isInteger(next) && next > c[name]) {
    return {code: 'SETTING_ABOVE_CEILING', message: `${name} ${shown(name, next)} is above the ceiling this machine's operator set (at most ${shown(name, c[name])}); nothing was changed`};
  }
  return null;
}

// What start passes, under the ceiling: {values, notes} with each setting's
// value clamped (said in notes), or {problem} to refuse the start. A
// trusted ceiling clamps a cap or timeout to its maximum, a forbidden sandbox
// loosening back to enforce and forbidden automatic upgrades to off; one that
// cannot be trusted refuses a start whose settings or flags loosen past the
// hard defaults. passedAudit: --moduleSandbox audit passed through. On
// Windows the sandbox is left out: start runs it under audit there until
// it installs a runtime with countinghouse#195 (ch-local #17), which is no
// loosening a setting or flag made.
function startUnderCeiling(settings, ceiling, {passedAudit = false, platform = process.platform} = {}) {
  const values = Object.assign({}, settings.values);
  const notes = [];
  if (ceiling == null || ceiling.state === 'none') return {values, notes};
  if (platform === 'win32') passedAudit = false;
  const loosened = ['maxOutputBytes', 'requestTimeout', 'autoUpgrade'].concat(platform === 'win32' ? [] : ['moduleSandbox'])
    .filter((name) => Object.prototype.hasOwnProperty.call(values, name) && !entryOf(name).tighter(entryOf(name).default, values[name]));
  if (ceiling.state !== 'trusted') {
    const what = loosened.concat(passedAudit ? ['--moduleSandbox audit'] : []);
    if (what.length > 0) {
      return {problem: `the operator's ceiling file ${ceiling.file} cannot be trusted (${ceiling.problem}), and this start would loosen ${what.join(', ')}: not starting; fix the file, or \`ch-local settings reset\``};
    }
    return {values, notes};
  }
  const c = ceiling.ceiling;
  if (passedAudit && c.forbid.includes('moduleSandbox')) {
    return {problem: '--moduleSandbox audit is forbidden by this machine\'s operator ceiling: not starting'};
  }
  for (const name of ['maxOutputBytes', 'requestTimeout']) {
    if (Number.isInteger(c[name]) && valueOf(settings, name) > c[name]) {
      notes.push(`${name} ${shown(name, valueOf(settings, name))} is above the operator's ceiling: the runtime gets ${shown(name, c[name])}`);
      values[name] = c[name];
    }
  }
  if (platform !== 'win32' && c.forbid.includes('moduleSandbox') && values.moduleSandbox === 'audit') {
    notes.push('moduleSandbox audit is forbidden by the operator\'s ceiling: the runtime runs under enforce');
    values.moduleSandbox = 'enforce';
  }
  if (c.forbid.includes('autoUpgrade') && values.autoUpgrade === true) {
    notes.push('automatic upgrades are forbidden by the operator\'s ceiling: they stay off');
    values.autoUpgrade = false;
  }
  return {values, notes};
}

module.exports = {ceilingFor, ceilingRefusal, startUnderCeiling};
