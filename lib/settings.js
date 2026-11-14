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

// name -> {parse, check(value) -> bounds text or null, default, guarding,
// tighter(old, new) -> true when the change tightens or keeps}
const ALLOWLIST = {
  locale: {parse: String, values: ['en', 'zh'], default: 'en', guarding: false},
  maxOutputBytes: {parse: size, min: MiB, max: 256 * MiB, default: 8 * MiB, guarding: true, tighter: (o, n) => n <= o},
  requestTimeout: {parse: ms, min: 5000, max: 120000, default: 30000, guarding: true, tighter: (o, n) => n <= o},
  moduleSandbox: {parse: String, values: ['enforce', 'audit'], default: 'enforce', guarding: true, tighter: (o, n) => n === 'enforce' || o === n},
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
  if (e.values != null) return e.values.includes(v);
  return Number.isInteger(v) && v >= e.min && v <= e.max;
}

// -> {values} as written, an earlier {autoUpgrade} migrated; or, when the file
// cannot be read or holds anything not valid, {values: {}, error}: a caller
// fails closed (the defaults at start, the last good settings while running)
// and says so, never applies part of it (the review of ch-local #13).
function readSettings(where) {
  let text;
  try { text = fs.readFileSync(where.settings, 'utf8'); } catch (err) { return {values: {}, ...(err.code === 'ENOENT' ? {} : {error: `${where.settings} cannot be read (${err.code})`})}; }
  let raw = null;
  try { raw = JSON.parse(text); } catch (err) { return {values: {}, error: `${where.settings} is not JSON`}; }
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {values: {}, error: `${where.settings} is not a settings file`};
  let values;
  if (raw.version === 1 && raw.values != null && typeof raw.values === 'object' && !Array.isArray(raw.values)) values = raw.values;
  else if (raw.version == null && Object.keys(raw).every((k) => k === 'autoUpgrade')) values = typeof raw.autoUpgrade === 'boolean' ? {autoUpgrade: raw.autoUpgrade} : {};
  else return {values: {}, error: `${where.settings} is not a version 1 settings file`};
  const bad = Object.entries(values).find(([name, v]) => !validStored(name, v));
  if (bad != null) return {values: {}, error: `${where.settings} has ${bad[0]} = ${JSON.stringify(bad[1]).slice(0, 40)}, which is not allowed`};
  return {values};
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

// -> {name, old, new, loosened} or throws {code, message, fields}
function setSetting(where, name, raw, {by = 'cli', mayLoosen = false} = {}) {
  const e = entryOf(name);
  if (e == null) throw Object.assign(new Error(`there is no setting named ${name}; \`ch-local settings get\` lists them`), {code: 'SETTING_UNKNOWN'});
  const next = e.parse(raw);
  const ok = e.values != null ? e.values.includes(next) : (Number.isInteger(next) && next >= e.min && next <= e.max);
  if (!ok) throw Object.assign(new Error(`the value ${raw} for ${name} is outside the allowed range (${boundsOf(e)}); nothing was changed`), {code: 'SETTING_OUT_OF_BOUNDS'});
  return withSettingsLock(where, () => {
    const settings = readSettings(where);
    if (settings.error != null) throw Object.assign(new Error(`${settings.error}; fix or remove it first; nothing was changed`), {code: 'SETTINGS_UNREADABLE'});
    const old = valueOf(settings, name);
    const loosened = loosens(name, old, next);
    if (loosened && !mayLoosen) throw Object.assign(new Error(`changing ${name} to ${raw} would loosen a guarding setting; nothing was changed`), {code: 'SETTING_LOOSENS_A_GUARD'});
    // recorded first: a change the history cannot hold is not made
    if (!appendHistory(where, {by, setting: name, old, new: next, ...(loosened ? {loosened: true} : {})}, {strict: true})) {
      throw Object.assign(new Error(`the change could not be recorded in ${where.home}/history.jsonl; nothing was changed`), {code: 'SETTING_NOT_RECORDED'});
    }
    writeAtomic(where.settings, JSON.stringify({version: 1, values: {...settings.values, [name]: next}}, null, 2) + '\n');
    return {name, old, new: next, loosened};
  });
}

// One lock around every settings write, shared by the CLI and countinghouse's
// settings tool (<home>/settings.lock, created exclusively; one older than
// SETTINGS_LOCK_STALE_MS is a holder that died). Waits up to
// SETTINGS_LOCK_WAIT_MS.
const SETTINGS_LOCK_STALE_MS = 30000;
const SETTINGS_LOCK_WAIT_MS = 5000;
function withSettingsLock(where, fn) {
  const lock = path.join(where.home, 'settings.lock');
  const until = Date.now() + SETTINGS_LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(where.home, {recursive: true});
      fs.writeFileSync(lock, JSON.stringify({pid: process.pid, at: Date.now()}), {flag: 'wx'});
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let at = 0;
      try { at = JSON.parse(fs.readFileSync(lock, 'utf8')).at || 0; } catch (e) { at = 0; }
      if (Date.now() - at > SETTINGS_LOCK_STALE_MS) { fs.rmSync(lock, {force: true}); continue; }
      if (Date.now() > until) throw Object.assign(new Error(`another change to the settings is under way (${lock}); try again`), {code: 'SETTINGS_BUSY'});
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, {force: true});
  }
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

module.exports = {ALLOWLIST, readSettings, valueOf, loosens, setSetting, listSettings, entryOf};
