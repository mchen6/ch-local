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
// the running (bundled) release: its pins and its descriptions of them
const running = (over = {}) => ({pins: {[A]: {version: '1.0.0', integrity: integrityOf(A, '1.0.0')}, [P]: {version: '2.0.0', integrity: integrityOf(P, '2.0.0')}, ...over}, modules: {[A]: DA, [P]: DP}});

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
  assert.strictEqual(installedDescription(where, record, {pins: {}, modules: {}}).modules[P], null, 'no running pin');
  fs.unlinkSync(path.join(home, 'module-store', ...P.split('/'), '2.0.0.json'));
  assert.strictEqual(installedDescription(where, record, running()).modules[P], null, 'no marker');
  assert.deepStrictEqual(installedDescription(where, null, running()), {packs: {}, modules: {}});
});

// the Reviewer's high on L4, 4: a pack the record has withdrawn is not
// running: its withdrawn modules are not described, so a release listing it
// again adds them
test('a pack the record has withdrawn: marked withdrawn, its withdrawn modules left out', () => {
  const home = tmp('ch-home-');
  storeModule(home, A, '1.0.0');
  storeModule(home, P, '2.0.0');
  const record = {packs: {a: {modules: {[A]: '1.0.0'}}, b: {modules: {[P]: '2.0.0'}}}, modules: {[A]: {version: '1.0.0'}, [P]: {version: '2.0.0'}}, withdrawn: [P]};
  const d = installedDescription(layout({COUNTINGHOUSE_HOME: home}), record, running());
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
