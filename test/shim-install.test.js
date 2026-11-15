'use strict';
// lib/shim-install.js (the native shim for this platform, agreed with A and
// the Reviewer): only this platform's @countinghouse/ch-shim-<os>-<arch>,
// fetched by its shim.packages pin, checked by verifyRelease (shim.yml,
// shim-v<version>), unpacked by the strict tar reader, and its binary put at
// <home>/shim/ch-shim (.exe on Windows), 0755, the one before kept as
// ch-shim.previous for rollback. A fake registry and the test root, offline.
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
const {installShim, swapShim} = require('../lib/shim-install');
const {tmp} = require('./fake-io');

const io = {env: {}, fetch: (u, o) => globalThis.fetch(u, o)};
const root = testRoot();
const trust = provenance.trustMaterial(root.trustedRoot, root.npmKeys);
const at = new Date(Date.now() - 100 * 3600e3);
const shipped = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8'));
const hex = (b) => crypto.createHash('sha512').update(b).digest('hex');

// a release pinning the linux-x64 shim at `version`, published with its provenance
async function world({version = '0.5.0', body = '#!/bin/sh\necho shim\n', files = null, lie = false} = {}) {
  const reg = await fakeRegistry();
  const name = '@countinghouse/ch-shim-linux-x64';
  const bytes = packageTgz({name, version}, files || {'bin/ch-shim': body});
  const integrity = reg.publish(name, version, bytes);
  const doc = shipped();
  const identity = {repository: doc.self.repository, repositoryId: doc.self.repositoryId, ownerId: doc.self.ownerId, workflow: '.github/workflows/shim.yml', tag: `shim-v${version}`};
  doc.pins[name] = Object.assign({version, integrity}, identity);
  reg.attest(name, version, {attestations: [{predicateType: provenance.PROVENANCE, bundle: root.provenance(name, version, lie ? hex(Buffer.from('x')) : hex(bytes), identity, at)},
    {predicateType: provenance.PUBLISH, bundle: root.publish(name, version, hex(bytes), at)}]});
  const data = parseReleasePins(doc);
  assert.strictEqual(data.problem, undefined, data.problem);
  return {reg, data: data.pins, fromNpm: {registry: reg.url, trust}};
}
const codeOf = async(p) => { try { await p; return 'resolved'; } catch (e) { return e.code; } };

test('this platform\'s shim: fetched by its pin, verified, its binary at <home>/shim/ch-shim, 0755; nothing else fetched', async() => {
  const w = await world();
  const home = tmp('ch-shim-');
  try {
    const r = await installShim({home, data: w.data, io, platform: 'linux', arch: 'x64', ...w.fromNpm});
    assert.strictEqual(r.status, 'installed');
    assert.strictEqual(r.path, path.join(home, 'shim', 'ch-shim'));
    assert.strictEqual(fs.readFileSync(r.path, 'utf8'), '#!/bin/sh\necho shim\n');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(r.path).mode & 0o777, 0o755);
      assert.strictEqual(fs.statSync(path.join(home, 'shim')).mode & 0o777, 0o700);
    }
    assert.ok(w.reg.requests.every((u) => u.includes('ch-shim-linux-x64')), 'only this platform\'s package');
    assert.deepStrictEqual(fs.readdirSync(path.join(home, 'shim')).sort(), ['ch-shim'], 'no staging left');
  } finally {
    await w.reg.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a second install keeps the one before as ch-shim.previous; swapShim swaps them back and forth (rollback)', async() => {
  const home = tmp('ch-shim-');
  const a = await world({version: '0.5.0', body: 'first'});
  const b = await world({version: '0.6.0', body: 'second'});
  try {
    await installShim({home, data: a.data, io, platform: 'linux', arch: 'x64', ...a.fromNpm});
    await installShim({home, data: b.data, io, platform: 'linux', arch: 'x64', ...b.fromNpm});
    const dir = path.join(home, 'shim');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'ch-shim'), 'utf8'), 'second');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'ch-shim.previous'), 'utf8'), 'first');
    assert.strictEqual(swapShim(home, {platform: 'linux'}), true);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'ch-shim'), 'utf8'), 'first');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'ch-shim.previous'), 'utf8'), 'second');
    assert.strictEqual(swapShim(home, {platform: 'linux'}), true);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'ch-shim'), 'utf8'), 'second');
    assert.strictEqual(swapShim(tmp('ch-none-'), {platform: 'linux'}), false, 'nothing to swap');
  } finally {
    await a.reg.close();
    await b.reg.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('no shim for this platform, or none pinned in this release: nothing fetched, said as the per-session mode', async() => {
  const w = await world();
  const home = tmp('ch-shim-');
  try {
    assert.strictEqual((await installShim({home, data: w.data, io, platform: 'freebsd', arch: 'x64', ...w.fromNpm})).status, 'unsupported');
    assert.strictEqual((await installShim({home, data: w.data, io, platform: 'linux', arch: 'arm64', ...w.fromNpm})).status, 'unpinned');
    assert.deepStrictEqual(w.reg.requests, []);
    assert.ok(!fs.existsSync(path.join(home, 'shim')));
  } finally {
    await w.reg.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('refused, with nothing placed: a provenance that fails, a tarball with no binary, or one the strict reader refuses', async() => {
  for (const [opts, code] of [[{lie: true}, 'PROVENANCE_IDENTITY'], [{files: {'README.md': 'x'}}, 'SHIM_NO_BINARY'], [{files: {'bin/ch-shim': 'x', 'node_modules/a/index.js': 'x'}}, 'SHIM_TARBALL']]) {
    const w = await world(opts);
    const home = tmp('ch-shim-');
    try {
      assert.strictEqual(await codeOf(installShim({home, data: w.data, io, platform: 'linux', arch: 'x64', ...w.fromNpm})), code, JSON.stringify(opts));
      assert.ok(!fs.existsSync(path.join(home, 'shim', 'ch-shim')));
    } finally {
      await w.reg.close();
      fs.rmSync(home, {recursive: true, force: true});
    }
  }
});

test('alignShim (rollback): the shim follows the restored release, whether either had one', () => {
  const {alignShim} = require('../lib/shim-install');
  const home = tmp('ch-align-');
  const dir = path.join(home, 'shim');
  const put = (name, body) => { fs.mkdirSync(dir, {recursive: true}); fs.writeFileSync(path.join(dir, name), body); };
  const read = (name) => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : null);
  try {
    put('ch-shim', 'new'); put('ch-shim.previous', 'old');
    // both had a shim, of other versions: swapped
    alignShim(home, {kept: {version: '0.6.0'}, restored: {version: '0.5.0'}, platform: 'linux'});
    assert.deepStrictEqual([read('ch-shim'), read('ch-shim.previous')], ['old', 'new']);
    // the same version: nothing moves
    alignShim(home, {kept: {version: '0.5.0'}, restored: {version: '0.5.0'}, platform: 'linux'});
    assert.deepStrictEqual([read('ch-shim'), read('ch-shim.previous')], ['old', 'new']);
    // the restored release had none: the shim is set aside, so it runs per session
    fs.rmSync(path.join(dir, 'ch-shim.previous'));
    alignShim(home, {kept: {version: '0.5.0'}, restored: null, platform: 'linux'});
    assert.deepStrictEqual([read('ch-shim'), read('ch-shim.previous')], [null, 'old']);
    // and rolling forward brings it back
    alignShim(home, {kept: null, restored: {version: '0.5.0'}, platform: 'linux'});
    assert.deepStrictEqual([read('ch-shim'), read('ch-shim.previous')], ['old', null]);
    // neither: nothing
    alignShim(home, {kept: null, restored: null, platform: 'linux'});
    assert.deepStrictEqual([read('ch-shim'), read('ch-shim.previous')], ['old', null]);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});
