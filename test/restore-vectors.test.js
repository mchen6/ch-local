'use strict';
require('./tmp-dirs');
// ch-local's restore against the runtime's rule, so the two can't drift
// again: countinghouse's lib/session-transport/restore.js refuses a restore
// whose keys are not exactly {id, type, sessions, declines, reset}
// (CONTROL_BAD_RESTORE), and then serves with an empty table and no
// confirmation form for 30 minutes. ch-local sent no `reset`, and every
// restore on countinghouse master was refused (found by the shared-runtime
// acceptance run, M17). The rows are held to the shared vectors'
// restoreRows (test/vectors/restore-rows.json, copied from countinghouse):
// every accepted row, told to the table, is restored exactly; every
// refused one is not; a dropped one is handed on for the runtime to drop; a
// mapped one (M5b) is handed on as told; a kindsDropped one is handed on
// unchanged, for the runtime to take its unknown kind out.
const test = require('node:test');
const assert = require('node:assert');
const {createSessionTable} = require('../lib/session-table');
const {restoreRows} = require('./vectors/restore-rows.json');

// the keys restore.js requires, `id` added by the control channel's request
const RUNTIME_KEYS = ['declines', 'id', 'reset', 'sessions', 'type'];

test('the restore message has exactly the keys the runtime requires, with the id the control channel adds', () => {
  const msg = Object.assign({id: 'r1'}, createSessionTable().restore());
  assert.deepStrictEqual(Object.keys(msg).sort(), RUNTIME_KEYS);
  assert.deepStrictEqual(msg.reset, [], 'the daemon resets no session today (a handoff that drops loosenings is C3b\'s)');
});

test('every accepted vector row, told to the table, is restored exactly', () => {
  const t = createSessionTable();
  for (const row of restoreRows.accepted) {
    t.told({type: 'session-state', session: row.session, state: row.state});
    t.told({type: 'session-resume', session: row.session, hash: row.resume});
  }
  const got = t.restore().sessions;
  for (const row of restoreRows.accepted) assert.deepStrictEqual(got.find((r) => r.session === row.session), row, row.session);
  assert.strictEqual(got.length, restoreRows.accepted.length);
});

test('no refused vector row is restored', () => {
  for (const {why, row} of restoreRows.refused) {
    const t = createSessionTable();
    t.told({type: 'session-state', session: row.session, state: row.state});
    t.told({type: 'session-resume', session: row.session, hash: row.resume});
    assert.ok(!t.restore().sessions.some((r) => JSON.stringify(r) === JSON.stringify(row)), why);
  }
});

// M5a (#438): a well-formed pack.* override from before it is dropped from
// its row by the runtime, the rest taken, and the session told once naming
// the packs. A runtime never tells one (refused as told); a handoff that
// carries one (seed) hands the row on as it is, for the runtime to drop and
// tell: the vector's `taken` is that row without it.
test('every dropped vector row: refused as told, and a handoff hands it on whole for the runtime to drop (taken is the rest)', () => {
  for (const {why, row, taken} of restoreRows.dropped) {
    const told = createSessionTable({warn: () => {}});
    assert.strictEqual(told.told({type: 'session-resume', session: row.session, hash: row.resume}), true, why);
    assert.strictEqual(told.told({type: 'session-state', session: row.session, state: row.state}), false, `${why}: never told by a runtime`);
    const t = createSessionTable({warn: () => {}});
    t.seed({sessions: [row], declines: []});
    const out = t.restore();
    assert.deepStrictEqual(out.sessions, [row], `${why}: handed on as it is`);
    assert.deepStrictEqual(out.reset, [], `${why}: the runtime tells it, naming the packs`);
    // (taken: the state as the runtime takes it, the stale override dropped)
    const withoutPacks = {...row.state, overrides: row.state.overrides.filter((o) => !o.name.startsWith('pack.'))};
    assert.deepStrictEqual(withoutPacks, taken, why);
  }
});

// the medium on 5b, 1 and 5: a refused row is refused by a handoff too: a
// pack.* override not of the pack form's shape refuses the whole row, never
// stripped and taken
test('every refused vector row with a pack.* override is refused by a handoff too, never taken without it', () => {
  const packRows = restoreRows.refused.filter(({row}) => row != null && row.state != null && Array.isArray(row.state.overrides) && row.state.overrides.some((o) => o != null && typeof o.name === 'string' && o.name.startsWith('pack.')));
  assert.ok(packRows.length > 0, 'the vectors hold one');
  for (const {why, row} of packRows) {
    const t = createSessionTable({warn: () => {}});
    t.seed({sessions: [row], declines: []});
    assert.deepStrictEqual(t.restore().sessions, [], why);
  }
});

// M5b (countinghouse #449): a row of the kind pack is the runtime's to map
// to enabled, deduped, a lock winning (the vector's `taken`). ch-local
// hands it on as it was told, by a runtime or by a previous daemon's
// handoff, so a runtime before M5b takes it as it is (the Reviewer's
// ruling: ch-local never maps a kind).
test('every mapped vector row: told or seeded, handed on as it was, for the runtime to map', () => {
  for (const {why, row} of restoreRows.mapped) {
    const told = createSessionTable({warn: () => {}});
    assert.strictEqual(told.told({type: 'session-resume', session: row.session, hash: row.resume}), true, why);
    assert.strictEqual(told.told({type: 'session-state', session: row.session, state: row.state}), true, why);
    assert.deepStrictEqual(told.restore().sessions, [row], `${why}: told, handed on as told`);
    const seeded = createSessionTable({warn: () => {}});
    assert.deepStrictEqual(seeded.seed({sessions: [row], declines: []}), {kept: 1, loosened: 0}, why);
    assert.deepStrictEqual(seeded.restore().sessions, [row], `${why}: seeded, handed on as it was`);
  }
});

// A kind the runtime has none of (of a kind's shape) is taken out of its
// row there (the vector's `taken`). For ch-local such a kind is most likely
// one a newer runtime knows and enforces, so it hands the row on exactly as
// told, told or seeded, and a decline of it too: dropping what it doesn't
// know is the runtime's job (the Reviewer's high review of #96).
test('every kindsDropped vector row: told or seeded, handed on unchanged, for the runtime to take the unknown kind out', () => {
  assert.ok(restoreRows.kindsDropped.length > 0);
  for (const {why, row} of restoreRows.kindsDropped) {
    const told = createSessionTable({warn: () => {}});
    told.told({type: 'session-resume', session: row.session, hash: row.resume});
    assert.strictEqual(told.told({type: 'session-state', session: row.session, state: row.state}), true, `${why}: kept as told`);
    assert.deepStrictEqual(told.restore().sessions, [row], `${why}: told, handed on unchanged`);
    const seeded = createSessionTable({warn: () => {}});
    assert.deepStrictEqual(seeded.seed({sessions: [row], declines: []}), {kept: 1, loosened: 0}, why);
    assert.deepStrictEqual(seeded.restore().sessions, [row], `${why}: seeded, handed on unchanged`);
  }
  // a decline of such a kind is kept and handed on
  const t = createSessionTable({warn: () => {}});
  const at = Date.now();
  assert.strictEqual(t.told({type: 'decline', kind: 'locale', at}), true);
  assert.deepStrictEqual(t.restore().declines, [{kind: 'locale', at}]);
});
