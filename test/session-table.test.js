'use strict';
require('./tmp-dirs');
// lib/session-table.js: ch-local daemon's in-memory session table (C3), in
// the shapes agreed with countinghouse (#255, N3, #252 rev 2). The runtime
// refuses a whole restore over one bad row, so the table keeps only what
// the runtime's check (lib/session-transport/restore.js) accepts.
const test = require('node:test');
const assert = require('node:assert');
const {createSessionTable, MAX_ROWS, MAX_DECLINES, DECLINE_KEEP_MS, EMPTY_STATE} = require('../lib/session-table');

const ID = (n) => n.toString(16).padStart(32, '0');
const HASH = 'f'.repeat(64);
const HASH2 = HASH.replace(/f$/, 'e');
const STATE = {overrides: [{name: 'requestTimeout', value: 120000, loosening: true, over: 30000, version: null}], locks: ['pack'], formsLeft: 2};

test('a fresh table restores empty', () => {
  assert.deepStrictEqual(createSessionTable().restore(), {type: 'restore', sessions: [], declines: [], reset: []});
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

test('a state the runtime would refuse is never kept, and drops that session\'s whole row', () => {
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
  assert.deepStrictEqual(t.restore().sessions, [], 'the whole row goes (#34 review): its resume is refused, and the shim replays only-tighter');
});

// B's next export (the distinct kinds with one unanswered form): an optional
// `unanswered`, the known kind names (module among them), distinct; any
// other key still drops the row.
test('a state with unanswered is kept; a bad unanswered, or an unknown key beside it, drops the row', () => {
  const t = createSessionTable({warn: () => {}});
  t.told({type: 'session-resume', session: ID(1), hash: HASH});
  // a kind not locked (STATE locks pack), with a form spent (formsLeft 2),
  // as the runtime requires
  const withIt = Object.assign({}, STATE, {unanswered: ['maxOutputBytes', 'requestTimeout']});
  assert.strictEqual(t.told({type: 'session-state', session: ID(1), state: withIt}), true);
  assert.deepStrictEqual(t.restore().sessions, [{session: ID(1), resume: HASH, state: withIt}]);
  // module's, and every kind at once (none locked, a form spent): kept, as
  // the runtime's restore.js keeps them
  for (const unanswered of [['module'], ['maxOutputBytes', 'module', 'pack', 'requestTimeout']]) {
    const k = createSessionTable({warn: () => {}});
    k.told({type: 'session-resume', session: ID(3), hash: HASH});
    const st = {overrides: [], locks: [], formsLeft: 0, unanswered};
    assert.strictEqual(k.told({type: 'session-state', session: ID(3), state: st}), true, JSON.stringify(unanswered));
  }
  // a kind of a kind's shape ch-local has none of is taken out, the row kept
  // (the shared vectors' kindsDropped); an unanswered list it empties goes
  const w = createSessionTable({warn: () => {}});
  w.told({type: 'session-resume', session: ID(4), hash: HASH});
  assert.strictEqual(w.told({type: 'session-state', session: ID(4), state: Object.assign({}, STATE, {unanswered: ['other']})}), true);
  assert.deepStrictEqual(w.restore().sessions[0].state, STATE, 'the unknown kind out, its list with it');
  for (const unanswered of [['other-kind'], ['pack', 'pack'], 'pack', [1], ['pack', 'maxOutputBytes', 'requestTimeout', 'pack'], ['other', 'other']]) {
    const u = createSessionTable({warn: () => {}});
    u.told({type: 'session-resume', session: ID(2), hash: HASH});
    assert.strictEqual(u.told({type: 'session-state', session: ID(2), state: Object.assign({}, STATE, {unanswered})}), false, JSON.stringify(unanswered));
  }
  const v = createSessionTable({warn: () => {}});
  v.told({type: 'session-resume', session: ID(3), hash: HASH});
  assert.strictEqual(v.told({type: 'session-state', session: ID(3), state: Object.assign({}, STATE, {unanswered: ['pack'], nonce: 'x'})}), false, 'still no other key');
  assert.deepStrictEqual(v.restore().sessions, []);
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

test('declines: a module setting\'s are the one kind module (the runtime\'s), kept as told', () => {
  const now = 1000000000000;
  const t = createSessionTable({now: () => now});
  assert.strictEqual(t.told({type: 'decline', kind: 'module', at: now}), true);
  assert.deepStrictEqual(t.restore().declines, [{kind: 'module', at: now}]);
});

test('declines: the runtime\'s kinds, a past epoch ms; kept DECLINE_KEEP_MS; at most MAX_DECLINES, the newest', () => {
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

// countinghouse's UserWindow.load (lib/settings-confirm.js LOAD_KEEP_MS)
// takes the declines of two 30-minute windows: a lock runs 30 minutes from
// its third decline, so declines at 0, 0 and 29 min lock until 59. A restart
// at 31 must still be handed all three, or the lock ends 28 minutes early.
test('declines are kept two windows (60 minutes): one 59 minutes old reaches a restart, one 61 minutes old does not', () => {
  let now = 1000000000000;
  const t = createSessionTable({now: () => now});
  assert.strictEqual(DECLINE_KEEP_MS, 60 * 60 * 1000);
  const old = now;
  assert.strictEqual(t.told({type: 'decline', kind: 'pack', at: old}), true);
  now = old + 59 * 60 * 1000;
  assert.deepStrictEqual(t.restore().declines, [{kind: 'pack', at: old}], '59 minutes old: still handed to a restart');
  now = old + 61 * 60 * 1000;
  assert.deepStrictEqual(t.restore().declines, [], '61 minutes old: gone');
});

test('clear() empties the table (a restore the runtime refused, #34 review)', () => {
  const t = createSessionTable();
  t.told({type: 'session-resume', session: ID(1), hash: HASH});
  t.told({type: 'decline', kind: 'pack', at: Date.now()});
  t.clear();
  assert.deepStrictEqual(t.restore(), {type: 'restore', sessions: [], declines: [], reset: []});
});

test('the shared vectors\' restoreRows (#270): each accepted row is kept as told, each refused one never (one shape with countinghouse\'s restore.js and B2)', () => {
  const V = require('./vectors/restore-rows.json').restoreRows;
  const t = createSessionTable({warn: () => {}});
  for (const row of V.accepted) {
    assert.strictEqual(t.told({type: 'session-resume', session: row.session, hash: row.resume}), true);
    assert.strictEqual(t.told({type: 'session-state', session: row.session, state: row.state}), true, JSON.stringify(row));
  }
  assert.deepStrictEqual(t.restore().sessions, V.accepted);
  // the table is fed by told messages and handoffs, never raw rows: whatever
  // a refused row's parts are, what it hands a runtime is never that row, and
  // is always exactly {session, resume, state}
  for (const c of V.refused) {
    const u = createSessionTable({warn: () => {}});
    u.seed({sessions: [c.row], declines: []});
    for (const out of u.restore().sessions) {
      assert.deepStrictEqual(Object.keys(out).sort(), ['resume', 'session', 'state'], c.why);
      assert.notDeepStrictEqual(out, c.row, `${c.why}: never handed on as it was`);
    }
  }
});

test('restore carries reset: the sessions a handoff took loosenings from, once (the Reviewer\'s ruling on #35)', () => {
  const t = createSessionTable();
  const state = {overrides: [{name: 'requestTimeout', value: 120000, loosening: true, over: 30000, version: null}], locks: [], formsLeft: 3};
  t.seed({sessions: [{session: ID(1), resume: HASH, state}, {session: ID(2), resume: HASH.replace(/f$/, 'e'), state: EMPTY_STATE}], declines: []});
  assert.deepStrictEqual(t.restore().reset, [ID(1)]);
  assert.deepStrictEqual(t.restore().reset, [], 'told once: the next runtime is not told again');
  assert.deepStrictEqual(createSessionTable().restore(), {type: 'restore', sessions: [], declines: [], reset: []});
});

// L3 (#413 section 10): a handoff from a daemon of the pack form keeps
// the kind pack as it was told, and hands a stale pack.* override on for the
// runtime to drop and tell. A runtime before M5b takes pack as it is; one
// with M5b (countinghouse #449) maps it to enabled on restore, per row,
// locks, declines and unanswered forms kept (the Reviewer's ruling), so
// ch-local hands on what it was told and never rewrites a kind.
test('seed keeps the kind pack as told, for the runtime to take or map; hands a stale pack.* override on for the runtime to drop and tell', () => {
  const t = createSessionTable({warn: () => {}});
  const at = Date.now();
  const state = {overrides: [
    {name: 'pack.weather', value: false, loosening: false, over: null, version: '1.0.0'},
    {name: 'requestTimeout', value: 20000, loosening: false, over: null, version: null}
  ], locks: ['pack', 'maxOutputBytes'], unanswered: [], formsLeft: 1};
  const other = {overrides: [], locks: [], unanswered: ['pack'], formsLeft: 2};
  const r = t.seed({sessions: [{session: ID(1), resume: HASH, state}, {session: ID(2), resume: HASH.replace(/f$/, 'e'), state: other}],
    declines: [{kind: 'pack', at}, {kind: 'module', at}]});
  assert.deepStrictEqual(r, {kept: 2, loosened: 0});
  const out = t.restore();
  const s1 = out.sessions.find((s) => s.session === ID(1)).state;
  assert.deepStrictEqual(s1.overrides, [{name: 'requestTimeout', value: 20000, loosening: false, over: null, version: null},
    {name: 'pack.weather', value: false, loosening: false, over: null, version: '1.0.0'}], 'the tightening kept; the stale pack override handed on for the runtime');
  assert.deepStrictEqual(s1.locks, ['pack', 'maxOutputBytes'], 'the kind pack as it is: a runtime before M5b takes it, one with M5b maps it to enabled');
  assert.deepStrictEqual(out.sessions.find((s) => s.session === ID(2)).state.unanswered, ['pack']);
  assert.deepStrictEqual(out.declines.map((d) => d.kind), ['pack', 'module']);
  assert.deepStrictEqual(out.reset, [], 'the runtime tells it, naming the pack (packsDropped)');
});

test('the table takes the kind enabled from a runtime that sends it', () => {
  const t = createSessionTable({warn: () => {}});
  assert.strictEqual(t.told({type: 'decline', kind: 'enabled', at: Date.now()}), true);
  assert.strictEqual(t.told({type: 'session-resume', session: ID(1), hash: HASH}), true);
  assert.strictEqual(t.told({type: 'session-state', session: ID(1), state: {overrides: [], locks: ['enabled'], formsLeft: 2}}), true);
});

// M5b (countinghouse #449): a session that declined an enabled.* form, or
// left one unanswered, or is locked from them, keeps that across a daemon's
// handoff, as told: restored to the runtime, and seeded into the next
// daemon's table and restored again, never dropped.
test('a handoff keeps the kind enabled: a lock, an unanswered form and a decline, restored and seeded on as told', () => {
  const at = Date.now();
  const t = createSessionTable({warn: () => {}});
  const locked = {overrides: [], locks: ['enabled'], formsLeft: 1};
  const asking = {overrides: [], locks: [], unanswered: ['enabled'], formsLeft: 2};
  t.told({type: 'session-resume', session: ID(1), hash: HASH});
  t.told({type: 'session-state', session: ID(1), state: locked});
  t.told({type: 'session-resume', session: ID(2), hash: HASH2});
  t.told({type: 'session-state', session: ID(2), state: asking});
  assert.strictEqual(t.told({type: 'decline', kind: 'enabled', at}), true);
  const first = t.restore();
  assert.deepStrictEqual(first.sessions, [{session: ID(1), resume: HASH, state: locked}, {session: ID(2), resume: HASH2, state: asking}]);
  assert.deepStrictEqual(first.declines, [{kind: 'enabled', at}]);
  // the next daemon: seeded with what this one handed on
  const next = createSessionTable({warn: () => {}});
  assert.deepStrictEqual(next.seed({sessions: first.sessions, declines: first.declines}), {kept: 2, loosened: 0});
  const second = next.restore();
  assert.deepStrictEqual(second.sessions, first.sessions);
  assert.deepStrictEqual(second.declines, first.declines);
});

