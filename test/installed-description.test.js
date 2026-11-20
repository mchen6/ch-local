'use strict';
require('./tmp-dirs');
// lib/installed-description.js (#413 rev 3 sections 9.3 and 9.6; L4): what
// the home has installed, pins-shaped: each module the running release's
// description when it is verifiably that release's pin; unknown (null)
// otherwise.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {tmp} = require('./fake-io');
const {storeModule} = require('./store-helpers');
const {layout} = require('../lib/home');
const {installedDescription} = require('../lib/installed-description');

const A = '@countinghouse/ch-pack-a';
const P = '@countinghouse/ch-step-p';

const integrityOf = (name, version) => 'sha512-' + require('node:crypto').createHash('sha512').update(`${name}@${version}`).digest('base64');
const DA = {role: 'scenario', credentials: [], calls: [P], confirmSettings: {}};
const DP = {role: 'part', credentials: [{variable: 'P_TOKEN', origin: 'https://api.example.test'}], calls: [], confirmSettings: {}};
// the running (bundled) release: its packs, its pins and its descriptions
const running = (over = {}, packs = {a: {modules: [A, P]}}) => ({packs, pins: {[A]: {version: '1.0.0', integrity: integrityOf(A, '1.0.0')}, [P]: {version: '2.0.0', integrity: integrityOf(P, '2.0.0')}, ...over}, modules: {[A]: DA, [P]: DP}});

// the Reviewer's high on L4, 3: a module is described only when it is
// verifiably the running release's pin; the store's own files are never read
// as its description
test('a recorded module at the running pin, its marker naming the pin\'s integrity, is the running release\'s description; packs list their modules', () => {
  const home = tmp('ch-home-');
  // (the stored files say something else: never read)
  storeModule(home, A, '1.0.0', {countinghouse: {role: 'part'}});
  storeModule(home, P, '2.0.0');
  const record = {packs: {a: {modules: {[A]: '1.0.0', [P]: '2.0.0'}}}, modules: {[A]: {version: '1.0.0'}, [P]: {version: '2.0.0'}}};
  const d = installedDescription(layout({COUNTINGHOUSE_HOME: home}), record, running());
  assert.deepStrictEqual(d.packs, {a: {modules: [A, P]}});
  assert.deepStrictEqual(d.modules, {[A]: DA, [P]: DP});
});

test('off its pin, a marker naming other bytes, no marker, or no running pin: unknown (null), never a guess', () => {
  const home = tmp('ch-home-');
  storeModule(home, A, '0.9.0');
  storeModule(home, P, '2.0.0');
  const where = layout({COUNTINGHOUSE_HOME: home});
  const record = {packs: {a: {modules: {[A]: '0.9.0', [P]: '2.0.0'}}}, modules: {[A]: {version: '0.9.0'}, [P]: {version: '2.0.0'}}};
  assert.deepStrictEqual(installedDescription(where, record, running()).modules, {[A]: null, [P]: DP}, 'the version table keeps A off its pin');
  assert.strictEqual(installedDescription(where, record, running({[P]: {version: '2.0.0', integrity: integrityOf(P, 'other')}})).modules[P], null, 'other bytes');
  assert.strictEqual(installedDescription(where, record, {packs: {a: {modules: [A, P]}}, pins: {}, modules: {}}).modules[P], null, 'no running pin');
  fs.unlinkSync(path.join(home, 'module-store', ...P.split('/'), '2.0.0.json'));
  assert.strictEqual(installedDescription(where, record, running()).modules[P], null, 'no marker');
  // (a marker with no version directory is not whole: store wholeAt, the
  // Reviewer's high on #101, round 2)
  storeModule(home, P, '2.0.0');
  fs.rmSync(path.join(home, 'module-store', ...P.split('/'), '2.0.0'), {recursive: true});
  assert.strictEqual(installedDescription(where, record, running()).modules[P], null, 'no directory');
  assert.deepStrictEqual(installedDescription(where, null, running()), {packs: {}, modules: {}});
});

// the Reviewer's high on L4, 4, and on #101 round 2: what runs is start's
// rule (withdrawnNames): a pack the record has withdrawn, or one the running
// release does not list, is not running, and a module no running pack lists
// is not described, so a release serving it again adds them
test('a pack not running (withdrawn in the record, or not in the running release): marked withdrawn, its modules left out', () => {
  const home = tmp('ch-home-');
  storeModule(home, A, '1.0.0');
  storeModule(home, P, '2.0.0');
  const record = {packs: {a: {modules: {[A]: '1.0.0'}}, b: {modules: {[P]: '2.0.0'}}}, modules: {[A]: {version: '1.0.0'}, [P]: {version: '2.0.0'}}};
  const where = layout({COUNTINGHOUSE_HOME: home});
  // the running release lists only a
  assert.deepStrictEqual(installedDescription(where, record, running({}, {a: {modules: [A]}})).packs, {a: {modules: [A]}, b: {modules: [], withdrawn: true}});
  record.withdrawn = [P];
  const d = installedDescription(where, record, running({}, {a: {modules: [A]}, b: {modules: [P]}}));
  assert.deepStrictEqual(d.packs, {a: {modules: [A]}, b: {modules: [], withdrawn: true}});
  assert.deepStrictEqual(Object.keys(d.modules), [A]);
  const {additions} = require('../lib/release-pins');
  const next = {packs: {a: {modules: [A]}, b: {modules: [P]}}, modules: {[A]: DA, [P]: DP}};
  assert.deepStrictEqual(additions(d, next, ['a', 'b']).map((x) => x.line), [
    'b is served again: its modules start after the upgrade',
    'a module in b: @countinghouse/ch-step-p',
    'ch-step-p sends a key (P_TOKEN) to https://api.example.test'
  ]);
});

// the medium on L4, 1, and the Reviewer's high, 2: an installed module
// whose description is unknown is an addition, and every credential and
// call of its new version is listed, as for a new module
test('additions: an installed module described as unknown is an `unknown` item, then listed as a new module is', () => {
  const {additions} = require('../lib/release-pins');
  const K = '@countinghouse/ch-step-k';
  const none = {role: 'scenario', credentials: [], calls: [], confirmSettings: {}};
  const now = {packs: {a: {modules: [A, P, K]}}, modules: {[A]: none, [P]: null, [K]: none}};
  const next = {packs: {a: {modules: [A, P, K]}}, modules: {[A]: none, [P]: {role: 'part', credentials: [{variable: 'P_TOKEN', origin: 'https://api.example.test'}], calls: [K], confirmSettings: {mode: {default: 'ask'}}},
    [K]: {...none, credentials: [{variable: 'K_TOKEN', origin: 'https://k.example.test'}]}}};
  const found = additions(now, next, ['a']).filter((x) => x.module === P);
  assert.deepStrictEqual(found.map((x) => x.kind), ['unknown', 'credential', 'keyCaller']);
  assert.deepStrictEqual(found.map((x) => x.line), [
    'ch-step-p as installed can\'t be verified, so all of what this release has it do is listed',
    'ch-step-p sends a key (P_TOKEN) to https://api.example.test',
    'ch-step-p now calls ch-step-k, which holds a key'
  ]);
});

// the medium on #101 round 2, 1: the digest an upgrade judged a home by
// covers a rollback that moves no module (the runtime, the release, held)
test('judgedDigest: the same record, the same digest; the runtime, the release, held, a version or the withdrawn list changed, another', () => {
  const {judgedDigest} = require('../lib/module-record');
  const base = () => ({runtime: {versions: {'@countinghouse/ch-local': '1.2.0'}}, release: {version: '1.2.0', security: null}, packs: {a: {modules: {[A]: '1.0.0'}}}, modules: {[A]: {version: '1.0.0'}}, withdrawn: []});
  assert.strictEqual(judgedDigest(base()), judgedDigest(base()));
  const edits = [
    (r) => { r.runtime.versions['@countinghouse/ch-local'] = '1.1.0'; },
    (r) => { r.release = {version: '1.1.0', security: null}; },
    (r) => { r.held = {b: {modules: {[P]: '2.0.0'}}}; },
    (r) => { r.modules[A].version = '0.9.0'; },
    (r) => { r.withdrawn = [A]; }
  ];
  for (const e of edits) { const r = base(); e(r); assert.notStrictEqual(judgedDigest(r), judgedDigest(base()), String(e)); }
  assert.strictEqual(judgedDigest(null), null);
});

// a pack not running whose modules a running pack also lists is still
// served again: one `served` item, which holds (the medium on #101 round 2,
// 4, checked: it does)
test('a resumed pack whose modules a running pack shares: still "served again", so it holds', () => {
  const home = tmp('ch-home-');
  storeModule(home, A, '1.0.0');
  storeModule(home, P, '2.0.0');
  const record = {packs: {a: {modules: {[A]: '1.0.0', [P]: '2.0.0'}}, b: {modules: {[P]: '2.0.0'}}}, modules: {[A]: {version: '1.0.0'}, [P]: {version: '2.0.0'}}};
  const d = installedDescription(layout({COUNTINGHOUSE_HOME: home}), record, running({}, {a: {modules: [A, P]}}));
  const {additions} = require('../lib/release-pins');
  const next = {packs: {a: {modules: [A, P]}, b: {modules: [P]}}, modules: {[A]: DA, [P]: DP}};
  assert.deepStrictEqual(additions(d, next, ['a', 'b']).map((x) => x.kind), ['served', 'module']);
});
