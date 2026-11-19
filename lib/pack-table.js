'use strict';
// Between packs from different pins (#413 rev 3 section 9.4; L1b-2): each
// module of a pack being added, by the table, with p the pack's pinned
// version and a the module's active version in the home:
//
//   not installed                                  p is placed
//   a = p                                          skipped (shared)
//   a newer than p, no breaking change             skipped; the pack recorded with a
//   a older than p, no breaking change             p placed and active; its callers said
//   a older than p, breaking, no installed caller  the same
//   a older than p, breaking, installed callers    Question A
//   a newer than p, breaking                       Question B
//
// A module's version is never lowered by adding a pack: a newer installed
// version stays active (rule 2: the highest any pack records), and the pack
// is recorded with it. A breaking change is semver's: the majors differ, or
// both are 0.x and the minors differ (0.0.x: the patches). "Installed
// modules that call it" are read from the installed modules' manifests'
// countinghouse.calls, the names before the slash, matched by friendly name
// (api.json's device.friendlyName) as the runtime matches them; the pack's
// own modules are not counted for Question A, and are the ones Question B
// names (read from its tarballs: not placed yet).
const fs = require('node:fs');
const path = require('node:path');
const {compareVersions, activeVersions, livePacks} = require('./module-record');
const {versionDir} = require('./store-paths');
const {readMember} = require('./tar');

const short = (name) => name.replace(/^@[^/]+\//, '');
const parts = (v) => String(v).split(/[-+]/)[0].split('.').map(Number);

// semver's breaking change between two versions
function breakingBetween(a, b) {
  const [x, y] = [parts(a), parts(b)];
  if (x[0] !== y[0]) return true;
  if (x[0] !== 0) return false;
  if (x[1] !== y[1]) return true;
  return x[1] === 0 && x[2] !== y[2];
}
// the line a version is written for: 2.x, 0.4.x, 0.0.3
function lineOf(v) {
  const [maj, min, pat] = parts(v);
  if (maj !== 0) return `${maj}.x`;
  if (min !== 0) return `0.${min}.x`;
  return `0.0.${pat}`;
}

const json = (buf) => { try { return buf == null ? null : JSON.parse(buf.toString('utf8')); } catch (err) { return null; } };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return null; } };
const callsOf = (manifest) => {
  const calls = manifest != null && manifest.countinghouse != null && Array.isArray(manifest.countinghouse.calls) ? manifest.countinghouse.calls : [];
  return new Set(calls.filter((c) => typeof c === 'string' && c.includes('/')).map((c) => c.slice(0, c.indexOf('/'))));
};
const friendlyOfApi = (api) => (api != null && api.device != null && typeof api.device.friendlyName === 'string' ? api.device.friendlyName : null);

// where, record (modules.json), pack (its name), spec ({packages}), pins
// ({m: {version}}), bytes ({m: the pinned tarball}, for the pack's own
// modules' manifests). -> {rows: [{module, case, a, p, place, recordAs,
// callers: [{module, version, pack}], question: null | 'A' | 'B'}],
// signature: what the rows were decided from (a change under the lock is
// refused)}.
function decide(where, record, pack, spec, pins, {bytes = {}} = {}) {
  const livePacked = livePacks(record.packs || {}, record.withdrawn);
  const live = activeVersions(livePacked, []);
  // a caller's pack: a live one (a withdrawn pack never loads)
  const recordedBy = (m) => Object.entries(livePacked).filter(([, e]) => e.modules != null && e.modules[m] != null).map(([n]) => n);
  const own = new Set(spec.packages);
  // the installed modules' friendly names and calls (placed ones)
  const installed = Object.keys(record.modules || {}).filter((m) => live[m] != null);
  const friendlyInstalled = (m) => friendlyOfApi(readJson(path.join(versionDir(where, m, live[m]), 'api.json'))) || short(m);
  const callsInstalled = new Map(installed.map((m) => [m, callsOf(readJson(path.join(versionDir(where, m, live[m]), 'package.json')))]));
  // the pack's own modules: from their tarballs, or, for one the store
  // holds at its pin already (no tarball read), from the store
  const ownManifest = (m) => (bytes[m] != null ? json(readMember(bytes[m], 'package.json')) : readJson(path.join(versionDir(where, m, pins[m].version), 'package.json')));
  const callsOwn = new Map([...own].map((m) => [m, callsOf(ownManifest(m))]));
  const rows = [];
  for (const m of spec.packages) {
    const p = pins[m].version;
    const a = live[m] != null ? live[m] : null;
    const row = {module: m, a, p, place: false, recordAs: p, callers: [], question: null};
    if (a == null) {
      Object.assign(row, {case: 'new', place: true});
    } else if (compareVersions(a, p) === 0) {
      row.case = 'same';
    } else if (compareVersions(a, p) > 0) {
      // never lowered: the installed version stays, and the pack is recorded with it
      row.recordAs = a;
      if (!breakingBetween(a, p)) {
        row.case = 'newer';
      } else {
        row.case = 'newer-breaking';
        row.question = 'B';
        const name = friendlyInstalled(m);
        row.callers = [...own].filter((o) => o !== m && callsOwn.get(o).has(name)).map((o) => ({module: o, version: pins[o].version, pack}));
      }
    } else {
      const name = friendlyInstalled(m);
      row.callers = installed.filter((o) => !own.has(o) && o !== m && callsInstalled.get(o).has(name))
        .map((o) => ({module: o, version: live[o], pack: recordedBy(o)[0] || null}));
      row.place = true;
      if (!breakingBetween(a, p)) row.case = 'older';
      else if (row.callers.length === 0) row.case = 'older-breaking-uncalled';
      else { row.case = 'older-breaking'; row.question = 'A'; }
    }
    rows.push(row);
  }
  // (Question B's callers are the pack's own, read from its pinned,
  // integrity-checked tarballs: they cannot change while the user is asked,
  // and are not read again under the lock)
  const signature = JSON.stringify(rows.map((r) => [r.module, r.a, r.p, r.case, r.question === 'B' ? [] : r.callers.map((c) => c.module)]));
  return {rows, signature};
}

// Question A and B's text (section 9.4)
function questionOf(row, pack) {
  const m = short(row.module);
  if (row.question === 'A') {
    return `${m} ${row.a} -> ${row.p} is a major version: it may change how it works.\nThese installed modules call it:\n`
      + row.callers.map((c) => `  ${short(c.module)} ${c.version}${c.pack != null ? ` (pack ${c.pack})` : ''}`).join('\n')
      + `\nUpdate ${m} anyway? [y/N] `;
  }
  return `${m} ${row.a} is installed, a newer major version than the pack "${pack}" was released with (${row.p}).\n`
    + (row.callers.length > 0 ? `These modules of the pack call it and may not work with it:\n${row.callers.map((c) => `  ${short(c.module)} ${c.version}`).join('\n')}\n` : '')
    + 'Install the pack anyway? [y/N] ';
}
// no terminal: what is said, nothing written (exit 2)
function noTerminal(row, pack) {
  const m = short(row.module);
  return row.question === 'A'
    ? `this install updates ${m} across a major version, which is confirmed at a terminal: run it in one; nothing was installed`
    : `this install adds the pack "${pack}" beside ${m} ${row.a}, a newer major version than it was released with, which is confirmed at a terminal: run it in one; nothing was installed`;
}

// The table's questions, every one asked before anything is written and
// before the home's lock is taken (no one holds it while someone types); any
// No ends the operation. Each answer is a history line. -> {code} (2: no
// terminal; 1: a No) or {signature} (checked again under the lock).
async function askAll(where, decided, pack, io, fail) {
  const questions = decided.rows.filter((r) => r.question != null);
  if (questions.length > 0 && io.interactive !== true) { fail(noTerminal(questions[0], pack)); return {code: 2}; }
  const {appendHistory} = require('./history');
  for (const r of questions) {
    const answer = String(await io.ask(questionOf(r, pack))).trim().toLowerCase();
    const yes = answer === 'y' || answer === 'yes';
    // the answer, as asked (Question B's module stays at from: to is the
    // version the pack was released with, never placed)
    appendHistory(where, {by: 'cli', question: r.question, module: r.module, from: r.a, to: r.p, callers: r.callers.map((c) => c.module), answer: yes ? 'yes' : 'no'});
    if (!yes) { fail('nothing was installed'); return {code: 1}; }
  }
  return {signature: decided.signature};
}

// Under the lock: decided again, and the answers given before it checked
// against it. -> {rows} or {problem}.
function recheck(where, record, pack, spec, pins, asked) {
  const decided = decide(where, record, pack, spec, pins, {bytes: {}});
  const questions = decided.rows.filter((r) => r.question != null);
  if ((asked == null && questions.length > 0) || (asked != null && decided.signature !== asked)) return {problem: 'the home changed while this was being asked; nothing was installed'};
  return {rows: decided.rows};
}

// What the table changed, and how to go back (section 9.4).
function changedLines(rows, pack) {
  const out = [];
  for (const r of rows) {
    const m = short(r.module);
    if (r.case === 'older' || r.case === 'older-breaking-uncalled') {
      const names = r.callers.map((c) => short(c.module));
      out.push(`updated ${m} ${r.a} -> ${r.p}${names.length > 0 ? `; ${names.join(', ')} ${names.length === 1 ? 'uses' : 'use'} it too` : ''}`);
    } else if (r.case === 'older-breaking') {
      out.push(`updated ${m} ${r.a} -> ${r.p}`);
      for (const c of r.callers) out.push(`${short(c.module)} ${c.version} was written for ${lineOf(r.a)} and still loads; if it stops working, \`ch-local remove-pack ${pack}\` puts ${m} back to ${r.a}`);
    } else if (r.case === 'newer-breaking') {
      out.push(`${m} stays at ${r.a}, newer than "${pack}" was released with (${r.p}); if the pack does not work with it, \`ch-local remove-pack ${pack}\` removes it`);
    }
  }
  return out;
}

// The record as the table reads it for a pack being installed again: the
// pack's own entry left out, so its earlier pins are not "installed".
const withoutPack = (record, pack) => {
  const packs = {...(record.packs || {})};
  delete packs[pack];
  return {...record, packs};
};

// The tarballs read before the lock, for Question B's callers: only the
// pack's modules the store does not hold whole at their pin (the others'
// manifests are read from the store), so a --from with only the changed
// tarballs is enough, as under the lock.
function preLockNeeds(where, spec, pins) {
  const {wholeAt} = require('./module-store');
  return spec.packages.filter((m) => { try { return !wholeAt(where, m, pins[m]); } catch (err) { return true; } });
}

module.exports = {decide, askAll, preLockNeeds, recheck, changedLines, withoutPack, questionOf, noTerminal, breakingBetween, lineOf, short};
