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

// post-rel L4 baseline (ruled 11-20 on #101): the baseline is judged by the
// pins of the record's OWN release, read from the home's app when the
// running ch-local's bundled release is another; unknown when they can't
// be read
const {homeDescription, ownReleasePins} = require('../lib/installed-description');
const SELF = '@countinghouse/ch-local';
const pinOf = (name, version, n) => ({version, integrity: integrityOf(name, version), repository: `mchen6/${name.split('/').pop()}`, repositoryId: 4000000 + n, ownerId: 1168741,
  workflow: '.github/workflows/publish.yml', tag: `v${version}`});
// the home's own release, as its pins file: packs a, its two modules pinned
const ownDoc = () => ({...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8')),
  packs: {a: {modules: [A, P]}}, modules: {[A]: DA, [P]: DP}, pins: {[A]: pinOf(A, '1.0.0', 1), [P]: pinOf(P, '2.0.0', 2)}});
// <home>/app's ch-local: its package.json and lib/release-pins.json
function app(home, {version = '0.9.0', name = SELF, doc = ownDoc(), pinsText = null} = {}) {
  const dir = path.join(home, 'app', 'node_modules', ...SELF.split('/'));
  fs.mkdirSync(path.join(dir, 'lib'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version}));
  fs.writeFileSync(path.join(dir, 'lib', 'release-pins.json'), pinsText != null ? pinsText : JSON.stringify(doc));
  return dir;
}
// a home holding the own release's modules, recorded as ch-local 0.9.0
function ownHome({release = {version: '0.9.0', security: null}} = {}) {
  const home = tmp('ch-home-');
  storeModule(home, A, '1.0.0');
  storeModule(home, P, '2.0.0');
  const record = {runtime: {versions: {[SELF]: '0.9.0'}}, release, packs: {a: {modules: {[A]: '1.0.0', [P]: '2.0.0'}}}, modules: {[A]: {version: '1.0.0'}, [P]: {version: '2.0.0'}}};
  return {home, where: layout({COUNTINGHOUSE_HOME: home}), record};
}
// the running ch-local's bundled release: another version, pinning other bytes
const bundled = () => ({release: {version: '1.4.0', security: null}, packs: {a: {modules: [A, P]}},
  pins: {[A]: {version: '1.1.0', integrity: integrityOf(A, '1.1.0')}, [P]: {version: '2.1.0', integrity: integrityOf(P, '2.1.0')}}, modules: {[A]: DA, [P]: DP}});

test('a ch-local whose bundled release is another judges the home by its own release\'s pins, from the app: described (by the bundled pins, as before, every module unknown)', () => {
  const {home, where, record} = ownHome();
  app(home);
  assert.deepStrictEqual(installedDescription(where, record, bundled()).modules, {[A]: null, [P]: null}, 'the bundled pins: what main judged by');
  const d = homeDescription(where, record, bundled());
  assert.deepStrictEqual(d.modules, {[A]: DA, [P]: DP});
  assert.deepStrictEqual(d.packs, {a: {modules: [A, P]}});
  assert.deepStrictEqual(Object.keys(ownReleasePins(where, record, bundled())), ['packs', 'modules', 'pins']);
  // a record with no release recorded: its runtime's ch-local is its version
  assert.deepStrictEqual(homeDescription(where, {...record, release: null}, bundled()).modules, {[A]: DA, [P]: DP});
});

test('no app: the bundled release when it has the record\'s version; an app there wins over a bundled release of the same version', () => {
  const {home, where, record} = ownHome();
  const same = {...bundled(), release: {version: '0.9.0', security: null}, pins: {[A]: pinOf(A, '1.0.0', 1), [P]: pinOf(P, '2.0.0', 2)}};
  // (no app at all)
  assert.deepStrictEqual(ownReleasePins(where, record, same), {packs: same.packs, modules: same.modules, pins: same.pins});
  assert.deepStrictEqual(homeDescription(where, record, same).modules, {[A]: DA, [P]: DP});
  // (the medium on L4 baseline, 3) a checkout of the same version whose
  // pins differ: the home's app is the baseline, not the checkout's pins
  const otherPins = {...same, pins: {[A]: {version: '1.0.0', integrity: integrityOf(A, 'other')}, [P]: {version: '2.0.0', integrity: integrityOf(P, 'other')}}};
  assert.deepStrictEqual(homeDescription(where, record, otherPins).modules, {[A]: null, [P]: null}, 'with no app, the bundled pins');
  app(home);
  assert.deepStrictEqual(homeDescription(where, record, otherPins).modules, {[A]: DA, [P]: DP}, 'the app\'s pins win');
});

// (the medium on L4 baseline, 1) a pack the running release withdraws is not
// running either, though the home's own release lists it: a release serving
// it again holds
test('a pack withdrawn by the running release, or the home\'s, is not running', () => {
  const B = '@countinghouse/ch-pack-b';
  const {home, where, record} = ownHome();
  storeModule(home, B, '3.0.0');
  const doc = ownDoc();
  doc.packs.b = {modules: [B]};
  doc.modules[B] = {...DA, calls: []};
  doc.pins[B] = pinOf(B, '3.0.0', 3);
  app(home, {doc});
  const r = {...record, packs: {...record.packs, b: {modules: {[B]: '3.0.0'}}}, modules: {...record.modules, [B]: {version: '3.0.0'}}};
  const runningListsA = bundled();
  const d = homeDescription(where, r, runningListsA);
  assert.deepStrictEqual(d.packs.b, {modules: [], withdrawn: true});
  assert.strictEqual(d.modules[B], undefined);
  const both = {...bundled(), packs: {a: {modules: [A, P]}, b: {modules: [B]}}};
  assert.deepStrictEqual(homeDescription(where, r, both).packs.b, {modules: [B]}, 'listed by both: running');
});

test('the own release\'s pins unknown: every running module unknown, never a throw (fail closed)', () => {
  const unknown = {[A]: null, [P]: null};
  const check = (label, setup, recordOver = {}) => {
    const {home, where, record} = ownHome();
    setup(home);
    const r = {...record, ...recordOver};
    assert.strictEqual(ownReleasePins(where, r, bundled()), null, label);
    assert.deepStrictEqual(homeDescription(where, r, bundled()).modules, unknown, label);
  };
  check('no app', () => {});
  check('the app another version', (h) => app(h, {version: '0.9.1'}));
  check('the app another package', (h) => app(h, {name: '@countinghouse/not-ch-local'}));
  check('the record\'s release another version than its runtime', (h) => app(h), {release: {version: '0.8.0', security: null}});
  check('no recorded ch-local', (h) => app(h), {runtime: {versions: {}}});
  check('pins not JSON', (h) => app(h, {pinsText: '{'}));
  check('pins with a problem', (h) => app(h, {doc: {...ownDoc(), pins: {[A]: {version: '1.0.0'}}}}));
  check('pins over MAX_BYTES', (h) => app(h, {pinsText: ' '.repeat(require('../lib/release-pins').MAX_BYTES + 1)}));
  check('package.json unreadable (a directory)', (h) => { const d = app(h); fs.rmSync(path.join(d, 'package.json')); fs.mkdirSync(path.join(d, 'package.json')); });
  if (process.platform !== 'win32') {
    check('pins a link', (h) => {
      const d = app(h);
      const real = path.join(h, 'elsewhere.json');
      fs.renameSync(path.join(d, 'lib', 'release-pins.json'), real);
      fs.symlinkSync(real, path.join(d, 'lib', 'release-pins.json'));
    });
  }
});

test('auto-apply and upgrade judge additions by homeDescription, never the bundled pins alone', () => {
  for (const f of ['auto-apply.js', 'upgrade.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8');
    assert.match(text, /\bhomeDescription\(/, f);
    assert.ok(!/\binstalledDescription\b/.test(text), f);
  }
});
