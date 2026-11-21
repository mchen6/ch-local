'use strict';
require('./tmp-dirs');
// The test trusted root (test/sigstore-fixture.js) never makes a CA whose own
// signature @sigstore/verify can't check. @sigstore/core parses an OCTET
// STRING's content as nested DER whenever it can, and re-encodes it
// canonically before checking a signature. A raw SHA-1 key identifier that
// happens to parse with a non-minimal length re-encodes differently, and every
// bundle under that root is refused as PROVENANCE_UNKNOWN_ROOT: about 1 random
// root in 150,000, seen once on ch-local#113's CI run 44872985445
// (upgrade.test's plugin step). The judge here is @sigstore/core itself.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {ASN1Obj, X509Certificate} = require('@sigstore/core');
const {testRoot, keyIdFromDigest} = require('./sigstore-fixture');

// the SubjectKeyIdentifier extension's value, as a certificate holds it
const skiExtension = (id) => {
  const inner = Buffer.concat([Buffer.from([0x04, id.length]), id]);
  return Buffer.concat([Buffer.from([0x04, inner.length]), inner]);
};
const roundTrips = (der) => Buffer.from(ASN1Obj.parseBuffer(der).toDER()).equals(der);

test('a key identifier the fixture makes is never re-encoded by @sigstore/core, even from a digest that a raw identifier would break on', () => {
  // (SHA-1 digests that, used raw, re-encode differently under @sigstore/core:
  // found by search over random digests)
  for (const hex of ['cb8111c14691fdfdd115e59f412444de100db4ff', '848111c8b56e7ef40891d14e182b6eecf6288a12', 'd38111b850eb9f982ce121cae74a3c4196cffa23']) {
    const digest = Buffer.from(hex, 'hex');
    assert.strictEqual(roundTrips(skiExtension(digest)), false, `premise: ${hex} raw is re-encoded`);
    const id = keyIdFromDigest(digest);
    assert.strictEqual(id.length, 20);
    assert.ok(roundTrips(skiExtension(id)), `${hex}: the fixture's identifier round-trips`);
  }
});

test('the test root\'s CA verifies itself under @sigstore/core', () => {
  const root = testRoot();
  const der = Buffer.from(root.trustedRoot.certificateAuthorities[0].certChain.certificates[0].rawBytes, 'base64');
  assert.strictEqual(X509Certificate.parse(der).verify(), true);
});
