'use strict';
require('./tmp-dirs');
// lib/npm-upgrade.js findUpgrade (docs/development/auto-upgrade.md, "The
// trust chain", steps 1-5): the registry's latest ch-local, strict semver,
// newer and of the same major; its tarball checked by its provenance against
// the installed release's own identity; its release-pins.json read from
// those verified bytes in memory; what it adds that needs the user's yes.
// Against a fake registry and the test root, offline.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {fakeRegistry} = require('./fake-registry');
const {testRoot} = require('./sigstore-fixture');
const {packageTgz} = require('./tgz');
const provenance = require('../lib/provenance');
const {parseReleasePins} = require('../lib/release-pins');
const {findUpgrade, releaseAllow, newer} = require('../lib/npm-upgrade');

const SELF = '@countinghouse/ch-local';
const io = {env: {}, fetch: (url, opts) => globalThis.fetch(url, opts)};
const root = testRoot();
const trust = provenance.trustMaterial(root.trustedRoot, root.npmKeys);
const at = new Date(Date.now() - 100 * 3600e3);
const shipped = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8'));
const current = parseReleasePins(shipped()).pins;

// the registry's ch-local at `version`, carrying `pins` (a release-pins
// document, or raw text) and signed for `identity`
async function registryWith(version, {pins = shipped(), identity, lie = null, latest = version} = {}) {
  const reg = await fakeRegistry();
  const text = typeof pins === 'string' ? pins : JSON.stringify(pins);
  const bytes = packageTgz({name: SELF, version}, {'lib/release-pins.json': text});
  reg.publish(SELF, version, bytes, {latest: latest === version});
  const id = identity || Object.assign({}, current.self, {tag: `v${version}`});
  const hex = crypto.createHash('sha512').update(lie === 'digest' ? Buffer.from('x') : bytes).digest('hex');
  reg.attest(SELF, version, {attestations: [{predicateType: provenance.PROVENANCE, bundle: root.provenance(SELF, version, hex, id, at)},
    {predicateType: provenance.PUBLISH, bundle: root.publish(SELF, version, crypto.createHash('sha512').update(bytes).digest('hex'), at)}]});
  return reg;
}
const find = (reg, installed = '0.3.0', packs = ['ci-failure-triage']) => findUpgrade({data: current, installed, packs, io, registry: reg.url, trust});
const codeOf = async(p) => { try { await p; return 'resolved'; } catch (e) { return e.code; } };

test('newer: strict MAJOR.MINOR.PATCH by precedence; anything else is never newer', () => {
  assert.strictEqual(newer('0.10.0', '0.9.9'), true);
  assert.strictEqual(newer('1.0.0', '0.99.99'), true);
  assert.strictEqual(newer('0.3.0', '0.3.0'), false);
  assert.strictEqual(newer('0.2.9', '0.3.0'), false);
  for (const v of ['0.4.0-rc.1', '0.4', '0.4.0+b', '00.4.0', 'v0.4.0', '', null]) assert.strictEqual(newer(v, '0.3.0'), false, String(v));
});

test('the review of #48: a 0.x minor or a 0.0.x patch is breaking; a 0.x patch or a 1.x minor is not', () => {
  const {breaking} = require('../lib/npm-upgrade');
  for (const [to, from, want] of [['0.2.0', '0.1.0', true], ['0.9.0', '0.1.5', true], ['0.0.2', '0.0.1', true], ['0.1.0', '0.0.9', true],
    ['0.1.1', '0.1.0', false], ['0.1.9', '0.1.2', false], ['1.1.0', '1.0.0', false], ['1.0.1', '1.0.0', false]]) {
    assert.strictEqual(breaking(to, from), want, `${from} -> ${to}`);
  }
});

test('a newer ch-local of the same major: available, its pins read from its verified tarball, nothing new to agree to', async() => {
  const reg = await registryWith('0.4.0');
  try {
    const r = await find(reg);
    assert.strictEqual(r.kind, 'available');
    assert.strictEqual(r.to, '0.4.0');
    assert.deepStrictEqual(r.adds, []);
    assert.deepStrictEqual(r.data.packs, current.packs);
    assert.strictEqual(r.publishedAt.getTime(), Math.floor(at.getTime() / 1000) * 1000);
    const allow = releaseAllow(r.data, r.to);
    assert.strictEqual(allow.release.version, '0.4.0');
    assert.deepStrictEqual(allow.self, current.self);
  } finally {
    await reg.close();
  }
});

test('up to date, or an older or non-strict latest: nothing; a major: announced, never available', async() => {
  for (const [latest, installed, kind] of [['0.3.0', '0.3.0', 'up-to-date'], ['0.2.0', '0.3.0', 'up-to-date'], ['0.4.0-rc.1', '0.3.0', 'up-to-date'], ['1.0.0', '0.3.0', 'major']]) {
    const reg = await registryWith(latest);
    try {
      const r = await find(reg, installed);
      assert.strictEqual(r.kind, kind, `${latest} over ${installed}`);
      if (kind === 'major') assert.strictEqual(r.to, '1.0.0');
      assert.ok(!reg.requests.some((u) => u.endsWith('.tgz')), 'no tarball fetched');
    } finally {
      await reg.close();
    }
  }
});

test('the review of #48: with allowMajor (ch-local upgrade only), a major is checked like any other; a downgrade, a prerelease or a non-strict version stays refused', async() => {
  const findMajor = (reg, installed) => findUpgrade({data: current, installed, packs: ['ci-failure-triage'], io, registry: reg.url, trust, allowMajor: true});
  const good = await registryWith('1.0.0');
  try {
    const r = await findMajor(good, '0.3.0');
    assert.deepStrictEqual([r.kind, r.to, r.major], ['available', '1.0.0', true]);
    assert.ok(good.requests.some((u) => u.endsWith('.tgz')), 'fetched and verified');
  } finally {
    await good.close();
  }
  const lie = await registryWith('1.0.0', {lie: 'digest'});
  try {
    assert.match(String(await codeOf(findMajor(lie, '0.3.0'))), /^PROVENANCE/, 'a major whose provenance fails is refused');
  } finally {
    await lie.close();
  }
  for (const [latest, installed] of [['0.2.0', '1.0.0'], ['2.0.0-rc.1', '1.0.0'], ['v2.0.0', '1.0.0']]) {
    const reg = await registryWith(latest);
    try {
      assert.strictEqual((await findMajor(reg, installed)).kind, 'up-to-date', `${latest} over ${installed}`);
    } finally {
      await reg.close();
    }
  }
});

test('the new release\'s provenance, against the installed release\'s own identity: another repository or digest fails', async() => {
  const other = await registryWith('0.4.0', {identity: Object.assign({}, current.self, {repository: 'someone/ch-local', tag: 'v0.4.0'})});
  const digest = await registryWith('0.4.0', {lie: 'digest'});
  try {
    assert.strictEqual(await codeOf(find(other)), 'PROVENANCE_IDENTITY');
    assert.strictEqual(await codeOf(find(digest)), 'PROVENANCE_IDENTITY');
  } finally {
    await other.close();
    await digest.close();
  }
});

test('the new release\'s pins: refused if invalid; its own identity changing is listed as blocking, not refused', async() => {
  const changed = shipped();
  changed.self.repositoryId += 1;
  const reg = await registryWith('0.4.0', {pins: changed});
  try {
    const r = await find(reg);
    assert.strictEqual(r.kind, 'available');
    assert.deepStrictEqual(r.identity, [`self's repositoryId: ${current.self.repositoryId} -> ${current.self.repositoryId + 1}`]);
    assert.deepStrictEqual(r.named, []);
  } finally {
    await reg.close();
  }
  const missingPins = await fakeRegistry();
  for (const [pins, code] of [['{not json', 'RELEASE_PINS'], [Object.assign(shipped(), {v: 2}), 'RELEASE_PINS']]) {
    const reg = await registryWith('0.4.0', {pins});
    try {
      assert.strictEqual(await codeOf(find(reg)), code, JSON.stringify(pins).slice(0, 40));
    } finally {
      await reg.close();
    }
  }
  await missingPins.close();
});

test('what it adds that needs a yes: a package in or a credential for an installed pack, an origin', async() => {
  const next = shipped();
  next.packs['ci-failure-triage'].credentials.push('NEW_TOKEN');
  next.allowedOrigins['https://api.example.invalid'] = ['NEW_TOKEN'];
  const reg = await registryWith('0.4.0', {pins: next});
  try {
    const r = await find(reg);
    assert.strictEqual(r.kind, 'available');
    assert.deepStrictEqual(r.adds.sort(), ['a credential for ci-failure-triage: NEW_TOKEN', 'an origin: https://api.example.invalid']);
  } finally {
    await reg.close();
  }
});
