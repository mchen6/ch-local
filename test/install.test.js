'use strict';
require('./tmp-dirs');
// ch-local install --pack <name> --from <dir> [--unreleased-pins <file>]
// (reviewer, 2026-11-12): the runtime by npm ci from its pinned lockfile into
// <home>/app, then the pack's dependency-free packages unpacked beside it,
// every tarball checked against its pinned version and integrity first. npm is
// stubbed through io.exec.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {ALLOWLIST} = require('../lib/allowlist');
const {fakeIo, tmp} = require('./fake-io');
const {devModules, release, npm, pkgDir, record, RUNTIME} = require('./install-helpers');
const {chLocal} = require('../lib/command-line');
const {layout} = require('../lib/home');
// a command as the home names it once an install wrote its launcher
// (lib/command-line.js), as a regular expression's source
const cmd = (h, args) => chLocal(layout({COUNTINGHOUSE_HOME: h}), args).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const TRIAGE = ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', '@countinghouse/ch-step-redact'];
const run = (r, io, args = {}) => install({pack: 'ci-failure-triage', from: r.from, ...args}, io, r.allow);
const home = () => tmp('ch-home-');

test('install runs npm ci for the runtime alone, from its pinned lockfile', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const app = path.join(h, 'app');
  const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.private, true);
  assert.deepStrictEqual(Object.keys(pkg.dependencies), RUNTIME.map(([n]) => n), 'the packs are not npm dependencies');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(app, 'package-lock.json'), 'utf8')), r.lockfile);
  assert.deepStrictEqual(io.execs.map((e) => e.args.slice(1)), [['ci', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', '--replace-registry-host=never']]);
  assert.ok(io.execs.every((e) => e.cmd === io.node && /npm-cli\.js$/.test(e.args[0])), 'npm runs as node npm-cli.js, no shell');
  assert.ok(!fs.existsSync(path.join(h, 'app.new')), 'no build directory left');
});

test('install places each of the pack\'s modules in the module store and records them in modules.json (#413 sections 9.1, 9.2)', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  for (const name of TRIAGE) {
    assert.strictEqual(pkgDir(h, name), path.join(h, 'module-store', ...name.split('/'), '0.1.0'));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pkgDir(h, name), 'package.json'), 'utf8')).name, name);
    assert.ok(fs.existsSync(`${pkgDir(h, name)}.json`), 'its marker');
  }
  assert.ok(fs.existsSync(path.join(pkgDir(h, TRIAGE[0]), 'lib', 'index.js')));
  const rec = record(h);
  assert.strictEqual(rec.v, 2);
  assert.deepStrictEqual(rec.runtime.versions, Object.fromEntries(RUNTIME));
  assert.deepStrictEqual(rec.packs, {'ci-failure-triage': {from: {release: '0.2.0'}, modules: Object.fromEntries(TRIAGE.map((n) => [n, '0.1.0']))}});
  assert.deepStrictEqual(rec.modules, {
    '@countinghouse/ch-access-github': {version: '0.1.0', role: 'part'},
    '@countinghouse/ch-pack-ci-failure-triage': {version: '0.1.0', role: 'scenario'},
    '@countinghouse/ch-step-redact': {version: '0.1.0', role: 'part'}
  });
  assert.deepStrictEqual(rec.withdrawn, []);
  assert.strictEqual(rec.unreleased, false);
  assert.strictEqual(fs.existsSync(path.join(h, 'packs.json')), false);
  assert.strictEqual(fs.existsSync(path.join(h, 'packs')), false, 'no pack tree');
  assert.ok(!fs.readdirSync(path.join(h, 'app', 'node_modules')).some((n) => n.startsWith('.ch-local')), 'no staging left');
});

test('install writes the installed command at <home>/bin/ch-local.js, running the installed launcher', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const shim = fs.readFileSync(path.join(h, 'bin', 'ch-local.js'), 'utf8');
  assert.ok(shim.includes(JSON.stringify(path.join(h, 'app', 'node_modules', '@countinghouse', 'ch-local', 'bin', 'ch-local.js'))));
});

test('install refuses a tarball no pin names, and installs nothing', async () => {
  const r = release(); const h = home();
  fs.writeFileSync(path.join(r.from, 'countinghouse-ch-evil-1.0.0.tgz'), 'evil');
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 1);
  assert.match(io.err, /countinghouse-ch-evil-1\.0\.0\.tgz is not on this launcher's allowlist/);
  assert.deepStrictEqual(io.execs, []);
  assert.ok(!fs.existsSync(path.join(h, 'app')));
});

test('install refuses a tarball whose integrity differs, a runtime\'s or a pack\'s', async () => {
  for (const file of ['countinghouse-8.0.0.tgz', 'countinghouse-ch-step-redact-0.1.0.tgz']) {
    const r = release(); const h = home();
    fs.appendFileSync(path.join(r.from, file), 'tampered');
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
    assert.strictEqual(await run(r, io), 1, file);
    assert.match(io.err, /the tarball's integrity is not the pinned one/);
    assert.deepStrictEqual(io.execs, []);
  }
});

test('a pinned package missing from the directory is named, nothing installed', async () => {
  const r = release(); const h = home();
  fs.rmSync(path.join(r.from, 'countinghouse-8.0.0.tgz'));
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 1);
  assert.match(io.err, /countinghouse@8\.0\.0: no countinghouse-8\.0\.0\.tgz in /);
  assert.deepStrictEqual(io.execs, []);
});

test('a pack package that declares npm dependencies is refused, and the previous install is unchanged', async () => {
  const r = release({extra: {'@countinghouse/ch-step-redact': {dependencies: {'left-pad': '1.3.0'}}}}); const h = home();
  fs.mkdirSync(path.join(h, 'app'), {recursive: true});
  fs.writeFileSync(path.join(h, 'app', 'marker'), 'previous');
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 1);
  assert.match(io.err, /@countinghouse\/ch-step-redact declares npm dependencies/);
  assert.strictEqual(fs.readFileSync(path.join(h, 'app', 'marker'), 'utf8'), 'previous');
  assert.ok(!fs.existsSync(path.join(h, 'packs.json')));
});

test('a pack tarball whose package.json names another package or version is refused', async () => {
  const r = release({extra: {'@countinghouse/ch-step-redact': {name: '@countinghouse/ch-step-evil'}}}); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 1);
  assert.match(io.err, /ch-step-redact.*is @countinghouse\/ch-step-evil@0\.1\.0/);
  assert.ok(!fs.existsSync(path.join(h, 'app')));
});

test('a pack tarball the strict reader refuses installs nothing', async () => {
  const r = release(); const h = home();
  const {tgz, member} = require('./tgz');
  const {integrityOf} = require('./install-helpers');
  const evil = tgz(member('package/package.json', {data: '{}'}), member('package/x', {type: '2', linkname: '/etc/passwd'}));
  fs.writeFileSync(path.join(r.from, 'countinghouse-ch-step-redact-0.1.0.tgz'), evil);
  r.allow.pins['@countinghouse/ch-step-redact'].integrity = integrityOf(evil);
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 1);
  assert.match(io.err, /ch-step-redact.*refused the tarball.*link/);
  assert.ok(!fs.existsSync(path.join(h, 'app')));
});

test('a failing npm leaves the previous install in place', async () => {
  const r = release(); const h = home();
  fs.mkdirSync(path.join(h, 'app'), {recursive: true});
  fs.writeFileSync(path.join(h, 'app', 'marker'), 'previous');
  const failing = (cmd, args, opts) => (args.includes('ci') ? {status: 1, stdout: '', stderr: 'npm ERR! network'} : npm()(cmd, args, opts));
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: failing});
  assert.strictEqual(await run(r, io), 1);
  assert.match(io.err, /npm ci failed/);
  assert.match(io.err, /npm ERR! network/);
  assert.strictEqual(fs.readFileSync(path.join(h, 'app', 'marker'), 'utf8'), 'previous');
  assert.ok(!fs.existsSync(path.join(h, 'app.new')));
});

test('a runtime without a pinned lockfile is refused: its dependencies would be unpinned', async () => {
  const r = release(); const h = home();
  r.allow.runtime.lockfile = null;
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 1);
  assert.match(io.err, /no lockfile is pinned for the runtime/);
  assert.deepStrictEqual(io.execs, []);
});

test('a swap that cannot move the new app in puts the old one back', async () => {
  const r = release(); const h = home();
  const real = fs.renameSync;
  try {
    fs.mkdirSync(path.join(h, 'app'), {recursive: true});
    fs.writeFileSync(path.join(h, 'app', 'marker'), 'previous');
    fs.renameSync = (a, b) => { if (String(a).endsWith('app.new')) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return real(a, b); };
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
    assert.strictEqual(await run(r, io), 1);
    assert.match(io.err, /could not replace .*app \(EBUSY\); is a client running it\? the previous install is unchanged/);
    fs.renameSync = real;
    assert.strictEqual(fs.readFileSync(path.join(h, 'app', 'marker'), 'utf8'), 'previous');
    assert.ok(!fs.existsSync(path.join(h, 'app.old')));
  } finally {
    fs.renameSync = real;
  }
});

test('an installed launcher whose version is not the pinned one is refused', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm('9.9.9')});
  assert.strictEqual(await run(r, io), 1);
  assert.match(io.err, /installed @countinghouse\/ch-local is 9\.9\.9, not the pinned 0\.2\.0/);
  assert.ok(!fs.existsSync(path.join(h, 'app')));
});

// #413 section 6.2 (L5a): install's end asks for each of the pack's
// modules that needs a credential and has none stored; with no terminal it
// names the command; a client environment's token is never one
test('install\'s end: with no terminal, each module that needs a credential is named with its command; never a value', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, GITHUB_TOKEN: 'secret-value-123'}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  // (the home's own launcher, which runs as printed: nothing puts ch-local
  // on PATH; A-firstrun d1, the fixed text business checked)
  const launcher = fs.realpathSync.native(path.join(h, 'bin', 'ch-local.js'));
  assert.ok(io.err.split('\n').includes(`ch-access-github needs a credential: in your own terminal run \`node "${launcher}" credentials add ch-access-github\``), io.err);
  assert.ok(!/GITHUB_TOKEN/.test(io.out), 'no environment variable is named');
  assert.ok(!(io.out + io.err).includes('secret-value-123'));
});

test('install\'s end at a terminal: the add conversation stores the key; nothing entered skips the module, named', async () => {
  const r = release(); const h = home();
  const typed = 'test-typed-value-1';
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  Object.assign(io, {terminal: true, readHidden: async () => typed, ask: async () => 'n'});
  assert.strictEqual(await run(r, io), 0, io.err);
  assert.match(io.err, /ch-access-github 0\.1\.0 declares one credential:\n  GITHUB_TOKEN, sent to https:\/\/api\.githubcopilot\.com/);
  const stored = require('../lib/credential-store').readStore(h, {platform: io.platform});
  assert.strictEqual(stored.modules.get('@countinghouse/ch-access-github').get('GITHUB_TOKEN').value, typed);
  assert.ok(!(io.out + io.err).includes(typed), 'never echoed');
  const h2 = home();
  const skip = fakeIo({env: {COUNTINGHOUSE_HOME: h2}, exec: npm()});
  Object.assign(skip, {terminal: true, readHidden: async () => '', ask: async () => 'n'});
  assert.strictEqual(await run(release(), skip), 0, skip.err);
  assert.ok(skip.err.includes(`ch-access-github is not loaded until it has one: in your own terminal run \`node "${fs.realpathSync.native(path.join(h2, 'bin', 'ch-local.js'))}" credentials add ch-access-github\``), skip.err);
});

// #413 section 9.4: install no longer drops the other packs; every installed
// pack this release lists is brought to its pins, and a module two packs
// share is placed once
test('install of a second pack keeps the first; the part they share is placed once and said', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const shared = path.join(h, 'module-store', '@countinghouse', 'ch-step-redact', '0.1.0');
  const old = new Date('2020-01-01T00:00:00Z');
  fs.utimesSync(shared, old, old);
  const again = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({pack: 'other', from: r.from}, again, r.allow), 0, again.err);
  assert.deepStrictEqual(Object.keys(record(h).packs).sort(), ['ci-failure-triage', 'other']);
  assert.match(again.out, /it shares ch-step-redact with the packs already installed/);
  assert.match(again.out, /the pack "ci-failure-triage" is at this release's pins/);
  assert.strictEqual(fs.statSync(shared).mtimeMs, old.getTime(), 'not unpacked again');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(shared)).sort(), ['0.1.0', '0.1.0.json']);
});

test('a release that pins a lower version moves the installed module back, with no question', async () => {
  const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(release(), io), 0, io.err);
  assert.strictEqual(await install({pack: 'other', from: release().from}, io, release().allow), 0, io.err);
  const lower = release({versions: {'@countinghouse/ch-step-redact': '0.0.9'}});
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(lower, io2), 0, io2.err);
  const rec = record(h);
  assert.strictEqual(rec.packs['ci-failure-triage'].modules['@countinghouse/ch-step-redact'], '0.0.9');
  assert.strictEqual(rec.packs.other.modules['@countinghouse/ch-step-redact'], '0.0.9', 'the other pack too: the release is a tested set');
  assert.strictEqual(rec.modules['@countinghouse/ch-step-redact'].version, '0.0.9');
  assert.ok(fs.existsSync(path.join(h, 'module-store', '@countinghouse', 'ch-step-redact', '0.0.9.json')));
  // the higher version stays while the rollback's kept record names it
  // (#413 section 9.10): rollback returns to it
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h, 'previous', 'modules.json'), 'utf8')).modules['@countinghouse/ch-step-redact'].version, '0.1.0');
  assert.ok(fs.existsSync(path.join(h, 'module-store', '@countinghouse', 'ch-step-redact', '0.1.0.json')), 'kept for the rollback');
  assert.doesNotMatch(io2.out + io2.err, /\?|\[y\/N\]/);
});

test('a pack the release no longer lists stays recorded, its own modules withdrawn, and said', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  assert.strictEqual(await install({pack: 'other', from: r.from}, io, r.allow), 0, io.err);
  const without = {...r.allow, packs: {'ci-failure-triage': r.allow.packs['ci-failure-triage']}};
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io2, without), 0, io2.err);
  const rec = record(h);
  assert.deepStrictEqual(Object.keys(rec.packs).sort(), ['ci-failure-triage', 'other']);
  assert.deepStrictEqual(rec.withdrawn, ['@countinghouse/ch-pack-other', '@countinghouse/ch-step-other'], 'ch-step-redact is still shipped by ci-failure-triage');
  assert.match(io2.out, new RegExp(`other: withdrawn in this release, so it is not started; \`${cmd(h, 'remove-pack other')}\` removes it`));
  assert.ok(fs.existsSync(pkgDir(h, '@countinghouse/ch-pack-other')), 'nothing of it is removed');
});

// #413 section 10: a home an earlier ch-local made is migrated by install
test('migration: packs.json, its trees and held packs become modules.json and the store; the old trees go once no start names them', async () => {
  const r = release(); const h = home();
  const tree = path.join(h, 'packs', 'ci-failure-triage', '0.1.0+1a2b3c4d', 'node_modules');
  fs.mkdirSync(path.join(tree, '@countinghouse', 'ch-pack-ci-failure-triage'), {recursive: true});
  const packages = Object.fromEntries(TRIAGE.map((n) => [n, '0.1.0']));
  const p = {packages, credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']};
  fs.writeFileSync(path.join(h, 'packs.json'), JSON.stringify({runtime: {versions: Object.fromEntries(RUNTIME)}, unreleased: false, release: null,
    packs: {'ci-failure-triage': p},
    held: {other: {packages: {'@countinghouse/ch-pack-other': '0.3.0'}, credentials: [], installedUnder: '0.1.0', withdrawn: true},
      old: {packages: {'@countinghouse/ch-pack-old': '1.0.0'}, credentials: [], installedUnder: '0.1.0'}}}));
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const rec = record(h);
  assert.deepStrictEqual(rec.packs['ci-failure-triage'], {from: {release: '0.2.0'}, modules: packages});
  // a held pack marked withdrawn becomes an ordinary pack; this release lists
  // it, so it is brought to its pins
  assert.deepStrictEqual(rec.packs.other.modules, {'@countinghouse/ch-pack-other': '0.3.0', '@countinghouse/ch-step-redact': '0.1.0', '@countinghouse/ch-step-other': '0.2.0'});
  // held after a rollback: not carried over, named (the Reviewer's one rule)
  assert.strictEqual(rec.held, undefined);
  assert.match(io.out, new RegExp(`not carried over: old; add it again with \`${cmd(h, 'add-pack old')}\` once a release lists it`));
  assert.strictEqual(fs.existsSync(path.join(h, 'packs.json')), false);
  // the earlier ch-local's packs/ kept whole beside the home, never collected
  assert.strictEqual(fs.existsSync(path.join(h, 'packs')), false);
  const kept = fs.readdirSync(h).filter((n) => n.startsWith('packs.migrated-'));
  assert.strictEqual(kept.length, 1);
  assert.ok(fs.existsSync(path.join(h, kept[0], 'ci-failure-triage')), 'nothing deleted');
  assert.match(io.out, /this home's record is now modules\.json/);
  assert.strictEqual(JSON.stringify(rec).includes('credentials'), false, 'credentials dropped');
});

test('an unknown pack, or no --from, is refused before anything is read', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}});
  assert.strictEqual(await install({pack: 'nope', from: r.from}, io, r.allow), 2);
  assert.match(io.err, /unknown pack "nope"; one of: ci-failure-triage, other/);
  assert.deepStrictEqual([...io.execs, ...io.fetches], []);
});

test('no --from: a release with no identity to install from npm with says so; --unreleased-pins needs --from', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}});
  assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, r.allow), 1);
  assert.match(io.err, /no release identity to install from npm with/);
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}});
  assert.strictEqual(await install({pack: 'ci-failure-triage', unreleasedPins: path.join(h, 'pins.json')}, io2, r.allow), 2);
  assert.match(io2.err, /--unreleased-pins is for tarballs on disk/);
  assert.deepStrictEqual([...io.execs, ...io2.execs, ...io.fetches, ...io2.fetches], []);
  assert.ok(!fs.existsSync(path.join(h, 'app')));
});

// docs/development/auto-upgrade.md: no --from installs from npm, every
// package checked against its pin and its provenance (a fake registry and the
// test root, passed only as install's test-only argument)
async function npmRelease(r, {lie = null, shim = false} = {}) {
  const {fakeRegistry} = require('./fake-registry');
  const {testRoot} = require('./sigstore-fixture');
  const provenance = require('../lib/provenance');
  const crypto = require('node:crypto');
  const reg = await fakeRegistry();
  const root = testRoot();
  const at = new Date(Date.now() - 100 * 3600e3);
  const self = {repository: 'mchen6/ch-local', repositoryId: 1454656051, ownerId: 1168741, workflow: '.github/workflows/publish.yml'};
  const pins = {};
  for (const [name, pin] of Object.entries(r.pins)) {
    const file = require('../lib/install').tarballName(name, pin.version);
    const bytes = fs.readFileSync(path.join(r.from, file));
    reg.publish(name, pin.version, bytes);
    const own = name === '@countinghouse/ch-local';
    const identity = own ? Object.assign({}, self, {tag: `v${pin.version}`}) : {repository: `mchen6/${name.split('/').pop()}`, repositoryId: 4000000 + Object.keys(pins).length, ownerId: 1168741, workflow: '.github/workflows/publish.yml', tag: `v${pin.version}`};
    const digest = crypto.createHash('sha512').update(lie === name ? Buffer.from('other') : bytes).digest('hex');
    reg.attest(name, pin.version, {attestations: [{predicateType: provenance.PROVENANCE, bundle: root.provenance(name, pin.version, digest, identity, at)},
      {predicateType: provenance.PUBLISH, bundle: root.publish(name, pin.version, crypto.createHash('sha512').update(bytes).digest('hex'), at)}]});
    if (!own) pins[name] = Object.assign({}, pin, identity);
  }
  const lockfile = JSON.parse(JSON.stringify(r.lockfile));
  lockfile.packages['node_modules/countinghouse'].integrity = r.pins.countinghouse.integrity;
  // a release can't carry its own digest: fetchRelease fills it from the verified one
  delete lockfile.packages['node_modules/@countinghouse/ch-local'].integrity;
  // this platform's native shim, pinned and published, when asked for
  const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'];
  const shimSection = {packages: Object.fromEntries(targets.map((t) => [t, `@countinghouse/ch-shim-${t}`]))};
  if (shim) {
    const key = `${process.platform}-${process.arch}`;
    const name = `@countinghouse/ch-shim-${key}`;
    const exe = process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim';
    const bytes = require('./tgz').packageTgz({name, version: '0.5.0'}, {[`bin/${exe}`]: 'the shim'});
    reg.publish(name, '0.5.0', bytes);
    const identity = Object.assign({}, self, {workflow: '.github/workflows/shim.yml', tag: 'shim-v0.5.0'});
    const hex = crypto.createHash('sha512').update(bytes).digest('hex');
    reg.attest(name, '0.5.0', {attestations: [{predicateType: provenance.PROVENANCE, bundle: root.provenance(name, '0.5.0', hex, identity, at)},
      {predicateType: provenance.PUBLISH, bundle: root.publish(name, '0.5.0', hex, at)}]});
    pins[name] = Object.assign({version: '0.5.0', integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`}, identity);
  }
  const allow = Object.assign({}, r.allow, {pins, self, shim: shimSection, release: {version: r.pins['@countinghouse/ch-local'].version, security: null},
    runtime: Object.assign({}, r.allow.runtime, {lockfile})});
  return {reg, allow, fromNpm: {registry: reg.url, trust: provenance.trustMaterial(root.trustedRoot, root.npmKeys)}};
}

test('no --from: every package from the registry, checked by its pin and its provenance, then installed as from a directory', async () => {
  const r = release(); const h = home();
  const n = await npmRelease(r);
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, n.allow, n.fromNpm), 0, io.err);
    assert.match(io.out, /fetching 5 package\(s\) from the npm registry, each checked against its pin and its provenance/);
    const lock = JSON.parse(fs.readFileSync(path.join(h, 'app', 'package-lock.json'), 'utf8'));
    assert.strictEqual(lock.packages['node_modules/@countinghouse/ch-local'].integrity, r.pins['@countinghouse/ch-local'].integrity, 'ch-local\'s entry filled from its verified digest');
    for (const name of TRIAGE) assert.ok(fs.existsSync(path.join(pkgDir(h, name), 'package.json')), name);
    assert.ok(io.fetches.every((u) => u.startsWith(n.reg.url)), 'the fake registry only');
  } finally {
    await n.reg.close();
  }
});

test('no --from: a release lower than the installed ch-local is refused, nothing fetched (no downgrade but rollback)', async () => {
  const r = release(); const h = home();
  const n = await npmRelease(r);
  try {
    fs.writeFileSync(path.join(h, 'packs.json'), JSON.stringify({runtime: {versions: {'@countinghouse/ch-local': '0.9.0', countinghouse: '8.0.0'}}, packs: {}}));
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, n.allow, n.fromNpm), 1);
    assert.match(io.err, /0\.2\.0 is lower than the installed 0\.9\.0: ch-local rollback is the way back/);
    assert.deepStrictEqual(io.fetches, []);
  } finally {
    await n.reg.close();
  }
});

test('no --from: this platform\'s native shim is installed too, and recorded; with none pinned, said as the per-session mode', async () => {
  const r = release(); const h = home();
  const n = await npmRelease(r, {shim: true});
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, n.allow, n.fromNpm), 0, io.err);
    const exe = process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim';
    assert.strictEqual(fs.readFileSync(path.join(h, 'shim', exe), 'utf8'), 'the shim');
    assert.deepStrictEqual(record(h).shim, {package: `@countinghouse/ch-shim-${process.platform}-${process.arch}`, version: '0.5.0'});
    assert.match(io.out, /the shared runtime's shim 0\.5\.0 is at /);
  } finally {
    await n.reg.close();
  }
  const r2 = release(); const h2 = home();
  const n2 = await npmRelease(r2);
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h2}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, n2.allow, n2.fromNpm), 0, io.err);
    assert.strictEqual(record(h2).shim, undefined);
    assert.match(io.out, /no shared-runtime shim is pinned for this platform in this release: each session runs its own runtime/);
  } finally {
    await n2.reg.close();
  }
});

test('a shim from before is set aside by an install that brings none: from --from, or from npm with none pinned', async () => {
  const exe = process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim';
  const plant = (h) => { fs.mkdirSync(path.join(h, 'shim'), {recursive: true}); fs.writeFileSync(path.join(h, 'shim', exe), 'stale'); };
  const r = release(); const h = home();
  plant(h);
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  assert.ok(!fs.existsSync(path.join(h, 'shim', exe)), 'never the one used');
  assert.strictEqual(fs.readFileSync(path.join(h, 'shim', 'ch-shim.previous'), 'utf8'), 'stale');
  assert.match(io.out, /the shared runtime's shim from before is set aside: each session runs its own runtime/);
  const r2 = release(); const h2 = home();
  plant(h2);
  const n2 = await npmRelease(r2);
  try {
    const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h2}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io2, n2.allow, n2.fromNpm), 0, io2.err);
    assert.ok(!fs.existsSync(path.join(h2, 'shim', exe)));
    assert.strictEqual(record(h2).shim, undefined);
  } finally {
    await n2.reg.close();
  }
  // a failed install leaves it be: the install it belongs to is still in place
  const h3 = home();
  plant(h3);
  const io3 = fakeIo({env: {COUNTINGHOUSE_HOME: h3}, exec: () => ({status: 1, stdout: '', stderr: 'npm broke'})});
  assert.strictEqual(await run(release(), io3), 1);
  assert.strictEqual(fs.readFileSync(path.join(h3, 'shim', exe), 'utf8'), 'stale');
});

test('no --from: one package whose provenance fails stops the install, naming it, with nothing installed', async () => {
  const r = release(); const h = home();
  const n = await npmRelease(r, {lie: '@countinghouse/ch-step-redact'});
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, n.allow, n.fromNpm), 1);
    assert.match(io.err, /@countinghouse\/ch-step-redact: .*\(PROVENANCE_IDENTITY\)/);
    assert.match(io.err, /nothing was installed/);
    assert.deepStrictEqual(io.execs, []);
    assert.ok(!fs.existsSync(path.join(h, 'app')));
  } finally {
    await n.reg.close();
  }
});

test('this launcher pins no release yet, and says so; its runtime is ch-local and countinghouse', async () => {
  assert.deepStrictEqual(ALLOWLIST.runtime.packages, ['@countinghouse/ch-local', 'countinghouse']);
  assert.deepStrictEqual(Object.keys(ALLOWLIST.packs), ['ci-failure-triage']);
  const triage = ALLOWLIST.packs['ci-failure-triage'].modules;
  assert.ok(triage.includes('@countinghouse/ch-pack-ci-failure-triage'));
  assert.ok(triage.includes('@countinghouse/ch-access-github'));
  // The usage report is the runtime's built-in countinghouse_usage_report: nothing installs ch-report (reviewer, 2026-11-11).
  assert.ok(!triage.includes('@countinghouse/ch-report'));
  assert.ok(!triage.includes('countinghouse') && !triage.includes('@countinghouse/ch-local'), 'the runtime is not a pack\'s');
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io), 1);
  assert.match(io.err, /no release of the pack "ci-failure-triage" is pinned in this ch-local yet/);
});

// --unreleased-pins (reviewer, 2026-11-12): development only.
// (with the descriptions the step writes for what it pins, unless the body
// gives its own)
const pinsFile = (r, body) => {
  const f = path.join(tmp('ch-pins-'), 'pins.json');
  const full = typeof body === 'string' || body.modules !== undefined || body.pins == null || Array.isArray(body.pins) ? body : {...body, modules: devModules(r.allow, body.pins)};
  fs.writeFileSync(f, typeof full === 'string' ? full : JSON.stringify(full));
  return f;
};

test('--unreleased-pins installs with its pins and lockfile, records the home as unreleased and says so', async () => {
  const r = release(); const h = home();
  const allow = {...r.allow, pins: {}, runtime: {...r.allow.runtime, lockfile: null}};
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
  const f = pinsFile(r, {pins: r.pins, runtimeLockfile: r.lockfile});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, io, allow), 0, io.err);
  assert.strictEqual(record(h).unreleased, true);
  // which pins the pack came from: the first 16 hex digits of the file's SHA-256
  const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
  assert.deepStrictEqual(record(h).packs['ci-failure-triage'].from, {unreleased: digest});
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(h, 'app', 'package-lock.json'), 'utf8')), r.lockfile);
  assert.strictEqual((io.out + io.err).split('\n').filter((l) => /unreleased/.test(l)).length, 1);
});

test('--unreleased-pins refuses a file that is not {pins, runtimeLockfile} with sha512 integrities, before anything is read', async () => {
  const r = release();
  for (const body of ['not json', {pins: r.pins}, {pins: {x: {version: '1.0.0', integrity: 'md5-abc'}}, runtimeLockfile: r.lockfile}, {pins: [], runtimeLockfile: r.lockfile}, {pins: r.pins, runtimeLockfile: {}}]) {
    const h = home();
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: pinsFile(r, body)}, io, r.allow), 2, JSON.stringify(body).slice(0, 60));
    assert.match(io.err, /--unreleased-pins/);
    assert.deepStrictEqual(io.execs, []);
  }
});

// The reviewer's high review of #5.
test('each tarball is read once: the bytes checked are the bytes installed', async () => {
  const r = release(); const h = home();
  const real = fs.readFileSync;
  const reads = {};
  fs.readFileSync = (p, ...rest) => { if (String(p).endsWith('.tgz')) reads[path.basename(String(p))] = (reads[path.basename(String(p))] || 0) + 1; return real(p, ...rest); };
  const copies = [];
  const realCopy = fs.copyFileSync;
  fs.copyFileSync = (a, b, ...rest) => { if (String(a).endsWith('.tgz')) copies.push(String(a)); return realCopy(a, b, ...rest); };
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
    assert.strictEqual(await run(r, io), 0, io.err);
  } finally {
    fs.readFileSync = real;
    fs.copyFileSync = realCopy;
  }
  assert.deepStrictEqual(copies, [], 'the runtime tarballs are written from the checked bytes, not copied from the directory again');
  for (const [file, n] of Object.entries(reads)) assert.strictEqual(n, 1, `${file} read ${n} times`);
  assert.strictEqual(Object.keys(reads).length, 5, 'the runtime\'s two and the pack\'s three');
});

test('--unreleased-pins needs CH_LOCAL_DEV=1', async () => {
  const r = release(); const h = home();
  const allow = {...r.allow, pins: {}, runtime: {...r.allow.runtime, lockfile: null}};
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  const f = pinsFile(r, {pins: r.pins, runtimeLockfile: r.lockfile});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, io, allow), 2);
  assert.match(io.err, /--unreleased-pins is for development: set CH_LOCAL_DEV=1/);
  assert.deepStrictEqual(io.execs, []);
});

test('--unreleased-pins refuses a lockfile whose runtime packages do not resolve to their tarballs, or whose dependencies are not integrity-pinned registry tarballs', async () => {
  const r = release();
  const lock = (entries) => ({name: 'countinghouse-home-app', lockfileVersion: 3, requires: true, packages: {'': {}, ...entries}});
  // each runtime package with its pin's integrity (the re-check of #42: npm ci installs any tarball for an entry without one)
  const good = {'node_modules/@countinghouse/ch-local': {version: '0.2.0', resolved: 'file:tarballs/countinghouse-ch-local-0.2.0.tgz', integrity: r.pins['@countinghouse/ch-local'].integrity},
    'node_modules/countinghouse': {version: '8.0.0', resolved: 'file:tarballs/countinghouse-8.0.0.tgz', integrity: r.pins.countinghouse.integrity},
    'node_modules/left-pad': {version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz', integrity: r.pins.countinghouse.integrity}};
  for (const [why, entries] of [
    ['a runtime package from a URL', {...good, 'node_modules/countinghouse': {version: '8.0.0', resolved: 'https://evil.example/countinghouse-8.0.0.tgz', integrity: r.pins.countinghouse.integrity}}],
    ['a runtime package from another file', {...good, 'node_modules/countinghouse': {version: '8.0.0', resolved: 'file:../../elsewhere/countinghouse-8.0.0.tgz'}}],
    ['a dependency from a git URL', {...good, 'node_modules/left-pad': {version: '1.3.0', resolved: 'git+https://github.com/x/left-pad.git#abc'}}],
    ['a dependency from a file outside', {...good, 'node_modules/left-pad': {version: '1.3.0', resolved: 'file:/tmp/left-pad.tgz', integrity: r.pins.countinghouse.integrity}}],
    ['a dependency without integrity', {...good, 'node_modules/left-pad': {version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz'}}]
  ]) {
    const h = home();
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
    const f = pinsFile(r, {pins: r.pins, runtimeLockfile: lock(entries)});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, io, {...r.allow, pins: {}}), 2, why);
    assert.match(io.err, /--unreleased-pins .*the runtime lockfile/, why);
    assert.deepStrictEqual(io.execs, [], why);
  }
  const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: pinsFile(r, {pins: r.pins, runtimeLockfile: lock(good)})}, io, {...r.allow, pins: {}}), 0, io.err);
});

// /code-review medium on the #5 high-review round.
test('--unreleased-pins takes only a v3 lockfile: no legacy dependencies tree to get around the check', async () => {
  const r = release();
  for (const lockfile of [{...r.lockfile, lockfileVersion: 1}, {...r.lockfile, lockfileVersion: 2}, {...r.lockfile, dependencies: {evil: {version: '1.0.0', resolved: 'git+https://attacker.example/x.git#abc'}}}]) {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: home(), CH_LOCAL_DEV: '1'}, exec: npm()});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: pinsFile(r, {pins: r.pins, runtimeLockfile: lockfile})}, io, {...r.allow, pins: {}}), 2);
    assert.match(io.err, /the runtime lockfile must be an npm v3 lockfile/);
  }
});

test('--unreleased-pins: a runtime package\'s lockfile version and integrity must be its pin\'s; a bundled dependency needs no URL; a link is refused', async () => {
  const r = release();
  const ch = 'node_modules/countinghouse';
  const cases = [
    [{[ch]: {...r.lockfile.packages[ch], version: '9.9.9'}}, 2, /version 9\.9\.9/],
    [{[ch]: {...r.lockfile.packages[ch], integrity: r.pins['@countinghouse/ch-local'].integrity}}, 2, /integrity/],
    // bundled only beneath a runtime package that bundles it (the review of #42):
    // under a registry dependency, or with no parent bundling it, refused
    [{'node_modules/left-pad/node_modules/inner': {version: '1.0.0', inBundle: true}}, 2, /bundles it/],
    [{'node_modules/countinghouse/node_modules/inner': {version: '1.0.0', inBundle: true}}, 2, /bundles it/],
    // its parent bundles it, but its tarball does not hold it: refused once read
    [{[ch]: {...r.lockfile.packages[ch], bundleDependencies: ['inner']}, 'node_modules/countinghouse/node_modules/inner': {version: '1.0.0', inBundle: true}}, 1, /not in the tarball/],
    [{'node_modules/linked': {resolved: '../elsewhere', link: true}}, 2, /linked/],
    // the re-check of #42: a runtime package with no integrity, a link of any value, a key outside node_modules
    [{[ch]: {...r.lockfile.packages[ch], integrity: undefined}}, 2, /integrity for countinghouse/],
    [{'node_modules/dep': {link: 1, resolved: 'https://registry.npmjs.org/../../../outside', integrity: r.pins.countinghouse.integrity}}, 2, /links node_modules\/dep/],
    [{'../outside': {version: '1.0.0', resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz', integrity: r.pins.countinghouse.integrity}}, 2, /not a node_modules path/]
  ];
  for (const [entries, code, why] of cases) {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: home(), CH_LOCAL_DEV: '1'}, exec: npm()});
    const lockfile = {...r.lockfile, packages: {...r.lockfile.packages, ...entries}};
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: pinsFile(r, {pins: r.pins, runtimeLockfile: lockfile})}, io, {...r.allow, pins: {}}), code, JSON.stringify(entries));
    if (why) assert.match(io.err, why);
  }
});

test('a tarball that cannot be read is a problem named like the others, not a crash', async () => {
  const r = release(); const h = home();
  const file = path.join(r.from, 'countinghouse-ch-step-redact-0.1.0.tgz');
  fs.rmSync(file);
  fs.mkdirSync(file);
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 1);
  assert.match(io.err, /@countinghouse\/ch-step-redact@0\.1\.0: cannot read countinghouse-ch-step-redact-0\.1\.0\.tgz \(EISDIR\)/);
  assert.match(io.err, /nothing was installed/);
});

test('a running daemon is told: install appends an upgrade request to run/daemon/requests (C3b)', {skip: process.platform === 'win32'}, async () => {
  const r = release(); const h = home();
  const dir = path.join(h, 'run', 'daemon');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(h, 'run'), 0o700);
  fs.chmodSync(dir, 0o700);
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const lines = fs.readFileSync(path.join(dir, 'requests'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => l.op), ['upgrade']);
});

test('no lock-order deadlock (the review of #35): an install while the daemon holds start.lock and waits on packs.lock, and both finish', {skip: process.platform === 'win32'}, async () => {
  const {withLockFile, withLock} = require('../lib/lock');
  const r = release(); const h = home();
  const dir = path.join(h, 'run', 'daemon');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(h, 'run'), 0o700);
  fs.chmodSync(dir, 0o700);
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  const installing = run(r, io);
  // once the install holds packs.lock, a daemon takes start.lock and waits on packs.lock, as its start() does
  const until = Date.now() + 10000;
  while (!fs.existsSync(path.join(h, 'packs.lock')) && Date.now() < until) await new Promise((res) => setTimeout(res, 5));
  const daemonSide = withLockFile(path.join(dir, 'start.lock'), dir, fakeIo({}), async() => withLock({home: h}, fakeIo({}), async() => 0, {wait: true}), {wait: true});
  const both = Promise.all([installing, daemonSide]);
  const outcome = await Promise.race([both, new Promise((res) => setTimeout(() => res('deadlock'), 15000))]);
  assert.notStrictEqual(outcome, 'deadlock');
  assert.strictEqual(outcome[0], 0, io.err);
  assert.ok(fs.readFileSync(path.join(dir, 'requests'), 'utf8').includes('"op":"upgrade"'), 'and the request was still written');
});

// Held packs are never dropped by an install (the deep review of #77), and
// each one's mark follows the release installed (its /code-review medium).

// the medium review of L1a-2
// #83's high review, 4: a record that cannot be read is set aside, named,
// and the install starts a new one; the rollback target is kept
test('a record that cannot be read is set aside and named; the install goes on, the rollback target kept', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  fs.mkdirSync(path.join(h, 'previous'), {recursive: true});
  fs.writeFileSync(path.join(h, 'previous', 'keep'), 'the rollback target');
  fs.writeFileSync(path.join(h, 'modules.json'), '{"v": 2');
  const again = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({pack: 'other', from: r.from}, again, r.allow), 0, again.err);
  const aside = fs.readdirSync(h).filter((n) => n.startsWith('modules.json.unreadable-'));
  assert.strictEqual(aside.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(h, aside[0]), 'utf8'), '{"v": 2', 'kept as it was');
  assert.match(again.out, new RegExp(`it is kept as ${aside[0].replace(/[.]/g, '\\.')} for reference, and this install starts a new one: add the other packs again with \`${cmd(h, 'add-pack')}\``));
  assert.deepStrictEqual(Object.keys(record(h).packs), ['other']);
  assert.ok(fs.existsSync(path.join(h, 'previous', 'keep')), 'the rollback target kept');
});

test('a home an earlier development launcher made (installed.json only) is installed over, as before (4)', async () => {
  const r = release(); const h = home();
  fs.writeFileSync(path.join(h, 'installed.json'), JSON.stringify({pack: 'ci-failure-triage', versions: {}, credentials: []}));
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  assert.ok(!fs.existsSync(path.join(h, 'installed.json')));
  assert.deepStrictEqual(Object.keys(record(h).packs), ['ci-failure-triage']);
});

// The Reviewer on #83: a migration reinstalls every pack packs.json lists
// from these pins' integrity-checked tarballs, never from an earlier
// ch-local's trees; under development pins --from must hold them all
test('migration reinstalls every pack the record lists from the tarballs; development pins missing one are refused, naming it', async () => {
  const r = release(); const h = home();
  const triage = Object.fromEntries(TRIAGE.map((n) => [n, '0.1.0']));
  const other = {'@countinghouse/ch-pack-other': '0.3.0', '@countinghouse/ch-step-redact': '0.1.0', '@countinghouse/ch-step-other': '0.2.0'};
  const old = JSON.stringify({runtime: {versions: Object.fromEntries(RUNTIME)}, unreleased: false, release: null,
    packs: {'ci-failure-triage': {packages: triage, credentials: []}, other: {packages: other, credentials: []}}});
  fs.writeFileSync(path.join(h, 'packs.json'), old);
  const f = path.join(tmp('ch-pins-'), 'pins.json');
  fs.writeFileSync(f, JSON.stringify({pins: r.pins, runtimeLockfile: r.lockfile, modules: devModules(r.allow, r.pins)}));
  const allow = {...r.allow, pins: {}, runtime: {...r.allow.runtime, lockfile: null}};
  // --from without ch-step-other's tarball: refused, naming it, nothing changed
  const missing = require('../lib/unpack').tarballName('@countinghouse/ch-step-other', '0.2.0');
  const kept = fs.readFileSync(path.join(r.from, missing));
  fs.rmSync(path.join(r.from, missing));
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, io, allow), 1);
  assert.match(io.err, new RegExp(`@countinghouse/ch-step-other@0\\.2\\.0: no ${missing.replace(/[.]/g, '\\.')}`));
  assert.strictEqual(fs.readFileSync(path.join(h, 'packs.json'), 'utf8'), old, 'nothing changed');
  // with it: every pack is installed from the tarballs, from the development pins
  fs.writeFileSync(path.join(r.from, missing), kept);
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, io2, allow), 0, io2.err);
  const rec = record(h);
  assert.deepStrictEqual(Object.keys(rec.packs).sort(), ['ci-failure-triage', 'other']);
  for (const [n, v] of Object.entries(other)) assert.strictEqual(JSON.parse(fs.readFileSync(path.join(h, 'module-store', ...n.split('/'), `${v}.json`), 'utf8')).integrity, r.pins[n].integrity, `${n} from its tarball`);
  const digest = require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
  assert.deepStrictEqual(rec.packs.other.from, {unreleased: digest});
});

// #83's high review, 8: a version the record names is never placed over
// with other contents, and nothing is placed before that is known
test('other contents under a version the record names are refused before anything is placed (8)', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  // a development pins file that rebuilt ch-step-redact 0.1.0 with other bytes
  const rebuilt = release({extra: {'@countinghouse/ch-step-redact': {description: 'rebuilt'}}});
  const f = path.join(tmp('ch-pins-'), 'pins.json');
  fs.writeFileSync(f, JSON.stringify({pins: rebuilt.pins, runtimeLockfile: rebuilt.lockfile, modules: devModules(rebuilt.allow, rebuilt.pins)}));
  const before = fs.readFileSync(path.join(h, 'module-store', '@countinghouse', 'ch-step-redact', '0.1.0', 'package.json'), 'utf8');
  const dev = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: rebuilt.from, unreleasedPins: f}, dev, {...rebuilt.allow, pins: {}, runtime: {...rebuilt.allow.runtime, lockfile: null}}), 1);
  assert.match(dev.err, /ch-step-redact 0\.1\.0 is installed with other contents; a changed module takes a new version.*nothing was installed/);
  assert.strictEqual(fs.readFileSync(path.join(h, 'module-store', '@countinghouse', 'ch-step-redact', '0.1.0', 'package.json'), 'utf8'), before, 'not replaced');
});

// the Reviewer's ruling on #83: an earlier ch-local's pack trees are never
// deleted: kept aside whole once no start from before uses them
test('an earlier ch-local\'s pack trees are kept aside whole, never deleted, whatever names them', async () => {
  const h = home();
  const triage = Object.fromEntries(TRIAGE.map((n) => [n, '0.1.0']));
  const {packKey} = require('../lib/gc');
  const tree = path.join('ci-failure-triage', packKey(triage), 'node_modules', 'x');
  fs.mkdirSync(path.join(h, 'packs', tree), {recursive: true});
  fs.writeFileSync(path.join(h, 'packs', tree, 'kept'), 'bytes');
  const r = release();
  assert.strictEqual(await run(r, fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()})), 0);
  const kept = fs.readdirSync(h).filter((n) => n.startsWith('packs.migrated-'));
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(h, kept[0], tree, 'kept'), 'utf8'), 'bytes');
});

test('a migration carries over only the packs these pins list: a held one and an empty one are named, not recorded', async () => {
  const r = release(); const h = home();
  fs.writeFileSync(path.join(h, 'packs.json'), JSON.stringify({runtime: {versions: Object.fromEntries(RUNTIME)}, unreleased: false, release: null,
    packs: {'ci-failure-triage': {packages: Object.fromEntries(TRIAGE.map((n) => [n, '0.1.0'])), credentials: []}},
    held: {other: {packages: {'@countinghouse/ch-pack-other': '0.3.0'}, credentials: [], installedUnder: '0.9.0'}, empty: {packages: {}, credentials: [], installedUnder: '0.9.0'}}}));
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  assert.deepStrictEqual(Object.keys(record(h).packs), ['ci-failure-triage']);
  assert.strictEqual(record(h).held, undefined);
  // this release lists it: add-pack brings it back
  assert.match(io.out, new RegExp(`not carried over: other; add it again with \`${cmd(h, 'add-pack other')}\`\n`));
});

// the medium review of #83's fixes
test('an unreadable record is set aside only once the install is through: one refused later leaves it where it was (1)', async () => {
  const r = release(); const h = home();
  assert.strictEqual(await run(r, fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()})), 0);
  fs.writeFileSync(path.join(h, 'modules.json'), '{"v": 2');
  // npm ci fails: refused after the record was read
  const failing = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: () => ({status: 1, stdout: '', stderr: 'boom'})});
  assert.strictEqual(await run(r, failing), 1);
  assert.strictEqual(fs.readFileSync(path.join(h, 'modules.json'), 'utf8'), '{"v": 2', 'not set aside');
  assert.deepStrictEqual(fs.readdirSync(h).filter((n) => n.includes('.unreadable-')), []);
});

// the Reviewer's check of #83's fixes
test('a record that cannot be read for an I/O error refuses the install, and drops no pack (4)', {skip: process.platform === 'win32' || process.getuid() === 0}, async () => {
  const r = release(); const h = home();
  assert.strictEqual(await run(r, fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()})), 0);
  const file = path.join(h, 'modules.json');
  const before = fs.readFileSync(file, 'utf8');
  fs.chmodSync(file, 0o000);
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
    assert.strictEqual(await install({pack: 'other', from: r.from}, io, r.allow), 1);
    assert.match(io.err, /is not readable \(EACCES\); nothing was installed/);
  } finally {
    fs.chmodSync(file, 0o644);
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'untouched, never set aside');
  assert.deepStrictEqual(fs.readdirSync(h).filter((n) => n.includes('.unreadable-')), []);
});

test('a set-aside that cannot move the record stops the install with nothing changed (5)', async (t) => {
  const r = release(); const h = home();
  assert.strictEqual(await run(r, fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()})), 0);
  const file = path.join(h, 'modules.json');
  fs.writeFileSync(file, '{"v": 2');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (a, b) => { if (a === file) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return rename(a, b); });
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({pack: 'other', from: r.from}, io, r.allow), 1);
  assert.match(io.err, /it could not be set aside \(EBUSY\); nothing was installed/);
  t.mock.restoreAll();
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"v": 2', 'never overwritten');
});

// (8): a kept packs.json can survive an install of the same release, which
// keeps previous/ as it was: it names no rollback target, and keeps nothing
test('a kept packs.json that survives a same-release install is refused by rollback, and its trees are not kept (8)', async () => {
  const h = home();
  const r = release(); r.allow.release = {version: '0.2.0', security: null};
  assert.strictEqual(await run(r, fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()})), 0);
  const triage = Object.fromEntries(TRIAGE.map((n) => [n, '0.1.0']));
  const {packKey} = require('../lib/gc');
  const tree = path.join(h, 'packs', 'ci-failure-triage', packKey(triage));
  fs.mkdirSync(path.join(tree, 'node_modules'), {recursive: true});
  fs.mkdirSync(path.join(h, 'previous', 'app'), {recursive: true});
  fs.writeFileSync(path.join(h, 'previous', 'packs.json'), JSON.stringify({runtime: {versions: {}}, release: {version: '0.1.0', security: null}, packs: {'ci-failure-triage': {packages: triage, credentials: []}}}));
  // the same release again: previous/ is kept as it is
  assert.strictEqual(await run(r, fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()})), 0);
  assert.ok(fs.existsSync(path.join(h, 'previous', 'packs.json')), 'it survives');
  assert.ok(!fs.existsSync(tree), 'its trees are not kept');
  const rio = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h}}), {interactive: true});
  assert.strictEqual(await require('../lib/rollback').rollback({}, rio), 1);
  assert.match(rio.err, /the kept release predates the module store, so it could not return you here; install it again instead/);
});


// the medium review of the Reviewer's round on #83
test('a throw after the new app is in leaves the set-aside record aside, already named; before the swap it goes back (3)', async (t) => {
  const r = release(); const h = home();
  assert.strictEqual(await run(r, fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()})), 0);
  const file = path.join(h, 'modules.json');
  fs.writeFileSync(file, '{"v": 2');
  t.mock.method(require('../lib/shim-config'), 'writeShimJson', () => { throw new Error('shim.json could not be written'); });
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  await assert.rejects(run(r, io), /shim\.json could not be written/);
  t.mock.restoreAll();
  const aside = fs.readdirSync(h).find((n) => n.startsWith('modules.json.unreadable-'));
  assert.ok(aside != null, 'never put back beside the new app');
  assert.match(io.out, new RegExp(`it is kept as ${aside.replace(/[.]/g, '\\.')} for reference`));
});

test('under development pins a pack the pins do not pin is not carried over, without failing; a held one neither', async () => {
  const r = release(); const h = home();
  const triage = Object.fromEntries(TRIAGE.map((n) => [n, '0.1.0']));
  fs.writeFileSync(path.join(h, 'packs.json'), JSON.stringify({runtime: {versions: Object.fromEntries(RUNTIME)}, unreleased: true, release: null,
    packs: {'ci-failure-triage': {packages: triage, credentials: []}, other: {packages: {'@countinghouse/ch-pack-other': '0.3.0'}, credentials: []}},
    held: {kept: {packages: {'@countinghouse/ch-pack-kept': '1.0.0'}, credentials: [], installedUnder: '0.9.0'}}}));
  // these development pins pin ci-failure-triage's modules and the runtime only
  const pins = Object.fromEntries(Object.entries(r.pins).filter(([n]) => !/ch-pack-other|ch-step-other/.test(n)));
  // (its --from holds what it pins: a tarball no pin names is refused)
  for (const n of ['@countinghouse/ch-pack-other', '@countinghouse/ch-step-other']) fs.rmSync(path.join(r.from, require('../lib/unpack').tarballName(n, r.pins[n].version)));
  const f = path.join(tmp('ch-pins-'), 'pins.json');
  fs.writeFileSync(f, JSON.stringify({pins, runtimeLockfile: r.lockfile, modules: devModules(r.allow, pins)}));
  const allow = {...r.allow, pins: {}, runtime: {...r.allow.runtime, lockfile: null}};
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, io, allow), 0, io.err);
  assert.deepStrictEqual(Object.keys(record(h).packs), ['ci-failure-triage']);
  assert.match(io.out, /not carried over: other; these pins do not pin all of its modules/);
  assert.match(io.out, new RegExp(`not carried over: kept; add it again with \`${cmd(h, 'add-pack kept')}\` once a release lists it`));
  assert.strictEqual((io.out.match(/not carried over: /g) || []).length, 2, 'each once');
});

// the Reviewer's round on #83, 5: a record that cannot be put back is named
test('a set-aside record that cannot be put back is named, where it is and what to rename it to', async (t) => {
  const r = release(); const h = home();
  assert.strictEqual(await run(r, fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()})), 0);
  const file = path.join(h, 'modules.json');
  fs.writeFileSync(file, '{"v": 2');
  const rename = fs.renameSync;
  const app = path.join(h, 'app');
  // the swap fails (a client holds the app), and so does putting the record back
  t.mock.method(fs, 'renameSync', (a, b) => {
    if (b === app && a === `${app}.new`) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    if (b === file) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; }
    return rename(a, b);
  });
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 1);
  t.mock.restoreAll();
  const aside = fs.readdirSync(h).find((n) => n.startsWith('modules.json.unreadable-'));
  assert.ok(aside != null);
  assert.match(io.err, new RegExp(`your previous record could not be put back \\(EBUSY\\): it is at .*${aside.replace(/[.]/g, '\\.')}; rename it to modules\\.json`));
});

// L3 (#413 section 10): the install that migrates the record moves each
// pack.<name> to enabled.<its scenario module>, off winning, a history
// line for each; one whose pack the home doesn't have is kept
test('migration: pack.* settings become enabled.<module> in the same install, off winning; an unknown pack\'s is kept', async () => {
  const r = release(); const h = home();
  const packages = Object.fromEntries(TRIAGE.map((n) => [n, '0.1.0']));
  fs.writeFileSync(path.join(h, 'packs.json'), JSON.stringify({runtime: {versions: Object.fromEntries(RUNTIME)}, unreleased: false, release: null,
    packs: {'ci-failure-triage': {packages, credentials: []}}}));
  fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({version: 1, values: {
    'pack.ci-failure-triage': false, 'enabled.@countinghouse/ch-pack-ci-failure-triage': true, 'pack.gone': false, locale: 'zh'}}));
  // (pack.ci-failure-triage was recorded off: the move must clear that too)
  fs.writeFileSync(path.join(h, 'history.jsonl'), JSON.stringify({by: 'cli', setting: 'pack.ci-failure-triage', old: true, new: false}) + '\n');
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const values = JSON.parse(fs.readFileSync(path.join(h, 'settings.json'), 'utf8')).values;
  assert.deepStrictEqual(values, {'enabled.@countinghouse/ch-pack-ci-failure-triage': false, 'pack.gone': false, locale: 'zh'});
  assert.match(io.out, /pack\.ci-failure-triage is now enabled\.@countinghouse\/ch-pack-ci-failure-triage/);
  const lines = fs.readFileSync(path.join(h, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.by === 'migration' && l.setting === 'pack.ci-failure-triage' && l.was === false), JSON.stringify(lines));
  // what moved is no outside edit
  const {outsideEdits} = require('../lib/outside-edits');
  const {readSettings} = require('../lib/settings');
  const where = require('../lib/home').layout({COUNTINGHOUSE_HOME: h});
  assert.deepStrictEqual(outsideEdits(where, readSettings(where)).filter((e) => /ci-failure-triage/.test(e.setting)), []);
});

// the medium on #101 round 2, 2: an install that judged no record (install,
// add-pack) refuses when the record gained a pack between its first read and
// its lock: that pack was never fetched for, asked about or checked
test('a pack the record gains while install reads its tarballs: refused, nothing installed', async () => {
  const home = tmp('ch-home-');
  const r = release();
  require('./install-helpers').installedHome(home, ['ci-failure-triage', 'other'], {r, runtime: {'@countinghouse/ch-local': '0.2.0', countinghouse: '8.0.0'}});
  const file = path.join(home, 'modules.json');
  const both = fs.readFileSync(file, 'utf8');
  require('./store-helpers').editHome(home, (rec) => { delete rec.packs.other; return rec; });
  const one = fs.readFileSync(file, 'utf8');
  // the first tarball read, before the lock: another ch-local adds "other"
  const read = fs.readFileSync;
  let changed = false;
  fs.readFileSync = function (p, ...rest) {
    if (!changed && typeof p === 'string' && p.startsWith(r.from) && p.endsWith('.tgz')) { changed = true; fs.writeFileSync(file, both); }
    return read.call(this, p, ...rest);
  };
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, r.allow), 1, io.err);
    assert.ok(changed, 'the record changed during the read');
    assert.match(io.err, /this home's packs changed while this install ran \(other\): run it again; nothing was installed/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), both, 'nothing written');
  } finally {
    fs.readFileSync = read;
  }
  assert.notStrictEqual(one, both);
});

// the medium on the floors: a development pins file is held to the release's
// floors too (an unreleased install never puts a part below one)
test('--unreleased-pins refuses a pin below the release\'s floor, before anything is installed', async () => {
  const r = release();
  const REDACT = '@countinghouse/ch-step-redact';
  const at = r.pins[REDACT].version;
  for (const [floor, code] of [['9.0.0', 2], [at, 0]]) {
    const h = home();
    const allow = {...r.allow, pins: {}, runtime: {...r.allow.runtime, lockfile: null}, floors: {[REDACT]: floor}};
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
    const f = pinsFile(r, {pins: r.pins, runtimeLockfile: r.lockfile});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, io, allow), code, io.err);
    if (code === 2) {
      assert.match(io.err, new RegExp(`${REDACT} ${at.replace(/\./g, '\\.')} is below its floor 9\\.0\\.0`));
      assert.ok(!fs.existsSync(path.join(h, 'app', 'node_modules')), 'nothing installed');
    }
  }
});

// A fresh install on an account whose umask is Ubuntu's default (0002): the
// home is made 0700 itself, never by the umask, so the shared runtime's
// daemon accepts it (lib/home.js homeOwnershipProblem refuses a group- or
// world-writable home); an existing such home is named with its chmod line
// and left as it is (the reviewer, 2026-11-21: found in the replay's prep)
test('a fresh install makes its home 0700 whatever the umask, and the daemon accepts it', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const {daemon} = require('../lib/daemon');
  const {daemonIo} = require('./daemon-fakes');
  const r = release();
  const h = path.join(home(), 'nested', 'home');
  const was = process.umask(0o002);
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
    assert.strictEqual(await run(r, io), 0, io.err);
    assert.strictEqual(fs.statSync(h).mode & 0o777, 0o700);
    // the daemon's own home check passes, and it goes on to start the runtime
    const dio = daemonIo(h);
    let started = false;
    await daemon({home: h}, dio, {run: async () => { started = true; return 0; }});
    assert.ok(started, `the daemon started its runtime on the installed home: ${dio.err}`);
    assert.doesNotMatch(dio.err, /writable/);
  } finally {
    process.umask(was);
  }
});

test('an existing group-writable home: install says so with the chmod line, and changes nothing', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const r = release(); const h = home();
  fs.chmodSync(h, 0o775);
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  assert.strictEqual(fs.statSync(h).mode & 0o777, 0o775, 'not changed');
  const said = io.out + io.err;
  assert.match(said, /group- or world-writable \(mode 0775\)/);
  assert.ok(said.includes(`chmod 700 '${fs.realpathSync.native(h)}'`) || said.includes(`chmod 700 "${fs.realpathSync.native(h)}"`) || said.includes(`chmod 700 ${fs.realpathSync.native(h)}`), said);
});

test('ensureHome: a missing home and its parents made 0700 under umask 0002; one that exists left as it is; a first setting makes it the same way', {skip: process.platform === 'win32' && 'POSIX modes'}, () => {
  const {ensureHome, layout} = require('../lib/home');
  const {withSettingsLock} = require('../lib/settings');
  const base = home();
  const was = process.umask(0o002);
  try {
    const h = path.join(base, 'a', 'home');
    assert.strictEqual(ensureHome(h), true);
    assert.strictEqual(fs.statSync(h).mode & 0o777, 0o700);
    assert.strictEqual(fs.statSync(path.dirname(h)).mode & 0o777, 0o700, 'its parent too');
    fs.chmodSync(h, 0o750);
    assert.strictEqual(ensureHome(h), false);
    assert.strictEqual(fs.statSync(h).mode & 0o777, 0o750, 'an existing home is not changed');
    const s = path.join(base, 'settings-home');
    withSettingsLock(layout({COUNTINGHOUSE_HOME: s}), () => 0);
    assert.strictEqual(fs.statSync(s).mode & 0o777, 0o700, 'settings\' first lock');
  } finally {
    process.umask(was);
  }
});
