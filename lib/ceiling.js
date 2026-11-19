'use strict';
// The operator's ceiling (countinghouse part 3, section 4): read with the
// installed runtime's own reader, lib/settings-ceiling.js (one source,
// decision b), and applied to every loosening ch-local makes: `settings set`,
// `upgrade --auto on`, and the values and flags `start` passes. An older
// runtime without the reader, with a ceiling file present, fails closed:
// every loosening is refused, and says why. No file: the hard bounds.
const fs = require('node:fs');
const path = require('node:path');
const {entryOf, valueOf, shown} = require('./settings');

// Windows' ProgramData, from the known folder (CommonApplicationData), read
// through lib/win-acl.js's PowerShell, never from the environment, which a
// client's config sets (docs/development/auto-upgrade.md; the review of #48).
// Once per process; null when it can't be read. The known folder is
// ProfileList's %SystemDrive%\ProgramData, expanded in PowerShell's own
// environment, and the shim's cleared one holds no SystemDrive (libuv
// completes a child's only from its parent's): the script sets it first,
// from the system's own Windows directory, as countinghouse's reader does.
const PROGRAMDATA_SCRIPT = "$env:SystemDrive = [IO.Path]::GetPathRoot([Environment]::GetFolderPath('Windows')).TrimEnd('\\'); " +
  "[Environment]::GetFolderPath('CommonApplicationData')";
let knownProgramData;
function programDataFolder() {
  if (knownProgramData !== undefined) return knownProgramData;
  try {
    const out = String(require('./win-acl').runPowershell(PROGRAMDATA_SCRIPT)).trim();
    knownProgramData = /^[A-Za-z]:\\[^\r\n]*$/.test(out) ? out : null;
  } catch (err) {
    knownProgramData = null;
  }
  return knownProgramData;
}

// Where a ceiling file may be when the runtime has no reader to ask. env is
// not read: on Windows the known folder, and C:\ProgramData as well.
// programData: a test's stand-in for the known-folder lookup.
// eslint-disable-next-line no-unused-vars
function fallbackFiles(platform, env, {programData = programDataFolder} = {}) {
  if (platform !== 'win32') return ['/etc/countinghouse/ceiling.json'];
  return [...new Set([programData(), 'C:\\ProgramData'].filter(Boolean))]
    .map((d) => path.win32.join(d, 'countinghouse', 'ceiling.json'));
}

// -> {state: 'none'} | {state: 'trusted', file, ceiling} | {state: 'untrusted', file, problem}
// file: where to look when the runtime has no reader (a test's).
//
// The reader is the one the runtime installed now (an upgrade replaces
// it): required again only when its file changes. Its answer is kept while
// the ceiling file and its directory are unchanged, and on Windows for at
// most 5 minutes (an ACL change moves no timestamp), so a running start does
// not run PowerShell on each change it applies.
let cached = null;   // {readerKey, ceilingKey, at, value}
const stampOf = (p) => { try { const st = fs.statSync(p); return `${st.ino}:${st.size}:${st.mtimeMs}:${st.mode}:${st.uid}`; } catch (err) { return err.code || 'error'; } };
function readCeiling(where, {platform = process.platform, env = process.env, file: given} = {}) {
  const readerFile = path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'settings-ceiling.js');
  const readerKey = `${readerFile}|${stampOf(readerFile)}`;
  let reader = null;
  try {
    if (cached == null || cached.readerKey !== readerKey) delete require.cache[require.resolve(readerFile)];
    reader = require(readerFile);
  } catch (err) { reader = null; }
  if (reader != null && typeof reader.readCeiling === 'function') {
    let ceilingKey = 'unknown';
    try {
      const f = reader.ceilingFile();
      ceilingKey = `${stampOf(f)}|${stampOf(path.dirname(f))}`;
    } catch (err) { ceilingKey = `error:${err.code || err.message}`; }
    const fresh = cached != null && cached.readerKey === readerKey && cached.ceilingKey === ceilingKey &&
      !(platform === 'win32' && Date.now() - cached.at > 5 * 60 * 1000);
    if (fresh) return cached.value;
    let c;
    try { c = reader.readCeiling(); } catch (err) { c = {state: 'untrusted', file: '(the ceiling)', problem: `it could not be read (${err.code || err.message})`}; }
    // anything but a ceiling's answer fails closed
    if (!(c != null && (c.state === 'none' || (c.state === 'untrusted' && typeof c.problem === 'string') ||
      (c.state === 'trusted' && c.ceiling != null && Array.isArray(c.ceiling.forbid))))) {
      c = {state: 'untrusted', file: '(the ceiling)', problem: 'the installed countinghouse gave an answer that is not a ceiling'};
    }
    cached = {readerKey, ceilingKey, at: Date.now(), value: c};
    return c;
  }
  // No reader (an older runtime): a ceiling file at any place it could be
  // fails closed. On Windows, where the known folder says, and C:\ProgramData.
  for (const file of (given != null ? [given] : fallbackFiles(platform, env))) {
    try {
      fs.lstatSync(file);
      return {state: 'untrusted', file, noReader: true, problem: 'the installed countinghouse cannot read it: it is older than this ch-local; `ch-local upgrade` installs one that can'};
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return {state: 'untrusted', file, problem: `it cannot be examined (${err.code || 'error'})`};
    }
  }
  return {state: 'none'};
}

// The ceiling as ch-local reads it (#413 section 8): the runtime's reader's
// answer, and a ceiling that still holds "packs" is not trusted: the list is
// by module now ("modules"), and an operator's old list must never quietly
// stop applying. Stricter than the runtime's reader until M6 brings it in
// line (the Reviewer's Q2 on L3).
function ceilingFor(where, opts = {}) {
  const c = readCeiling(where, opts);
  // (the runtime's reader answers packs: null for a file without it)
  if (c != null && c.state === 'trusted' && c.ceiling != null && Array.isArray(c.ceiling.packs)) {
    return {state: 'untrusted', file: c.file, problem: 'it holds "packs", which is no longer read: list each module under "modules"'};
  }
  return c;
}

// A module is the ceiling's allowlist's ("modules": [package names], when
// present: only those ever load, parts included), never forbid's. A ceiling
// that cannot be trusted allows NO module (the review of #18): a typo in it,
// a PowerShell that timed out or an older reader must not quietly lift the
// operator's list; it is said, naming the problem.
const short = (m) => String(m).replace(/^@[^/]+\//, '');
function moduleAllowed(ceiling, module) {
  if (ceiling == null || ceiling.state === 'none') return true;
  if (ceiling.state !== 'trusted') return false;
  return !(Array.isArray(ceiling.ceiling.modules) && !ceiling.ceiling.modules.includes(module));
}
const untrustedText = (ceiling) => `the operator's ceiling file ${ceiling.file} cannot be trusted (${ceiling.problem}), so no module loads`;
// Why these modules may not load, or null: the ones not on the list, named.
function modulesRefusal(ceiling, modules) {
  if (ceiling == null || ceiling.state === 'none') return null;
  if (ceiling.state !== 'trusted') return untrustedText(ceiling);
  const out = modules.filter((m) => !moduleAllowed(ceiling, m));
  return out.length === 0 ? null : `${out.length === 1 ? 'its module' : 'its modules'} ${out.map(short).join(', ')} ${out.length === 1 ? 'is' : 'are'} not on the operator's list`;
}
// A pack (the seams' unit until L2b): allowed while every module it records
// is (a part not listed keeps its callers out: section 8). record: the
// home's modules.json; without one, only the pack's scenario can be named.
const packModules = (record, pack) => {
  const p = record != null && record.packs != null ? record.packs[pack] : null;
  return p != null && p.modules != null ? Object.keys(p.modules) : [`@countinghouse/ch-pack-${pack}`];
};
function packAllowed(ceiling, pack, record = null) {
  return packModules(record, pack).every((m) => moduleAllowed(ceiling, m));
}
function packRefusal(ceiling, pack, record = null) {
  const why = modulesRefusal(ceiling, packModules(record, pack));
  return why == null ? null : (ceiling.state !== 'trusted' ? why : `${why}`);
}
const packName = (name) => { const m = /^pack\.(.+)$/.exec(name); return m == null ? null : m[1]; };
const enabledModule = (name) => { const m = /^enabled\.(.+)$/.exec(name); return m == null ? null : m[1]; };

// The loosening of name to next (in its stored form) against the ceiling:
// null, or {code, message}. Tightening is never refused by it.
function ceilingRefusal(ceiling, name, next, record = null) {
  if (ceiling == null || ceiling.state === 'none') return null;
  if (ceiling.state !== 'trusted') {
    return {code: 'SETTING_CEILING_UNTRUSTED', message: `the operator's ceiling file ${ceiling.file} cannot be trusted (${ceiling.problem}), so no setting is loosened; nothing was changed`};
  }
  const c = ceiling.ceiling;
  const pack = packName(name);
  const module = enabledModule(name);
  // a module turned on that is not on the list (section 8: naming
  // enabled.<module>); a pack by its modules (the old name, read until L2b)
  const forbidden = module != null ? (next === true && !moduleAllowed(ceiling, module))
    : pack != null ? (next === true && !packAllowed(ceiling, pack, record)) : c.forbid.includes(name);
  if (forbidden) {
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
// hard defaults. passedAudit: --moduleSandbox audit passed through.
// forcedAudit: the installed runtime cannot run enforce here (Windows before
// countinghouse#195, lib/sandbox-support.js), so start runs audit, which is
// no loosening a setting or flag made: the sandbox is left out.
function startUnderCeiling(settings, ceiling, {passedAudit = false, forcedAudit = false} = {}) {
  const values = Object.assign({}, settings.values);
  const notes = [];
  if (ceiling == null || ceiling.state === 'none') return {values, notes};
  if (forcedAudit) passedAudit = false;
  const loosened = ['maxOutputBytes', 'requestTimeout', 'autoUpgrade'].concat(forcedAudit ? [] : ['moduleSandbox'])
    .filter((name) => Object.prototype.hasOwnProperty.call(values, name) && !entryOf(name).tighter(entryOf(name).default, values[name]));
  if (ceiling.state !== 'trusted') {
    const what = loosened.concat(passedAudit ? ['--moduleSandbox audit'] : []);
    if (what.length > 0) {
      return {problem: `the operator's ceiling file ${ceiling.file} cannot be trusted (${ceiling.problem}), and this start would loosen ${what.join(', ')}: not starting; the operator fixes the file, or the settings are tightened back (\`ch-local settings get\`)`};
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
  if (!forcedAudit && c.forbid.includes('moduleSandbox') && values.moduleSandbox === 'audit') {
    notes.push('moduleSandbox audit is forbidden by the operator\'s ceiling: the runtime runs under enforce');
    values.moduleSandbox = 'enforce';
  }
  if (c.forbid.includes('autoUpgrade') && values.autoUpgrade === true) {
    notes.push('automatic upgrades are forbidden by the operator\'s ceiling: they stay off');
    values.autoUpgrade = false;
  }
  return {values, notes};
}

// An outside loosening the ceiling forbids outright (refused, not applied);
// one above a cap is clamped like any value, and an untrusted ceiling is
// start's and the applier's own refusal.
function forbiddenBy(ceiling) {
  return (name, value) => { const r = ceilingRefusal(ceiling, name, value); return r != null && r.code === 'SETTING_FORBIDDEN_BY_CEILING' ? r : null; };
}

// install and add-pack: null, or why the operator's ceiling refuses pack.
// With no runtime installed yet there is no reader to ask (a first install):
// the install goes on, and start, reading the ceiling with the runtime it
// installed, loads only what the ceiling allows (none if it cannot be
// trusted).
// packages: every module of the pack (the release's), each checked before
// anything is fetched; one missing refuses the pack whole and names them
// (section 8).
function notAllowed(where, pack, io, packages = [`@countinghouse/ch-pack-${pack}`]) {
  const c = ceilingFor(where, {platform: io.platform || process.platform, env: io.env});
  if (c.noReader === true && !fs.existsSync(path.join(where.app, 'node_modules', 'countinghouse'))) return null;
  const why = modulesRefusal(c, packages);
  return why == null ? null : `the pack "${pack}" is not allowed on this machine: ${why}; nothing was installed`;
}

module.exports = {programDataFolder, PROGRAMDATA_SCRIPT, ceilingFor, ceilingRefusal, startUnderCeiling, fallbackFiles, forbiddenBy, packAllowed, packRefusal, moduleAllowed, modulesRefusal, notAllowed, resetForTests: () => { cached = null; }};
