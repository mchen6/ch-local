'use strict';
// ch-local rollback [--yes] (plan Task 12; business review, 2026-11-12). An
// install over an existing one keeps the replaced release's programs in
// <home>/previous (app/ and its packs.json), one level. rollback swaps them
// with the current ones in one step, so a second rollback returns to the newer
// release.
// - Programs only: caches, usage records, settings, the identity secret, the
//   client entries and auth.json are not touched.
// - A pack the restored release lacks stays recorded under `held`, with the
//   release it was installed under; start does not load it, status names it,
//   and remove-pack removes it.
// - Rolling back a release marked as a security fix names it, says what it
//   fixed and asks; without a terminal it refuses unless --yes.
// - A kept release from before rollback existed is refused: its launcher
//   could never bring you back.
// - One pack that got worse is remove-pack on the current release, not this.
//
// The swap is three renames and two record writes, so it is journaled: before
// anything moves, <home>/rollback.journal holds both records and the newer app
// gets a marker file. While the journal exists every command refuses (lib/
// record.js), and the next rollback finishes the swap from what is on disk. A
// rename that fails part-way is undone at once, and nothing is ever removed
// recursively, so the newer release cannot be lost.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {layout} = require('./home');
const record = require('./record');
const {writeAtomic} = require('./atomic');
const {withLock} = require('./lock');

const MARKER = '.ch-local-rollback-newer';
const versionOf = (r) => (r != null && r.release != null && r.release.version != null ? r.release.version : 'an unnamed release');

// Moves done in order; each undone in reverse when a later one fails.
function swap(where, aside) {
  const moves = [[where.app, path.join(aside, 'app')], [where.previousApp, where.app], [path.join(aside, 'app'), where.previousApp]];
  const done = [];
  for (const [a, b] of moves) {
    try {
      fs.renameSync(a, b);
      done.push([a, b]);
    } catch (err) {
      for (const [x, y] of done.reverse()) {
        try { fs.renameSync(y, x); } catch (e) { return {error: err, stuck: true}; }
      }
      return {error: err, stuck: false};
    }
  }
  return {};
}

// Writes both records and clears the journal: the last step of a swap, and
// of finishing an interrupted one.
function settle(where, journal, aside) {
  record.writeRecord({packs: where.previousRecord}, journal.kept);
  record.writeRecord(where, journal.restored);
  for (const dir of [where.app, where.previousApp]) fs.rmSync(path.join(dir, MARKER), {force: true});
  fs.rmSync(where.journal, {force: true});
  try { if (aside != null) fs.rmdirSync(aside); } catch (err) { /* not there, or not empty: left */ }
}

// An interrupted rollback, finished from what is on disk: -> 'finished' | 'undone'.
function finish(where, journal) {
  const aside = path.join(where.home, journal.aside);
  const X = fs.existsSync(path.join(aside, 'app'));
  const A = fs.existsSync(where.app);
  const P = fs.existsSync(where.previousApp);
  if (X && !A && P) { fs.renameSync(where.previousApp, where.app); fs.renameSync(path.join(aside, 'app'), where.previousApp); }
  else if (X && A && !P) fs.renameSync(path.join(aside, 'app'), where.previousApp);
  else if (!X && A && P && fs.existsSync(path.join(where.app, MARKER))) {
    // Nothing had moved: the newer app is still in place.
    fs.rmSync(path.join(where.app, MARKER), {force: true});
    fs.rmSync(where.journal, {force: true});
    try { fs.rmdirSync(aside); } catch (err) { /* left */ }
    return 'undone';
  }
  settle(where, journal, aside);
  return 'finished';
}

async function rollback({yes = false}, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const fail = (s, code = 1) => { io.stderr.write(`ch-local: ${s}\n`); return code; };
  const where = layout(io.env, io.homedir);
  if (!fs.existsSync(where.home)) return fail('nothing is installed; there is nothing to roll back');

  return withLock(where, io, async () => {
    // Read inside the lock, so no install or add-pack lands in between.
    if (fs.existsSync(where.journal)) {
      let journal;
      try { journal = JSON.parse(fs.readFileSync(where.journal, 'utf8')); } catch (err) { return fail(`${where.journal} is not readable; restore by hand`); }
      const how = finish(where, journal);
      say(how === 'finished' ? `finished the interrupted rollback to ${versionOf(journal.restored)}` : 'the interrupted rollback had moved nothing; nothing changed');
      return 0;
    }
    const plain = {...where, journal: null};
    let current;
    try { current = record.readRecord(plain); } catch (err) { return fail(err.message); }
    if (current == null) return fail('nothing is installed; there is nothing to roll back');
    if (!fs.existsSync(where.previousApp) || !fs.existsSync(where.previousRecord)) return fail('no previous release is kept: rollback returns to the release an install replaced');
    let older;
    try { older = record.readRecord({packs: where.previousRecord}); } catch (err) { return fail(`the kept release's record: ${err.message}`); }
    if (older == null) return fail('no previous release is kept: rollback returns to the release an install replaced');
    if (older.release == null) return fail('the kept release predates rollback, so it could not return you here; install it again instead');

    const security = current.release != null ? current.release.security : null;
    const from = versionOf(current);
    const to = versionOf(older);
    if (security != null && !yes) {
      if (io.interactive !== true) return fail(`ch-local ${from} is a security fix (${security.fixes}); without a terminal, rollback needs --yes`);
      const answer = String(await io.ask(`ch-local ${from} is a security fix: ${security.fixes}. Roll back to ${to} anyway? (yes/no) `)).trim().toLowerCase();
      if (answer !== 'yes') { say('nothing changed'); return 1; }
    }

    // Packs the restored release does not have: recorded, not loaded.
    const held = {};
    for (const [name, p] of Object.entries(current.held || {})) if (!record.own(older.packs, name)) held[name] = p;
    for (const [name, p] of Object.entries(current.packs)) {
      if (!record.own(older.packs, name)) held[name] = {packages: p.packages, credentials: p.credentials, installedUnder: from};
    }
    const restored = {...record.withoutHeld(older), ...(Object.keys(held).length > 0 ? {held} : {})};
    const aside = `previous.${crypto.randomBytes(4).toString('hex')}`;
    const journal = {kept: record.withoutHeld(current), restored, aside, at: new Date().toISOString()};

    fs.writeFileSync(path.join(where.app, MARKER), journal.at);
    writeAtomic(where.journal, JSON.stringify(journal, null, 2) + '\n');
    const asideDir = path.join(where.home, aside);
    fs.mkdirSync(asideDir);
    const moved = swap(where, asideDir);
    if (moved.error != null) {
      if (moved.stuck) return fail(`rollback was interrupted (${moved.error.code || moved.error.message}); run \`ch-local rollback\` to finish it`);
      fs.rmSync(path.join(where.app, MARKER), {force: true});
      fs.rmSync(where.journal, {force: true});
      try { fs.rmdirSync(asideDir); } catch (err) { /* left */ }
      return fail(`could not swap the releases (${moved.error.code || moved.error.message}); is a client running it? nothing changed`);
    }
    settle(where, journal, asideDir);

    say(`rolled back from ch-local ${from} to ${to}: the runtime, packs and parts`);
    if (security != null) say(`undid the security fix in ch-local ${from} (${security.fixes})`);
    for (const [name, h] of Object.entries(held)) say(`the pack "${name}" needs ch-local ${h.installedUnder}; it stays recorded and is not loaded`);
    say('caches, usage records, settings and the identity secret are unchanged');
    say('`ch-local rollback` again returns to the newer release; if one pack got worse, `ch-local remove-pack <name>` on the newer release is the way');
    return 0;
  });
}

module.exports = {rollback};
