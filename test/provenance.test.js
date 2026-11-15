'use strict';
// lib/provenance.js (docs/development/auto-upgrade.md, "Provenance: exactly
// what is checked"): a version's two attestations, verified against a trusted
// root by @sigstore/verify, then its identity, predicate and subject checked
// against its pin. The test root (test/sigstore-fixture.js) reaches the
// verifier only as an argument; the real chain check runs, offline.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {testRoot} = require('./sigstore-fixture');
const provenance = require('../lib/provenance');

const NAME = '@countinghouse/ch-local';
const V = '0.3.0';
const bytes = Buffer.from('the tarball');
const integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
const sha512Hex = crypto.createHash('sha512').update(bytes).digest('hex');
const pin = {version: V, integrity, repository: 'mchen6/ch-local', repositoryId: 1000001, ownerId: 2000002, workflow: '.github/workflows/publish.yml', tag: `v${V}`};
const root = testRoot();
const trust = provenance.trustMaterial(root.trustedRoot, root.npmKeys);
const at = new Date(Date.now() - 80 * 3600e3);
const att = (prov, pub) => ({attestations: [{predicateType: 'https://slsa.dev/provenance/v1', bundle: prov}, {predicateType: 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1', bundle: pub}]});
const good = (opts = {}) => att(root.provenance(NAME, V, sha512Hex, Object.assign({}, pin, opts.identity), opts.at || at, opts.prov || {}),
  root.publish(NAME, V, sha512Hex, opts.publishAt || at, opts.pub || {}));
const verify = (attestations, extra = {}) => provenance.verifyRelease(Object.assign({name: NAME, version: V, pin, attestations, trust}, extra));
const codeOf = (fn) => { try { fn(); return 'passed'; } catch (e) { return e.code; } };

test('a version built by its pinned repository\'s workflow at its tag passes, with both log times read after verification', () => {
  const pubAt = new Date(at.getTime() + 30e3);
  const r = verify(good({publishAt: pubAt}));
  assert.strictEqual(r.builtAt.getTime(), Math.floor(at.getTime() / 1000) * 1000);
  assert.strictEqual(r.publishedAt.getTime(), Math.floor(pubAt.getTime() / 1000) * 1000);
});

test('the identity: another repository, repository ID, owner ID, workflow, tag, event, runner or issuer fails', () => {
  for (const identity of [{repository: 'someone/ch-local'}, {repositoryId: 1000009}, {ownerId: 2000009}, {workflow: '.github/workflows/other.yml'},
    {tag: 'v0.2.9'}, {event: 'workflow_dispatch'}, {runner: 'self-hosted'}, {issuer: 'https://issuer.example.invalid'}]) {
    assert.strictEqual(codeOf(() => verify(good({identity}))), 'PROVENANCE_IDENTITY', JSON.stringify(identity));
  }
});

test('the subject and predicate: another digest, package or version, or a predicate that disagrees with its certificate, fails', () => {
  const other = crypto.createHash('sha512').update('other bytes').digest('hex');
  const prov = (overrides) => att(root.provenance(NAME, V, sha512Hex, pin, at, {overrides}), root.publish(NAME, V, sha512Hex, at));
  assert.strictEqual(codeOf(() => verify(att(root.provenance(NAME, V, other, pin, at), root.publish(NAME, V, sha512Hex, at)))), 'PROVENANCE_IDENTITY', 'another digest');
  assert.strictEqual(codeOf(() => verify(prov({subject: 'pkg:npm/%40countinghouse/other@0.3.0'}))), 'PROVENANCE_IDENTITY');
  assert.strictEqual(codeOf(() => verify(prov({subject: 'pkg:npm/%40countinghouse/ch-local@0.2.0'}))), 'PROVENANCE_IDENTITY');
  const lying = {buildDefinition: {buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
    externalParameters: {workflow: {ref: 'refs/tags/v0.3.0', repository: 'https://github.com/mchen6/ch-local', path: '.github/workflows/other.yml'}},
    internalParameters: {github: {event_name: 'push'}}}};
  assert.strictEqual(codeOf(() => verify(prov({predicate: lying}))), 'PROVENANCE_IDENTITY', 'a predicate that disagrees with the certificate');
  const otherType = JSON.parse(JSON.stringify(lying));
  otherType.buildDefinition.buildType = 'https://example.invalid/other';
  otherType.buildDefinition.externalParameters.workflow.path = '.github/workflows/publish.yml';
  assert.strictEqual(codeOf(() => verify(prov({predicate: otherType}))), 'PROVENANCE_IDENTITY');
  // the publish attestation's own subject and predicate
  assert.strictEqual(codeOf(() => verify(att(root.provenance(NAME, V, sha512Hex, pin, at), root.publish(NAME, V, other, at)))), 'PROVENANCE_IDENTITY');
  assert.strictEqual(codeOf(() => verify(att(root.provenance(NAME, V, sha512Hex, pin, at), root.publish(NAME, V, sha512Hex, at, {predicate: {name: NAME, version: V, registry: 'https://registry.example.invalid'}})))), 'PROVENANCE_IDENTITY');
});

test('the log: exactly one entry, with an inclusion promise; a proof alone, or two entries, fail (backdating)', () => {
  assert.strictEqual(codeOf(() => verify(good({prov: {bundle: {promise: false}}}))), 'PROVENANCE_LOG');
  assert.strictEqual(codeOf(() => verify(good({prov: {bundle: {entries: 2}}}))), 'PROVENANCE_LOG');
  assert.strictEqual(codeOf(() => verify(good({pub: {bundle: {promise: false}}}))), 'PROVENANCE_LOG');
});

test('missing attestations: none, one of the two, or two of one kind fail as no provenance', () => {
  const g = good();
  assert.strictEqual(codeOf(() => verify(null)), 'NO_PROVENANCE');
  assert.strictEqual(codeOf(() => verify({attestations: []})), 'NO_PROVENANCE');
  assert.strictEqual(codeOf(() => verify({attestations: [g.attestations[0]]})), 'NO_PROVENANCE');
  assert.strictEqual(codeOf(() => verify({attestations: [g.attestations[1]]})), 'NO_PROVENANCE');
  assert.strictEqual(codeOf(() => verify({attestations: [g.attestations[0], g.attestations[0], g.attestations[1]]})), 'NO_PROVENANCE');
});

test('another root: a bundle under a CA this root lacks is "can\'t verify yet"; a publish attestation under an unknown key fails', () => {
  const stranger = testRoot();
  const fromStranger = att(stranger.provenance(NAME, V, sha512Hex, pin, at), root.publish(NAME, V, sha512Hex, at));
  assert.strictEqual(codeOf(() => verify(fromStranger)), 'PROVENANCE_UNKNOWN_ROOT');
  // npm's publish attestation under a key the shipped list lacks, its log
  // entry ours
  const unknownKey = att(root.provenance(NAME, V, sha512Hex, pin, at), root.publish(NAME, V, sha512Hex, at, {key: root.otherKey(), keyId: 'SHA256:not-a-known-key'}));
  assert.strictEqual(codeOf(() => verify(unknownKey)), 'PROVENANCE_UNKNOWN_ROOT');
  // a log entry another log signed is no rotation we can tell from a forgery:
  // a chain failure
  const otherLog = att(root.provenance(NAME, V, sha512Hex, pin, at), stranger.publish(NAME, V, sha512Hex, at));
  assert.strictEqual(codeOf(() => verify(otherLog)), 'PROVENANCE_CHAIN');
});

test('the bundled root: a bundle validly signed under the test root is refused when no test root is passed', () => {
  // no `trust`: the root and keys shipped in lib/sigstore are used
  const r = codeOf(() => provenance.verifyRelease({name: NAME, version: V, pin, attestations: good()}));
  assert.ok(['PROVENANCE_UNKNOWN_ROOT', 'PROVENANCE_CHAIN'].includes(r), r);
});

test('a pin without its whole identity, or for another version, is refused before anything is verified', () => {
  for (const field of ['repository', 'repositoryId', 'ownerId', 'workflow', 'tag', 'integrity']) {
    const p = Object.assign({}, pin);
    delete p[field];
    assert.strictEqual(codeOf(() => verify(good(), {pin: p})), 'PIN_INCOMPLETE', field);
  }
  assert.strictEqual(codeOf(() => verify(good(), {pin: Object.assign({}, pin, {version: '0.2.0'})})), 'PIN_INCOMPLETE');
  // the tag is v<version>, for every pin, ch-local's in-memory one included
  assert.strictEqual(codeOf(() => verify(good(), {pin: Object.assign({}, pin, {tag: 'v0.3.1'})})), 'PIN_INCOMPLETE', 'a tag not v<version>');
  assert.strictEqual(codeOf(() => verify(good(), {pin: Object.assign({}, pin, {repositoryId: '1000001'})})), 'PIN_INCOMPLETE', 'a numeric ID as a number');
});

test('nothing in the module reads the environment, a file named by it, or argv', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/provenance'), 'utf8');
  assert.doesNotMatch(src, /process\.env|io\.env|process\.argv|CH_LOCAL_DEV/);
});

// the review of #41 -----------------------------------------------------------

test('(1) the publish attestation is bound to npm\'s key: one signed by any certificate is refused', () => {
  const minted = att(root.provenance(NAME, V, sha512Hex, pin, at), root.publish(NAME, V, sha512Hex, at, {withCertificate: pin}));
  assert.strictEqual(codeOf(() => verify(minted)), 'PROVENANCE_CHAIN');
  // nor is a provenance accepted that npm's key signed instead of a certificate
  const keyed = att(root.publish(NAME, V, sha512Hex, at), root.publish(NAME, V, sha512Hex, at));
  keyed.attestations[0].predicateType = 'https://slsa.dev/provenance/v1';
  assert.ok(['PROVENANCE_CHAIN', 'PROVENANCE_IDENTITY'].includes(codeOf(() => verify(keyed))));
});

test('(2) npm\'s publish statement is Statement/v0.1, the provenance v1; a real recorded pair verifies offline under the shipped root', () => {
  const v1Publish = att(root.provenance(NAME, V, sha512Hex, pin, at), root.publish(NAME, V, sha512Hex, at, {type: 'https://in-toto.io/Statement/v1'}));
  assert.strictEqual(codeOf(() => verify(v1Publish)), 'PROVENANCE_IDENTITY');
  // @sigstore/verify@3.1.1's own attestations, as the registry serves them
  // (test/fixtures/attestations), built from sigstore/sigstore-js main
  const real = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'attestations', 'sigstore-verify-3.1.1.json'), 'utf8'));
  const r = provenance.verifyAttestations({name: '@sigstore/verify', version: '3.1.1',
    integrity: 'sha512-qv7+G3J2cc6wwFj3yKvXOamzqhMwSk1ogPGmhpS8iXllcPrJaIIBA+4HbttlHVu1pqWTdmaCH/WE7UOC51kdoA==',
    identity: {repository: 'sigstore/sigstore-js', repositoryId: 495574555, ownerId: 71096353, workflow: '.github/workflows/release.yml', ref: 'refs/heads/main'},
    attestations: real});
  assert.ok(r.builtAt instanceof Date && r.publishedAt instanceof Date);
  assert.ok(r.publishedAt.getTime() > Date.UTC(2025, 0, 1));
  // and the same real pair, held to another repository's identity, fails
  assert.strictEqual(codeOf(() => provenance.verifyAttestations({name: '@sigstore/verify', version: '3.1.1',
    integrity: 'sha512-qv7+G3J2cc6wwFj3yKvXOamzqhMwSk1ogPGmhpS8iXllcPrJaIIBA+4HbttlHVu1pqWTdmaCH/WE7UOC51kdoA==',
    identity: {repository: 'sigstore/sigstore-js', repositoryId: 495574556, ownerId: 71096353, workflow: '.github/workflows/release.yml', ref: 'refs/heads/main'},
    attestations: real})), 'PROVENANCE_IDENTITY');
});

test('(3) the SAN is compared exactly, not as a pattern', () => {
  // ".github" as a pattern matches "xgithub"; the predicate agrees with the pin
  const predicate = {buildDefinition: {buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
    externalParameters: {workflow: {ref: `refs/tags/v${V}`, repository: 'https://github.com/mchen6/ch-local', path: '.github/workflows/publish.yml'}},
    internalParameters: {github: {event_name: 'push'}}}};
  const lookalike = att(root.provenance(NAME, V, sha512Hex, Object.assign({}, pin, {workflow: 'xgithub/workflows/publish.yml'}), at, {overrides: {predicate}}), root.publish(NAME, V, sha512Hex, at));
  assert.strictEqual(codeOf(() => verify(lookalike)), 'PROVENANCE_IDENTITY');
});

test('(4) the statement and the log entry are the parsed bundle\'s: a bundle without a DSSE envelope is refused', () => {
  const g = good();
  const prov = JSON.parse(JSON.stringify(g.attestations[0].bundle));
  // a message signature beside the envelope: the parsed bundle prefers it
  prov.messageSignature = {messageDigest: {algorithm: 'SHA2_256', digest: Buffer.alloc(32).toString('base64')}, signature: Buffer.alloc(64).toString('base64')};
  assert.notStrictEqual(codeOf(() => verify({attestations: [{predicateType: provenance.PROVENANCE, bundle: prov}, g.attestations[1]]})), 'passed');
});

test('(5) a known npm key used outside its window is a chain failure, not "can\'t verify yet"', () => {
  const expired = JSON.parse(JSON.stringify(root.npmKeys));
  expired.keys[0].expires = new Date(at.getTime() - 3600e3).toISOString();
  const t = provenance.trustMaterial(root.trustedRoot, expired);
  assert.strictEqual(codeOf(() => verify(good(), {trust: t})), 'PROVENANCE_CHAIN');
});

test('a pin\'s tag is exactly its workflow\'s prefix and its version: v for publish.yml, shim-v for shim.yml; any other workflow is refused', () => {
  assert.strictEqual(codeOf(() => verify(good(), {pin: Object.assign({}, pin, {tag: `shim-v${V}`})})), 'PIN_INCOMPLETE', 'publish.yml with shim-v');
  assert.strictEqual(codeOf(() => verify(good(), {pin: Object.assign({}, pin, {workflow: '.github/workflows/release.yml'})})), 'PIN_INCOMPLETE');
  // a shim pin, signed as shim.yml at shim-v<version>, verifies
  const shimPin = Object.assign({}, pin, {workflow: '.github/workflows/shim.yml', tag: `shim-v${V}`});
  const shim = att(root.provenance(NAME, V, sha512Hex, shimPin, at), root.publish(NAME, V, sha512Hex, at));
  assert.strictEqual(codeOf(() => verify(shim, {pin: shimPin})), 'passed');
});
