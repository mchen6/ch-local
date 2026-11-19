'use strict';
// ch-local's restore against the runtime's rule, so the two can't drift
// again: countinghouse's lib/session-transport/restore.js refuses a restore
// whose keys are not exactly {id, type, sessions, declines, reset}
// (CONTROL_BAD_RESTORE), and then serves with an empty table and no
// confirmation form for 30 minutes. ch-local sent no `reset`, and every
// restore on countinghouse master was refused (found by the shared-runtime
// acceptance run, M17). The rows are held to the shared vectors'
// restoreRows (test/vectors/restore-rows.json, copied from countinghouse):
// every accepted row, told to the table, is restored exactly; every
// refused one is not.
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
// its row, the rest taken. A runtime never tells one (it is refused as
// told); a handoff that carries one (seed) gives exactly the row taken,
// and the session is told once (reset).
test('every dropped vector row: refused as told, and a handoff gives exactly the state taken, its session told once', () => {
  for (const {why, row, taken} of restoreRows.dropped) {
    const told = createSessionTable({warn: () => {}});
    assert.strictEqual(told.told({type: 'session-resume', session: row.session, hash: row.resume}), true, why);
    assert.strictEqual(told.told({type: 'session-state', session: row.session, state: row.state}), false, `${why}: never told by a runtime`);
    const t = createSessionTable({warn: () => {}});
    t.seed({sessions: [row], declines: []});
    const out = t.restore();
    // (taken: the row's state as the runtime takes it)
    assert.deepStrictEqual(out.sessions, [{session: row.session, resume: row.resume, state: taken}], why);
    assert.deepStrictEqual(out.reset, [row.session], `${why}: told once`);
  }
});
