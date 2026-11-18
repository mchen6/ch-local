'use strict';
// What loads, by module (#413 section 5.2; L2a): lib/availability.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {availability} = require('../lib/availability');
const {layout} = require('../lib/home');
const {tmp} = require('./fake-io');
const {storeModule, writeHome} = require('./store-helpers');

const A = '@t/ch-pack-a';
const B = '@t/ch-pack-b';
const X = '@t/ch-step-x';
const Y = '@t/ch-step-y';
const PACKS = {a: {[A]: '1.0.0', [X]: '1.0.0'}, b: {[B]: '2.0.0', [X]: '1.0.0', [Y]: '1.0.0'}};
const pinsOf = (packs) => Object.fromEntries(Object.values(packs).flatMap((ms) => Object.entries(ms)).map(([m, v]) => [m, {version: v}]));
const releaseOf = (packs) => ({packs: Object.fromEntries(Object.entries(packs).map(([p, ms]) => [p, {packages: Object.keys(ms)}])), pins: pinsOf(packs)});
const NONE = {ceiling: () => null, off: () => null, credential: () => null};

// a home: a calls x, b calls x and y; both installed and placed
function home({packs = PACKS, unreleased = false, calls = {}} = {}) {
  const dir = tmp('ch-avail-');
  const where = layout({COUNTINGHOUSE_HOME: dir});
  const roles = {[A]: ['scenario', ['ch-step-x/s.go']], [B]: ['scenario', ['ch-step-x/s.go', 'ch-step-y/s.go']], [X]: ['part', []], [Y]: ['part', []], ...calls};
  for (const ms of Object.values(packs)) {
    for (const [m, v] of Object.entries(ms)) {
      const [role, c] = roles[m] || ['part', []];
      storeModule(dir, m, v, {countinghouse: {role, calls: c}});
    }
  }
  const record = writeHome(dir, packs, {unreleased});
  return {where, record, dir};
}

test('every available top-level module is a unit with its closure; a part is never one', () => {
  const {where, record} = home();
  const av = availability(where, record, {release: releaseOf(PACKS), seams: NONE});
  assert.deepStrictEqual(av.units.map((u) => u.name), [A, B]);
  assert.deepStrictEqual(av.units[0].modules, {[A]: '1.0.0', [X]: '1.0.0'});
  assert.deepStrictEqual(Object.keys(av.units[1].modules).sort(), [B, X, Y].sort());
  assert.deepStrictEqual(av.units[0].packs, ['a']);
  assert.strictEqual(av.units[1].short, 'ch-pack-b');
  assert.strictEqual(av.unavailable.size, 0);
});

test('the first rule that fails is the reason: files, then the release, then the ceiling, off and the credential', () => {
  const all = {ceiling: () => 'the ceiling says no', off: () => 'it is turned off', credential: () => 'no credential'};
  // the files missing beat everything else
  {
    const {where, record} = home();
    fs.rmSync(path.join(where.moduleStore, '@t', 'ch-pack-a', '1.0.0.json'));
    const u = availability(where, record, {release: releaseOf(PACKS), seams: all}).unavailable.get(A);
    assert.deepStrictEqual([u.kind, u.line], ['missing', 'not loading ch-pack-a: its files are missing; run `ch-local install` again']);
  }
  // not listed by the release: withdrawn (section 9.7's sentence), before the ceiling
  {
    const {where, record} = home();
    const release = releaseOf({b: PACKS.b});
    const u = availability(where, record, {release, seams: all}).unavailable.get(A);
    assert.strictEqual(u.kind, 'withdrawn');
    assert.strictEqual(u.line, 'module ch-pack-a was withdrawn in this release and was not started; `ch-local remove-pack a` removes it');
  }
  // at another version than the release's pin
  {
    const {where, record} = home();
    const release = releaseOf(PACKS);
    release.pins[A] = {version: '1.1.0'};
    const u = availability(where, record, {release, seams: all}).unavailable.get(A);
    assert.deepStrictEqual([u.kind, u.line], ['pin', 'not loading ch-pack-a: 1.0.0 is installed and this release pins 1.1.0; run `ch-local install` again']);
  }
  // then the seams, in order
  const {where, record} = home();
  const r = releaseOf(PACKS);
  assert.strictEqual(availability(where, record, {release: r, seams: all}).unavailable.get(A).kind, 'ceiling');
  assert.strictEqual(availability(where, record, {release: r, seams: {...all, ceiling: () => null}}).unavailable.get(A).kind, 'off');
  const cred = availability(where, record, {release: r, seams: {...NONE, credential: () => 'no credential'}}).unavailable.get(A);
  assert.deepStrictEqual([cred.kind, cred.line], ['credential', 'not loading ch-pack-a: no credential']);
});

test('a module whose part is not available is not either, its caller saying which and why; the others load', () => {
  const {where, record} = home();
  fs.rmSync(path.join(where.moduleStore, '@t', 'ch-step-y', '1.0.0.json'));
  const av = availability(where, record, {release: releaseOf(PACKS), seams: NONE});
  assert.deepStrictEqual(av.units.map((u) => u.name), [A]);
  const u = av.unavailable.get(B);
  assert.strictEqual(u.kind, 'calls');
  assert.strictEqual(u.line, 'not loading ch-pack-b: it calls ch-step-y, which is missing from the module store; run `ch-local install` again');
  // a part is never said on its own: its callers say it
  assert.ok(!av.unavailable.has(Y));
});

test('a call to a module that is not installed, and a cycle of calls, are said, never followed forever', () => {
  const {where, record} = home({calls: {[A]: ['scenario', ['ch-step-z/s.go']], [X]: ['part', ['ch-step-y/s.go']], [Y]: ['part', ['ch-step-x/s.go']]}});
  const av = availability(where, record, {release: releaseOf(PACKS), seams: NONE});
  assert.strictEqual(av.unavailable.get(A).line, 'not loading ch-pack-a: it calls ch-step-z, which is not installed');
  assert.deepStrictEqual(av.units.map((u) => u.name), [B]);
  assert.deepStrictEqual(Object.keys(av.units[0].modules).sort(), [B, X, Y].sort());
});

test('a top-level module two packs record is one unit, loaded once, with both packs for the seams', () => {
  const packs = {a: {[A]: '1.0.0', [X]: '1.0.0'}, c: {[A]: '1.0.0', [X]: '1.0.0'}};
  const {where, record} = home({packs});
  const seen = [];
  const av = availability(where, record, {release: releaseOf(packs), seams: {...NONE, off: (m, p) => { seen.push([m, p]); return null; }}});
  assert.deepStrictEqual(av.units.map((u) => u.name), [A]);
  assert.deepStrictEqual(av.units[0].packs, ['a', 'c']);
  assert.deepStrictEqual(seen, [[A, ['a', 'c']]]);
});

test('a development home is exempt from the release rule; so is a record of another release (pins: false)', () => {
  const release = {packs: {}, pins: {}};
  {
    const {where, record} = home({unreleased: true});
    assert.deepStrictEqual(availability(where, record, {release, seams: NONE}).units.map((u) => u.name), [A, B]);
  }
  const {where, record} = home();
  assert.strictEqual(availability(where, record, {release, seams: NONE}).units.length, 0);
  assert.deepStrictEqual(availability(where, record, {release, seams: NONE, pins: false}).units.map((u) => u.name), [A, B]);
});

test('the credential is asked last, of what would otherwise load only', () => {
  const {where, record} = home();
  const asked = [];
  availability(where, record, {release: releaseOf(PACKS), seams: {...NONE, off: (m) => (m === A ? 'off' : null), credential: (m) => { asked.push(m); return null; }}});
  assert.deepStrictEqual(asked, [B]);
});
