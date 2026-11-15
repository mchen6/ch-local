'use strict';
// A test trusted root and the bundles it signs (docs/development/
// auto-upgrade.md, "Tests (no network)"), generated per run, so the real
// @sigstore/verify chain check runs offline:
// - a self-signed CA in Fulcio's place, issuing leaf certificates with the
//   GitHub OIDC extensions (numeric IDs included) and an SCT from a test CT
//   log over the precertificate (RFC 6962 section 3.2);
// - a Rekor key: each bundle's DSSE entry (dsse 0.0.1) with an inclusion
//   promise (the signed entry timestamp) at an integrated time the test
//   chooses;
// - an npm-registry key for the publish attestation.
// Nothing here is a real key or reaches the network; the URLs are .invalid.
const crypto = require('node:crypto');

// --- DER, minimal and canonical ---------------------------------------------
const len = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items) => tlv(0x30, Buffer.concat(items));
const set = (...items) => tlv(0x31, Buffer.concat(items));
const int = (n) => {
  let b = Buffer.isBuffer(n) ? n : Buffer.from(n.toString(16).padStart(2, '0').replace(/^(.(..)*)$/, '0$1'), 'hex');
  while (b.length > 1 && b[0] === 0 && b[1] < 0x80) b = b.subarray(1);
  if (b[0] >= 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
};
const oid = (dotted) => {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (const p of parts.slice(2)) {
    const stack = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) stack.unshift(0x80 | (v & 0x7f));
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
};
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const octets = (b) => tlv(0x04, b);
const bits = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const ctx = (n, body, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, body);
const time = (d) => {
  const s = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${s.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${s}Z`));
};
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));
const name = (cn) => seq(set(seq(oid('2.5.4.10'), utf8('countinghouse-test'))), set(seq(oid('2.5.4.3'), utf8(cn))));
const ext = (id, value, critical = false) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const spki = (key) => key.export({type: 'spki', format: 'der'});
const ski = (key) => crypto.createHash('sha1').update(spki(key)).digest();

function certificate({serial, issuer, subject, notBefore, notAfter, publicKey, extensions, signer}) {
  const tbs = seq(ctx(0, int(2)), int(serial), ECDSA_SHA256, issuer, seq(time(notBefore), time(notAfter)), subject, spki(publicKey), ctx(3, seq(...extensions)));
  const sig = crypto.sign('sha256', tbs, signer);
  return {tbs, der: seq(tbs, ECDSA_SHA256, bits(sig))};
}

const keyPair = () => crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
const logIdOf = (key) => crypto.createHash('sha256').update(spki(key)).digest();
const pem = (der, label) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : (v != null && typeof v === 'object') ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v));

// Fulcio's certificate extension OIDs (1.3.6.1.4.1.57264.1.<n>)
const FULCIO = (n) => `1.3.6.1.4.1.57264.1.${n}`;
// a package URL as npm writes it in a statement's subject: the scope's @ as %40
const purl = (name, version) => `pkg:npm/${name.replace(/^@/, '%40')}@${version}`;

// -> {trustedRoot (the protobuf JSON), npmKeys, sign: {provenance, publish}}
function testRoot({start = new Date(Date.now() - 365 * 864e5), end = new Date(Date.now() + 365 * 864e5)} = {}) {
  const ca = keyPair();
  const rekor = keyPair();
  const ctlog = keyPair();
  const npm = keyPair();
  const caName = name('test fulcio');
  const caCert = certificate({serial: 1, issuer: caName, subject: caName, notBefore: start, notAfter: end, publicKey: ca.publicKey, signer: ca.privateKey,
    extensions: [ext('2.5.29.19', seq(bool(true)), true), ext('2.5.29.15', bits(Buffer.from([0x06])), true), ext('2.5.29.14', octets(ski(ca.publicKey)))]}).der;
  const logEntry = (key) => ({baseUrl: 'https://log.example.invalid', hashAlgorithm: 'SHA2_256',
    publicKey: {rawBytes: spki(key).toString('base64'), keyDetails: 'PKIX_ECDSA_P256_SHA_256', validFor: {start: start.toISOString()}},
    logId: {keyId: logIdOf(key).toString('base64')}});
  const trustedRoot = {
    mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1',
    tlogs: [logEntry(rekor.publicKey)],
    certificateAuthorities: [{subject: {organization: 'countinghouse-test', commonName: 'test fulcio'}, uri: 'https://fulcio.example.invalid',
      certChain: {certificates: [{rawBytes: caCert.toString('base64')}]}, validFor: {start: start.toISOString(), end: end.toISOString()}}],
    ctlogs: [logEntry(ctlog.publicKey)],
    timestampAuthorities: []
  };
  const npmKeyId = 'SHA256:countinghouse-test-npm-key';
  let serial = 100;

  // a DSSE envelope over `statement`, signed by `key`, as a bundle whose
  // Rekor entry is integrated at `integratedTime` (a Date). verification:
  // {certificate: der} or {publicKey: hint}.
  const bundle = (statement, key, verification, {integratedTime, promise = true, entries = 1, tamper = {}} = {}) => {
    const payload = Buffer.from(JSON.stringify(statement));
    const type = 'application/vnd.in-toto+json';
    const pae = Buffer.concat([Buffer.from(`DSSEv1 ${type.length} ${type} ${payload.length} `), payload]);
    const sig = crypto.sign('sha256', pae, key);
    const verifier = verification.certificate != null ? pem(verification.certificate, 'CERTIFICATE') : pem(spki(verification.publicKeyObject), 'PUBLIC KEY');
    const body = Buffer.from(canonical({apiVersion: '0.0.1', kind: 'dsse', spec: {
      envelopeHash: {algorithm: 'sha256', value: crypto.createHash('sha256').update(canonical({payload: payload.toString('base64'), payloadType: type, signatures: [{sig: sig.toString('base64')}]})).digest('hex')},
      payloadHash: {algorithm: 'sha256', value: crypto.createHash('sha256').update(payload).digest('hex')},
      signatures: [{signature: sig.toString('base64'), verifier: Buffer.from(verifier).toString('base64')}]}}));
    const seconds = Math.floor(integratedTime.getTime() / 1000);
    const entry = (logIndex) => {
      const e = {logIndex: String(logIndex), logId: {keyId: logIdOf(rekor.publicKey).toString('base64')}, kindVersion: {kind: 'dsse', version: '0.0.1'},
        integratedTime: String(seconds), canonicalizedBody: body.toString('base64')};
      if (promise) {
        const set = crypto.sign('sha256', Buffer.from(canonical({body: body.toString('base64'), integratedTime: seconds, logIndex, logID: logIdOf(rekor.publicKey).toString('hex')})), rekor.privateKey);
        e.inclusionPromise = {signedEntryTimestamp: set.toString('base64')};
      }
      // the inclusion proof (a bundle v0.3 needs one): the entry as a tree of
      // one leaf, its root the leaf's hash (RFC 6962), and a checkpoint
      // signed by the log ("<origin>\n<size>\n<root>\n", then the signature
      // line: the log's name, and its key's 4-byte hint and the signature)
      const root = crypto.createHash('sha256').update(Buffer.concat([Buffer.from([0]), body])).digest();
      const note = `log.example.invalid - test\n1\n${root.toString('base64')}\n`;
      const noteSig = crypto.sign('sha256', Buffer.from(note), rekor.privateKey);
      const signature = Buffer.concat([logIdOf(rekor.publicKey).subarray(0, 4), noteSig]).toString('base64');
      e.inclusionProof = {logIndex: '0', rootHash: root.toString('base64'), treeSize: '1', hashes: [],
        checkpoint: {envelope: `${note}\n— log.example.invalid ${signature}\n`}};
      return e;
    };
    const tlogEntries = Array.from({length: entries}, (_, i) => entry(1000 + i));
    const material = verification.certificate != null ? {certificate: {rawBytes: verification.certificate.toString('base64')}} : {publicKey: {hint: verification.publicKey}};
    return Object.assign({mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json', verificationMaterial: Object.assign(material, {tlogEntries}),
      dsseEnvelope: {payload: payload.toString('base64'), payloadType: type, signatures: [{sig: sig.toString('base64'), keyid: ''}]}}, tamper);
  };

  // a Fulcio-style leaf for a GitHub Actions run, with its SCT
  const leaf = (identity, at) => {
    const key = keyPair();
    const {repository, repositoryId, ownerId, workflow, tag, issuer = 'https://token.actions.githubusercontent.com', runner = 'github-hosted', event = 'push'} = identity;
    const san = `https://github.com/${repository}/${workflow}@refs/tags/${tag}`;
    const fulcio = [
      ext(FULCIO(8), utf8(issuer)), ext(FULCIO(9), utf8(san)), ext(FULCIO(11), utf8(runner)), ext(FULCIO(12), utf8(`https://github.com/${repository}`)),
      ext(FULCIO(14), utf8(`refs/tags/${tag}`)), ext(FULCIO(15), utf8(String(repositoryId))), ext(FULCIO(17), utf8(String(ownerId))), ext(FULCIO(20), utf8(event))
    ];
    const base = [ext('2.5.29.15', bits(Buffer.from([0x80])), true), ext('2.5.29.37', seq(oid('1.3.6.1.5.5.7.3.3'))),
      ext('2.5.29.35', seq(ctx(0, ski(ca.publicKey), false))), ext('2.5.29.17', seq(tlv(0x86, Buffer.from(san))), true), ...fulcio];
    const notBefore = new Date(at.getTime() - 60e3);
    const notAfter = new Date(at.getTime() + 10 * 60e3);
    serial += 1;
    const common = {serial, issuer: caName, subject: seq(), notBefore, notAfter, publicKey: key.publicKey, signer: ca.privateKey};
    // the precertificate's TBS: the same, without the SCT extension
    const pre = certificate(Object.assign({}, common, {extensions: base}));
    const stamp = Buffer.alloc(8);
    stamp.writeBigInt64BE(BigInt(at.getTime()));
    const issuerId = crypto.createHash('sha256').update(spki(ca.publicKey)).digest();
    const tbsLen = Buffer.alloc(3);
    tbsLen.writeUIntBE(pre.tbs.length, 0, 3);
    const signed = Buffer.concat([Buffer.from([0, 0]), stamp, Buffer.from([0, 1]), issuerId, tbsLen, pre.tbs, Buffer.from([0, 0])]);
    const sctSig = crypto.sign('sha256', signed, ctlog.privateKey);
    const sigLen = Buffer.alloc(2);
    sigLen.writeUInt16BE(sctSig.length);
    const sct = Buffer.concat([Buffer.from([0]), logIdOf(ctlog.publicKey), stamp, Buffer.from([0, 0]), Buffer.from([4, 3]), sigLen, sctSig]);
    const one = Buffer.concat([Buffer.alloc(2), sct]);
    one.writeUInt16BE(sct.length, 0);
    const list = Buffer.concat([Buffer.alloc(2), one]);
    list.writeUInt16BE(one.length, 0);
    const full = certificate(Object.assign({}, common, {extensions: [...base, ext('1.3.6.1.4.1.11129.2.4.2', octets(list))]}));
    return {key, der: full.der};
  };

  const statement = (predicateType, subjectName, sha512Hex, predicate) => ({_type: 'https://in-toto.io/Statement/v1',
    subject: [{name: subjectName, digest: {sha512: sha512Hex}}], predicateType, predicate});

  return {
    trustedRoot,
    // npm's keys, in the registry's own form (/-/npm/v1/keys), which
    // ch-local ships beside the trusted root
    npmKeys: {keys: [{expires: null, keyid: npmKeyId, keytype: 'ecdsa-sha2-nistp256', scheme: 'ecdsa-sha2-nistp256', key: spki(npm.publicKey).toString('base64')}]},
    rekorKey: rekor.publicKey,
    // the SLSA provenance bundle for name@version whose tarball's sha512 is
    // sha512Hex, built by `identity` at `at`. overrides: {predicate, subject,
    // statement} to make a lying one.
    provenance(name, version, sha512Hex, identity, at, {overrides = {}, bundle: opts = {}} = {}) {
      const {repository, workflow, tag} = identity;
      const predicate = overrides.predicate || {buildDefinition: {buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {workflow: {ref: `refs/tags/${tag}`, repository: `https://github.com/${repository}`, path: workflow}},
        internalParameters: {github: {event_name: identity.event || 'push', repository_id: String(identity.repositoryId), repository_owner_id: String(identity.ownerId)}}},
      runDetails: {builder: {id: 'https://github.com/actions/runner/github-hosted'}}};
      const st = overrides.statement || statement('https://slsa.dev/provenance/v1', overrides.subject || purl(name, version), sha512Hex, predicate);
      const cert = leaf(identity, at);
      return bundle(st, cert.key.privateKey, {certificate: cert.der}, Object.assign({integratedTime: at}, opts));
    },
    // npm's publish attestation for name@version, signed by the npm key (or
    // another, for a test)
    publish(name, version, sha512Hex, at, {key = npm, keyId = npmKeyId, predicate, bundle: opts = {}} = {}) {
      const st = statement('https://github.com/npm/attestation/tree/main/specs/publish/v0.1', purl(name, version), sha512Hex,
        predicate || {name, version, registry: 'https://registry.npmjs.org'});
      return bundle(st, key.privateKey, {publicKey: keyId, publicKeyObject: key.publicKey}, Object.assign({integratedTime: at}, opts));
    },
    otherKey: keyPair
  };
}

module.exports = {testRoot, FULCIO, purl};
