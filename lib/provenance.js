'use strict';
// Provenance for an upgrade from npm (docs/development/auto-upgrade.md,
// "Provenance: exactly what is checked"). A version's attestations, as the
// registry serves them (/-/npm/v1/attestations/<name>@<version>), must hold
// exactly one SLSA provenance and one npm publish attestation.
// - Each is read from the parsed bundle the verifier checks, never the raw
//   JSON: a DSSE envelope, and exactly one Rekor entry with an inclusion
//   promise (the signed entry timestamp covers the integrated time; a proof
//   alone doesn't), else PROVENANCE_LOG.
// - The SLSA provenance must be signed by a Fulcio certificate, verified by
//   @sigstore/verify against the root's CAs and logs, and no key. The
//   publish attestation must be signed by npm's key, verified against the
//   root's logs and npm's keys, and no CA: anyone can get a certificate.
// - A CA or a key the trust lacks is PROVENANCE_UNKNOWN_ROOT ("can't verify
//   yet"); a known key outside its window, and any other failure, is
//   PROVENANCE_CHAIN.
// - The certificate's identity: the issuer and Fulcio's build signer URI
//   (.9), runner (.11), repository URI (.12), ref (.14), repository and owner
//   IDs (.15, .17) and trigger (.20) by the verifier's policy, and the SAN by
//   equality here. Then the predicate must agree with it, the provenance's
//   statement be in-toto v1 and the publish one v0.1 (as npm writes them),
//   and both subjects be pkg:npm/<name>@<version> with the tarball's sha512.
//   Any mismatch is PROVENANCE_IDENTITY.
// - The log times are read only after verification passes.
// The trusted root and npm's keys are the ones shipped in lib/sigstore,
// unless a test passes its own `trust` as an argument: nothing in the
// environment, argv or a file chooses them.
const {Verifier, toTrustMaterial, toSignedEntity} = require('@sigstore/verify');
const {bundleFromJSON} = require('@sigstore/bundle');
const {TrustedRoot, PublicKey} = require('@sigstore/protobuf-specs');

const PROVENANCE = 'https://slsa.dev/provenance/v1';
const PUBLISH = 'https://github.com/npm/attestation/tree/main/specs/publish/v0.1';
const ISSUER = 'https://token.actions.githubusercontent.com';
const BUILD_TYPE = 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';
const REGISTRY = 'https://registry.npmjs.org';
// npm writes its SLSA provenance as Statement/v1, its publish attestation as
// Statement/v0.1 (as its live attestations show: test/fixtures/attestations)
const STATEMENT_V1 = 'https://in-toto.io/Statement/v1';
const STATEMENT_V01 = 'https://in-toto.io/Statement/v0.1';

const failure = (code, message) => Object.assign(new Error(message), {code});

// npm's key list ({keys: [{keyid, keytype, key, expires}]}) -> the verifier's
// {keyid: PublicKey}, each valid until its `expires`
function npmPublicKeys(list) {
  const keys = {};
  for (const k of (list && Array.isArray(list.keys)) ? list.keys : []) {
    if (k == null || typeof k.keyid !== 'string' || typeof k.key !== 'string' || k.keytype !== 'ecdsa-sha2-nistp256') continue;
    keys[k.keyid] = PublicKey.fromJSON({rawBytes: k.key, keyDetails: 'PKIX_ECDSA_P256_SHA_256',
      validFor: Object.assign({start: '1970-01-01T00:00:00Z'}, k.expires != null ? {end: k.expires} : {})});
  }
  return keys;
}

// a trusted root (its protobuf JSON) and npm's key list -> the two trust
// materials, each holding only what its attestation may be signed by (the
// review of #41):
// - provenance: the root's CAs, logs and CT logs, and no key, so only a
//   Fulcio certificate verifies;
// - publish: the root's logs, no CA, and npm's keys alone, so only npm's key
//   verifies (anyone can get a Sigstore certificate).
function trustMaterial(trustedRoot, npmKeys) {
  const noCAs = Object.assign({}, trustedRoot, {certificateAuthorities: []});
  return {
    provenance: toTrustMaterial(TrustedRoot.fromJSON(trustedRoot), {}),
    publish: toTrustMaterial(TrustedRoot.fromJSON(noCAs), npmPublicKeys(npmKeys))
  };
}

let bundled = null;
const bundledTrust = () => {
  if (bundled == null) bundled = trustMaterial(require('./sigstore/trusted-root.json'), require('./sigstore/npm-keys.json'));
  return bundled;
};

// DER UTF8String of s (with DER's long length form): how Fulcio encodes its
// extensions' values
const utf8Der = (s) => {
  const body = Buffer.from(s, 'utf8');
  if (body.length < 0x80) return Buffer.concat([Buffer.from([0x0c, body.length]), body]);
  const len = [];
  for (let v = body.length; v > 0; v >>= 8) len.unshift(v & 0xff);
  return Buffer.concat([Buffer.from([0x0c, 0x80 | len.length, ...len]), body]);
};
const fulcio = (n, value) => ({oid: {id: [1, 3, 6, 1, 4, 1, 57264, 1, n]}, value: utf8Der(value)});
const purl = (name, version) => `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

function pinProblem(pin, version) {
  if (pin == null || typeof pin !== 'object') return 'no pin';
  if (pin.version !== version) return `the pin is for ${pin.version}, not ${version}`;
  if (typeof pin.integrity !== 'string' || !SHA512.test(pin.integrity)) return 'the pin has no sha512 integrity';
  if (typeof pin.tag !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(pin.tag)) return 'the pin names no tag';
  // refs/tags/v<version> and nothing else, for every pin, ch-local's own
  // (built in memory by lib/npm-release.js) included
  if (pin.tag !== `v${version}`) return `the pin's tag is ${pin.tag}, not v${version}`;
  return identityProblem(pin);
}
function identityProblem(id) {
  if (typeof id.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(id.repository)) return 'no repository';
  for (const k of ['repositoryId', 'ownerId']) if (!Number.isSafeInteger(id[k]) || id[k] <= 0) return `${k} is not a positive integer`;
  if (typeof id.workflow !== 'string' || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(id.workflow)) return 'no workflow';
  return null;
}

// a raw bundle -> {parsed, entity}: what the verifier checks, and what is read
// afterwards (the review of #41: never the raw JSON, which the parsed bundle
// may differ from); its content must be a DSSE envelope, and exactly one log
// entry, with an inclusion promise
function parse(raw, what, key) {
  let parsed;
  try {
    parsed = bundleFromJSON(raw);
  } catch (e) {
    throw failure('PROVENANCE_CHAIN', `${what} is not a valid bundle (${e.message})`);
  }
  if (parsed.content == null || parsed.content.$case !== 'dsseEnvelope') throw failure('PROVENANCE_CHAIN', `${what} is not a DSSE envelope`);
  const material = parsed.verificationMaterial != null && parsed.verificationMaterial.content != null ? parsed.verificationMaterial.content.$case : null;
  if (material !== key) throw failure('PROVENANCE_CHAIN', `${what} must be signed by ${key === 'certificate' ? 'a Fulcio certificate' : 'npm\'s key'}, not ${material}`);
  const entries = parsed.verificationMaterial.tlogEntries;
  if (!Array.isArray(entries) || entries.length !== 1) throw failure('PROVENANCE_LOG', `${what} has ${Array.isArray(entries) ? entries.length : 'no'} log entries, not exactly one`);
  if (entries[0] == null || entries[0].inclusionPromise == null) throw failure('PROVENANCE_LOG', `${what}'s log entry has no inclusion promise`);
  let entity;
  try {
    entity = toSignedEntity(parsed);
  } catch (e) {
    throw failure('PROVENANCE_CHAIN', `${what} is not a valid bundle (${e.message})`);
  }
  return {parsed, entity, entry: entries[0]};
}

// verified by the trust -> the signer; failures as PROVENANCE_* codes
function verifyEntity(entity, trust, policy, what) {
  try {
    return new Verifier(trust).verify(entity, policy);
  } catch (e) {
    if (e != null && e.name === 'PolicyError') throw failure('PROVENANCE_IDENTITY', `${what}: ${e.message}`);
    const cause = e != null && e.cause != null ? String(e.cause.message) : '';
    if (e != null && e.code === 'CERTIFICATE_ERROR' && /certificate path found/.test(cause)) throw failure('PROVENANCE_UNKNOWN_ROOT', `${what} is signed under a CA this ch-local does not know`);
    // a key the list lacks; one it holds, used outside its window, is a
    // chain failure (the review of #41)
    if (e != null && e.code === 'PUBLIC_KEY_ERROR' && /key not found/.test(String(e.message))) throw failure('PROVENANCE_UNKNOWN_ROOT', `${what} is signed by a key this ch-local does not know`);
    throw failure('PROVENANCE_CHAIN', `${what} did not verify (${e && e.code ? `${e.code}: ` : ''}${e && e.message})`);
  }
}

function statementOf(parsed, type, what) {
  try {
    const st = JSON.parse(Buffer.from(parsed.content.dsseEnvelope.payload).toString('utf8'));
    if (st == null || st._type !== type) throw new Error(`not an in-toto ${type} statement`);
    return st;
  } catch (e) {
    throw failure('PROVENANCE_IDENTITY', `${what}'s statement could not be read (${e.message})`);
  }
}

function subjectOk(st, name, version, sha512Hex) {
  return Array.isArray(st.subject) && st.subject.length === 1 && st.subject[0] != null && st.subject[0].name === purl(name, version) &&
    st.subject[0].digest != null && st.subject[0].digest.sha512 === sha512Hex;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// {name, version, integrity, identity: {repository, repositoryId, ownerId,
//  workflow, ref}, attestations, trust?} -> {builtAt, publishedAt}
function verifyAttestations({name, version, integrity, identity, attestations, trust = null}) {
  if (typeof integrity !== 'string' || !SHA512.test(integrity)) throw failure('PIN_INCOMPLETE', `${name}@${version}: no sha512 integrity`);
  const why = identity != null ? identityProblem(identity) : 'no identity';
  if (why != null || typeof identity.ref !== 'string' || !/^refs\/(tags|heads)\/[A-Za-z0-9_./-]+$/.test(identity.ref)) throw failure('PIN_INCOMPLETE', `${name}@${version}: ${why || 'no ref'}`);
  const list = attestations != null && Array.isArray(attestations.attestations) ? attestations.attestations : [];
  const of = (type) => list.filter((a) => a != null && a.predicateType === type);
  if (of(PROVENANCE).length !== 1 || of(PUBLISH).length !== 1) throw failure('NO_PROVENANCE', `${name}@${version} has no provenance`);
  const material = trust != null ? trust : bundledTrust();
  const sha512Hex = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
  const {ref} = identity;
  const repoUrl = `https://github.com/${identity.repository}`;
  const san = `${repoUrl}/${identity.workflow}@${ref}`;

  // the SLSA provenance: a Fulcio certificate, its chain, then its identity:
  // the verifier's policy for the issuer and the OIDs (the build signer URI,
  // .9, among them), and the SAN compared exactly here (the verifier's own
  // SAN check is a pattern, not an equality)
  const prov = parse(of(PROVENANCE)[0].bundle, 'the provenance', 'certificate');
  const signer = verifyEntity(prov.entity, material.provenance, {
    extensions: {issuer: ISSUER},
    oids: [fulcio(9, san), fulcio(11, 'github-hosted'), fulcio(12, repoUrl), fulcio(14, ref), fulcio(15, String(identity.repositoryId)), fulcio(17, String(identity.ownerId)), fulcio(20, 'push')]
  }, 'the provenance');
  if (signer.identity == null || signer.identity.subjectAlternativeName !== san) {
    throw failure('PROVENANCE_IDENTITY', `the provenance was signed by ${signer.identity != null ? signer.identity.subjectAlternativeName : 'no identity'}, not ${san}`);
  }
  const st = statementOf(prov.parsed, STATEMENT_V1, 'the provenance');
  if (st.predicateType !== PROVENANCE || !subjectOk(st, name, version, sha512Hex)) throw failure('PROVENANCE_IDENTITY', `the provenance is not for ${name}@${version} with this tarball`);
  const def = st.predicate != null ? st.predicate.buildDefinition : null;
  const wf = def != null && def.externalParameters != null ? def.externalParameters.workflow : null;
  const gh = def != null && def.internalParameters != null ? def.internalParameters.github : null;
  if (def == null || def.buildType !== BUILD_TYPE || !sameJson(wf, {ref, repository: repoUrl, path: identity.workflow}) || gh == null || gh.event_name !== 'push') {
    throw failure('PROVENANCE_IDENTITY', 'the provenance\'s predicate does not agree with its certificate');
  }

  // npm's publish attestation: npm's key, and nothing else
  const pub = parse(of(PUBLISH)[0].bundle, 'the publish attestation', 'publicKey');
  verifyEntity(pub.entity, material.publish, undefined, 'the publish attestation');
  const ps = statementOf(pub.parsed, STATEMENT_V01, 'the publish attestation');
  if (ps.predicateType !== PUBLISH || !subjectOk(ps, name, version, sha512Hex) || !sameJson(ps.predicate, {name, version, registry: REGISTRY})) {
    throw failure('PROVENANCE_IDENTITY', `the publish attestation is not npm's for ${name}@${version} with this tarball`);
  }

  // the log times, from the parsed bundles, only now
  const seconds = (e) => new Date(Number(e.integratedTime) * 1000);
  return {builtAt: seconds(prov.entry), publishedAt: seconds(pub.entry)};
}

// {name, version, pin, attestations, trust?} -> {builtAt, publishedAt}: a
// release's package, built from its pinned repository's workflow at its tag
function verifyRelease({name, version, pin, attestations, trust = null}) {
  const why = pinProblem(pin, version);
  if (why != null) throw failure('PIN_INCOMPLETE', `${name}@${version}: ${why}`);
  return verifyAttestations({name, version, integrity: pin.integrity, attestations, trust,
    identity: {repository: pin.repository, repositoryId: pin.repositoryId, ownerId: pin.ownerId, workflow: pin.workflow, ref: `refs/tags/${pin.tag}`}});
}

module.exports = {verifyRelease, verifyAttestations, trustMaterial, npmPublicKeys, PROVENANCE, PUBLISH};
