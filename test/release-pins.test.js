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
