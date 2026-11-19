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
const {versionDir, looksPlaced} = require('./store-paths');
const {readMember} = require('./tar');
const {short, manifestOf, friendlyOf, callsOf} = require('./availability');
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

// where, record (modules.json), pack (its name), spec ({packages}), pins
// ({m: {version}}), bytes ({m: the pinned tarball}, for the pack's own
// modules' manifests). -> {rows: [{module, case, a, p, place, recordAs,
// callers: [{module, version, pack}], question: null | 'A' | 'B'}],
// signature: what the rows were decided from (a change under the lock is
// refused)} | {problem} (a caller that decides a row cannot be read).
function decide(where, record, pack, spec, pins, {bytes = {}, withOwnCallers = true} = {}) {
  const livePacked = livePacks(record.packs || {}, record.withdrawn);
  const live = activeVersions(livePacked, []);
  // a caller's pack: a live one (a withdrawn pack never loads)
  const recordedBy = (m) => Object.entries(livePacked).filter(([, e]) => e.modules != null && e.modules[m] != null).map(([n]) => n);
  const own = new Set(spec.packages);
  // Callers are found as a start matches them (lib/availability.js): a
  // placed module's calls, by the friendly name in its api.json; a module
  // whose files are missing loads nothing and calls nothing, and is called
  // by its short name. Unknown is never "no callers": a placed module whose
  // package.json or api.json cannot be read refuses the operation where a
  // caller decides the row (fail closed), naming it.
  const installed = Object.keys(record.modules || {}).filter((m) => live[m] != null);
  const dirOf = (m) => versionDir(where, m, live[m]);
  const placed = (m) => looksPlaced(where, m, live[m]);
  const apiReadable = (dir) => { try { JSON.parse(fs.readFileSync(path.join(dir, 'api.json'), 'utf8')); return true; } catch (err) { return false; } };
  const cannot = (m, o, file) => ({problem: `cannot tell which modules call ${short(m)}: ${short(o)}'s ${file} cannot be read; nothing was installed`});
  // m's name as its callers write it, or {problem}
  const nameOf = (m) => {
    if (!placed(m)) return short(m);
    if (!apiReadable(dirOf(m))) return cannot(m, m, 'api.json');
    return friendlyOf(dirOf(m));
  };
  // the installed modules (not the pack's own, not m) that call m: [o] or {problem}
  const installedCallers = (m) => {
    const name = nameOf(m);
    if (name != null && name.problem != null) return name;
    const out = [];
    for (const o of installed) {
      if (own.has(o) || o === m || !placed(o)) continue;
      const manifest = manifestOf(dirOf(o));
      if (manifest == null) return cannot(m, o, 'package.json');
      if (name != null && callsOf(manifest).includes(name)) out.push(o);
    }
    return out;
  };
  // the pack's own modules: from their tarballs, or, for one the store
  // holds at its pin already (no tarball read), from the store
  const ownManifest = (m) => (bytes[m] != null ? json(readMember(bytes[m], 'package.json')) : manifestOf(versionDir(where, m, pins[m].version)));
  const ownCallers = (m) => {
    const name = nameOf(m);
    if (name != null && name.problem != null) return name;
    const out = [];
    for (const o of own) {
      if (o === m) continue;
      const manifest = ownManifest(o);
      if (manifest == null) return cannot(m, o, 'package.json');
      if (name != null && callsOf(manifest).includes(name)) out.push(o);
    }
    return out;
  };
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
        // (under the lock they are not read again: see the signature)
        const callers = withOwnCallers ? ownCallers(m) : [];
        if (callers.problem != null) return callers;
        row.callers = callers.map((o) => ({module: o, version: pins[o].version, pack}));
      }
    } else {
      row.place = true;
      const breaking = breakingBetween(a, p);
      const callers = installedCallers(m);
      // (not breaking: the callers only name who uses it too, said when known)
      if (callers.problem != null && breaking) return callers;
      row.callers = callers.problem != null ? [] : callers.map((o) => ({module: o, version: live[o], pack: recordedBy(o)[0] || null}));
      if (!breaking) row.case = 'older';
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
// terminal; 1: a No) or {signature} (checked again under the lock; null
// when nothing was asked).
async function askAll(where, decided, pack, io, fail) {
  if (decided.problem != null) { fail(decided.problem); return {code: 1}; }
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
  // (with nothing asked, nothing is held to: the lock decides again)
  return {signature: questions.length > 0 ? decided.signature : null};
}

// Under the lock: decided again. Answers given before it hold only for the
// home they were given about (a changed signature is refused); with nothing
// asked, the new decision stands, unless it now needs a question, which
// cannot be asked under the lock (the high review of #94, 5). -> {rows} or
// {problem}.
function recheck(where, record, pack, spec, pins, asked) {
  const decided = decide(where, record, pack, spec, pins, {withOwnCallers: false});
  if (decided.problem != null) return {problem: decided.problem};
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
      for (const c of r.callers) out.push(`${short(c.module)} ${c.version} was written for ${lineOf(r.a)} and still loads; if it stops working, \`ch-local remove-pack ${pack}\` puts ${m} back to ${r.a}, unless a pack added later relies on the newer version`);
    } else if (r.case === 'newer-breaking') {
      out.push(`${m} stays at ${r.a}, newer than "${pack}" was released with (${r.p}); if the pack does not work with it, \`ch-local remove-pack ${pack}\` removes it`);
    }
  }
  return out;
}

// Packs from different pins (section 9.4), one predicate for add-pack,
// install and remove-pack (the high review of #94, 9). The packs compared
// are the live ones that stay beside the operation's (not `except`: the
// packs it brings to its own pins, or drops); a withdrawn pack never loads.
// With `from` (the pins the operation takes): true when one of them comes
// from other pins (a development home's packs come from their pins file).
// With from null (remove-pack): true when they come from more than one.
function fromOtherPins(record, from, {except = []} = {}) {
  const skip = new Set(except);
  const froms = Object.entries(livePacks(record.packs || {}, record.withdrawn))
    .filter(([n]) => !skip.has(n)).map(([, e]) => JSON.stringify(e.from));
  if (from == null) return new Set(froms).size > 1;
  return froms.some((f) => f !== JSON.stringify(from));
}

// The modules a pack shares with the packs already installed, as the table
// decided them (at the pin, or kept at a newer installed version), and the
// line both add-pack and install say it with (the high review of #94, 10).
const sharedOf = (rows) => rows.filter((r) => r.case === 'same' || r.case === 'newer').map((r) => r.module);
const sharesText = (modules) => `it shares ${modules.map(short).join(', ')} with the packs already installed`;

// The tarballs read before the lock (the high review of #94, 3 and 7):
// those the locked path places (a row placed, or shared but not whole in
// the store), and, for a Question B row, the pack's own modules not whole
// in the store (their calls are read from them). A module the pack never
// places needs none, and each is read and hashed once: the bytes go on to
// the locked path.
function needsOf(where, rows, spec, pins) {
  const {wholeAt} = require('./module-store');
  const notWhole = (m) => { try { return !wholeAt(where, m, pins[m]); } catch (err) { return true; } };
  const out = new Set(rows.filter((r) => r.place || r.case === 'same').map((r) => r.module).filter(notWhole));
  if (rows.some((r) => r.question === 'B')) for (const m of spec.packages) if (notWhole(m)) out.add(m);
  return [...out];
}

// Before the lock: decided, the tarballs it needs read (load(names) ->
// {problems, bytes}), and Question B's callers read from them.
// -> {decided, bytes} | {problems}.
function decideBeforeLock(where, record, pack, spec, pins, load) {
  const first = decide(where, record, pack, spec, pins, {withOwnCallers: false});
  if (first.problem != null) return {decided: first, bytes: {}};
  const {problems, bytes} = load(needsOf(where, first.rows, spec, pins));
  if (problems.length > 0) return {problems};
  const decided = first.rows.some((r) => r.question === 'B') ? decide(where, record, pack, spec, pins, {bytes}) : first;
  return {decided, bytes};
}

module.exports = {decide, decideBeforeLock, fromOtherPins, sharedOf, sharesText, askAll, recheck, changedLines, questionOf, noTerminal, breakingBetween, lineOf, short};
