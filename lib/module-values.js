'use strict';
// A module's settings at a terminal (#413 sections 4.2 and 4.3; L3):
//
//   ch-local settings modules [<m>]
//   ch-local settings set <m>.<setting> [<value>]   (no value: prompted)
//   ch-local settings reset <m>[.<setting>]
//
// <m> is a package name or the short name one installed module has;
// `module.` may be left out. The stored name is always
// module.<package>.<setting> (the last dot splits it: a setting name has
// none). The declaration is read from the module's active version in the
// module store, and a value is checked with the INSTALLED runtime's own
// reader (its lib/module-settings.js: parseDeclaration and checkValue), as
// lib/ceiling.js reads the ceiling with the runtime's, so the grammar has one
// source. A running start or daemon sees the file change and has its
// runtime read the values again (`reread`, section 7.3).
const fs = require('node:fs');
const path = require('node:path');
const {versionDir} = require('./store-paths');
const {readModulesRecord} = require('./module-record');
const settingsLib = require('./settings');

const short = (m) => String(m).replace(/^@[^/]+\//, '');
const refuse = (code, message) => Object.assign(new Error(message), {code});

// The installed runtime's reader, required again only when its file
// changes. -> its exports, or null (none installed, or one older than
// module settings).
let cached = null;
function runtimeReader(where) {
  const file = path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'module-settings.js');
  let stamp;
  try { const st = fs.statSync(file); stamp = `${st.ino}:${st.size}:${st.mtimeMs}`; } catch (err) { return null; }
  if (cached != null && cached.file === file && cached.stamp === stamp) return cached.reader;
  let reader = null;
  try {
    delete require.cache[require.resolve(file)];
    reader = require(file);
  } catch (err) { reader = null; }
  if (reader == null || typeof reader.parseDeclaration !== 'function' || typeof reader.checkValue !== 'function') reader = null;
  cached = {file, stamp, reader};
  return reader;
}
const NO_READER = 'the installed countinghouse cannot check a module\'s setting: run `ch-local upgrade` to install one that can; nothing was changed';

// An installed module by its package name or the short name one installed
// module has. -> package name; throws SETTING_UNKNOWN.
function moduleNamed(record, given) {
  const names = Object.keys((record && record.modules) || {});
  if (names.includes(given)) return given;
  const matches = names.filter((n) => short(n) === given);
  if (matches.length > 1) throw refuse('SETTING_AMBIGUOUS', `more than one installed module is named ${given}: ${matches.join(', ')}; give the full name`);
  if (matches.length === 1) return matches[0];
  throw refuse('SETTING_UNKNOWN', `no installed module is named ${given}; \`ch-local settings modules\` lists them`);
}

// "<m>.<setting>", "module.<package>.<setting>" or "<package>.<setting>":
// -> {module, setting, stored}. The last dot splits it.
function resolve(record, name) {
  const bare = String(name).replace(/^module\./, '');
  const dot = bare.lastIndexOf('.');
  if (dot <= 0 || dot === bare.length - 1) throw refuse('SETTING_UNKNOWN', `${name} is not <module>.<setting>; \`ch-local settings modules\` lists them`);
  const module = moduleNamed(record, bare.slice(0, dot));
  const setting = bare.slice(dot + 1);
  return {module, setting, stored: `module.${module}.${setting}`};
}

// The module's declared settings, from its active version's package.json in
// the store: -> {settings: map name -> declaration, net} (settings null
// when it declares none).
function declarationOf(where, record, module, reader) {
  const e = record.modules[module];
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(versionDir(where, module, e.version), 'package.json'), 'utf8')); } catch (err) {
    throw refuse('SETTING_UNKNOWN', `${short(module)}'s files are missing from the module store; run \`ch-local install\` again; nothing was changed`);
  }
  const parsed = reader.parseDeclaration(pkg);
  if (parsed.problems != null && parsed.problems.length > 0) {
    throw refuse('SETTING_UNKNOWN', `${short(module)}'s settings declaration cannot be read (${parsed.problems[0].message}); nothing was changed`);
  }
  const perms = pkg.countinghouse != null && pkg.countinghouse.permissions != null ? pkg.countinghouse.permissions : {};
  return {settings: parsed.settings, net: Array.isArray(perms.net) ? perms.net : null};
}

// A raw terminal value in the declared type's form.
function typed(decl, raw) {
  if (decl.type === 'boolean') return raw === 'true' || raw === 'on' ? true : raw === 'false' || raw === 'off' ? false : raw;
  if (decl.type === 'integer' || decl.type === 'number') return /^-?\d+(\.\d+)?$/.test(String(raw).trim()) ? Number(raw) : raw;
  return raw;
}
// what a declaration allows, said (never a value)
function allowedOf(decl) {
  if (decl.type === 'enum') return decl.values.join(' or ');
  if (decl.type === 'boolean') return 'true or false';
  if (decl.type === 'integer' || decl.type === 'number') return `${decl.type === 'integer' ? 'a whole number' : 'a number'}${decl.min != null ? ` from ${decl.min}` : ''}${decl.max != null ? ` to ${decl.max}` : ''}`;
  if (decl.format === 'repo') return 'owner/name';
  return decl.format != null ? `a ${decl.format}` : `text of at most ${decl.maxLength} characters`;
}
const shownValue = (v) => (v === true ? 'on' : v === false ? 'off' : v === undefined ? '(not set)' : String(v));

// The operator's rule for one setting (section 8 moduleSettings): {fixed} |
// {confirm} | {conversation: false} | null, read with the installed
// runtime's own moduleSettingRule (lib/ceiling.js). A ceiling that cannot
// be trusted fails closed, as ch-local's own settings do: its rules are not
// known, so no module setting is changed under it (the Reviewer's high
// review of #90, 2). Throws SETTING_CEILING_UNTRUSTED.
// (the ceiling read once: -> (module, setting) -> rule)
function rulesFor(where, io) {
  const ceiling = require('./ceiling');
  const c = ceiling.ceilingFor(where, {platform: io.platform || process.platform, env: io.env});
  if (c.state === 'untrusted') throw refuse('SETTING_CEILING_UNTRUSTED', `the operator's ceiling file ${c.file} cannot be trusted (${c.problem}), so no module setting is changed; nothing was changed`);
  return (module, setting) => ceiling.moduleSettingRule(where, c, module, setting);
}
const ceilingRule = (where, io, module, setting) => rulesFor(where, io)(module, setting);

// What a set would do, before the lock (to ask first): -> {stored, module,
// setting, decl, old, next, confirm}; throws SETTING_*.
function planModuleSetting(where, io, name, raw) {
  const reader = runtimeReader(where);
  if (reader == null) throw refuse('SETTING_NO_READER', NO_READER);
  const record = readModulesRecord(where);
  if (record == null) throw refuse('SETTING_UNKNOWN', 'nothing is installed; run `ch-local install --pack <name>` first; nothing was changed');
  const r = resolve(record, name);
  const {settings, net} = declarationOf(where, record, r.module, reader);
  const decl = settings != null ? settings[r.setting] : null;
  if (decl == null) {
    const names = settings != null ? Object.keys(settings) : [];
    throw refuse('SETTING_UNKNOWN', `${short(r.module)} declares no setting ${r.setting}${names.length > 0 ? `; it declares ${names.join(', ')}` : ''}; nothing was changed`);
  }
  const rule = ceilingRule(where, io, r.module, r.setting);
  if (rule != null && Object.prototype.hasOwnProperty.call(rule, 'fixed')) {
    throw refuse('SETTING_FORBIDDEN_BY_CEILING', `${r.setting} for ${short(r.module)} is fixed by this machine's operator ceiling; nothing was changed`);
  }
  const checked = reader.checkValue(decl, typed(decl, raw), {net});
  if (checked.ok !== true) throw refuse(checked.code || 'SETTING_OUT_OF_BOUNDS', `${checked.reason}; nothing was changed`);
  const read = settingsLib.readSettings(where);
  if (read.error != null) throw refuse('SETTINGS_UNREADABLE', `${read.error}; fix or remove it first; nothing was changed`);
  const has = Object.prototype.hasOwnProperty.call(read.kept, r.stored);
  return {...r, decl, old: has ? read.kept[r.stored] : decl.default, stored0: has ? read.kept[r.stored] : undefined,
    next: checked.value, confirm: decl.confirm === true || (rule != null && rule.confirm === true)};
}

// ch-local settings set <m>.<setting> [<value>] -> exit code
async function setModuleSetting(where, io, name, raw) {
  const fail = (code, message) => { io.stderr.write(`ch-local: ${message}\n`); return code; };
  const say = (s) => io.stdout.write(`${s}\n`);
  try {
    if (raw === undefined) {
      // no value: asked at a terminal (what is allowed shown first)
      const reader = runtimeReader(where);
      if (reader == null) return fail(2, NO_READER);
      const record = readModulesRecord(where);
      const r = resolve(record, name);
      const {settings} = declarationOf(where, record, r.module, reader);
      const decl = settings != null ? settings[r.setting] : null;
      if (decl == null) return fail(2, `${short(r.module)} declares no setting ${r.setting}; nothing was changed`);
      // the ceiling before anything is asked: a fixed or untrusted one
      // refuses at once (the medium on the high round, 7)
      const rule = ceilingRule(where, io, r.module, r.setting);
      if (rule != null && Object.prototype.hasOwnProperty.call(rule, 'fixed')) return fail(2, `${r.setting} for ${short(r.module)} is fixed by this machine's operator ceiling; nothing was changed`);
      if (io.interactive !== true || typeof io.ask !== 'function') return fail(2, `${r.setting} for ${short(r.module)} needs a value: give the value, or run it at a terminal to be asked; nothing was changed`);
      raw = String(await io.ask(`${r.setting} for ${short(r.module)} (${allowedOf(decl)}): `)).trim();
    }
    const plan = planModuleSetting(where, io, name, raw);
    if (plan.confirm) {
      if (io.interactive !== true || typeof io.ask !== 'function') return fail(2, `${plan.setting} for ${short(plan.module)} is confirmed at a terminal: run it in one; nothing was changed`);
      const answer = String(await io.ask(`Change ${plan.setting} for ${short(plan.module)} from ${JSON.stringify(plan.old) || 'unset'} to ${JSON.stringify(plan.next)}? [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') return fail(1, `${plan.setting} for ${short(plan.module)} was not changed`);
    }
    settingsLib.writeModuleValues(where, {[plan.stored]: plan.next}, {by: 'cli', expect: {[plan.stored]: plan.stored0}, inEffect: {[plan.stored]: plan.old}});
    say(`${short(plan.module)}.${plan.setting}: ${shownValue(plan.old)} -> ${shownValue(plan.next)}; a running client applies it now, and the next load otherwise`);
    return 0;
  } catch (err) {
    if (err.code === 'SETTINGS_BUSY' || err.code === 'SETTINGS_UNREADABLE' || err.code === 'SETTINGS_CHANGED') return fail(1, err.message);
    if (typeof err.code === 'string' && err.code.startsWith('SETTING')) return fail(2, err.message);
    throw err;
  }
}

// ch-local settings reset <m>[.<setting>] -> exit code: the stored values
// removed (each back to its default), recorded; other names kept.
function resetModuleSetting(where, io, target) {
  const fail = (code, message) => { io.stderr.write(`ch-local: ${message}\n`); return code; };
  try {
    const record = readModulesRecord(where);
    if (record == null) return fail(2, 'nothing is installed; nothing was changed');
    let module = null;
    let setting = null;
    try { module = moduleNamed(record, String(target).replace(/^module\./, '')); } catch (err) {
      // two installed modules share that short name: said as it is (the
      // Reviewer's high review of #90, 7), never taken for <m>.<setting>
      if (err.code === 'SETTING_AMBIGUOUS') return fail(2, `${err.message}; nothing was changed`);
      const r = resolve(record, target);
      module = r.module;
      setting = r.setting;
    }
    const read = settingsLib.readSettings(where);
    if (read.error != null) return fail(1, `${read.error}; fix or remove it first; nothing was changed`);
    const prefix = `module.${module}.`;
    const names = Object.keys(read.kept).filter((n) => (setting != null ? n === `${prefix}${setting}` : n.startsWith(prefix) && !n.slice(prefix.length).includes('.')));
    // a setting the operator's ceiling fixes is never changed, by a reset
    // either (the medium on L3, 8)
    const rules = rulesFor(where, io);
    const fixed = names.map((n) => n.slice(prefix.length)).filter((s) => { const rule = rules(module, s); return rule != null && Object.prototype.hasOwnProperty.call(rule, 'fixed'); });
    if (fixed.length > 0) return fail(2, `${fixed.join(', ')} for ${short(module)} ${fixed.length === 1 ? 'is' : 'are'} fixed by this machine's operator ceiling; nothing was changed`);
    const done = settingsLib.writeModuleValues(where, Object.fromEntries(names.map((n) => [n, settingsLib.REMOVE])), {by: 'cli', change: 'reset'});
    io.stdout.write(`${done.changed.length === 0 ? 'nothing to reset' : `${done.changed.length} setting${done.changed.length === 1 ? '' : 's'} of ${short(module)} back to the default`}; a running client applies it now\n`);
    return 0;
  } catch (err) {
    if (typeof err.code === 'string' && (err.code.startsWith('SETTING') || err.code.startsWith('SETTINGS'))) return fail(2, err.message);
    throw err;
  }
}

// ch-local settings modules [<m>] -> exit code: every installed module's
// declared settings (loaded or not), one line each; with <m>, its
// descriptions too.
function listModuleSettings(where, io, given = null) {
  const say = (s) => io.stdout.write(`${s}\n`);
  const reader = runtimeReader(where);
  if (reader == null) { io.stderr.write(`ch-local: ${NO_READER.replace(/; nothing was changed$/, '')}\n`); return 2; }
  const record = readModulesRecord(where);
  if (record == null) { say('nothing is installed'); return 0; }
  let only = null;
  try { only = given != null ? moduleNamed(record, given) : null; } catch (err) { io.stderr.write(`ch-local: ${err.message}\n`); return 2; }
  const read = settingsLib.readSettings(where);
  // a file that is not valid is said, never listed as defaults (as
  // `settings get` does: the Reviewer's high review of #90, 6)
  if (read.error != null) { io.stderr.write(`ch-local: ${read.error}; ch-local start refuses to start until it is fixed\n`); return 1; }
  const kept = read.kept || {};
  let any = false;
  for (const m of Object.keys(record.modules).sort()) {
    if (only != null && m !== only) continue;
    let decl;
    try { decl = declarationOf(where, record, m, reader).settings; } catch (err) { say(`${short(m)}: ${err.message.replace(/; nothing was changed$/, '')}`); continue; }
    if (decl == null) continue;
    for (const [name, d] of Object.entries(decl)) {
      any = true;
      const stored = kept[`module.${m}.${name}`];
      const value = stored !== undefined ? stored : d.default;
      const parts = [d.title, d.default !== undefined ? `default ${shownValue(d.default)}` : null, allowedOf(d), d.confirm === true ? 'asks before a change' : null].filter((x) => x != null);
      say(`${short(m)}.${name} = ${shownValue(value)}  (${parts.join('; ')})`);
      if (only != null && d.description != null) say(`    ${d.description}`);
    }
  }
  if (!any) say(only != null ? `${short(only)} declares no settings` : 'no installed module declares a setting');
  return 0;
}

// Whether a name is a module's setting (not one of ch-local's own, an
// enabled.* or a pack.*): what the settings command routes here.
const isModuleName = (name) => settingsLib.entryOf(name) == null && /\./.test(String(name)) && !/^(enabled|pack)\./.test(String(name));

module.exports = {setModuleSetting, resetModuleSetting, listModuleSettings, planModuleSetting, isModuleName, runtimeReader, resolve, resetForTests: () => { cached = null; }};
