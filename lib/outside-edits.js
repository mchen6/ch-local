'use strict';
// Settings changed outside the tools (countinghouse part 3, section 5): each
// start compares settings.json with the last value <home>/history.jsonl
// recorded for each setting; a difference is reported, on stderr and in the
// history ("changed outside ch-local"), so the record holds what the model
// cannot edit. Reporting only: the file is the user's.
//
// The history, replayed: a change ({setting, new}, no change label) sets
// the value; a reset ({setting: '*', change: 'reset'}) clears every one;
// "not made" (a write that failed after its line) undoes the change before
// it; a request not confirmed ({asked}) and any other labelled line (part
// 3's this-start changes) set nothing. A report sets the value it saw, so it
// is reported once.
const fs = require('node:fs');
const path = require('node:path');
const {valueOf, entryOf, loosens, shown, historyValue, cutPoints} = require('./settings');
const crypto = require('node:crypto');

// a module's setting (module.<package>.<setting>): kept by ch-local, the
// runtime's to apply (#413 sections 4.2 and 4.3)
const isModule = (name) => name.startsWith('module.');
// a value recorded cut (over 64 characters: its line holds the SHA-256 of
// the whole): compared by that hash
const CUT = Symbol('cut');
const sameValue = (recorded, now) => (recorded != null && recorded[CUT] != null
  ? now !== undefined && crypto.createHash('sha256').update(JSON.stringify(now)).digest('hex') === recorded[CUT]
  : JSON.stringify(recorded) === JSON.stringify(now));
const {appendHistory} = require('./history');

const OUTSIDE = 'changed outside ch-local';
// an outside loosening the operator's ceiling refuses: said and recorded,
// not applied; it sets no value, so each start says it again
const REFUSED = 'changed outside ch-local, refused by the ceiling';

// -> Map(setting -> the value last recorded)
function recordedValues(where) {
  let text = '';
  try { text = fs.readFileSync(path.join(where.home, 'history.jsonl'), 'utf8'); } catch (err) { text = ''; }
  const recorded = new Map();
  const before = new Map();   // setting -> {had, value} before its last change
  let beforeReset = null;      // what the last reset cleared, until a 'not made' says it wasn't
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch (err) { continue; }
    if (e == null || typeof e !== 'object' || typeof e.setting !== 'string') continue;
    // a bare reset: every setting of ch-local's own back to its default; a
    // module's values are kept by it, so theirs stand (section 4.3)
    if (e.setting === '*' && e.change === 'reset') {
      beforeReset = {recorded: new Map(recorded), before: new Map(before)};
      for (const k of [...recorded.keys()]) if (!isModule(k)) { recorded.delete(k); before.delete(k); }
      continue;
    }
    // a reset whose write failed: the values before it stand
    if (e.setting === '*' && e.change === 'not made') {
      if (beforeReset != null) {
        for (const [k, v] of beforeReset.recorded) recorded.set(k, v);
        for (const [k, v] of beforeReset.before) before.set(k, v);
        beforeReset = null;
      }
      continue;
    }
    if (e.asked !== undefined) continue;
    if (e.change === 'not made') {
      const b = before.get(e.setting);
      if (b != null) { if (b.had) recorded.set(e.setting, b.value); else recorded.delete(e.setting); before.delete(e.setting); }
      continue;
    }
    // one setting's value removed (a module's setting reset, a leftover
    // pack.* removed with its module turned on, or moved to enabled.* by
    // the migration): back to no value
    if (!Object.prototype.hasOwnProperty.call(e, 'new') && typeof e.change === 'string' && (e.change === 'reset' || e.change.startsWith('removed with ') || e.change.startsWith('moved to '))) {
      before.set(e.setting, {had: recorded.has(e.setting), value: recorded.get(e.setting)});
      recorded.delete(e.setting);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(e, 'new')) continue;
    if (e.change !== undefined && e.change !== OUTSIDE) continue;
    before.set(e.setting, {had: recorded.has(e.setting), value: recorded.get(e.setting)});
    recorded.set(e.setting, typeof e.newSha256 === 'string' ? {[CUT]: e.newSha256} : e.new);
  }
  return recorded;
}

// settings: readSettings(where) -> [{setting, old, new, loosened}]
function outsideEdits(where, settings) {
  const recorded = recordedValues(where);
  const kept = settings.kept || {};
  const names = new Set([...recorded.keys(), ...Object.keys(settings.values), ...Object.keys(kept).filter(isModule)]);
  const out = [];
  for (const name of names) {
    if (isModule(name)) {
      // a module's setting: compared as stored (no value is no value), a cut
      // one by its hash; the runtime checks it at its next read, so no
      // loosening and no ceiling here
      const was = recorded.has(name) ? recorded.get(name) : undefined;
      const now = Object.prototype.hasOwnProperty.call(kept, name) ? kept[name] : undefined;
      if (sameValue(was, now)) continue;
      out.push({setting: name, old: was != null && was[CUT] != null ? '(a long value)' : was, new: now, loosened: false, module: true});
      continue;
    }
    if (entryOf(name) == null) continue;
    const was = recorded.has(name) ? recorded.get(name) : valueOf({values: {}}, name);
    const now = valueOf(settings, name);
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    out.push({setting: name, old: was, new: now, loosened: loosens(name, was, now)});
  }
  return out;
}

// Reports each (say) and records it. refusal(setting, value) -> null, or
// the ceiling's refusal of a loosening ({message}): that edit is marked
// refused, for the caller to leave unapplied. A settings file that cannot
// be read is no report. -> the edits.
// A refused edit sets no value, so it is found again: said and recorded once
// per process (one start), again at the next start.
const refusedSaid = new Set();
function reportOutsideEdits(where, settings, {say, host = null, pid = null, refusal = () => null} = {}) {
  if (settings.error != null) return [];
  const edits = outsideEdits(where, settings);
  for (const e of edits) {
    const refused = e.loosened ? refusal(e.setting, e.new) : null;
    if (refused != null) e.refused = refused;
    const key = `${where.home}\0${e.setting}\0${JSON.stringify(e.new)}`;
    if (refused != null && refusedSaid.has(key)) continue;
    if (refused != null) refusedSaid.add(key);
    // (a module's value said as stored, cut past 64 characters; recorded cut,
    // with its hash, as any module value)
    const said = (v) => { if (!e.module) return shown(e.setting, v); if (v === undefined) return '(not set)'; const cut = cutPoints(v); return cut != null ? `${cut}…` : String(v); };
    say(`${e.setting} was changed outside ch-local: ${said(e.old)} -> ${said(e.new)}${e.loosened ? ' (this loosens a guarding setting)' : ''}` +
      // (the ceiling's refusal without its setting and value again: within the
      // runtime's notice cut -- the final pass on #134)
      (refused != null ? `; not applied: ${refused.code === 'SETTING_FORBIDDEN_BY_CEILING' ? 'its operator\'s ceiling forbids it' : refused.message.replace(/; nothing was changed$/, '')}` : ''));
    const values = e.module
      ? {...(e.old === undefined ? {} : historyValue('old', e.old)), ...(e.new === undefined ? {} : historyValue('new', e.new))}
      : {old: e.old, new: e.new};
    if (e.module && e.new === undefined) {
      appendHistory(where, {by: 'start', setting: e.setting, ...values, change: 'removed with an outside edit'}, {host, pid});
      continue;
    }
    appendHistory(where, {by: 'start', setting: e.setting, ...values, change: refused != null ? REFUSED : OUTSIDE, ...(e.loosened ? {loosened: true} : {})}, {host, pid});
  }
  return edits;
}

module.exports = {outsideEdits, reportOutsideEdits, recordedValues, OUTSIDE, REFUSED, resetForTests: () => refusedSaid.clear()};
