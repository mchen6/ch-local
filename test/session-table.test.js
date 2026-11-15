'use strict';
// lib/session-table.js: ch-local daemon's in-memory session table (C3), in
// the shapes agreed with countinghouse (#255, N3, #252 rev 2). The runtime
// refuses a whole restore over one bad row, so the table keeps only what
// the runtime's check (lib/session-transport/restore.js) accepts.
const test = require('node:test');
const assert = require('node:assert');
const {createSessionTable, MAX_ROWS, MAX_DECLINES, DECLINE_KEEP_MS, EMPTY_STATE} = require('../lib/session-table');

const ID = (n) => n.toString(16).padStart(32, '0');
const HASH = 'f'.repeat(64);
const STATE = {overrides: [{name: 'requestTimeout', value: 120000, loosening: true, over: 30000, version: null}], locks: ['pack'], formsLeft: 2};

test('a fresh table restores empty', () => {
  assert.deepStrictEqual(createSessionTable().restore(), {type: 'restore', sessions: [], declines: []});
});

test('a session is restored once it has a resume hash: its latest hash and state; its end drops it', () => {
  const t = createSessionTable();
  assert.strictEqual(t.told({type: 'session-state', session: ID(1), state: STATE}), true);
  assert.deepStrictEqual(t.restore().sessions, [], 'no hash yet: nothing to resume by');
  t.told({type: 'session-resume', session: ID(1), hash: 'a'.repeat(64)});
  t.told({type: 'session-resume', session: ID(1), hash: HASH});
  t.told({type: 'session-resume', session: ID(2), hash: HASH.replace(/f$/, 'e')});
  assert.deepStrictEqual(t.restore().sessions, [{session: ID(1), resume: HASH, state: STATE}, {session: ID(2), resume: HASH.replace(/f$/, 'e'), state: EMPTY_STATE}]);
  t.told({type: 'session-gone', session: ID(2)});
  assert.deepStrictEqual(t.restore().sessions.map((r) => r.session), [ID(1)]);
});

test('the empty state is the runtime\'s fresh one', () => {
  assert.deepStrictEqual(EMPTY_STATE, {overrides: [], locks: [], formsLeft: 3});
});

test('a state the runtime would refuse is never kept, and drops that session\'s older one', () => {
  const t = createSessionTable({warn: () => {}});
  t.told({type: 'session-resume', session: ID(1), hash: HASH});
  t.told({type: 'session-state', session: ID(1), state: STATE});
  const bad = [
    {overrides: [], locks: [], formsLeft: 4},
    {overrides: [], locks: ['pack', 'pack'], formsLeft: 3},
    {overrides: [{name: 'secret', value: 1, loosening: false, over: null, version: null}], locks: [], formsLeft: 3},
    {overrides: [{name: 'pack.one', value: true, loosening: false, over: null, version: null}], locks: [], formsLeft: 3},
    {overrides: [{name: 'maxOutputBytes', value: 1, loosening: true, over: null, version: null}], locks: [], formsLeft: 3},
    {overrides: [], locks: [], formsLeft: 3, nonce: 'x'}
  ];
  for (const state of bad) {
    assert.strictEqual(t.told({type: 'session-state', session: ID(1), state}), false, JSON.stringify(state));
  }
  assert.deepStrictEqual(t.restore().sessions[0].state, EMPTY_STATE, 'the older state is dropped, never restored stale');
});

test('bad ids and hashes are refused; past the row cap a new session is not kept', () => {
  const t = createSessionTable({warn: () => {}});
  assert.strictEqual(t.told({type: 'session-resume', session: 'not-hex', hash: HASH}), false);
  assert.strictEqual(t.told({type: 'session-resume', session: ID(1), hash: 'F'.repeat(64)}), false);
  assert.strictEqual(t.told({type: 'session-resume', session: ID(1), hash: 'f'.repeat(63)}), false);
  assert.strictEqual(t.told({type: 'nonsense'}), false);
  assert.strictEqual(t.told(null), false);
  for (let i = 0; i < MAX_ROWS; i++) assert.strictEqual(t.told({type: 'session-resume', session: ID(i), hash: HASH}), true);
  assert.strictEqual(t.told({type: 'session-resume', session: ID(MAX_ROWS), hash: HASH}), false);
  assert.strictEqual(t.told({type: 'session-resume', session: ID(0), hash: HASH}), true, 'an existing one still updates');
  assert.strictEqual(t.size(), MAX_ROWS);
});

test('declines: the three kinds, a past epoch ms; kept 30 minutes; at most MAX_DECLINES, the newest', () => {
  let now = 1000000000000;
  const t = createSessionTable({now: () => now});
  assert.strictEqual(t.told({type: 'decline', kind: 'pack', at: now}), true);
  for (const bad of [{kind: 'other', at: now}, {kind: 'pack', at: -5}, {kind: 'pack', at: 1.5}, {kind: 'pack', at: now + 61000}, {kind: 'pack', at: now, session: ID(1)}]) {
    assert.strictEqual(t.told(Object.assign({type: 'decline'}, bad)), false, JSON.stringify(bad));
  }
  assert.deepStrictEqual(t.restore().declines, [{kind: 'pack', at: now}]);
  now += DECLINE_KEEP_MS + 1;
  assert.deepStrictEqual(t.restore().declines, []);
  for (let i = 0; i < MAX_DECLINES + 5; i++) t.told({type: 'decline', kind: 'requestTimeout', at: now});
  assert.strictEqual(t.restore().declines.length, MAX_DECLINES);
});
