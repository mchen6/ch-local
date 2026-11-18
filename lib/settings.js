'use strict';
// The launcher's settings (packs in place, part 2, plan Task B4; countinghouse
// #168's spec, section 3): <home>/settings.json, {version: 1, values}, read by
// start at spawn and watched while it runs. The same allowlist and bounds as
// countinghouse's countinghouse_settings, which may only tighten a guarding
// setting; `ch-local settings set` is the user at a terminal and may loosen
// one too (whether a change loosens: loosens(), one function, which part 3
// wraps with its confirmation). Every change is appended to
// <home>/history.jsonl, by: 'cli'.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {writeAtomic} = require('./atomic');
const {appendHistory} = require('./history');

const MiB = 1024 * 1024;
const size = (v) => {
  const m = /^(\d+)\s*(MiB|M|KiB|K|B)?$/i.exec(String(v).trim());
  if (m == null) return NaN;
  const unit = (m[2] || 'B').toLowerCase();
  return Number(m[1]) * (unit.startsWith('m') ? MiB : unit.startsWith('k') ? 1024 : 1);
};
const ms = (v) => {
  const m = /^(\d+)\s*(ms|s)?$/i.exec(String(v).trim());
  if (m == null) return NaN;
  return Number(m[1]) * ((m[2] || 'ms').toLowerCase() === 's' ? 1000 : 1);
};
const onOff = (v) => (v === true || v === 'on' ? true : v === false || v === 'off' ? false : null);

// The sandbox setting: enforce and audit on every platform, enforce the
// default, as countinghouse's lib/settings-tool.js has it since #195 (enforce
// on Windows). With an older runtime on Windows, which cannot run enforce,
// start runs audit whatever is stored, and says so (lib/sandbox-support.js).
// (platform: kept for callers; the entry is the same everywhere.)
const sandboxEntry = () => ({parse: String, values: ['enforce', 'audit'], default: 'enforce', guarding: true, tighter: (o, n) => n === 'enforce' || o === n});

// name -> {parse, check(value) -> bounds text or null, default, guarding,
// tighter(old, new) -> true when the change tightens or keeps}
const ALLOWLIST = {
  locale: {parse: String, values: ['en', 'zh'], default: 'en', guarding: false},
  // 16 MiB: the runtime's own default (countinghouse lib/cli-options.js and
  // its settings tool's allowlist; maintainer's decision, 2026-11-15). The
  // two are kept in step: with no value in the file the runtime starts on its
  // default, and this is what
  // `settings get`, a loosening and the start's ceiling check go by.
  maxOutputBytes: {parse: size, min: MiB, max: 256 * MiB, default: 16 * MiB, guarding: true, tighter: (o, n) => n <= o},
  requestTimeout: {parse: ms, min: 5000, max: 120000, default: 30000, guarding: true, tighter: (o, n) => n <= o},
  moduleSandbox: sandboxEntry(process.platform),
  autoUpgrade: {parse: onOff, values: [true, false], default: false, guarding: true, tighter: (o, n) => n === false || o === n},
  upgradeCheck: {parse: String, values: ['daily', 'weekly', 'never'], default: 'daily', guarding: false}
};
const PACK = /^pack\.([a-z0-9][a-z0-9-]{0,63})$/;
const packEntry = {parse: onOff, values: [true, false], default: true, guarding: true, tighter: (o, n) => n === false || o === n};
const entryOf = (name) => (Object.prototype.hasOwnProperty.call(ALLOWLIST, name) ? ALLOWLIST[name] : PACK.test(name) ? packEntry : null);
const boundsOf = (e) => (e.values != null ? e.values.map((v) => (v === true ? 'on' : v === false ? 'off' : v)).join(', ') : `${e.min} to ${e.max}`);

// A value as stored is valid for its setting (the stored form: numbers,
// booleans, the listed strings).
function validStored(name, v) {
  const e = entryOf(name);
  if (e == null) return false;
  if (e.values != null) return (e.stored || e.values).includes(v);
  return Number.isInteger(v) && v >= e.min && v <= e.max;
}

// -> {values, kept, order} as written, an earlier {autoUpgrade} migrated; or,
// when the file cannot be read or holds anything not valid, {values: {},
// kept, order, error} (and `unreadable` when it is there but could not be
// read): a caller fails closed (the defaults at start, the last good
// settings while running) and says so, never applies part of it (the review
// of ch-local #13).
// kept: every name this ch-local does not know, with its value as stored
// (the runtime's settings tool writes module.* values here; a newer runtime
// its own names). Never applied, and written back as it is by every write
// (module-level configuration design, 2026-11-18, section 4.2). {} for a
// file that is not a readable version 1 settings file.
function readSettings(where) {
  const none = {values: {}, kept: {}, order: []};
  let text;
  // (a file there that could not be read is `unreadable`: what it holds is
  // not known, and a reset never removes it)
  try { text = fs.readFileSync(where.settings, 'utf8'); } catch (err) { return {...none, ...(err.code === 'ENOENT' ? {} : {error: `${where.settings} cannot be read (${err.code})`, unreadable: true})}; }
  let raw = null;
  try { raw = JSON.parse(text); } catch (err) { return {...none, error: `${where.settings} is not JSON`}; }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {...none, error: `${where.settings} is not a settings file`};
  let values;
  if (raw.version === 1 && raw.values != null && typeof raw.values === 'object' && !Array.isArray(raw.values)) values = raw.values;
  else if (raw.version == null && Object.keys(raw).every((k) => k === 'autoUpgrade')) values = typeof raw.autoUpgrade === 'boolean' ? {autoUpgrade: raw.autoUpgrade} : {};
  else return {...none, error: `${where.settings} is not a version 1 settings file`};
  // A name this ch-local does not know (a module's setting, which the
  // runtime's settings tool writes; a newer runtime's) is kept as stored and
  // never applied; a known one with a value not allowed makes the whole file
  // bad. order: the file's own order of names, which a write keeps.
  const entries = Object.entries(values);
  const known = Object.fromEntries(entries.filter(([name]) => entryOf(name) != null));
  const kept = Object.fromEntries(entries.filter(([name]) => entryOf(name) == null));
  const order = entries.map(([name]) => name);
  const bad = Object.entries(known).find(([name, v]) => !validStored(name, v));
  if (bad != null) return {values: {}, kept, order, error: `${where.settings} has ${bad[0]} = ${JSON.stringify(bad[1]).slice(0, 40)}, which is not allowed`};
  // module.<package>.<setting> is the runtime's, expected here: not warned
  // about (the warning is for a name nobody here expects)
  const unknown = Object.keys(kept).filter((name) => !name.startsWith('module.'));
  return {values: known, kept, order, ...(unknown.length > 0 ? {warning: `${where.settings} has settings this ch-local does not know, ignored: ${unknown.slice(0, 5).join(', ')}`} : {})};
}
// The values to write: the file's names in its own order (known ones from
// `values`, the rest from `kept`), each in `changes` replaced, and a changed
// name new to the file last.
function inFileOrder(settings, changes = {}) {
  const has = (o, n) => o != null && Object.prototype.hasOwnProperty.call(o, n);
  const out = [];
  for (const name of settings.order || []) {
    if (has(changes, name)) out.push([name, changes[name]]);
    else if (has(settings.values, name)) out.push([name, settings.values[name]]);
    else if (has(settings.kept, name)) out.push([name, settings.kept[name]]);
  }
  for (const [name, v] of Object.entries(changes)) if (!(settings.order || []).includes(name)) out.push([name, v]);
  return Object.fromEntries(out);
}
const valueOf = (settings, name) => {
  const e = entryOf(name);
  return Object.prototype.hasOwnProperty.call(settings.values, name) ? settings.values[name] : (e != null ? e.default : undefined);
};

// Whether setting `name` from `old` to `next` loosens a guard (part 3 wraps
// this with its confirmation; this tool's own callers decide what to do).
function loosens(name, old, next) {
  const e = entryOf(name);
  return e != null && e.guarding === true && !e.tighter(old, next);
}

// name and raw value -> the value in its stored form, or throws
// SETTING_UNKNOWN or SETTING_OUT_OF_BOUNDS.
function parseSetting(name, raw) {
  const e = entryOf(name);
  if (e == null) throw Object.assign(new Error(`there is no setting named ${name}; \`ch-local settings get\` lists them`), {code: 'SETTING_UNKNOWN'});
  const next = e.parse(raw);
  const ok = e.values != null ? e.values.includes(next) : (Number.isInteger(next) && next >= e.min && next <= e.max);
  if (!ok) throw Object.assign(new Error(`the value ${raw} for ${name} is outside the allowed range (${boundsOf(e)}); nothing was changed`), {code: 'SETTING_OUT_OF_BOUNDS'});
  return next;
}

// What a set would do, without the lock (to ask the user before taking it):
// -> {next, old, loosened}, or throws as setSetting does.
function planSetting(where, name, raw) {
  const next = parseSetting(name, raw);
  const settings = readSettings(where);
  if (settings.error != null) throw Object.assign(new Error(`${settings.error}; fix or remove it first; nothing was changed`), {code: 'SETTINGS_UNREADABLE'});
  const old = valueOf(settings, name);
  return {next, old, loosened: loosens(name, old, next)};
}

// A setting's value as ch-local shows it: on/off, a size in MiB and a
// timeout in s when they are whole, as countinghouse's messages give them.
function shown(name, v) {
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (name === 'maxOutputBytes' && Number.isInteger(v)) return v % MiB === 0 ? `${v / MiB}MiB` : `${v}B`;
  if (name === 'requestTimeout' && Number.isInteger(v)) return v % 1000 === 0 ? `${v / 1000}s` : `${v}ms`;
  return String(v);
}

// What a reset would loosen: [{name, old, new}] each setting whose default is
// looser than its value; {unknown: true} when the file is not valid (its
// values cannot be known). expect: what resetSettings compares with.
function planReset(where) {
  const read = readSettings(where);
  if (read.error != null) return {unknown: true, loosens: [], expect: {error: read.error}};
  const out = [];
  for (const name of Object.keys(read.values)) {
    if (entryOf(name) == null) continue;
    const old = valueOf(read, name);
    const next = valueOf({values: {}}, name);
    if (loosens(name, old, next)) out.push({name, old, new: next});
  }
  return {unknown: false, loosens: out, expect: read.values};
}

// -> {name, old, new, loosened} or throws {code, message, fields}.
// expect: the old value the caller planned with (planSetting): a value
// changed since is not overwritten (SETTINGS_CHANGED). confirmed: how a
// loosening was confirmed ('cli'), recorded with it (part 3, section 5).
function setSetting(where, name, raw, {by = 'cli', mayLoosen = false, expect, confirmed} = {}) {
  const next = parseSetting(name, raw);
  return withSettingsLock(where, () => {
    const settings = readSettings(where);
    if (settings.error != null) throw Object.assign(new Error(`${settings.error}; fix or remove it first; nothing was changed`), {code: 'SETTINGS_UNREADABLE'});
    const old = valueOf(settings, name);
    if (expect !== undefined && old !== expect) throw Object.assign(new Error(`${name} was changed by another writer meanwhile; nothing was changed; run it again`), {code: 'SETTINGS_CHANGED'});
    const loosened = loosens(name, old, next);
    if (loosened && !mayLoosen) throw Object.assign(new Error(`changing ${name} to ${raw} would loosen a guarding setting; nothing was changed`), {code: 'SETTING_LOOSENS_A_GUARD'});
    // recorded first: a change the history cannot hold is not made
    if (!appendHistory(where, {by, setting: name, old, new: next, ...(loosened ? {loosened: true} : {}), ...(loosened && confirmed ? {confirmed} : {})}, {strict: true})) {
      throw Object.assign(new Error(`the change could not be recorded in ${where.home}/history.jsonl; nothing was changed`), {code: 'SETTING_NOT_RECORDED'});
    }
    try {
      // (the names it does not know kept as stored, the file's order kept:
      // section 4.2)
      writeAtomic(where.settings, JSON.stringify({version: 1, values: inFileOrder(settings, {[name]: next})}, null, 2) + '\n');
    } catch (err) {
      // said in the history too, so it never shows a change not made (and
      // start's outside-edit check does not report one)
      appendHistory(where, {by, setting: name, change: 'not made', problem: err.code || 'error'});
      throw err;
    }
    return {name, old, new: next, loosened};
  });
}

// `ch-local settings reset`: every setting this ch-local knows back to its
// default, recorded first, under the settings lock. The names it does not
// know are kept (a module's values, section 4.2): the file is rewritten
// holding only them, or removed when there are none. A file that is not a
// readable version 1 settings file holds no names to keep, and is removed
// whole, as a bad one always was.
// expect: the values the caller planned with (planReset): changed since, it
// is not made (SETTINGS_CHANGED). confirmed: how its loosenings were.
// -> {kept: how many names it kept}
function resetSettings(where, {by = 'cli', expect, confirmed} = {}) {
  return withSettingsLock(where, () => {
    // one read, under the lock: what is kept is what was compared
    const now = readSettings(where);
    // a file there that could not be read may hold a module's values: never
    // removed blind (a reader holding it on Windows, say)
    if (now.unreadable === true) throw Object.assign(new Error(`${now.error}; nothing was changed; run it again`), {code: 'SETTINGS_UNREADABLE'});
    if (expect !== undefined) {
      if (JSON.stringify(now.error != null ? {error: now.error} : now.values) !== JSON.stringify(expect)) {
        throw Object.assign(new Error('the settings were changed by another writer meanwhile; nothing was changed; run it again'), {code: 'SETTINGS_CHANGED'});
      }
    }
    if (!appendHistory(where, {by, setting: '*', change: 'reset', ...(confirmed ? {confirmed} : {})}, {strict: true})) {
      throw Object.assign(new Error(`the reset could not be recorded in ${where.home}/history.jsonl; nothing was changed`), {code: 'SETTING_NOT_RECORDED'});
    }
    const kept = Object.fromEntries(now.order.filter((name) => Object.prototype.hasOwnProperty.call(now.kept, name)).map((name) => [name, now.kept[name]]));
    try {
      if (Object.keys(kept).length > 0) writeAtomic(where.settings, JSON.stringify({version: 1, values: kept}, null, 2) + '\n');
      else fs.rmSync(where.settings, {force: true});
    } catch (err) {
      // said in the history too, so it never shows a reset not made (start's
      // outside-edit check reads the history: lib/outside-edits.js)
      appendHistory(where, {by, setting: '*', change: 'not made', problem: err.code || 'error'});
      throw err;
    }
    return {kept: Object.keys(kept).length};
  });
}

// One lock around every settings write, shared by the CLI and countinghouse's
// settings tool: the protocol is docs/development/settings.md's, which
// countinghouse follows too. <home>/settings.lock is created whole (written
// to a temporary file and linked into place), held only for the read, the
// history line and the write, and released by its holder. One whose mtime is
// SETTINGS_LOCK_STALE_MS old is a holder that died, and is removed only if it
// is still that file (same inode). Waits up to SETTINGS_LOCK_WAIT_MS.
const SETTINGS_LOCK_STALE_MS = 30000;
const SETTINGS_LOCK_WAIT_MS = 5000;
// waitMs: how long to wait for another writer (0: not at all, for start's
// event loop, which must not stall; SETTINGS_BUSY then).
function withSettingsLock(where, fn, {waitMs = SETTINGS_LOCK_WAIT_MS} = {}) {
  const {createWhole} = require('./lock');
  const lock = path.join(where.home, 'settings.lock');
  const mine = {pid: process.pid, host: os.hostname(), at: new Date().toISOString()};
  const until = Date.now() + waitMs;
  fs.mkdirSync(where.home, {recursive: true});
  while (!createWhole(lock, mine)) {
    let st = null;
    try { st = fs.statSync(lock); } catch (err) { continue; }   // released: try again
    if (Date.now() - st.mtimeMs > SETTINGS_LOCK_STALE_MS) {
      try { const again = fs.statSync(lock); if (again.ino === st.ino) fs.rmSync(lock, {force: true}); } catch (err) { /* gone */ }
      continue;
    }
    if (Date.now() > until) throw Object.assign(new Error(`another change to the settings is under way (${lock}); try again`), {code: 'SETTINGS_BUSY'});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try {
    return fn();
  } finally {
    let held = null;
    try { held = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch (err) { held = null; }
    if (held != null && held.pid === mine.pid && held.at === mine.at) fs.rmSync(lock, {force: true});
  }
}

// A setting's value as countinghouse's option takes it, at start and live
// alike: requestTimeout is kept in milliseconds and passed in whole seconds,
// rounded down; locale
// is kept as en or zh and passed as the runtime's en-US or zh-CN (it reads
// any other value as en-US, so zh alone was English).
const RUNTIME_LOCALES = {en: 'en-US', zh: 'zh-CN'};
function runtimeValue(name, value) {
  // rounded down, at least 1 s: a tightened timeout never comes out looser
  // than asked (the review of countinghouse #183)
  if (name === 'requestTimeout') return Math.max(1, Math.floor(value / 1000));
  if (name === 'locale') return RUNTIME_LOCALES[value] || value;
  return value;
}

// Every allowlisted setting with its value, default and bounds, and each
// pack's on/off. -> [{name, value, default, bounds, guarding}]
function listSettings(where, packNames = []) {
  const settings = readSettings(where);
  const names = [...Object.keys(ALLOWLIST), ...packNames.map((p) => `pack.${p}`)];
  return names.map((name) => {
    const e = entryOf(name);
    return {name, value: valueOf(settings, name), default: e.default, bounds: boundsOf(e), guarding: e.guarding};
  });
}

module.exports = {ALLOWLIST, sandboxEntry, readSettings, valueOf, loosens, parseSetting, planSetting, planReset, setSetting, shown, resetSettings, listSettings, entryOf, withSettingsLock, runtimeValue};
