'use strict';
// A fake registry holding a whole release, each package with its provenance
// under the test root (test/sigstore-fixture.js), for the install and upgrade
// tests. The release is install-helpers' release(); ch-local's tarball is a
// real one carrying the release's lib/release-pins.json, as a published
// ch-local would. Offline: the registry is on 127.0.0.1.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {fakeRegistry} = require('./fake-registry');
const {testRoot} = require('./sigstore-fixture');
const {packageTgz} = require('./tgz');
const provenance = require('../lib/provenance');
const {tarballName} = require('../lib/install');

const SELF = '@countinghouse/ch-local';
const hex = (b) => crypto.createHash('sha512').update(b).digest('hex');
const sri = (b) => `sha512-${crypto.createHash('sha512').update(b).digest('base64')}`;
const shipped = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8'));

// r: install-helpers' release(). version: ch-local's. -> {reg, pinsDoc,
// fromNpm, close}. edit(doc): changes the release-pins document ch-local
// carries before it is packed.
async function npmWorld(r, {version = r.pins[SELF].version, edit = null, lie = null, at = new Date(Date.now() - 100 * 3600e3)} = {}) {
  const reg = await fakeRegistry();
  const root = testRoot();
  const doc = shipped();
  doc.packs = JSON.parse(JSON.stringify(r.allow.packs));
  doc.pins = {};
  let n = 0;
  const attest = (name, v, bytes, identity) => {
    reg.attest(name, v, {attestations: [
      {predicateType: provenance.PROVENANCE, bundle: root.provenance(name, v, lie === name ? hex(Buffer.from('other')) : hex(bytes), identity, at)},
      {predicateType: provenance.PUBLISH, bundle: root.publish(name, v, hex(bytes), at)}]});
  };
  for (const [name, pin] of Object.entries(r.pins)) {
    if (name === SELF) continue;
    const bytes = fs.readFileSync(path.join(r.from, tarballName(name, pin.version)));
    reg.publish(name, pin.version, bytes);
    const identity = {repository: `mchen6/${name.split('/').pop()}`, repositoryId: 4000000 + (n += 1), ownerId: 1168741, workflow: '.github/workflows/publish.yml', tag: `v${pin.version}`};
    attest(name, pin.version, bytes, identity);
    doc.pins[name] = Object.assign({version: pin.version, integrity: pin.integrity}, identity);
  }
  const lockfile = JSON.parse(JSON.stringify(r.lockfile));
  lockfile.packages['node_modules/countinghouse'].integrity = r.pins.countinghouse.integrity;
  lockfile.packages[`node_modules/${SELF}`].version = version;
  lockfile.packages[`node_modules/${SELF}`].resolved = `file:tarballs/${tarballName(SELF, version)}`;
  doc.runtime.lockfile = lockfile;
  if (edit != null) edit(doc);
  const selfBytes = packageTgz({name: SELF, version}, {'lib/release-pins.json': JSON.stringify(doc)});
  reg.publish(SELF, version, selfBytes, {latest: true});
  attest(SELF, version, selfBytes, Object.assign({}, doc.self, {tag: `v${version}`}));
  return {reg, pinsDoc: doc, selfIntegrity: sri(selfBytes),
    fromNpm: {registry: reg.url, trust: provenance.trustMaterial(root.trustedRoot, root.npmKeys)}, close: () => reg.close()};
}

module.exports = {npmWorld, SELF};
