'use strict';
require('./tmp-dirs');
// The registry fetch (docs/development/auto-upgrade.md, "The trust chain",
// step 2): a packument and a tarball from the registry only, each bounded in
// size and time, the tarball's sha512 checked against dist.integrity and,
// when given, its pin. Against a fake registry on 127.0.0.1: no network.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const {fakeRegistry, sri} = require('./fake-registry');
const npmFetch = require('../lib/npm-fetch');

const NAME = '@countinghouse/ch-local';
const io = {env: {}, fetch: (url, opts) => globalThis.fetch(url, opts)};
const bytesOf = (n, seed = 1) => crypto.createHash('sha512').update(String(seed)).digest().toString('hex').repeat(Math.ceil(n / 128)).slice(0, n);
const code = async(p) => { try { await p; return 'resolved'; } catch (e) { return e.code; } };

test('the registry is registry.npmjs.org; nothing in the environment chooses another', () => {
  assert.strictEqual(npmFetch.REGISTRY, 'https://registry.npmjs.org/');
  assert.strictEqual(npmFetch.registryFor, undefined, 'no selector: a test passes its fake as an argument');
  const src = require('node:fs').readFileSync(require.resolve('../lib/npm-fetch'), 'utf8');
  assert.doesNotMatch(src, /process\.env|io\.env|CH_LOCAL_DEV/, 'the module reads no environment');
});

test('a tarball: fetched from the registry, its sha512 checked against dist.integrity and its pin', async() => {
  const reg = await fakeRegistry();
  try {
    const bytes = Buffer.from(bytesOf(4096));
    const integrity = reg.publish(NAME, '0.2.0', bytes, {latest: true});
    const got = await npmFetch.fetchTarball(NAME, '0.2.0', io, {registry: reg.url, pin: {version: '0.2.0', integrity}});
    assert.ok(got.bytes.equals(bytes));
    assert.strictEqual(got.integrity, integrity);
    // without a pin: dist.integrity alone
    assert.ok((await npmFetch.fetchTarball(NAME, '0.2.0', io, {registry: reg.url})).bytes.equals(bytes));
    assert.deepStrictEqual(reg.requests.slice(0, 2), [`/${NAME}`, `/${NAME}/-/ch-local-0.2.0.tgz`]);
    const doc = await npmFetch.packument(NAME, io, {registry: reg.url});
    assert.strictEqual(doc['dist-tags'].latest, '0.2.0');
  } finally {
    await reg.close();
  }
});

test('refused: other bytes, another integrity, a sha1-only one, a pin that differs, a version not published, a package not there', async() => {
  const reg = await fakeRegistry();
  try {
    const bytes = Buffer.from(bytesOf(2048));
    const integrity = reg.publish(NAME, '0.2.0', bytes);
    reg.publish(NAME, '0.2.1', bytes);
    reg.publish(NAME, '0.2.2', bytes);
    reg.publish(NAME, '0.2.3', bytes);
    reg.tamper(NAME, '0.2.1', {body: Buffer.from(bytesOf(2048, 2))});
    reg.tamper(NAME, '0.2.2', {integrity: sri(Buffer.from('something else'))});
    reg.tamper(NAME, '0.2.3', {integrity: 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk='});
    const at = (v, extra = {}) => npmFetch.fetchTarball(NAME, v, io, Object.assign({registry: reg.url}, extra));
    assert.strictEqual(await code(at('0.2.1')), 'INTEGRITY_MISMATCH', 'the bytes are not what dist.integrity says');
    assert.strictEqual(await code(at('0.2.2')), 'INTEGRITY_MISMATCH');
    assert.strictEqual(await code(at('0.2.3')), 'NO_SHA512');
    assert.strictEqual(await code(at('0.2.0', {pin: {version: '0.2.0', integrity: sri(Buffer.from('pinned other'))}})), 'PIN_MISMATCH');
    assert.strictEqual(await code(at('0.2.0', {pin: {version: '0.2.9', integrity}})), 'PIN_MISMATCH', 'a pin for another version');
    assert.strictEqual(await code(at('9.9.9')), 'NOT_PUBLISHED');
    assert.strictEqual(await code(npmFetch.fetchTarball('@countinghouse/nothing', '1.0.0', io, {registry: reg.url})), 'NOT_PUBLISHED');
    // a pin that differs is refused before the tarball is fetched at all
    const before = reg.requests.filter((r) => r.endsWith('.tgz')).length;
    await code(at('0.2.0', {pin: {version: '0.2.0', integrity: sri(Buffer.from('pinned other'))}}));
    assert.strictEqual(reg.requests.filter((r) => r.endsWith('.tgz')).length, before);
  } finally {
    await reg.close();
  }
});

test('refused: a tarball URL anywhere but the registry\'s own path for that version', async() => {
  const reg = await fakeRegistry();
  try {
    const bytes = Buffer.from(bytesOf(1024));
    for (const [v, tarball] of [['1.0.0', 'https://elsewhere.example.invalid/ch-local-1.0.0.tgz'], ['1.0.1', `${reg.url}@countinghouse/other/-/other-1.0.1.tgz`],
      ['1.0.2', `${reg.url}@countinghouse/ch-local/-/ch-local-1.0.1.tgz`], ['1.0.3', `${reg.url.replace('http:', 'https:')}@countinghouse/ch-local/-/ch-local-1.0.3.tgz`],
      ['1.0.4', `${reg.url}@countinghouse/ch-local/-/ch-local-1.0.4.tgz?x=1`]]) {
      reg.publish(NAME, v, bytes);
      reg.tamper(NAME, v, {tarball});
      assert.strictEqual(await code(npmFetch.fetchTarball(NAME, v, io, {registry: reg.url})), 'NOT_ON_REGISTRY', tarball);
    }
    assert.ok(!reg.requests.some((r) => r.endsWith('.tgz')), 'none fetched');
  } finally {
    await reg.close();
  }
});

test('bounded: a tarball or a packument over its size, and an answer past its time, are refused', async() => {
  const reg = await fakeRegistry();
  try {
    const bytes = Buffer.from(bytesOf(8192));
    reg.publish(NAME, '0.3.0', bytes);
    assert.strictEqual(await code(npmFetch.fetchTarball(NAME, '0.3.0', io, {registry: reg.url, maxBytes: 4096})), 'FETCH_TOO_LARGE');
    assert.strictEqual(await code(npmFetch.packument(NAME, io, {registry: reg.url, maxBytes: 64})), 'FETCH_TOO_LARGE');
    reg.publish(NAME, '0.3.1', bytes);
    reg.tamper(NAME, '0.3.1', {delayMs: 2000});
    const t0 = Date.now();
    assert.strictEqual(await code(npmFetch.fetchTarball(NAME, '0.3.1', io, {registry: reg.url, timeoutMs: 200})), 'FETCH_FAILED');
    assert.ok(Date.now() - t0 < 1500, 'it gave up at its bound');
  } finally {
    await reg.close();
  }
});

test('a registry that is down, or answers an error, is FETCH_FAILED, naming the status', async() => {
  const reg = await fakeRegistry();
  const url = reg.url;
  await reg.close();
  assert.strictEqual(await code(npmFetch.packument(NAME, io, {registry: url})), 'FETCH_FAILED');
  const broken = {env: {}, fetch: async() => new Response('no', {status: 503})};
  await assert.rejects(npmFetch.packument(NAME, broken, {registry: url}), (e) => e.code === 'FETCH_FAILED' && /503/.test(e.message));
});

test('attestations: the registry\'s for name@version, at most 1 MB, JSON; none is null', async() => {
  const reg = await fakeRegistry();
  try {
    reg.attest(NAME, '0.3.0', {attestations: [{predicateType: 'x', bundle: {}}]});
    assert.deepStrictEqual(await npmFetch.attestations(NAME, '0.3.0', io, {registry: reg.url}), {attestations: [{predicateType: 'x', bundle: {}}]});
    assert.ok(reg.requests.includes(`/-/npm/v1/attestations/${NAME}@0.3.0`));
    assert.strictEqual(await npmFetch.attestations(NAME, '0.3.1', io, {registry: reg.url}), null);
    reg.attest(NAME, '0.3.2', 'not json');
    assert.strictEqual(await code(npmFetch.attestations(NAME, '0.3.2', io, {registry: reg.url})), 'FETCH_FAILED');
    reg.attest(NAME, '0.3.3', {padding: 'x'.repeat(2 * 1024 * 1024)});
    assert.strictEqual(await code(npmFetch.attestations(NAME, '0.3.3', io, {registry: reg.url})), 'FETCH_TOO_LARGE');
    assert.strictEqual(npmFetch.ATTESTATIONS_MAX, 1024 * 1024);
  } finally {
    await reg.close();
  }
});

test('the defaults: tarballs at most 50 MB, packuments 16 MB', () => {
  assert.strictEqual(npmFetch.TARBALL_MAX, 50 * 1024 * 1024);
  assert.strictEqual(npmFetch.PACKUMENT_MAX, 16 * 1024 * 1024);
});
