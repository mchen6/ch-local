'use strict';
require('./tmp-dirs');
const {unhomed} = require('./unhomed');

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
    assert.deepStrictEqual([u.kind, unhomed(u.line)], ['missing', 'not loading ch-pack-a: its files are missing; run `npx @countinghouse\/ch-local install` again']);
  }
  // not listed by the release: withdrawn (section 9.7's sentence), before the ceiling
  {
    const {where, record} = home();
    const release = releaseOf({b: PACKS.b});
    const u = availability(where, record, {release, seams: all}).unavailable.get(A);
    assert.strictEqual(u.kind, 'withdrawn');
    assert.strictEqual(unhomed(u.line), 'module ch-pack-a was withdrawn in this release and was not started; `npx @countinghouse\/ch-local remove-pack a` removes it');
  }
  // at another version than the release's pin
  {
    const {where, record} = home();
    const release = releaseOf(PACKS);
    release.pins[A] = {version: '1.1.0'};
    const u = availability(where, record, {release, seams: all}).unavailable.get(A);
    assert.deepStrictEqual([u.kind, unhomed(u.line)], ['pin', 'not loading ch-pack-a: 1.0.0 is installed and this release pins 1.1.0; run `npx @countinghouse\/ch-local install` again']);
  }
  // then the seams, in order
  const {where, record} = home();
  const r = releaseOf(PACKS);
  assert.strictEqual(availability(where, record, {release: r, seams: all}).unavailable.get(A).kind, 'ceiling');
  assert.strictEqual(availability(where, record, {release: r, seams: {...all, ceiling: () => null}}).unavailable.get(A).kind, 'off');
  const cred = availability(where, record, {release: r, seams: {...NONE, credential: (m) => (m === A ? 'no credential' : null)}}).unavailable.get(A);
  assert.deepStrictEqual([cred.kind, cred.line], ['credential', 'not loading ch-pack-a: no credential']);
});

test('a module whose part is not available is not either, its caller saying which and why; the others load', () => {
  const {where, record} = home();
  fs.rmSync(path.join(where.moduleStore, '@t', 'ch-step-y', '1.0.0.json'));
  const av = availability(where, record, {release: releaseOf(PACKS), seams: NONE});
  assert.deepStrictEqual(av.units.map((u) => u.name), [A]);
  const u = av.unavailable.get(B);
  assert.strictEqual(u.kind, 'calls');
  assert.strictEqual(unhomed(u.line), 'not loading ch-pack-b: it calls ch-step-y, which is missing from the module store; run `npx @countinghouse\/ch-local install` again');
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

test('a top-level module two packs record is one unit, loaded once, asked of the seams once', () => {
  const packs = {a: {[A]: '1.0.0', [X]: '1.0.0'}, c: {[A]: '1.0.0', [X]: '1.0.0'}};
  const {where, record} = home({packs});
  const seen = [];
  const av = availability(where, record, {release: releaseOf(packs), seams: {...NONE, off: (m, p) => { seen.push([m, p]); return null; }}});
  assert.deepStrictEqual(av.units.map((u) => u.name), [A]);
  assert.deepStrictEqual(av.units[0].packs, ['a', 'c']);
  assert.deepStrictEqual(seen.map(([m]) => m), [A], 'by module (L2b): once');
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

// a credential is its declaring module's, a part's included (L5a): every
// module that would otherwise load is asked, callees first; one turned off
// is not
test('the credential is asked last, of every module that would otherwise load, parts included, callees first', () => {
  const {where, record} = home();
  const asked = [];
  availability(where, record, {release: releaseOf(PACKS), seams: {...NONE, off: (m) => (m === A ? 'off' : null), credential: (m) => { asked.push(m); return null; }}});
  assert.deepStrictEqual(asked, [X, Y, B]);
});

// the medium review of L2a, 1: a pack whose modules declare no role is
// never past its seams: its first module is its scenario, the rest parts
test('a pack whose modules declare no role: its first is top-level and goes through the seams; the others are parts', () => {
  const N = '@t/n-main';
  const M = '@t/n-helper';
  const packs = {n: {[N]: '1.0.0', [M]: '1.0.0'}};
  const dir = tmp('ch-avail-');
  const where = layout({COUNTINGHOUSE_HOME: dir});
  storeModule(dir, N, '1.0.0', {countinghouse: {calls: ['n-helper/s.go']}});
  storeModule(dir, M, '1.0.0');
  const record = writeHome(dir, packs);
  const av = availability(where, record, {release: releaseOf(packs), seams: {...NONE, off: (m) => (m === N ? 'it is turned off' : null)}});
  assert.deepStrictEqual(av.units, []);
  assert.deepStrictEqual([...av.unavailable.keys()], [N]);
  assert.strictEqual(av.unavailable.get(N).kind, 'off');
  const on = availability(where, record, {release: releaseOf(packs), seams: NONE});
  assert.deepStrictEqual(on.units.map((u) => [u.name, u.packs, Object.keys(u.modules).sort()]), [[N, ['n'], [M, N].sort()]]);
});

// the medium review of L2a, 2: a cycle never caches a module available
// that reaches an unavailable one
test('a cycle that reaches a module not installed leaves every module of it unavailable', () => {
  const {where, record} = home({calls: {[A]: ['scenario', ['ch-pack-b/s.go', 'ch-step-z/s.go']], [B]: ['scenario', ['ch-pack-a/s.go']]}});
  const av = availability(where, record, {release: releaseOf(PACKS), seams: NONE});
  assert.deepStrictEqual(av.units, []);
  assert.strictEqual(av.unavailable.get(A).line, 'not loading ch-pack-a: it calls ch-step-z, which is not installed');
  assert.strictEqual(av.unavailable.get(B).line, 'not loading ch-pack-b: it calls ch-pack-a, which calls ch-step-z, which is not installed');
});

// the high review of L2a, 1: a top-level module without its credential is
// not available to a module that calls it either
test('a module that calls a top-level module without its credential is not available', () => {
  const {where, record} = home({calls: {[A]: ['scenario', ['ch-step-x/s.go', 'ch-pack-b/s.go']]}});
  const av = availability(where, record, {release: releaseOf(PACKS), seams: {...NONE, credential: (m) => (m === B ? 'set B_TOKEN' : null)}});
  assert.deepStrictEqual(av.units, []);
  assert.strictEqual(av.unavailable.get(B).line, 'not loading ch-pack-b: set B_TOKEN');
  assert.strictEqual(av.unavailable.get(A).line, 'not loading ch-pack-a: it calls ch-pack-b, which is not available (set B_TOKEN)');
});

// L2b (#413 sections 5.1, 5.2 and 8): the seams by module. Off: a top-level
// module's enabled.*, a leftover pack.* off winning; the ceiling: the
// operator's modules list, for every module, a part included
test('module seams: off by enabled.* or a leftover pack.* off (off wins); the ceiling by the modules list; untrusted allows none', () => {
  const {moduleSeams} = require('../lib/module-seams');
  const record = {packs: {a: {modules: {[A]: '1.0.0', [X]: '1.0.0'}}}, modules: {[A]: {version: '1.0.0', role: 'scenario'}, [X]: {version: '1.0.0', role: 'part'}}};
  const seams = (values, ceiling = {state: 'none'}) => moduleSeams({settings: {version: 1, values}, ceiling, record});
  assert.strictEqual(seams({}).off(A), null);
  assert.strictEqual(seams({[`enabled.${A}`]: false}).off(A), `it is turned off (\`npx @countinghouse\/ch-local settings set enabled.${A} on\`)`);
  assert.match(seams({'pack.a': false, [`enabled.${A}`]: true}).off(A), /it is turned off/, 'off wins');
  const only = {state: 'trusted', ceiling: {modules: [A]}};
  assert.strictEqual(seams({}, only).ceiling(A), null);
  assert.strictEqual(seams({}, only).ceiling(X), 'it is not on the operator\'s list', 'a part too');
  assert.match(seams({}, {state: 'untrusted', file: '/etc/c.json', problem: 'bad'}).ceiling(A), /cannot be trusted \(bad\), so no module loads/);
});

test('a top-level module that calls a part not on the operator\'s list is not available, and says so', () => {
  const {where, record} = home({calls: {[A]: ['scenario', ['ch-step-x/s.go']]}});
  const {moduleSeams} = require('../lib/module-seams');
  const av = availability(where, record, {release: releaseOf(PACKS), seams: Object.assign(moduleSeams({settings: {version: 1, values: {}}, ceiling: {state: 'trusted', ceiling: {modules: [A, B]}}, record}), {credential: () => null})});
  assert.ok(!av.units.some((u) => u.name === A));
  assert.strictEqual(av.unavailable.get(A).line, 'not loading ch-pack-a: it calls ch-step-x, which is not available (it is not on the operator\'s list)');
});

// the medium review of the high round, 8: the credential is asked only of
// what would otherwise load, and never said over the real blocker
test('a module that cannot load for another reason is never asked its credential, and says that reason', () => {
  const {where, record} = home({calls: {[A]: ['scenario', ['ch-step-z/s.go']]}});
  const asked = [];
  const av = availability(where, record, {release: releaseOf(PACKS), seams: {...NONE, credential: (m) => { asked.push(m); return 'set A_TOKEN'; }}});
  assert.strictEqual(av.unavailable.get(A).line, 'not loading ch-pack-a: it calls ch-step-z, which is not installed');
  assert.ok(!asked.includes(A));
});

// the high review of L2a's medium round, 8: callees first, so a caller
// whose callee lacks its credential reports that, and is never asked its own
test('credentials are asked callees first: the caller reports its callee\'s missing credential', () => {
  const {where, record} = home({calls: {[A]: ['scenario', ['ch-step-x/s.go', 'ch-pack-b/s.go']]}});
  const asked = [];
  const av = availability(where, record, {release: releaseOf(PACKS), seams: {...NONE, credential: (m) => { asked.push(m); return m === B ? 'set B_TOKEN' : (m === A ? 'set A_TOKEN' : null); }}});
  assert.strictEqual(av.unavailable.get(A).line, 'not loading ch-pack-a: it calls ch-pack-b, which is not available (set B_TOKEN)');
  assert.ok(!asked.includes(A), JSON.stringify(asked));
});

// A-reason (#449's moduleMessages id 10): a caller's because, the module it
// calls directly that is turned off, only when that is all that keeps it
// from loading (the runtime then says "it calls <because>, which is turned
// off ... turning <because> on brings it back"; the medium on A-reason)
test('a caller\'s becauseOff: its direct callee turned off and its only blocker; never through a part, beside another blocker, or for itself', () => {
  const off = {...NONE, off: (m) => (m === B ? 'it is turned off' : null)};
  const direct = home({calls: {[A]: ['scenario', ['ch-pack-b/s.go', 'ch-step-x/s.go']], [B]: ['scenario', []]}});
  const d = availability(direct.where, direct.record, {release: releaseOf(PACKS), seams: off}).unavailable;
  assert.deepStrictEqual([d.get(A).kind, d.get(A).becauseOff], ['calls', B]);
  assert.strictEqual(d.get(B).becauseOff, null, 'turned off itself: no because');
  // through a part: a calls x, x calls b: "it calls ch-pack-b" would be false
  const chain = home({calls: {[A]: ['scenario', ['ch-step-x/s.go']], [X]: ['part', ['ch-pack-b/s.go']], [B]: ['scenario', []]}});
  const c = availability(chain.where, chain.record, {release: releaseOf(PACKS), seams: off}).unavailable.get(A);
  assert.deepStrictEqual([c.kind, c.root, c.becauseOff], ['calls', 'off', null]);
  // beside another blocker: turning b on would not bring a back
  const both = home({calls: {[A]: ['scenario', ['ch-pack-b/s.go', 'ch-step-y/s.go']], [B]: ['scenario', []]}});
  fs.rmSync(path.join(both.where.moduleStore, '@t', 'ch-step-y', '1.0.0.json'));
  assert.strictEqual(availability(both.where, both.record, {release: releaseOf(PACKS), seams: off}).unavailable.get(A).becauseOff, null);
  const gone = home({calls: {[A]: ['scenario', ['ch-pack-b/s.go', 'ch-nowhere/s.go']], [B]: ['scenario', []]}});
  assert.strictEqual(availability(gone.where, gone.record, {release: releaseOf(PACKS), seams: off}).unavailable.get(A).becauseOff, null, 'a callee not installed too');
  // a key missing for the caller, or for the module turned off: turning it
  // on would not bring the caller back (the medium on #98's high round, 1)
  for (const lacking of [A, B]) {
    const seams = {...off, credential: (m) => (m === lacking ? 'no key stored' : null)};
    assert.strictEqual(availability(direct.where, direct.record, {release: releaseOf(PACKS), seams}).unavailable.get(A).becauseOff, null, lacking);
  }
});

// A-firstrun d1 (the held-back file, countinghouse #490): a caller's via, the
// module at the bottom of its chain, so the runtime's overview names the
// module the user acts on (a credential added to it, turned on, installed);
// for a callee not installed, the name it calls, as it declares it
test('a caller\'s via: the module at the bottom of its chain, through parts; a callee not installed by its declared name; none on any other reason', () => {
  const cred = {...NONE, credential: (m) => (m === B ? 'set B_TOKEN' : null)};
  const chain = home({calls: {[A]: ['scenario', ['ch-step-x/s.go']], [X]: ['part', ['ch-pack-b/s.go']], [B]: ['scenario', []]}});
  const u = availability(chain.where, chain.record, {release: releaseOf(PACKS), seams: cred}).unavailable;
  assert.deepStrictEqual([u.get(A).kind, u.get(A).root, u.get(A).via], ['calls', 'credential', B]);
  assert.strictEqual(u.get(B).via, null, 'its own reason: no via');
  const gone = home({calls: {[A]: ['scenario', ['ch-nowhere/s.go']]}});
  const g = availability(gone.where, gone.record, {release: releaseOf(PACKS), seams: NONE}).unavailable.get(A);
  assert.deepStrictEqual([g.kind, g.root, g.via], ['calls', 'not installed', 'ch-nowhere']);
});
