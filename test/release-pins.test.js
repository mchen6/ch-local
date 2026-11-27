'use strict';
require('./tmp-dirs');
// lib/release-pins.json and lib/release-pins.js (docs/development/
// auto-upgrade.md, "The trust chain", step 5): what a release pins, as data,
// never code. The pins (each with its identity), the runtime lockfile, the
// packs' modules, and each module's description (its credential, calls and
// confirm settings: version 2, #413 section 9.3), the origins derived. A new
// release's file is parsed from the verified bytes in memory; what it adds
// that the user must agree to is listed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {parseReleasePins, additions} = require('../lib/release-pins');

const shipped = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8'));
const SHA = `sha512-${'A'.repeat(86)}==`;
const pin = (v = '1.2.3') => ({version: v, integrity: SHA, repository: 'mchen6/ch-pack-ci-failure-triage', repositoryId: 1000001, ownerId: 2000002, workflow: '.github/workflows/publish.yml', tag: `v${v}`});
const problemOf = (doc) => parseReleasePins(doc).problem;

test('the shipped file parses (version 2), and lib/allowlist.js reads its packs, descriptions, origins and pins from it, unchanged for its callers', () => {
  const r = parseReleasePins(shipped());
  assert.strictEqual(r.problem, undefined, r.problem);
  const {ALLOWLIST, ALLOWED_ORIGINS, originsOf} = require('../lib/allowlist');
  assert.deepStrictEqual(ALLOWLIST.packs, r.pins.packs);
  assert.deepStrictEqual(ALLOWLIST.modules, r.pins.modules);
  assert.deepStrictEqual(ALLOWLIST.runtime, r.pins.runtime);
  assert.deepStrictEqual(ALLOWLIST.pins, r.pins.pins);
  assert.strictEqual(ALLOWLIST.release.version, require('../package.json').version, 'the version is the package\'s');
  // the origins are the descriptions' credentials, each with its variables
  // (fallbackEnv is never described: section 6.1)
  assert.deepStrictEqual(ALLOWED_ORIGINS, originsOf(r.pins.modules));
  assert.deepStrictEqual(ALLOWED_ORIGINS['https://api.githubcopilot.com'], ['GITHUB_TOKEN']);
  assert.ok(Object.isFrozen(ALLOWED_ORIGINS) && Object.isFrozen(ALLOWLIST.packs['ci-failure-triage']), 'read-only');
});

test('self: ch-local\'s own identity, which its provenance must carry (a release cannot pin its own digest)', () => {
  const r = parseReleasePins(shipped());
  assert.deepStrictEqual(r.pins.self, {repository: 'mchen6/ch-local', repositoryId: 1454656051, ownerId: 1168741, workflow: '.github/workflows/publish.yml'});
  for (const mutate of [(d) => { delete d.self; }, (d) => { d.self.repositoryId = '1454656051'; }, (d) => { d.self.tag = 'v1'; }, (d) => { d.self.workflow = 'x'; },
    (d) => { d.pins['@countinghouse/ch-local'] = pin(); }]) {
    const d = shipped();
    mutate(d);
    assert.ok(problemOf(d) != null, String(mutate));
  }
});

test('from bytes, as a new release\'s verified tarball gives them: JSON only, bounded', () => {
  assert.strictEqual(parseReleasePins(Buffer.from(JSON.stringify(shipped()))).problem, undefined);
  assert.match(String(problemOf(Buffer.from('module.exports = {}'))), /not JSON/);
  assert.match(String(problemOf(Buffer.alloc(1024 * 1024 + 1, 0x20))), /over/);
});

test('a pin carries its whole identity, a strict version and a sha512', () => {
  const doc = shipped();
  doc.pins = {'@countinghouse/ch-pack-ci-failure-triage': pin()};
  assert.strictEqual(problemOf(doc), undefined);
  for (const [field, bad] of [['version', '1.2'], ['version', '1.2.3-rc.1'], ['version', '01.2.3'], ['integrity', 'sha1-x'], ['repository', 'nope'], ['repositoryId', '1000001'],
    ['ownerId', 0], ['workflow', 'publish.yml'], ['tag', 'v 1'], ['tag', undefined]]) {
    const d = shipped();
    d.pins = {'@countinghouse/ch-pack-ci-failure-triage': Object.assign(pin(), {[field]: bad})};
    if (bad === undefined) delete d.pins['@countinghouse/ch-pack-ci-failure-triage'][field];
    assert.match(String(problemOf(d)), /pin/, `${field}: ${bad}`);
  }
  // the tag is the version's own: refs/tags/v<version> is the ref provenance holds it to
  const otherTag = shipped();
  otherTag.pins = {'@countinghouse/ch-pack-ci-failure-triage': Object.assign(pin(), {tag: 'v1.2.4'})};
  assert.match(String(problemOf(otherTag)), /tag must be v1\.2\.3/);
  const extra = shipped();
  extra.pins = {'@countinghouse/ch-pack-ci-failure-triage': Object.assign(pin(), {url: 'https://example.invalid/x.tgz'})};
  assert.match(String(problemOf(extra)), /pin/, 'no key beyond the identity');
  const stranger = shipped();
  stranger.pins = {'left-pad': pin()};
  assert.match(String(problemOf(stranger)), /no package of this release/);
});

test('the packs, the module descriptions and the runtime: exact shapes, nothing beyond them', () => {
  const ACCESS = '@countinghouse/ch-access-github';
  const TRIAGE = '@countinghouse/ch-pack-ci-failure-triage';
  const cases = [
    (d) => { d.extra = 1; },
    (d) => { d.v = 1; },
    (d) => { d.packs['ci-failure-triage'].modules = []; },
    (d) => { d.packs['ci-failure-triage'].packages = d.packs['ci-failure-triage'].modules; },
    (d) => { d.packs['ci-failure-triage'].credentials = []; },
    (d) => { d.packs['Bad Name'] = {modules: ['@countinghouse/x']}; },
    (d) => { d.allowedOrigins = {}; },
    (d) => { d.modules[ACCESS].credentials[0].variable = 'not a-variable'; },
    (d) => { d.modules[ACCESS].credentials[0].origin = 'http://api.example.invalid'; },
    (d) => { d.modules[ACCESS].credentials[0].origin = 'https://api.example.invalid/path'; },
    (d) => { d.modules[ACCESS].credentials.push({variable: 'X_TOKEN', origin: 'https://api.example.invalid'}); },
    (d) => { d.modules[ACCESS].extra = 1; },
    (d) => { d.modules['@countinghouse/ch-step-orphan'] = {role: null, credentials: [], calls: [], confirmSettings: {}}; },
    (d) => { delete d.modules[ACCESS]; },
    (d) => { d.modules[TRIAGE].calls.push('@countinghouse/ch-step-elsewhere'); },
    (d) => { d.modules[TRIAGE].confirmSettings = {x: undefined, 'bad name': true}; },
    (d) => { d.runtime.packages = ['countinghouse']; },
    (d) => { d.runtime.lockfile = {lockfileVersion: 2, packages: {}}; },
    (d) => { d.release = {security: 'x'}; }
  ];
  for (const [i, mutate] of cases.entries()) {
    const d = shipped();
    mutate(d);
    assert.ok(problemOf(d) != null, `case ${i}: ${String(mutate)}`);
  }
  // a v1 document is refused with its own line (section 9.3)
  const v1 = shipped();
  v1.v = 1;
  assert.match(String(problemOf(v1)), /version 2|v must be 2|\bv\b/);
});

test('what a new release adds that needs the user\'s yes, for the installed packs: a module, a credential destination, a new caller of a key, a confirm setting changed', () => {
  const ACCESS = '@countinghouse/ch-access-github';
  const TRIAGE = '@countinghouse/ch-pack-ci-failure-triage';
  const REDACT = '@countinghouse/ch-step-redact';
  const now = parseReleasePins(shipped()).pins;
  assert.deepStrictEqual(additions(now, parseReleasePins(shipped()).pins, ['ci-failure-triage']), []);
  const next = shipped();
  next.packs['ci-failure-triage'].modules.push('@countinghouse/ch-step-new');
  next.modules['@countinghouse/ch-step-new'] = {role: 'part', credentials: [], calls: [ACCESS], confirmSettings: {}};
  next.modules[ACCESS].credentials = [{variable: 'GITHUB_TOKEN', origin: 'https://api.example.invalid'}];
  next.packs['another-pack'] = {modules: ['@countinghouse/ch-pack-another']};
  next.modules['@countinghouse/ch-pack-another'] = {role: 'scenario', credentials: [{variable: 'OTHER_TOKEN', origin: 'https://other.example.invalid'}], calls: [], confirmSettings: {}};
  const parsed = parseReleasePins(next);
  assert.strictEqual(parsed.problem, undefined, parsed.problem);
  const found = additions(now, parsed.pins, ['ci-failure-triage']);
  assert.deepStrictEqual(found.map((x) => [x.kind, x.module]), [
    ['credential', ACCESS],
    ['module', '@countinghouse/ch-step-new'],
    ['keyCaller', '@countinghouse/ch-step-new']
  ]);
  assert.strictEqual(found[0].line, 'ch-access-github\'s key goes to https://api.example.invalid as GITHUB_TOKEN (was https://api.githubcopilot.com as GITHUB_TOKEN)');
  assert.strictEqual(found[2].line, 'ch-step-new now calls ch-access-github, which holds a key');
  assert.ok(!found.some((x) => x.module === '@countinghouse/ch-pack-another'), 'a pack the user has not installed adds nothing to agree to');
  // a confirm setting: its mark gone, or its default changed
  const withConfirm = shipped();
  withConfirm.modules[REDACT].confirmSettings = {strict: true, depth: 3};
  const before = parseReleasePins(withConfirm).pins;
  const changed = shipped();
  changed.modules[REDACT].confirmSettings = {depth: 4};
  const c = additions(before, parseReleasePins(changed).pins, ['ci-failure-triage']);
  assert.deepStrictEqual(c.map((x) => [x.kind, x.setting, x.now]), [['confirm', 'depth', {default: 4}], ['confirm', 'strict', null]]);
  // a part no longer one: those of its settings that need no confirmation
  // could be changed in conversation from then on (the Reviewer's high review of #98, 6)
  assert.strictEqual(now.modules[REDACT].role, 'part', 'the shipped description records the role');
  const promoted = shipped();
  promoted.modules[REDACT].role = 'scenario';
  const r = additions(now, parseReleasePins(promoted).pins, ['ci-failure-triage']);
  assert.deepStrictEqual(r.map((x) => [x.kind, x.module, x.was, x.now]), [['role', REDACT, 'part', 'scenario']]);
  // (a setting marked confirm, or any text setting, needs a confirmation, a
  // terminal's while no client is tested: the line says only what the
  // conversation can change)
  assert.strictEqual(r[0].line, 'ch-step-redact is no longer a part: those of its settings that need no confirmation can now be changed in conversation');
  // anything removed asks nothing
  const fewer = shipped();
  fewer.packs['ci-failure-triage'].modules = fewer.packs['ci-failure-triage'].modules.filter((m) => m !== '@countinghouse/ch-step-dedupe');
  delete fewer.modules['@countinghouse/ch-step-dedupe'];
  // (and its floor, which would otherwise name a module the release lacks)
  delete fewer.floors['@countinghouse/ch-step-dedupe'];
  fewer.modules[TRIAGE].calls = fewer.modules[TRIAGE].calls.filter((m) => m !== '@countinghouse/ch-step-dedupe');
  fewer.modules[ACCESS].credentials = [];
  assert.deepStrictEqual(additions(now, parseReleasePins(fewer).pins, ['ci-failure-triage']), []);
});

// A's shim pins and the Reviewer's ruling: a tag is exactly prefix+version,
// the prefix fixed by the pin's workflow (v for publish.yml, shim-v for
// shim.yml), and a package's kind fixes its workflow
test('the shim section: the six platforms, each package @countinghouse/ch-shim-<platform>, pinned from shim.yml at shim-v<version>', () => {
  const r = parseReleasePins(shipped());
  assert.deepStrictEqual(Object.keys(r.pins.shim.packages).sort(), ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);
  for (const [k, name] of Object.entries(r.pins.shim.packages)) assert.strictEqual(name, `@countinghouse/ch-shim-${k}`);
  const shimPin = (extra = {}) => Object.assign({version: '0.5.0', integrity: SHA, repository: 'mchen6/ch-local', repositoryId: 1454656051, ownerId: 1168741,
    workflow: '.github/workflows/shim.yml', tag: 'shim-v0.5.0'}, extra);
  const ok = shipped();
  ok.pins = {'@countinghouse/ch-shim-linux-x64': shimPin()};
  assert.strictEqual(problemOf(ok), undefined);
  for (const [extra, why] of [[{tag: 'v0.5.0'}, /tag must be shim-v0\.5\.0/], [{workflow: '.github/workflows/publish.yml', tag: 'v0.5.0'}, /from \.github\/workflows\/shim\.yml/],
    [{workflow: '.github/workflows/other.yml'}, /workflow/]]) {
    const d = shipped();
    d.pins = {'@countinghouse/ch-shim-linux-x64': shimPin(extra)};
    assert.match(String(problemOf(d)), why, JSON.stringify(extra));
  }
  // a pack's package is built by publish.yml at v<version>, never shim.yml
  const pack = shipped();
  pack.pins = {'@countinghouse/ch-pack-ci-failure-triage': Object.assign(pin(), {workflow: '.github/workflows/shim.yml', tag: 'shim-v1.2.3'})};
  assert.match(String(problemOf(pack)), /from \.github\/workflows\/publish\.yml/);
  for (const mutate of [(d) => { delete d.shim; }, (d) => { d.shim.packages['freebsd-x64'] = '@countinghouse/ch-shim-freebsd-x64'; },
    (d) => { d.shim.packages['linux-x64'] = '@countinghouse/ch-shim-linux-arm64'; }, (d) => { d.shim.extra = 1; }]) {
    const d = shipped();
    mutate(d);
    assert.ok(problemOf(d) != null, String(mutate));
  }
});

// the review of #42, 5: identity changes to an existing pin or to self block
// an automatic upgrade; a pack the user has not installed is named, never
// blocking (auto never installs it)
test('identityChanges: self, or a pin of the runtime, an installed pack or the shim, changing its repository, IDs or workflow, blocks; another pack\'s is named', () => {
  const {identityChanges} = require('../lib/release-pins');
  const withPins = (edit) => {
    const d = shipped();
    d.packs.other = {modules: ['@countinghouse/ch-pack-other']};
    d.modules['@countinghouse/ch-pack-other'] = {role: 'scenario', credentials: [], calls: [], confirmSettings: {}};
    d.pins = {'@countinghouse/ch-pack-ci-failure-triage': pin(), '@countinghouse/ch-pack-other': Object.assign(pin(), {repository: 'mchen6/ch-pack-other'}), countinghouse: Object.assign(pin(), {repository: 'mchen6/countinghouse'})};
    if (edit) edit(d);
    const r = parseReleasePins(d);
    assert.strictEqual(r.problem, undefined, r.problem);
    return r.pins;
  };
  const now = withPins();
  assert.deepStrictEqual(identityChanges(now, withPins(), ['ci-failure-triage']), {blocking: [], named: []});
  const next = withPins((d) => {
    d.self.repositoryId += 1;
    d.pins.countinghouse.ownerId += 1;
    d.pins['@countinghouse/ch-pack-ci-failure-triage'].repository = 'someone/ch-pack-ci-failure-triage';
    d.pins['@countinghouse/ch-pack-other'].repositoryId += 1;
  });
  const r = identityChanges(now, next, ['ci-failure-triage']);
  assert.deepStrictEqual(r.blocking.sort(), [
    '@countinghouse/ch-pack-ci-failure-triage\'s repository: mchen6/ch-pack-ci-failure-triage -> someone/ch-pack-ci-failure-triage',
    'countinghouse\'s ownerId: 2000002 -> 2000003',
    'self\'s repositoryId: 1454656051 -> 1454656052'
  ].sort());
  assert.deepStrictEqual(r.named, ['@countinghouse/ch-pack-other\'s repositoryId: 1000001 -> 1000002 (the pack other, not installed)']);
});

test('the review of #48: a first pin for a name this install uses (the runtime, an installed pack, the shim) blocks; one for another pack does not', () => {
  const {identityChanges} = require('../lib/release-pins');
  const d = shipped();
  d.packs.other = {modules: ['@countinghouse/ch-pack-other']};
  d.modules['@countinghouse/ch-pack-other'] = {role: 'scenario', credentials: [], calls: [], confirmSettings: {}};
  const now = parseReleasePins(d).pins;
  d.pins = {countinghouse: Object.assign(pin(), {repository: 'mchen6/countinghouse'}), '@countinghouse/ch-pack-other': Object.assign(pin(), {repository: 'mchen6/ch-pack-other'}),
    '@countinghouse/ch-shim-linux-x64': Object.assign(pin(), {repository: 'mchen6/ch-local', workflow: '.github/workflows/shim.yml', tag: `shim-v${pin().version}`})};
  const parsed = parseReleasePins(d);
  assert.strictEqual(parsed.problem, undefined, parsed.problem);
  const r = identityChanges(now, parsed.pins, ['ci-failure-triage']);
  assert.deepStrictEqual(r.blocking.sort(), [
    '@countinghouse/ch-shim-linux-x64: pinned for the first time (mchen6/ch-local, .github/workflows/shim.yml)',
    'countinghouse: pinned for the first time (mchen6/countinghouse, .github/workflows/publish.yml)'
  ]);
  assert.deepStrictEqual(r.named, []);
});

// The reviewer on the redaction fixes (release 1): a home's parts are only as
// new as the release's pins, so the file names a floor per part that carries
// a fix a release must hold, and no pin may go below it.
test('floors: optional; each a strict version of a module some pack lists; a pin below its floor refused', () => {
  const d = shipped();
  // the shipped floors: the redaction and GitHub fixes (A-redact), the
  // credential-leak fixes of 11-21 (report's userinfo, pack 1's step names),
  // the runs list that was lost (access-github), pack 1's fixes of 0.7.2 and
  // 0.7.3 with the parts' fixes they need, 0.7.4's README of its known
  // limits, and every part's README true of the release
  assert.deepStrictEqual(d.floors, {'@countinghouse/ch-access-github': '0.3.2', '@countinghouse/ch-pack-ci-failure-triage': '0.7.4', '@countinghouse/ch-step-dedupe': '0.1.3',
    '@countinghouse/ch-step-error-patterns': '0.3.1', '@countinghouse/ch-step-failure-signature': '0.2.2', '@countinghouse/ch-step-log-clean': '0.2.5',
    '@countinghouse/ch-step-owner-hint': '0.1.3', '@countinghouse/ch-step-redact': '0.2.5', '@countinghouse/ch-step-report': '0.4.6'});
  assert.strictEqual(problemOf(d), undefined);
  const without = shipped();
  delete without.floors;
  assert.strictEqual(problemOf(without), undefined, 'optional');
  for (const [mutate, re] of [
    [(x) => { x.floors = []; }, /floors must be an object/],
    [(x) => { x.floors['@countinghouse/ch-step-nope'] = '1.0.0'; }, /floor for @countinghouse\/ch-step-nope names no module/],
    [(x) => { x.floors['@countinghouse/ch-step-redact'] = '0.2'; }, /floor for @countinghouse\/ch-step-redact is no strict/],
    [(x) => { x.pins['@countinghouse/ch-step-redact'] = Object.assign(pin('0.2.4'), {repository: 'mchen6/ch-step-redact'}); }, /ch-step-redact 0\.2\.4 is below its floor 0\.2\.5/],
    // (a pack's own module has a floor too: pack 1's README of 0.7.4)
    [(x) => { x.pins['@countinghouse/ch-pack-ci-failure-triage'] = Object.assign(pin('0.7.3'), {repository: 'mchen6/ch-pack-ci-failure-triage'}); }, /ch-pack-ci-failure-triage 0\.7\.3 is below its floor 0\.7\.4/]
  ]) {
    const x = shipped();
    mutate(x);
    assert.match(problemOf(x) || '', re);
  }
  const at = shipped();
  at.pins['@countinghouse/ch-step-redact'] = pin('0.2.5');
  at.pins['@countinghouse/ch-step-redact'].repository = 'mchen6/ch-step-redact';
  assert.strictEqual(problemOf(at), undefined, 'at its floor');
});

// the medium on the floors, 1: a pre-release comes before its version, and
// what is no version is below every floor (fail closed)
test('belowFloor: semver precedence, pre-releases below their version, a non-version below every floor', () => {
  const {belowFloor} = require('../lib/release-pins');
  assert.strictEqual(belowFloor('0.2.3', '0.2.3'), false);
  assert.strictEqual(belowFloor('0.2.4', '0.2.3'), false);
  assert.strictEqual(belowFloor('0.10.0', '0.2.3'), false);
  assert.strictEqual(belowFloor('0.2.2', '0.2.3'), true);
  for (const v of ['0.2.3-rc.1', '0.2.2-rc.1', '0.2', 'x', '', undefined]) assert.strictEqual(belowFloor(v, '0.2.3'), true, String(v));
  assert.deepStrictEqual(require('../lib/allowlist').ALLOWLIST.floors, shipped().floors, 'the allowlist carries the floors');
});

// (the medium on the docs PR: a key of release this ch-local doesn't read
// marks a later format, as a top-level one does)
test('an unknown key in release is a later format', () => {
  const {parseReleasePins} = require('../lib/release-pins');
  const base = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8'));
  const r = parseReleasePins({...base, release: {...base.release, later: 1}});
  assert.ok(r.problem != null);
  assert.strictEqual(r.later, true);
});
