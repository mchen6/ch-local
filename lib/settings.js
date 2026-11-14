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

// -> {values}: settings.json as written, an earlier {autoUpgrade} migrated
function readSettings(where) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(where.settings, 'utf8')); } catch (err) { raw = null; }
  if (raw == null || typeof raw !== 'object') return {values: {}};
  if (raw.version === 1 && raw.values != null && typeof raw.values === 'object') return {values: raw.values};
  return {values: typeof raw.autoUpgrade === 'boolean' ? {autoUpgrade: raw.autoUpgrade} : {}};
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
  const settings = readSettings(where);
  const old = valueOf(settings, name);
  const loosened = loosens(name, old, next);
  if (loosened && !mayLoosen) throw Object.assign(new Error(`changing ${name} to ${raw} would loosen a guarding setting; nothing was changed`), {code: 'SETTING_LOOSENS_A_GUARD'});
  writeAtomic(where.settings, JSON.stringify({version: 1, values: {...settings.values, [name]: next}}, null, 2) + '\n');
  try { fs.appendFileSync(path.join(where.home, 'history.jsonl'), JSON.stringify({at: new Date().toISOString(), by, setting: name, old, new: next}) + '\n'); } catch (err) { /* the change stands */ }
  return {name, old, new: next, loosened};
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
