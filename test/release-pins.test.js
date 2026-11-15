'use strict';
// lib/release-pins.json and lib/release-pins.js (docs/development/
// auto-upgrade.md, "The trust chain", step 5): what a release pins, as data,
// never code. The pins (each with its identity), the runtime lockfile, the
// packs' composition and credentials, and the allowed origins. A new
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

test('the shipped file parses, and lib/allowlist.js reads its packs, origins and pins from it, unchanged for its callers', () => {
  const r = parseReleasePins(shipped());
  assert.strictEqual(r.problem, undefined, r.problem);
  const {ALLOWLIST, ALLOWED_ORIGINS} = require('../lib/allowlist');
  assert.deepStrictEqual(ALLOWLIST.packs, r.pins.packs);
  assert.deepStrictEqual(ALLOWLIST.runtime, r.pins.runtime);
  assert.deepStrictEqual(ALLOWLIST.pins, r.pins.pins);
  assert.deepStrictEqual(ALLOWED_ORIGINS, r.pins.allowedOrigins);
  assert.strictEqual(ALLOWLIST.release.version, require('../package.json').version, 'the version is the package\'s');
  assert.deepStrictEqual(ALLOWLIST.packs['ci-failure-triage'].credentials, ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']);
  assert.deepStrictEqual(ALLOWED_ORIGINS['https://api.githubcopilot.com'], ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']);
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

test('the packs, origins and runtime: exact shapes, nothing beyond them', () => {
  const cases = [
    (d) => { d.extra = 1; },
    (d) => { d.v = 2; },
    (d) => { d.packs['ci-failure-triage'].packages = []; },
    (d) => { d.packs['ci-failure-triage'].credentials = ['lowercase']; },
    (d) => { d.packs['ci-failure-triage'].script = 'x'; },
    (d) => { d.packs['Bad Name'] = {packages: ['@countinghouse/x'], credentials: []}; },
    (d) => { d.allowedOrigins['http://api.example.invalid'] = ['X_TOKEN']; },
    (d) => { d.allowedOrigins['https://api.example.invalid/path'] = ['X_TOKEN']; },
    (d) => { d.allowedOrigins['https://api.example.invalid'] = 'X_TOKEN'; },
    (d) => { d.runtime.packages = ['countinghouse']; },
    (d) => { d.runtime.lockfile = {lockfileVersion: 2, packages: {}}; },
    (d) => { d.release = {security: 'x'}; }
  ];
  for (const [i, mutate] of cases.entries()) {
    const d = shipped();
    mutate(d);
    assert.ok(problemOf(d) != null, `case ${i}`);
  }
});

test('what a new release adds that needs the user\'s yes: a package in an installed pack, a credential, an origin or a variable for one', () => {
  const now = parseReleasePins(shipped()).pins;
  const same = parseReleasePins(shipped()).pins;
  assert.deepStrictEqual(additions(now, same, ['ci-failure-triage']), []);
  const next = shipped();
  next.packs['ci-failure-triage'].packages.push('@countinghouse/ch-step-new');
  next.packs['ci-failure-triage'].credentials.push('NEW_TOKEN');
  next.allowedOrigins['https://api.githubcopilot.com'] = ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN', 'NEW_TOKEN'];
  next.allowedOrigins['https://api.example.invalid'] = ['OTHER_TOKEN'];
  next.packs['another-pack'] = {packages: ['@countinghouse/ch-pack-another'], credentials: []};
  const found = additions(now, parseReleasePins(next).pins, ['ci-failure-triage']);
  assert.deepStrictEqual(found.sort(), [
    'a credential for ci-failure-triage: NEW_TOKEN',
    'a package in ci-failure-triage: @countinghouse/ch-step-new',
    'an origin: https://api.example.invalid',
    'NEW_TOKEN sent to https://api.githubcopilot.com'
  ].sort());
  // a pack the user has not installed adds nothing to agree to; one removed asks nothing
  const fewer = shipped();
  fewer.packs['ci-failure-triage'].packages.pop();
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
    d.packs.other = {packages: ['@countinghouse/ch-pack-other'], credentials: []};
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
