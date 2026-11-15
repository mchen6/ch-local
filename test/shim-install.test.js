'use strict';
// lib/shim-install.js (the native shim for this platform, agreed with A and
// the Reviewer): only this platform's @countinghouse/ch-shim-<os>-<arch>,
// fetched by its shim.packages pin, checked by verifyRelease (shim.yml,
// shim-v<version>), unpacked by the strict tar reader, and its binary put at
// <home>/shim/ch-shim (.exe on Windows), 0755, the one before kept as
// ch-shim.previous for rollback; which version each is, by its content.
// A fake registry and the test root, offline; Windows with lib/win-acl.js
// stubbed.
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
const {installShim, alignShim, setAside} = require('../lib/shim-install');
const {tmp} = require('./fake-io');

const io = {env: {}, fetch: (u, o) => globalThis.fetch(u, o)};
const root = testRoot();
const trust = provenance.trustMaterial(root.trustedRoot, root.npmKeys);
const at = new Date(Date.now() - 100 * 3600e3);
const shipped = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'lib', 'release-pins.json'), 'utf8'));
const hex = (b) => crypto.createHash('sha512').update(b).digest('hex');

// a release pinning the <platform>-<arch> shim at `version`, published with its provenance
async function world({version = '0.5.0', body = '#!/bin/sh\necho shim\n', files = null, lie = false, platform = 'linux', arch = 'x64'} = {}) {
  const reg = await fakeRegistry();
  const name = `@countinghouse/ch-shim-${platform}-${arch}`;
  const bytes = packageTgz({name, version}, files || {[`bin/${platform === 'win32' ? 'ch-shim.exe' : 'ch-shim'}`]: body});
  const integrity = reg.publish(name, version, bytes);
  const doc = shipped();
  const identity = {repository: doc.self.repository, repositoryId: doc.self.repositoryId, ownerId: doc.self.ownerId, workflow: '.github/workflows/shim.yml', tag: `shim-v${version}`};
  doc.pins[name] = Object.assign({version, integrity}, identity);
  reg.attest(name, version, {attestations: [{predicateType: provenance.PROVENANCE, bundle: root.provenance(name, version, lie ? hex(Buffer.from('x')) : hex(bytes), identity, at)},
    {predicateType: provenance.PUBLISH, bundle: root.publish(name, version, hex(bytes), at)}]});
  const data = parseReleasePins(doc);
  assert.strictEqual(data.problem, undefined, data.problem);
  return {reg, data: data.pins, fromNpm: {registry: reg.url, trust}, platform, arch};
}
const put = async(home, w) => installShim({home, data: w.data, io, platform: w.platform, arch: w.arch, ...w.fromNpm});
const read = (home, name) => { const f = path.join(home, 'shim', name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
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
    assert.deepStrictEqual(fs.readdirSync(path.join(home, 'shim')).sort(), ['ch-shim', 'versions.json'], 'no staging left');
  } finally {
    await w.reg.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('a second install keeps the one before as ch-shim.previous; the same one again moves nothing', async() => {
  const home = tmp('ch-shim-');
  const a = await world({version: '0.5.0', body: 'first'});
  const b = await world({version: '0.6.0', body: 'second'});
  try {
    await put(home, a);
    await put(home, b);
    assert.deepStrictEqual([read(home, 'ch-shim'), read(home, 'ch-shim.previous')], ['second', 'first']);
    // the same release reinstalled: the one before stays the one before
    await put(home, b);
    assert.deepStrictEqual([read(home, 'ch-shim'), read(home, 'ch-shim.previous')], ['second', 'first']);
    assert.deepStrictEqual(Object.values(JSON.parse(read(home, 'versions.json'))).sort(), ['0.5.0', '0.6.0'], 'each binary\'s version, by its sha512');
    assert.deepStrictEqual(fs.readdirSync(path.join(home, 'shim')).sort(), ['ch-shim', 'ch-shim.previous', 'versions.json']);
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

test('alignShim (rollback) goes by content: a resumed rollback, or one after the same release reinstalled, never swaps back', async() => {
  const home = tmp('ch-align-');
  const a = await world({version: '0.5.0', body: 'v1'});
  const b = await world({version: '0.6.0', body: 'v2'});
  try {
    await put(home, a);
    await put(home, b);
    const v1 = {version: '0.5.0'};
    const v2 = {version: '0.6.0'};
    assert.strictEqual(alignShim(home, {restored: v1, platform: 'linux'}), 'swapped');
    assert.deepStrictEqual([read(home, 'ch-shim'), read(home, 'ch-shim.previous')], ['v1', 'v2']);
    // the review's probe: settled, then resumed, ran it again: v1 stays
    assert.strictEqual(alignShim(home, {restored: v1, platform: 'linux'}), 'nothing');
    assert.deepStrictEqual([read(home, 'ch-shim'), read(home, 'ch-shim.previous')], ['v1', 'v2']);
    // and forward again
    assert.strictEqual(alignShim(home, {restored: v2, platform: 'linux'}), 'swapped');
    assert.strictEqual(read(home, 'ch-shim'), 'v2');
    // v2 reinstalled, then rolled back to v1: v1 (by content, not by record)
    await put(home, b);
    assert.strictEqual(alignShim(home, {restored: v1, platform: 'linux'}), 'swapped');
    assert.strictEqual(read(home, 'ch-shim'), 'v1');
  } finally {
    await a.reg.close();
    await b.reg.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('alignShim: a restored release with no shim, or one not on disk, sets the shim there aside; one at ch-shim.previous comes back', async() => {
  const home = tmp('ch-align-');
  const a = await world({version: '0.5.0', body: 'v1'});
  try {
    await put(home, a);
    assert.strictEqual(alignShim(home, {restored: null, platform: 'linux'}), 'set aside');
    assert.deepStrictEqual([read(home, 'ch-shim'), read(home, 'ch-shim.previous')], [null, 'v1']);
    assert.strictEqual(alignShim(home, {restored: null, platform: 'linux'}), 'nothing', 'again: nothing');
    assert.strictEqual(alignShim(home, {restored: {version: '0.5.0'}, platform: 'linux'}), 'restored');
    assert.deepStrictEqual([read(home, 'ch-shim'), read(home, 'ch-shim.previous')], ['v1', null]);
    // a version nothing on disk is: the shim there is not used for it
    assert.strictEqual(alignShim(home, {restored: {version: '0.4.0'}, platform: 'linux'}), 'set aside');
    assert.strictEqual(read(home, 'ch-shim'), null);
    // no shim directory at all: nothing, no throw
    assert.strictEqual(alignShim(tmp('ch-none-'), {restored: {version: '0.5.0'}, platform: 'linux'}), 'nothing');
  } finally {
    await a.reg.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('setAside: the shim moves to ch-shim.previous; a ch-shim.previous that cannot be removed leaves it aside under another name; an install then says why', async() => {
  const home = tmp('ch-aside-');
  const a = await world({version: '0.5.0', body: 'v1'});
  const b = await world({version: '0.6.0', body: 'v2'});
  try {
    await put(home, a);
    // a ch-shim.previous that can't be removed (as one still running on Windows)
    fs.mkdirSync(path.join(home, 'shim', 'ch-shim.previous', 'held'), {recursive: true});
    assert.strictEqual(await codeOf(put(home, b)), 'SHIM_BUSY');
    assert.strictEqual(read(home, 'ch-shim'), 'v1', 'the one there is kept when the new one cannot go in');
    assert.strictEqual(setAside(home, {platform: 'linux'}), true);
    assert.strictEqual(read(home, 'ch-shim'), null, 'never the one used');
    assert.strictEqual(fs.readdirSync(path.join(home, 'shim')).filter((n) => n.startsWith('.stale-')).length, 1);
    assert.strictEqual(setAside(home, {platform: 'linux'}), false, 'nothing there');
    // once it can be: the next install clears what was set aside
    fs.rmSync(path.join(home, 'shim', 'ch-shim.previous'), {recursive: true});
    await put(home, b);
    assert.deepStrictEqual(fs.readdirSync(path.join(home, 'shim')).sort(), ['ch-shim', 'versions.json']);
  } finally {
    await a.reg.close();
    await b.reg.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('POSIX: <home>/shim is checked, not only set: a link is refused, nothing written through it; a loose mode is made 0700', {skip: process.platform === 'win32'}, async() => {
  const w = await world();
  const home = tmp('ch-shim-');
  const elsewhere = tmp('ch-elsewhere-');
  try {
    fs.symlinkSync(elsewhere, path.join(home, 'shim'));
    assert.strictEqual(await codeOf(put(home, w)), 'SHIM_DIR');
    assert.deepStrictEqual(fs.readdirSync(elsewhere), [], 'nothing through the link');
    fs.rmSync(path.join(home, 'shim'));
    fs.mkdirSync(path.join(home, 'shim'), {mode: 0o777});
    fs.chmodSync(path.join(home, 'shim'), 0o777);
    assert.strictEqual((await put(home, w)).status, 'installed');
    assert.strictEqual(fs.statSync(path.join(home, 'shim')).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.join(home, 'shim', 'ch-shim')).mode & 0o777, 0o755);
  } finally {
    await w.reg.close();
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(elsewhere, {recursive: true, force: true});
  }
});

test('Windows (lib/win-acl.js stubbed): ch-shim.exe in a directory made private and checked; a DACL that fails the check places nothing; .previous is not launchable', async() => {
  const winAcl = require('../lib/win-acl');
  const saved = {makePrivateDirs: winAcl.makePrivateDirs, privateProblem: winAcl.privateProblem};
  const calls = [];
  let problem = null;
  winAcl.makePrivateDirs = (dirs, readBack) => { calls.push(['makePrivateDirs', dirs, readBack]); return [{user: 'S-1-5-21-1', owner: 'S-1-5-21-1', otherAces: false, rules: []}]; };
  winAcl.privateProblem = (what, acl, opts) => { calls.push(['privateProblem', what, opts]); return problem; };
  const a = await world({version: '0.5.0', body: 'w1', platform: 'win32'});
  const b = await world({version: '0.6.0', body: 'w2', platform: 'win32'});
  const home = tmp('ch-shim-win-');
  try {
    const r = await put(home, a);
    assert.strictEqual(r.status, 'installed');
    assert.strictEqual(r.path, path.join(home, 'shim', 'ch-shim.exe'));
    const dir = path.join(home, 'shim');
    assert.deepStrictEqual(calls, [['makePrivateDirs', [dir], [dir]], ['privateProblem', dir, {directory: true}]]);
    await put(home, b);
    assert.deepStrictEqual([read(home, 'ch-shim.exe'), read(home, 'ch-shim.previous')], ['w2', 'w1'], 'ch-shim.previous, no .exe');
    assert.strictEqual(alignShim(home, {restored: {version: '0.5.0'}, platform: 'win32'}), 'swapped');
    assert.strictEqual(read(home, 'ch-shim.exe'), 'w1');
    // the DACL read back fails the check: refused, nothing placed
    problem = 'shim is accessible by S-1-1-0';
    const home2 = tmp('ch-shim-win-');
    assert.strictEqual(await codeOf(put(home2, a)), 'SHIM_DIR');
    assert.ok(!fs.existsSync(path.join(home2, 'shim', 'ch-shim.exe')));
    fs.rmSync(home2, {recursive: true, force: true});
  } finally {
    Object.assign(winAcl, saved);
    await a.reg.close();
    await b.reg.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});
