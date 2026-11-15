'use strict';
// lib/npm-release.js (docs/development/auto-upgrade.md, "The trust chain",
// steps 2-7): a release's packages fetched from the registry, each checked
// against its pin and its provenance, ch-local's own by its provenance alone,
// and written to a release directory for install's loadTarballs; the runtime
// lockfile with ch-local's entry filled from its verified digest. Against a
// fake registry and the test root, offline.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {fakeRegistry, sri} = require('./fake-registry');
const {testRoot} = require('./sigstore-fixture');
const provenance = require('../lib/provenance');
const {parseReleasePins} = require('../lib/release-pins');
const {fetchRelease, fillLockfile} = require('../lib/npm-release');
const {tarballName} = require('../lib/unpack');

const SELF = '@countinghouse/ch-local';
const io = {env: {}, fetch: (url, opts) => globalThis.fetch(url, opts)};
const root = testRoot();
const trust = provenance.trustMaterial(root.trustedRoot, root.npmKeys);
const at = new Date(Date.now() - 100 * 3600e3);
const hex = (bytes) => crypto.createHash('sha512').update(bytes).digest('hex');
const ids = {'countinghouse': [3000001, 2000002], '@countinghouse/ch-pack-ci-failure-triage': [3000002, 2000002]};
const repoOf = (name) => `mchen6/${name.split('/').pop()}`;

// a release whose pins name countinghouse and the triage pack's scenario,
// each published to `reg` with its provenance; ch-local at `selfVersion`
async function world({selfVersion = '0.4.0', lie = {}} = {}) {
  const reg = await fakeRegistry();
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8'));
  shipped.packs['ci-failure-triage'].packages = ['@countinghouse/ch-pack-ci-failure-triage'];
  const publish = (name, version, identity) => {
    const bytes = Buffer.from(`the ${name}@${version} tarball`);
    const integrity = reg.publish(name, version, bytes);
    const prov = root.provenance(name, version, lie[name] === 'digest' ? hex(Buffer.from('other')) : hex(bytes), identity, at);
    reg.attest(name, version, lie[name] === 'none' ? {attestations: []} : {attestations: [{predicateType: provenance.PROVENANCE, bundle: prov},
      {predicateType: provenance.PUBLISH, bundle: root.publish(name, version, hex(bytes), at)}]});
    return integrity;
  };
  for (const name of ['countinghouse', '@countinghouse/ch-pack-ci-failure-triage']) {
    const identity = {repository: repoOf(name), repositoryId: ids[name][0], ownerId: ids[name][1], workflow: '.github/workflows/publish.yml', tag: 'v1.2.3'};
    shipped.pins[name] = Object.assign({version: '1.2.3', integrity: publish(name, '1.2.3', identity)}, identity);
  }
  const self = Object.assign({}, shipped.self, {tag: `v${selfVersion}`});
  const selfIntegrity = publish(SELF, selfVersion, lie[SELF] === 'repo' ? Object.assign({}, self, {repository: 'someone/ch-local'}) : self);
  shipped.runtime.lockfile = {name: 'countinghouse-home-app', lockfileVersion: 3, requires: true, packages: {
    '': {name: 'countinghouse-home-app'},
    [`node_modules/${SELF}`]: {version: selfVersion, resolved: `file:tarballs/${tarballName(SELF, selfVersion)}`},
    'node_modules/countinghouse': {version: '1.2.3', resolved: 'file:tarballs/countinghouse-1.2.3.tgz', integrity: shipped.pins.countinghouse.integrity},
    'node_modules/ajv': {version: '8.17.1', resolved: 'https://registry.npmjs.org/ajv/-/ajv-8.17.1.tgz', integrity: `sha512-${'B'.repeat(86)}==`},
    [`node_modules/${SELF}/node_modules/@sigstore/verify`]: {version: '3.1.1', inBundle: true}
  }};
  const data = parseReleasePins(shipped);
  assert.strictEqual(data.problem, undefined, data.problem);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-rel-'));
  return {reg, data: data.pins, dir, selfVersion, selfIntegrity, close: async() => { await reg.close(); fs.rmSync(dir, {recursive: true, force: true}); }};
}
const names = [SELF, 'countinghouse', '@countinghouse/ch-pack-ci-failure-triage'];
const codeOf = async(p) => { try { await p; return 'resolved'; } catch (e) { return e.code; } };

test('a release: every package fetched, checked and written; ch-local pinned by its verified digest; the lockfile\'s ch-local entry filled', async() => {
  const w = await world();
  try {
    const r = await fetchRelease({data: w.data, version: w.selfVersion, names, dir: w.dir, io, registry: w.reg.url, trust});
    assert.deepStrictEqual(fs.readdirSync(w.dir).sort(), names.map((n) => tarballName(n, n === SELF ? w.selfVersion : '1.2.3')).sort());
    assert.strictEqual(r.pins[SELF].integrity, w.selfIntegrity);
    assert.deepStrictEqual(Object.keys(r.pins[SELF]).sort(), ['integrity', 'ownerId', 'repository', 'repositoryId', 'tag', 'version', 'workflow']);
    assert.strictEqual(r.pins[SELF].tag, `v${w.selfVersion}`);
    assert.strictEqual(r.lockfile.packages[`node_modules/${SELF}`].integrity, w.selfIntegrity, 'filled from the verified digest');
    assert.strictEqual(w.data.runtime.lockfile.packages[`node_modules/${SELF}`].integrity, undefined, 'the release\'s own data untouched');
    for (const n of names) assert.strictEqual(r.published[n].getTime(), Math.floor(at.getTime() / 1000) * 1000, n);
    for (const n of names) {
      const file = path.join(w.dir, tarballName(n, n === SELF ? w.selfVersion : '1.2.3'));
      assert.strictEqual(sri(fs.readFileSync(file)), r.pins[n].integrity, `${n}: the bytes written are the ones checked`);
    }
  } finally {
    await w.close();
  }
});

test('one package that fails its provenance, or has none, fails the release, naming it, and nothing is written', async() => {
  for (const [name, lie, code] of [['countinghouse', 'digest', 'PROVENANCE_IDENTITY'], ['@countinghouse/ch-pack-ci-failure-triage', 'none', 'NO_PROVENANCE'], [SELF, 'repo', 'PROVENANCE_IDENTITY']]) {
    const w = await world({lie: {[name]: lie}});
    try {
      let err = null;
      try { await fetchRelease({data: w.data, version: w.selfVersion, names, dir: w.dir, io, registry: w.reg.url, trust}); } catch (e) { err = e; }
      assert.ok(err != null, name);
      assert.strictEqual(err.code, code, name);
      assert.strictEqual(err.package, name);
      assert.deepStrictEqual(fs.readdirSync(w.dir), [], `${name}: nothing written`);
    } finally {
      await w.close();
    }
  }
});

test('a lockfile entry without integrity fails the release before anything is written; a pack alone needs no lockfile', async() => {
  const w = await world();
  try {
    const data = JSON.parse(JSON.stringify(w.data));
    delete data.runtime.lockfile.packages['node_modules/ajv'].integrity;
    let err = null;
    try { await fetchRelease({data, version: w.selfVersion, names, dir: w.dir, io, registry: w.reg.url, trust}); } catch (e) { err = e; }
    assert.strictEqual(err && err.code, 'LOCKFILE_INTEGRITY');
    assert.deepStrictEqual(fs.readdirSync(w.dir), [], 'nothing written');
    const packOnly = await fetchRelease({data: w.data, version: w.selfVersion, names: ['@countinghouse/ch-pack-ci-failure-triage'], dir: w.dir, io, registry: w.reg.url, trust});
    assert.strictEqual(packOnly.lockfile, null);
  } finally {
    await w.close();
  }
});

test('a package no pin names (other than ch-local) is refused before anything is fetched', async() => {
  const w = await world();
  try {
    assert.strictEqual(await codeOf(fetchRelease({data: w.data, version: w.selfVersion, names: [...names, '@countinghouse/ch-step-redact'], dir: w.dir, io, registry: w.reg.url, trust})), 'NOT_PINNED');
    assert.deepStrictEqual(w.reg.requests, []);
  } finally {
    await w.close();
  }
});

test('the lockfile: every entry but the root, ch-local\'s own and bundled ones must carry a sha512 integrity', () => {
  const SHA = `sha512-${'C'.repeat(86)}==`;
  const lock = {lockfileVersion: 3, packages: {'': {}, [`node_modules/${SELF}`]: {version: '0.4.0'}, 'node_modules/a': {version: '1.0.0', integrity: SHA},
    [`node_modules/${SELF}/node_modules/@sigstore/core`]: {version: '3.2.1', inBundle: true}}};
  const filled = fillLockfile(lock, SHA);
  assert.strictEqual(filled.packages[`node_modules/${SELF}`].integrity, SHA);
  assert.strictEqual(lock.packages[`node_modules/${SELF}`].integrity, undefined, 'a copy');
  const missing = JSON.parse(JSON.stringify(lock));
  delete missing.packages['node_modules/a'].integrity;
  assert.throws(() => fillLockfile(missing, SHA), (e) => e.code === 'LOCKFILE_INTEGRITY' && /node_modules\/a/.test(e.message));
  const sha1 = JSON.parse(JSON.stringify(lock));
  sha1.packages['node_modules/a'].integrity = 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=';
  assert.throws(() => fillLockfile(sha1, SHA), (e) => e.code === 'LOCKFILE_INTEGRITY');
  const noSelf = JSON.parse(JSON.stringify(lock));
  delete noSelf.packages[`node_modules/${SELF}`];
  assert.throws(() => fillLockfile(noSelf, SHA), (e) => e.code === 'LOCKFILE_INTEGRITY' && /ch-local/.test(e.message));
  assert.strictEqual(fillLockfile(null, SHA), null, 'no lockfile yet (before the first release)');
});

// the review of #41, for the callers ----------------------------------------

test('no lib/ code passes `trust` or `registry`: only a test\'s own code does', () => {
  const lib = path.join(__dirname, '..', 'lib');
  const files = fs.readdirSync(lib).filter((f) => f.endsWith('.js'));
  // code only: comments and strings set nothing
  const code = (f) => fs.readFileSync(path.join(lib, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "''");
  const found = [];
  for (const f of files) {
    const src = code(f);
    // a call or an object literal naming either as a property, or a spread
    // of a variable into one (fromNpm is install's test-only argument)
    for (const m of src.matchAll(/[{,]\s*(trust|registry)\s*:/g)) {
      const line = src.slice(0, m.index).split('\n').length;
      found.push(`${f}:${line}`);
    }
  }
  // the only places: the defaults in the signatures that take them
  const allowed = new Set(['npm-fetch.js', 'npm-release.js', 'provenance.js']);
  const bad = found.filter((at) => !allowed.has(at.split(':')[0]));
  assert.deepStrictEqual(bad, [], `trust or registry passed from: ${bad.join(', ')}`);
  for (const f of allowed) {
    const src = code(f);
    assert.doesNotMatch(src, /[{,]\s*(trust|registry)\s*:\s*(?!null\b|REGISTRY\b|npmFetch\.REGISTRY\b|trust\b|registry\b)/, `${f} sets trust or registry to something of its own`);
  }
  assert.match(fs.readFileSync(path.join(lib, 'install.js'), 'utf8'), /\.\.\.fromNpm/, 'install passes only its test-only argument on');
});

test('install and upgrade reach provenance only through verifyRelease (refs/tags/v<version>): no lib/ code but provenance.js names verifyAttestations', () => {
  const lib = path.join(__dirname, '..', 'lib');
  const callers = fs.readdirSync(lib).filter((f) => f.endsWith('.js') && f !== 'provenance.js')
    .filter((f) => /verifyAttestations/.test(fs.readFileSync(path.join(lib, f), 'utf8')));
  assert.deepStrictEqual(callers, []);
  assert.match(fs.readFileSync(path.join(lib, 'npm-release.js'), 'utf8'), /provenance\.verifyRelease\(/);
});

test('a bundled lockfile entry is exempt only beneath a runtime package\'s own node_modules', () => {
  const SHA = `sha512-${'C'.repeat(86)}==`;
  const base = () => ({lockfileVersion: 3, packages: {'': {}, [`node_modules/${SELF}`]: {version: '0.4.0'}, 'node_modules/countinghouse': {version: '1.2.3', integrity: SHA}}});
  const under = base();
  under.packages[`node_modules/${SELF}/node_modules/@sigstore/core`] = {version: '3.2.1', inBundle: true};
  under.packages['node_modules/countinghouse/node_modules/x'] = {version: '1.0.0', inBundle: true};
  assert.ok(fillLockfile(under, SHA));
  const loose = base();
  loose.packages['node_modules/evil'] = {version: '6.6.6', inBundle: true};
  assert.throws(() => fillLockfile(loose, SHA), (e) => e.code === 'LOCKFILE_INTEGRITY' && /node_modules\/evil/.test(e.message));
  const underOther = base();
  underOther.packages['node_modules/left-pad/node_modules/y'] = {version: '1.0.0', inBundle: true};
  assert.throws(() => fillLockfile(underOther, SHA), (e) => e.code === 'LOCKFILE_INTEGRITY');
});
