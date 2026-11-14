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
const {valueOf, entryOf, loosens, shown} = require('./settings');
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
  for (const line of text.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch (err) { continue; }
    if (e == null || typeof e !== 'object' || typeof e.setting !== 'string') continue;
    if (e.setting === '*' && e.change === 'reset') { recorded.clear(); before.clear(); continue; }
    if (e.asked !== undefined) continue;
    if (e.change === 'not made') {
      const b = before.get(e.setting);
      if (b != null) { if (b.had) recorded.set(e.setting, b.value); else recorded.delete(e.setting); before.delete(e.setting); }
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(e, 'new')) continue;
    if (e.change !== undefined && e.change !== OUTSIDE) continue;
    before.set(e.setting, {had: recorded.has(e.setting), value: recorded.get(e.setting)});
    recorded.set(e.setting, e.new);
  }
  return recorded;
}

// settings: readSettings(where) -> [{setting, old, new, loosened}]
function outsideEdits(where, settings) {
  const recorded = recordedValues(where);
  const names = new Set([...recorded.keys(), ...Object.keys(settings.values)]);
  const out = [];
  for (const name of names) {
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
function reportOutsideEdits(where, settings, {say, host = null, pid = null, refusal = () => null} = {}) {
  if (settings.error != null) return [];
  const edits = outsideEdits(where, settings);
  for (const e of edits) {
    const refused = e.loosened ? refusal(e.setting, e.new) : null;
    if (refused != null) e.refused = refused;
    say(`${e.setting} was changed outside ch-local: ${shown(e.setting, e.old)} -> ${shown(e.setting, e.new)}${e.loosened ? ' (this loosens a guarding setting)' : ''}` +
      (refused != null ? `; not applied: ${refused.message.replace(/; nothing was changed$/, '')}` : ''));
    appendHistory(where, {by: 'start', setting: e.setting, old: e.old, new: e.new, change: refused != null ? REFUSED : OUTSIDE, ...(e.loosened ? {loosened: true} : {})}, {host, pid});
  }
  return edits;
}

module.exports = {outsideEdits, reportOutsideEdits, recordedValues, OUTSIDE, REFUSED};
