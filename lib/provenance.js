'use strict';
// Provenance for an upgrade from npm (docs/development/auto-upgrade.md,
// "Provenance: exactly what is checked"). A version's attestations, as the
// registry serves them (/-/npm/v1/attestations/<name>@<version>), must hold
// exactly one SLSA provenance and one npm publish attestation.
// - Each bundle has exactly one Rekor entry, with an inclusion promise (the
//   signed entry timestamp covers the integrated time; a proof alone
//   doesn't), else PROVENANCE_LOG.
// - Each is verified by @sigstore/verify against the trusted root (the
//   chain, the SCT, the log entry, the signature): the SLSA one by its
//   Fulcio certificate, the publish one by npm's key. A certificate that
//   chains to no CA in the root, or a key the root lacks, is
//   PROVENANCE_UNKNOWN_ROOT ("can't verify yet"); any other failure is
//   PROVENANCE_CHAIN.
// - The certificate's identity is the pin's, by the verifier's own policy:
//   the SAN, the issuer, and Fulcio's runner (.11), repository URI (.12),
//   ref (.14), repository and owner IDs (.15, .17) and trigger (.20).
//   Then the predicate must agree with it, and the subject be
//   pkg:npm/<name>@<version> with the tarball's sha512. Any mismatch is
//   PROVENANCE_IDENTITY.
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
const STATEMENT = 'https://in-toto.io/Statement/v1';

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

// a trusted root (its protobuf JSON) and npm's key list -> TrustMaterial
function trustMaterial(trustedRoot, npmKeys) {
  return toTrustMaterial(TrustedRoot.fromJSON(trustedRoot), npmPublicKeys(npmKeys));
}

let bundled = null;
const bundledTrust = () => {
  if (bundled == null) bundled = trustMaterial(require('./sigstore/trusted-root.json'), require('./sigstore/npm-keys.json'));
  return bundled;
};

// DER UTF8String of s: how Fulcio encodes its extensions' values
const utf8Der = (s) => {
  const body = Buffer.from(s, 'utf8');
  if (body.length >= 0x80) throw failure('PIN_INCOMPLETE', 'an identity value is too long');
  return Buffer.concat([Buffer.from([0x0c, body.length]), body]);
};
const fulcio = (n, value) => ({oid: {id: [1, 3, 6, 1, 4, 1, 57264, 1, n]}, value: utf8Der(value)});
const purl = (name, version) => `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;

function pinProblem(pin, version) {
  if (pin == null || typeof pin !== 'object') return 'no pin';
  if (pin.version !== version) return `the pin is for ${pin.version}, not ${version}`;
  if (typeof pin.integrity !== 'string' || !SHA512.test(pin.integrity)) return 'the pin has no sha512 integrity';
  if (typeof pin.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pin.repository)) return 'the pin names no repository';
  for (const k of ['repositoryId', 'ownerId']) if (!Number.isSafeInteger(pin[k]) || pin[k] <= 0) return `the pin's ${k} is not a positive integer`;
  if (typeof pin.workflow !== 'string' || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(pin.workflow)) return 'the pin names no workflow';
  if (typeof pin.tag !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(pin.tag)) return 'the pin names no tag';
  return null;
}

// exactly one log entry, with an inclusion promise -> that entry
function oneEntry(bundle, what) {
  const entries = bundle != null && bundle.verificationMaterial != null ? bundle.verificationMaterial.tlogEntries : null;
  if (!Array.isArray(entries) || entries.length !== 1) throw failure('PROVENANCE_LOG', `${what} has ${Array.isArray(entries) ? entries.length : 'no'} log entries, not exactly one`);
  if (entries[0] == null || entries[0].inclusionPromise == null) throw failure('PROVENANCE_LOG', `${what}'s log entry has no inclusion promise`);
  return entries[0];
}

// verified by the root -> the signer; failures as PROVENANCE_* codes
function verifyBundle(bundle, trust, policy, what) {
  let entity;
  try {
    entity = toSignedEntity(bundleFromJSON(bundle));
  } catch (e) {
    throw failure('PROVENANCE_CHAIN', `${what} is not a valid bundle (${e.message})`);
  }
  try {
    return new Verifier(trust).verify(entity, policy);
  } catch (e) {
    if (e != null && e.name === 'PolicyError') throw failure('PROVENANCE_IDENTITY', `${what}: ${e.message}`);
    const cause = e != null && e.cause != null ? String(e.cause.message) : '';
    if (e != null && e.code === 'CERTIFICATE_ERROR' && /certificate path found/.test(cause)) throw failure('PROVENANCE_UNKNOWN_ROOT', `${what} is signed under a CA this ch-local does not know`);
    if (e != null && e.code === 'PUBLIC_KEY_ERROR') throw failure('PROVENANCE_UNKNOWN_ROOT', `${what} is signed by a key this ch-local does not know`);
    throw failure('PROVENANCE_CHAIN', `${what} did not verify (${e && e.code ? `${e.code}: ` : ''}${e && e.message})`);
  }
}

function statementOf(bundle, what) {
  try {
    const st = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
    if (st == null || st._type !== STATEMENT) throw new Error('not an in-toto statement');
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

// {name, version, pin, attestations, trust?} -> {builtAt, publishedAt}
function verifyRelease({name, version, pin, attestations, trust = null}) {
  const why = pinProblem(pin, version);
  if (why != null) throw failure('PIN_INCOMPLETE', `${name}@${version}: ${why}`);
  const list = attestations != null && Array.isArray(attestations.attestations) ? attestations.attestations : [];
  const of = (type) => list.filter((a) => a != null && a.predicateType === type);
  if (of(PROVENANCE).length !== 1 || of(PUBLISH).length !== 1) throw failure('NO_PROVENANCE', `${name}@${version} has no provenance`);
  const prov = of(PROVENANCE)[0].bundle;
  const pub = of(PUBLISH)[0].bundle;
  const material = trust != null ? trust : bundledTrust();
  const sha512Hex = Buffer.from(pin.integrity.slice('sha512-'.length), 'base64').toString('hex');
  const ref = `refs/tags/${pin.tag}`;
  const repoUrl = `https://github.com/${pin.repository}`;

  // the SLSA provenance: the chain, then the certificate's identity
  const provEntry = oneEntry(prov, 'the provenance');
  verifyBundle(prov, material, {
    subjectAlternativeName: `${repoUrl}/${pin.workflow}@${ref}`,
    extensions: {issuer: ISSUER},
    oids: [fulcio(11, 'github-hosted'), fulcio(12, repoUrl), fulcio(14, ref), fulcio(15, String(pin.repositoryId)), fulcio(17, String(pin.ownerId)), fulcio(20, 'push')]
  }, 'the provenance');
  const st = statementOf(prov, 'the provenance');
  if (st.predicateType !== PROVENANCE || !subjectOk(st, name, version, sha512Hex)) throw failure('PROVENANCE_IDENTITY', `the provenance is not for ${name}@${version} with this tarball`);
  const def = st.predicate != null ? st.predicate.buildDefinition : null;
  const wf = def != null && def.externalParameters != null ? def.externalParameters.workflow : null;
  const gh = def != null && def.internalParameters != null ? def.internalParameters.github : null;
  if (def == null || def.buildType !== BUILD_TYPE || !sameJson(wf, {ref, repository: repoUrl, path: pin.workflow}) || gh == null || gh.event_name !== 'push') {
    throw failure('PROVENANCE_IDENTITY', 'the provenance\'s predicate does not agree with its certificate');
  }

  // npm's publish attestation, by npm's key
  const pubEntry = oneEntry(pub, 'the publish attestation');
  verifyBundle(pub, material, undefined, 'the publish attestation');
  const ps = statementOf(pub, 'the publish attestation');
  if (ps.predicateType !== PUBLISH || !subjectOk(ps, name, version, sha512Hex) || !sameJson(ps.predicate, {name, version, registry: REGISTRY})) {
    throw failure('PROVENANCE_IDENTITY', `the publish attestation is not npm's for ${name}@${version} with this tarball`);
  }

  // the log times, only now
  const seconds = (e) => new Date(Number(e.integratedTime) * 1000);
  return {builtAt: seconds(provEntry), publishedAt: seconds(pubEntry)};
}

module.exports = {verifyRelease, trustMaterial, npmPublicKeys, PROVENANCE, PUBLISH};
