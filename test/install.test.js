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
  assert.match(io.out, new RegExp(`not carried over: old; add it again with \`${cmd(h, 'install --pack old')}\` once a release lists it`));
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
async function npmRelease(r, {lie = null, shim = false, shimBody = 'the shim'} = {}) {
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
    const bytes = require('./tgz').packageTgz({name, version: '0.5.0'}, {[`bin/${exe}`]: shimBody});
    reg.publish(name, '0.5.0', bytes);
    const identity = Object.assign({}, self, {workflow: '.github/workflows/shim.yml', tag: 'shim-v0.5.0'});
    const hex = crypto.createHash('sha512').update(bytes).digest('hex');
    reg.attest(name, '0.5.0', {attestations: [{predicateType: provenance.PROVENANCE, bundle: root.provenance(name, '0.5.0', hex, identity, at)},
      {predicateType: provenance.PUBLISH, bundle: root.publish(name, '0.5.0', hex, at)}]});
    pins[name] = Object.assign({version: '0.5.0', integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`}, identity);
  }
  const allow = Object.assign({}, r.allow, {pins, self, shim: shimSection, release: {version: r.pins['@countinghouse/ch-local'].version, security: null},
    runtime: Object.assign({}, r.allow.runtime, {lockfile})});
  // the release's data as release-pins.json parses it, for the production
  // builders (lib/npm-upgrade.js releaseAllow) to make the allow from
  const data = {release: {security: null}, self, shim: shimSection, runtime: allow.runtime, packs: r.allow.packs, modules: r.allow.modules, pins};
  return {reg, allow, data, fromNpm: {registry: reg.url, trust: provenance.trustMaterial(root.trustedRoot, root.npmKeys)}};
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
    assert.match(io.err, /0\.2\.0 is lower than the installed 0\.9\.0: (?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local rollback is the way back/);
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

// A-shim-from (the reviewer, 11-21): a prepared folder carries this
// platform's shim, pinned by its sha512 as its packs are, and --from places
// and records it as the npm path does. A program header this machine's
// session check takes (lib/session.js formatProblem).
const {hostProgram} = require('./host-program');
const HOST_KEY = `${process.platform}-${process.arch}`;
const SHIM_PACKAGES = Object.fromEntries(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'].map((t) => [t, `@countinghouse/ch-shim-${t}`]));
// a shim package's tarball put in the folder -> {name, version, pin} (lie: a
// pin naming other bytes)
// files: the package's files in place of bin/<exe>; raw: the tarball's bytes
function folderShim(r, {key = HOST_KEY, body = hostProgram(), version = '0.5.0', lie = false, files = null, raw = null} = {}) {
  const name = SHIM_PACKAGES[key] || `@countinghouse/ch-shim-${key}`;
  const exe = key.startsWith('win32') ? 'ch-shim.exe' : 'ch-shim';
  const bytes = raw != null ? raw : require('./tgz').packageTgz({name, version}, files != null ? files : {[`bin/${exe}`]: body});
  fs.writeFileSync(path.join(r.from, require('../lib/install').tarballName(name, version)), bytes);
  const integrity = `sha512-${require('node:crypto').createHash('sha512').update(lie ? Buffer.from('other') : bytes).digest('base64')}`;
  return {name, version, pin: {version, integrity}};
}
const withShim = (allow, ...shims) => ({...allow, shim: {packages: SHIM_PACKAGES}, pins: {...allow.pins, ...Object.fromEntries(shims.map((x) => [x.name, x.pin]))}});
const EXE_HERE = process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim';

test('--from with this platform\'s shim in the folder: placed by its pinned sha512, recorded, and the one a session runs', async () => {
  const r = release(); const h = home();
  const s = folderShim(r);
  // (this Node in shim.json, which a session checks before the shim: A3)
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()}), {node: process.execPath});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, withShim(r.allow, s)), 0, io.err);
  assert.ok(fs.readFileSync(path.join(h, 'shim', EXE_HERE)).equals(hostProgram()), 'the tarball\'s binary, placed');
  assert.deepStrictEqual(record(h).shim, {package: s.name, version: '0.5.0'});
  assert.match(io.out, /the shared runtime's shim 0\.5\.0 is at /);
  // (end to end: the recorded version is versions.json's, so session execs it)
  const {sessionChoice} = require('../lib/session');
  assert.strictEqual(sessionChoice({where: layout({COUNTINGHOUSE_HOME: h})}).shim, path.join(h, 'shim', EXE_HERE));
  // (status names it: the reviewer's high, F2)
  const st = fakeIo({env: {COUNTINGHOUSE_HOME: h}});
  await require('../lib/packs-command').status({}, st);
  assert.match(st.out, /^the shared runtime's shim, as recorded: 0\.5\.0$/m);
  // (again: the same shim, checked again, moves nothing)
  const io2 = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()}), {node: process.execPath});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io2, withShim(r.allow, s)), 0, io2.err);
  assert.ok(!fs.existsSync(path.join(h, 'shim', 'ch-shim.previous')), 'the same binary moves nothing');
  // (a rebuilt folder at the same version: its bytes are placed, never the
  // one there kept by its version -- the medium, 1)
  const rebuilt = Buffer.concat([hostProgram(), Buffer.from('rebuilt')]);
  const s2 = folderShim(r, {body: rebuilt});
  const io3 = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()}), {node: process.execPath});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io3, withShim(r.allow, s2)), 0, io3.err);
  assert.ok(fs.readFileSync(path.join(h, 'shim', EXE_HERE)).equals(rebuilt), 'the rebuilt binary, placed');
  assert.strictEqual(require('../lib/session').sessionChoice({where: layout({COUNTINGHOUSE_HOME: h})}).shim, path.join(h, 'shim', EXE_HERE));
  // (and other bytes than the pin's are refused though the record names
  // that version -- the medium, 3)
  const s3 = folderShim(r, {lie: true});
  const io4 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io4, withShim(r.allow, s3)), 1, io4.out);
  assert.match(io4.err, /the tarball's integrity is not the pinned one/);
  assert.ok(fs.readFileSync(path.join(h, 'shim', EXE_HERE)).equals(rebuilt), 'the one there kept');
});

test('--from with a release\'s whole set of shims: this machine\'s is placed, the others left alone', async () => {
  const r = release(); const h = home();
  const other = HOST_KEY === 'linux-arm64' ? 'linux-x64' : 'linux-arm64';
  const ours = folderShim(r);
  const theirs = folderShim(r, {key: other});
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, withShim(r.allow, ours, theirs)), 0, io.err);
  assert.deepStrictEqual(record(h).shim, {package: ours.name, version: '0.5.0'});
});

test('--unreleased-pins with a shim in the folder (dogfood --release-dir): placed and recorded, the home still unreleased', async () => {
  const r = release(); const h = home();
  // (a dev build's version, as dogfood gives it: never a released one -- the
  // reviewer's high, F1)
  const s = folderShim(r, {version: '0.5.0-dev.0123456789ab'});
  const allow = {...r.allow, pins: {}, shim: {packages: SHIM_PACKAGES}, runtime: {...r.allow.runtime, lockfile: null}};
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()}), {node: process.execPath});
  const f = pinsFile(r, {pins: {...r.pins, [s.name]: s.pin}, runtimeLockfile: r.lockfile});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, io, allow), 0, io.err);
  assert.deepStrictEqual(record(h).shim, {package: s.name, version: '0.5.0-dev.0123456789ab'});
  assert.strictEqual(record(h).unreleased, true);
  assert.match(io.err, /this is an unreleased install \(development only\)/);
  assert.strictEqual(require('../lib/session').sessionChoice({where: layout({COUNTINGHOUSE_HOME: h})}).shim, path.join(h, 'shim', EXE_HERE));
});

test('--from refuses a folder\'s shim as it refuses a pack: other bytes than the pin\'s, not a program this machine runs, no binary, a refused tarball, missing, a version the record can\'t hold', async () => {
  const refused = async (shims, re) => {
    const r = release(); const h = home();
    const made = shims(r);
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, withShim(r.allow, ...made)), 1, io.out);
    assert.match(io.err, re);
    assert.match(io.err, /nothing was installed/);
    assert.ok(!fs.existsSync(path.join(h, 'modules.json')), 'nothing recorded');
    assert.ok(!fs.existsSync(path.join(h, 'shim', EXE_HERE)), 'nothing placed');
  };
  await refused((r) => [folderShim(r, {lie: true})], new RegExp(`${SHIM_PACKAGES[HOST_KEY] || `@countinghouse/ch-shim-${HOST_KEY}`}@0\\.5\\.0: the tarball's integrity is not the pinned one`));
  if (process.platform !== 'win32') {
    await refused((r) => [folderShim(r, {body: '#!/bin/sh\necho hi\n'})], new RegExp(`@0\\.5\\.0's bin/ch-shim is not a program this machine runs \\(${HOST_KEY}: not an? (ELF|Mach-O) program`));
  }
  // (an ELF of another architecture under this machine's name: F's tests)
  if (process.platform === 'linux') {
    const other = hostProgram();
    other.writeUInt16LE(process.arch === 'arm64' ? 0x3e : 0xb7, 18);
    await refused((r) => [folderShim(r, {body: other})], new RegExp(`is not a program this machine runs \\(${HOST_KEY}: not an ELF program for ${process.arch}\\)`));
  }
  // (no binary, and a tarball the strict reader refuses: a link)
  await refused((r) => [folderShim(r, {files: {'README.md': 'no binary'}})], new RegExp(`@0\\.5\\.0 holds no bin/${EXE_HERE.replace('.', '\\.')}`));
  const {member, tgz} = require('./tgz');
  await refused((r) => [folderShim(r, {raw: tgz(member('package/package.json', {data: '{}'}), member(`package/bin/${EXE_HERE}`, {type: '2', linkname: '/bin/sh'}))})], /@0\.5\.0's tarball was refused \(/);
  // (pinned for this machine but not in the folder, as a pack's tarball:
  // F4, F5)
  await refused((r) => { const s = folderShim(r); fs.rmSync(path.join(r.from, require('../lib/install').tarballName(s.name, '0.5.0'))); return [s]; }, new RegExp(`${SHIM_PACKAGES[HOST_KEY] || ''}@0\\.5\\.0: no .*ch-shim-${HOST_KEY}-0\\.5\\.0\\.tgz in `));
  // (a version a home's record can't hold: refused before the app is
  // swapped, F3)
  await refused((r) => [folderShim(r, {version: `0.5.0-${'a'.repeat(65)}`})], /: not a version a home's record can hold/);
});

// The reviewer's high on A-shim-from, F1: under unreleased pins a shim at a
// release's version (dev bytes under a name a release uses) is refused; and
// an unreleased home's shim is never 'current' to an install from npm, which
// fetches and verifies the release's own
test('F1: an unreleased install\'s shim must carry a pre-release version; an npm install over an unreleased home fetches the release\'s shim', async () => {
  const r = release(); const h = home();
  const s = folderShim(r);
  const allow = {...r.allow, pins: {}, shim: {packages: SHIM_PACKAGES}, runtime: {...r.allow.runtime, lockfile: null}};
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
  const f = pinsFile(r, {pins: {...r.pins, [s.name]: s.pin}, runtimeLockfile: r.lockfile});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, io, allow), 1);
  assert.match(io.err, /@0\.5\.0: an unreleased install's shim carries dogfood's version \(<x\.y\.z>-dev\.<12 hex>\), never one a release could use/);
  // (a pre-release a release could publish is refused too: the medium, 1)
  const rc = folderShim(r, {version: '0.5.0-rc.1'});
  const io3 = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: pinsFile(r, {pins: {...r.pins, [rc.name]: rc.pin}, runtimeLockfile: r.lockfile})}, io3, allow), 1);
  assert.match(io3.err, /@0\.5\.0-rc\.1: an unreleased install's shim carries dogfood's version/);
  assert.match(io.err, /nothing was installed/);
  // (an npm install over an unreleased home whose record names the same
  // version: fetched and verified, never kept as current)
  const r2 = release(); const h2 = home();
  const n = await npmRelease(r2, {shim: true});
  try {
    const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h2}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io2, n.allow, n.fromNpm), 0, io2.err);
    const file = path.join(h2, 'modules.json');
    fs.writeFileSync(file, JSON.stringify({...JSON.parse(fs.readFileSync(file, 'utf8')), unreleased: true}, null, 2) + '\n');
    const {prepareShim} = require('../lib/shim-install');
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ready = await prepareShim({data: {shim: n.allow.shim, pins: n.allow.pins}, record: rec, home: h2, io: io2, ...n.fromNpm});
    assert.strictEqual(ready.status, 'ready', 'fetched and verified, not current');
  } finally {
    await n.reg.close();
  }
});

// A3 (the reviewer): the session's note says to run install when shim.json
// names a Node that is gone; a bare reinstall writes shim.json's node and
// chLocal again, from this process, and keeps the shim, so the session picks
// it again
test('A3: after node moves, a bare reinstall writes shim.json again and keeps the shim: the session picks it again', async () => {
  const {hostProgram} = require('./host-program');
  const {sessionChoice} = require('../lib/session');
  const r = release(); const h = home();
  const n = await npmRelease(r, {shim: true, shimBody: hostProgram()});
  try {
    const at = () => sessionChoice({where: layout({COUNTINGHOUSE_HOME: h})});
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    io.node = process.execPath;
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, n.allow, n.fromNpm), 0, io.err);
    const exe = path.join(h, 'shim', process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');
    assert.strictEqual(at().shim, exe, at().note);
    // (Node moved: shim.json still names the one install ran under)
    const file = path.join(h, 'shim.json');
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({...body, node: path.join(h, 'old-node', process.platform === 'win32' ? 'node.exe' : 'node')}));
    assert.strictEqual(at().shim, null);
    assert.match(at().note, /name a Node that can't be used \(node: ENOENT\)/);
    // the note's fix: a bare reinstall, in the Node that runs now
    const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    io2.node = process.execPath;
    assert.strictEqual(await install({}, io2, n.allow, n.fromNpm), 0, io2.err);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).node, process.execPath);
    assert.deepStrictEqual(record(h).shim, {package: `@countinghouse/ch-shim-${process.platform}-${process.arch}`, version: '0.5.0'}, 'the shim kept');
    assert.strictEqual(at().shim, exe, at().note);
  } finally {
    await n.reg.close();
  }
});

// (the reviewer's high, the medium's 7: a folder's shim refused before the
// table's questions, over a home that has packs to ask about)
test('--from over an unreleased home: a refused shim is refused before the table asks anything', async (t) => {
  const r = release(); const h = home();
  const good = folderShim(r, {version: '0.5.0-dev.0123456789ab'});
  const allow = {...r.allow, pins: {}, shim: {packages: SHIM_PACKAGES}, runtime: {...r.allow.runtime, lockfile: null}};
  const env = {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'};
  const f = pinsFile(r, {pins: {...r.pins, [good.name]: good.pin}, runtimeLockfile: r.lockfile});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, fakeIo({env, exec: npm()}), allow), 0);
  const asked = [];
  const table = require('../lib/pack-table');
  const real = table.askAll;
  t.mock.method(table, 'askAll', async (...a) => { asked.push(a[2]); return real(...a); });
  // (the control: with its shim as pinned, the table is asked)
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, fakeIo({env, exec: npm()}), allow), 0);
  assert.strictEqual(asked.length, 1, 'an unreleased home: the table runs');
  // (the shim's bytes not the pin's: refused, and nothing asked)
  const lie = folderShim(r, {version: '0.5.0-dev.0123456789ab', lie: true});
  const f2 = pinsFile(r, {pins: {...r.pins, [lie.name]: lie.pin}, runtimeLockfile: r.lockfile});
  const io = fakeIo({env, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f2}, io, allow), 1);
  assert.match(io.err, /the tarball's integrity is not the pinned one/);
  assert.strictEqual(asked.length, 1, 'nothing asked');
});

test('--from on a machine whose shim isn\'t named or pinned: said as from npm, whatever other platforms\' shims the folder holds (F4)', async () => {
  const other = HOST_KEY === 'linux-arm64' ? 'linux-x64' : 'linux-arm64';
  // (unpinned: the packages name this machine's, the pins only another's)
  const r = release(); const h = home();
  const theirs = folderShim(r, {key: other});
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, withShim(r.allow, theirs)), 0, io.err);
  assert.strictEqual(record(h).shim, undefined);
  assert.match(io.out, /no shared-runtime shim is pinned for this platform in this release: each session runs its own runtime/);
  // (unsupported: no package for this machine at all)
  const r2 = release(); const h2 = home();
  const theirs2 = folderShim(r2, {key: other});
  const packages = Object.fromEntries(Object.entries(SHIM_PACKAGES).filter(([k]) => k !== HOST_KEY));
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h2}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, io2, {...withShim(r2.allow, theirs2), shim: {packages}}), 0, io2.err);
  assert.match(io2.out, /there is no shared-runtime shim for this platform: each session runs its own runtime/);
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
  assert.match(again.out, new RegExp(`it is kept as ${aside[0].replace(/[.]/g, '\\.')} for reference, and this install starts a new one: add the other packs again with \`${cmd(h, 'install --pack <pack>')}\``));
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
  assert.match(io.out, new RegExp(`not carried over: other; add it again with \`${cmd(h, 'install --pack other')}\`\n`));
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
  assert.match(io.out, new RegExp(`not carried over: kept; add it again with \`${cmd(h, 'install --pack kept')}\` once a release lists it`));
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

// The reviewer's targeted high (11-21): ALLOWLIST and releaseAllow carried
// no shim, so `allow.shim` was null outside tests (the shim test injects
// it) and every install or upgrade from npm set the shim aside: the shared
// runtime never ran on an installed home. The production builders, never an
// allow made by hand.
test('the production allows carry the release\'s shim: ALLOWLIST from release-pins.json, and releaseAllow', () => {
  const {ALLOWLIST} = require('../lib/allowlist');
  const shipped = require('../lib/release-pins').parseReleasePins(require('../lib/release-pins.json')).pins;
  assert.ok(ALLOWLIST.shim != null, 'ALLOWLIST.shim');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ALLOWLIST.shim)), JSON.parse(JSON.stringify(shipped.shim)));
  const {releaseAllow} = require('../lib/npm-upgrade');
  assert.deepStrictEqual(releaseAllow(shipped, '9.9.9').shim, shipped.shim);
});

test('an npm install whose allow comes from releaseAllow places the pinned, provenance-checked shim', async () => {
  const r = release(); const h = home();
  const n = await npmRelease(r, {shim: true});
  try {
    const allow = require('../lib/npm-upgrade').releaseAllow(n.data, r.pins['@countinghouse/ch-local'].version);
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, allow, n.fromNpm), 0, io.err);
    const exe = process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim';
    assert.strictEqual(fs.readFileSync(path.join(h, 'shim', exe), 'utf8'), 'the shim');
    assert.deepStrictEqual(record(h).shim, {package: `@countinghouse/ch-shim-${process.platform}-${process.arch}`, version: '0.5.0'});
    assert.ok(!/set aside/.test(io.out), io.out);
  } finally {
    await n.reg.close();
  }
});

// the medium on B-shim-allow, 8: the shim is placed (and recorded) before
// the daemon is asked to restart onto the new release
test('the shim is in place and recorded before the daemon is asked to restart', async () => {
  const r = release(); const h = home();
  const n = await npmRelease(r, {shim: true});
  const dr = require('../lib/daemon-requests');
  const real = dr.requestUpgrade;
  let atRestart = null;
  dr.requestUpgrade = async (homeDir) => {
    const exe = process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim';
    atRestart = {placed: fs.existsSync(path.join(homeDir, 'shim', exe)), recorded: record(homeDir).shim != null};
  };
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, n.allow, n.fromNpm), 0, io.err);
    assert.deepStrictEqual(atRestart, {placed: true, recorded: true});
  } finally {
    dr.requestUpgrade = real;
    await n.reg.close();
  }
});

// the medium on B-shim-allow, 2 and 3: a shim not placed leaves no shim in
// the record (rollback would restore it); a busy one says what to do
test('a shim that cannot be placed clears the record\'s shim; a busy one says how to get the shared runtime back', async () => {
  const r = release(); const h = home();
  const n = await npmRelease(r, {shim: true});
  const si = require('../lib/shim-install');
  const realPlace = si.placeShim;
  const realPrepare = si.prepareShim;
  try {
    const io0 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io0, n.allow, n.fromNpm), 0, io0.err);
    assert.ok(record(h).shim != null, 'placed first');
    si.placeShim = () => { throw Object.assign(new Error('C:\\h\\shim\\ch-shim.previous could not be removed (EBUSY)'), {code: 'SHIM_BUSY'}); };
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, n.allow, n.fromNpm), 0, io.err);
    assert.strictEqual(record(h).shim, undefined, 'the record matches: no shim');
    assert.match(io.err, /the shared runtime's shim could not be replaced: a session still uses the old one\. Close that session \(or the client running it\), then run `.*install` to place the new one; until then each session runs its own runtime/);
    si.placeShim = realPlace;
    si.prepareShim = async () => ({status: 'failed', name: 'x', version: '0.5.0', error: Object.assign(new Error('the registry could not be reached'), {code: 'NPM_FETCH'})});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)}), n.allow, n.fromNpm), 0);
    assert.strictEqual(record(h).shim, undefined);
  } finally {
    si.placeShim = realPlace;
    si.prepareShim = realPrepare;
    await n.reg.close();
  }
});

// the medium on B-shim-allow, 7: a shim already at its pin, verified when it
// was placed, is not fetched again
test('a shim already at its pin is not fetched again', async () => {
  const r = release(); const h = home();
  const n = await npmRelease(r, {shim: true});
  try {
    const io0 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io0, n.allow, n.fromNpm), 0, io0.err);
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, n.allow, n.fromNpm), 0, io.err);
    assert.ok(!io.fetches.some((u) => /ch-shim/.test(u)), JSON.stringify(io.fetches.filter((u) => /shim/.test(u))));
    assert.ok(record(h).shim != null);
  } finally {
    await n.reg.close();
  }
});

// the medium on B-shim-allow's round 3: the shim step never throws past the
// app swap (a rejection that is no Error), and a shim judged current before
// the lock that changed meanwhile says to run install again
test('a shim prepared with no error object, or changed since it was judged current: said, set aside, the record names none', async () => {
  const r = release(); const h = home();
  const n = await npmRelease(r, {shim: true});
  const si = require('../lib/shim-install');
  const realPrepare = si.prepareShim;
  const realPlace = si.placeShim;
  try {
    si.prepareShim = async () => ({status: 'failed', name: 'x', version: '0.5.0', error: null});
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, n.allow, n.fromNpm), 0, io.err);
    assert.strictEqual(record(h).shim, undefined);
    assert.match(io.err, /the shared runtime's shim could not be installed/);
    si.prepareShim = async () => ({status: 'current', name: 'x', version: '0.5.0'});
    si.placeShim = () => { throw Object.assign(new Error('no longer the verified shim'), {code: 'SHIM_STALE'}); };
    const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io2, n.allow, n.fromNpm), 0, io2.err);
    assert.match(io2.err, /the shared runtime's shim in place changed while this install ran: run `.*install` again to place it/);
    assert.strictEqual(record(h).shim, undefined);
  } finally {
    si.prepareShim = realPrepare;
    si.placeShim = realPlace;
    await n.reg.close();
  }
});

// the medium's round 4: a real throw inside the shim step after a binary was
// placed: set aside, the record naming none, the install not failed
test('a throw inside the shim step after placing: the binary set aside, the record names none', async () => {
  const r = release(); const h = home();
  const n = await npmRelease(r, {shim: true});
  const si = require('../lib/shim-install');
  const realPlace = si.placeShim;
  const exe = process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim';
  try {
    si.placeShim = (homeDir) => {
      fs.mkdirSync(path.join(homeDir, 'shim'), {recursive: true});
      fs.writeFileSync(path.join(homeDir, 'shim', exe), 'placed');
      return null;   // what follows reads r.version: a TypeError
    };
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(), fetch: (url, opts) => globalThis.fetch(url, opts)});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, n.allow, n.fromNpm), 0, io.err);
    assert.strictEqual(record(h).shim, undefined);
    assert.strictEqual(fs.existsSync(path.join(h, 'shim', exe)), false, 'set aside');
    assert.match(io.err, /the shared runtime's shim could not be installed \(.+\); each session runs its own runtime/);
  } finally {
    si.placeShim = realPlace;
    await n.reg.close();
  }
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

// `install` with no --pack (the reviewer on the install hints, 2026-11-21):
// reinstalls exactly what the record lists, at this ch-local's pins, through
// install itself. It never adds a pack and never moves the home to another
// release than this ch-local's; with nothing installed, or an unreleased
// home, it says the full command; with no network, the --from line.
// this release, as the npm stub installs it (ch-local 0.2.0): a reinstall
// stays on the home's own release
const ours = (r) => ({...r.allow, release: {version: '0.2.0', security: null}});

test('install with no --pack: nothing installed is refused with the --pack line', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({from: r.from}, io, r.allow), 2);
  assert.match(io.err, /nothing is installed here, so there is nothing to reinstall: run `(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local install --pack <name>`/);
  assert.deepStrictEqual(fs.readdirSync(h), [], 'nothing written');
});

test('install with no --pack reinstalls what the record lists, at this release\'s pins, and adds no pack', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const before = record(h);
  // a module's files gone from the store, as the hints' "files are missing"
  const gone = path.join(h, 'module-store', '@countinghouse', 'ch-step-redact', '0.1.0');
  fs.rmSync(gone, {recursive: true, force: true});
  fs.rmSync(`${gone}.json`, {force: true});
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({from: r.from}, io2, ours(r)), 0, io2.err);
  assert.ok(fs.existsSync(gone), 'the missing module is back');
  const rec = record(h);
  assert.deepStrictEqual(Object.keys(rec.packs), ['ci-failure-triage'], 'only the recorded pack: "other", which the release lists, is not added');
  assert.deepStrictEqual(rec.packs['ci-failure-triage'].from, before.packs['ci-failure-triage'].from, 'this ch-local\'s own release, as before');
  assert.deepStrictEqual(rec.runtime.versions, before.runtime.versions, 'no move to another release');
});

test('install with no --pack on an unreleased home: refused with the full --from and --unreleased-pins line', async () => {
  const r = release(); const h = home();
  const allow = {...r.allow, pins: {}, runtime: {...r.allow.runtime, lockfile: null}};
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
  const f = pinsFile(r, {pins: r.pins, runtimeLockfile: r.lockfile});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, io, allow), 0, io.err);
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
  assert.strictEqual(await install({from: r.from}, io2, allow), 2);
  assert.match(io2.err, new RegExp(`this is an unreleased install \\(development only\\): reinstall it with \`${cmd(h, 'install --pack ci-failure-triage --from <release directory> --unreleased-pins <pins file>')}\`; nothing was installed`));
});

test('install with no --pack and no network: one line naming install --from, and why', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const nr = require('../lib/npm-release');
  const real = nr.fetchRelease;
  // (what lib/npm-fetch.js throws when the registry can't be reached)
  nr.fetchRelease = async () => { throw Object.assign(new Error('the packument of countinghouse could not be fetched (ENOTFOUND)'), {code: 'FETCH_FAILED', unreachable: true}); };
  try {
    const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
    // (a release with its identity, so the reinstall goes to npm)
    const {ALLOWLIST} = require('../lib/allowlist');
    assert.strictEqual(await install({}, io2, {...ours(r), self: ALLOWLIST.self}), 1);
    const lines = io2.err.trim().split('\n').filter((l) => /npm registry|--from/.test(l));
    assert.strictEqual(lines.length, 1, io2.err);
    assert.match(lines[0], new RegExp(`could not fetch this release from the npm registry \\(the packument of countinghouse could not be fetched \\(ENOTFOUND\\)\\); with no network, run \`${cmd(h, 'install --from <release directory>')}\`(?: \\(with COUNTINGHOUSE_HOME set to "[^"]+"\\))? with this release's tarballs \\(its packs', its runtime's and this machine's shim's\\); nothing was installed`));
  } finally {
    nr.fetchRelease = real;
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

test('an existing group-writable home: refused with the chmod line, nothing installed and nothing changed', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const r = release(); const h = home();
  fs.chmodSync(h, 0o775);
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 1);
  assert.strictEqual(fs.statSync(h).mode & 0o777, 0o775, 'not changed');
  assert.deepStrictEqual(fs.readdirSync(h), [], 'nothing installed');
  assert.ok(io.err.includes(`this home is group- or world-writable (mode 0775), so another user could change what runs from it; it may already have been changed: move it aside (\`mv "${fs.realpathSync.native(h)}" "${fs.realpathSync.native(h)}.suspect"\`) and install again`), io.err);
  assert.match(io.err, /nothing was installed/);
  // a path the command line can't quote safely: refused the same, with no line to paste
  const odd = path.join(home(), 'my$home');
  fs.mkdirSync(odd, {mode: 0o700});
  fs.chmodSync(odd, 0o777);
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: odd}, exec: npm()});
  assert.strictEqual(await run(r, io2), 1);
  // (a writable home may already have been changed: moved aside, never
  // trusted after a chmod: the reviewer's Fable high on #126, F2; with no
  // path to paste, said in words)
  assert.match(io2.err, /world-writable \(mode 0777\), so another user could change what runs from it; it may already have been changed: move it aside and install again\n/);
  assert.doesNotMatch(io2.err, /chmod|mv /);
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
    assert.strictEqual(fs.statSync(path.dirname(h)).mode & 0o777, 0o775, 'its parent as mkdir -p makes it: only the home is private');
    fs.chmodSync(h, 0o750);
    assert.strictEqual(ensureHome(h), false);
    assert.strictEqual(fs.statSync(h).mode & 0o777, 0o750, 'an existing home is not changed');
    const s = path.join(base, 'settings-home');
    withSettingsLock(layout({COUNTINGHOUSE_HOME: s}), () => 0);
    assert.strictEqual(fs.statSync(s).mode & 0o777, 0o700, 'settings\' first lock');
    // a umask that takes the owner's own bits: the mode is set whole after mkdir
    process.umask(0o200);
    const w = path.join(base, 'w-home');
    assert.strictEqual(ensureHome(w), true);
    assert.strictEqual(fs.statSync(w).mode & 0o777, 0o700);
    // a file written before install into a missing home (writeAtomic) makes it private too
    process.umask(0o002);
    const early = path.join(base, 'early-home');
    require('../lib/atomic').writeAtomic(path.join(early, 'x.json'), '{}');
    assert.strictEqual(fs.statSync(early).mode & 0o777, 0o700);
  } finally {
    process.umask(was);
  }
});

// the reviewer on #122's merge with #120: a home another user could write
// into is refused before anything is fetched or placed, the shim included
test('a group-writable home is refused before any fetch or shim step', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const r = release(); const h = home();
  fs.chmodSync(h, 0o775);
  const nr = require('../lib/npm-release');
  const si = require('../lib/shim-install');
  const real = {fetchRelease: nr.fetchRelease, prepareShim: si.prepareShim, placeShim: si.placeShim, setAside: si.setAside};
  const called = [];
  nr.fetchRelease = async () => { called.push('fetchRelease'); throw new Error('not here'); };
  si.prepareShim = async () => { called.push('prepareShim'); return null; };
  si.placeShim = () => { called.push('placeShim'); };
  si.setAside = () => { called.push('setAside'); return false; };
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io, r.allow), 1);
    assert.deepStrictEqual(called, []);
    assert.match(io.err, /this home is group- or world-writable \(mode 0775\), so another user could change what runs from it; it may already have been changed: move it aside \(`mv "/);
    assert.deepStrictEqual(fs.readdirSync(h), []);
  } finally {
    Object.assign(nr, {fetchRelease: real.fetchRelease});
    Object.assign(si, {prepareShim: real.prepareShim, placeShim: real.placeShim, setAside: real.setAside});
  }
});

// the medium on the install hints
test('install with no --pack: an unreadable record names install --pack, never itself (1)', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  fs.writeFileSync(path.join(h, 'modules.json'), '{"v": 2');
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({from: r.from}, io2, ours(r)), 1);
  assert.match(io2.err, new RegExp(`install a pack again with \`${cmd(h, 'install --pack <name>')}\`, which sets this record aside and starts a new one; nothing was installed`));
  assert.doesNotMatch(io2.err, new RegExp(`\`${cmd(h, 'install')}\` again`));
});

test('install with no --pack: a recorded pack this release does not list is said, not reinstalled (3)', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const without = {...ours(r), packs: {other: r.allow.packs.other}};
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({from: r.from}, io2, without), 0, io2.err);
  assert.match(io2.out + io2.err, /pack ci-failure-triage is not in this release, so it was not reinstalled/);
  assert.ok(!Object.keys(record(h).packs).includes('other'), '"other" is not added');
});

test('install with no --pack: a registry that answered (not unreachable) gets install\'s own line, never the no-network one (4)', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const nr = require('../lib/npm-release');
  const real = nr.fetchRelease;
  nr.fetchRelease = async () => { throw Object.assign(new Error('the registry answered 500 for the packument of countinghouse'), {code: 'FETCH_FAILED', package: 'countinghouse'}); };
  try {
    const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
    const {ALLOWLIST} = require('../lib/allowlist');
    assert.strictEqual(await install({}, io2, {...ours(r), self: ALLOWLIST.self}), 1);
    assert.doesNotMatch(io2.err, /no network/);
    assert.match(io2.err, /countinghouse: the registry answered 500/);
  } finally {
    nr.fetchRelease = real;
  }
});

test('install with no --pack never moves the home to another release: another ch-local than the home\'s is refused, with the home\'s own launcher (5)', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const before = fs.readFileSync(path.join(h, 'modules.json'), 'utf8');
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({from: r.from}, io2, {...r.allow, release: {version: '0.1.0', security: null}}), 2);
  assert.match(io2.err, new RegExp(`this home's ch-local is 0\\.2\\.0, and this one is 0\\.1\\.0: a reinstall stays on the home's own release; run \`${cmd(h, 'install')}\` \\(the home's own launcher\\), or \`${cmd(h, 'upgrade')}\` or \`${cmd(h, 'rollback')}\` to move it; nothing was installed`));
  assert.strictEqual(fs.readFileSync(path.join(h, 'modules.json'), 'utf8'), before, 'nothing changed');
});

// the reviewer's high on #124
test('install with no --pack: a record it can\'t read (permissions) names the file and its fix, never a command that can\'t fix it (high, 1)', {skip: (process.platform === 'win32' || process.getuid() === 0) && 'POSIX modes, not root'}, async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const file = path.join(h, 'modules.json');
  fs.chmodSync(file, 0o000);
  try {
    const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
    assert.strictEqual(await install({from: r.from}, io2, ours(r)), 1);
    assert.ok(io2.err.includes(`${file} is not readable (EACCES); make it readable by you again: check its owner and mode (\`ls -l "${file}"\`); nothing was installed`), io2.err);
    assert.doesNotMatch(io2.err, /install --pack|sets this record aside/);
    // the record's own advice says the same, wherever it is read
    assert.throws(() => require('../lib/module-record').readModulesRecord(layout({COUNTINGHOUSE_HOME: h})), (e) => e.code === 'RECORD_IO' && e.message.includes(`check its owner and mode (\`ls -l "${file}"\`)`));
  } finally {
    fs.chmodSync(file, 0o600);
  }
});

test('install with no --pack: an interrupted rollback says rollback, before the record is read (high, 2)', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  fs.writeFileSync(layout({COUNTINGHOUSE_HOME: h}).journal, '{}');
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({from: r.from}, io2, ours(r)), 1);
  assert.match(io2.err, new RegExp(`a rollback was interrupted; run \`${cmd(h, 'rollback')}\`(?: \\(with COUNTINGHOUSE_HOME set to "[^"]+"\\))? to finish it; nothing was installed`));
  assert.doesNotMatch(io2.err, /sets this record aside/);
});

test('install with no --pack from the home\'s own launcher, whose release the record does not name yet: it names the install that finishes it, never itself (high, 3)', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  // (the home's app is ch-local 0.3.0, its record still 0.2.0: an install that did not finish)
  const io2 = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()}), {selfVersion: '0.3.0'});
  assert.strictEqual(await install({from: r.from}, io2, {...r.allow, release: {version: '0.3.0', security: null}}), 2);
  assert.match(io2.err, new RegExp(`this home's record names release 0\\.2\\.0, but its launcher is ch-local 0\\.3\\.0: an install or upgrade did not finish; run \`${cmd(h, 'install --pack ci-failure-triage')}\` to finish it; nothing was installed`));
});

// the reviewer's pre-work high (A-home-check, 4): on Windows too, a home
// install makes is private (a protected DACL: makePrivateDirs), and an
// existing one another user could change is refused (with ACLs given)
test('Windows: install makes a new home private, and refuses an existing one another user could change (ACLs given)', () => {
  const {ensureHome} = require('../lib/home');
  const {unsafeHomeLine} = require('../lib/install');
  const made = [];
  const h = path.join(home(), 'new-home');
  const ME0 = 'S-1-5-21-1-2-3-1001';
  const PRIVATE0 = {user: ME0, owner: ME0, otherAces: false, rules: [{sid: ME0, rights: 2032127, type: 'Allow', inheritOnly: false}]};
  assert.strictEqual(ensureHome(h, 'win32', {makePrivateDirs: (dirs, read) => { made.push([dirs, read]); return [PRIVATE0]; }}), true);
  // (read is never empty: makePrivateDirs refuses an empty list)
  assert.deepStrictEqual(made, [[[h], [h]]], 'made private as it is made, its ACL read back');
  const ME = 'S-1-5-21-1-2-3-1001';
  const OPEN = {user: ME, owner: ME, otherAces: false, rules: [{sid: 'S-1-1-0', rights: 1245631, type: 'Allow', inheritOnly: false}]};
  const PRIVATE = {user: ME, owner: ME, otherAces: false, rules: [{sid: ME, rights: 2032127, type: 'Allow', inheritOnly: false}]};
  assert.strictEqual(unsafeHomeLine(h, 'win32', {fileAcl: () => PRIVATE}), null);
  assert.match(String(unsafeHomeLine(h, 'win32', {fileAcl: () => OPEN})), /^this home is accessible by S-1-1-0, so another user could change what runs from it; make it a folder only you can change: icacls /);
});

// ... and on Windows itself, the real DACL (the medium on A-home-check, 1:
// a stub hid makePrivateDirs refusing an empty list)
test('Windows: a home install makes is private by its real DACL', {skip: process.platform !== 'win32' && 'Windows only'}, () => {
  const {ensureHome} = require('../lib/home');
  const winAcl = require('../lib/win-acl');
  const h = path.join(home(), 'made-home');
  assert.strictEqual(ensureHome(h), true);
  assert.strictEqual(winAcl.privateProblem('it', winAcl.fileAcl(h), {directory: true}), null);
});

// the reviewer's high on #126, H1: a home another user could change has none
// of its code run, by install, add-pack, status, settings or add-module.
// install checks the home first, and every require from <home>/app (the
// ceiling's reader, the module-settings reader) checks it before it loads
const planted = (h) => {
  const lib = path.join(h, 'app', 'node_modules', 'countinghouse', 'lib');
  fs.mkdirSync(lib, {recursive: true});
  const marker = path.join(path.dirname(h), `${path.basename(h)}-marker`);
  for (const f of ['settings-ceiling.js', 'module-settings.js']) fs.writeFileSync(path.join(lib, f), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); module.exports = {};`);
  return marker;
};
test('install, add-pack and the readers of <home>/app run none of a home\'s code when another user could change it (high H1)', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const r = release(); const h = path.join(home(), 'open');
  fs.mkdirSync(h, {mode: 0o700});
  const marker = planted(h);
  fs.chmodSync(h, 0o777);
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, r.allow), 1);
  assert.match(io.err, /so another user could change what runs from it/);
  assert.ok(!fs.existsSync(marker), 'install ran none of the home\'s code');
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  await require('../lib/packs-command').addPack({pack: 'other', from: r.from}, io2, r.allow);
  assert.ok(!fs.existsSync(marker), 'add-pack ran none of it');
  const where = layout({COUNTINGHOUSE_HOME: h});
  const c = require('../lib/ceiling').ceilingFor(where, {platform: process.platform, env: {}});
  assert.strictEqual(c.state, 'untrusted', JSON.stringify(c));
  assert.match(c.problem, /so another user could change what runs from it/);
  // (said as the home's problem, never an operator ceiling's: the medium on the round, 2)
  const refusal = require('../lib/ceiling').ceilingRefusal(c, 'autoUpgrade', true);
  assert.match(String(refusal && refusal.message), /^this home can't be used: /);
  assert.doesNotMatch(String(refusal && refusal.message), /operator's ceiling file/);
  assert.throws(() => require('../lib/module-values').planModuleSetting(where, io2, 'ch-step-redact.x', '1'), (e) => /so another user could change what runs from it/.test(e.message));
  assert.ok(!fs.existsSync(marker), 'the readers loaded none of it');
});

test('a home must be private: one open to group or others (0755, as an older install or a umask of 0022 leaves it) is refused, with chmod 700 (high M2)', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const {homeOpenProblem} = require('../lib/home');
  const h = home();
  fs.chmodSync(h, 0o755);
  const p = homeOpenProblem(h);
  assert.ok(p != null, 'refused');
  assert.match(p.why, /^it is open to group or others \(mode 0755\), and its folders may be too$/);
  assert.strictEqual(p.fix, `run \`chmod 700 "${fs.realpathSync.native(h)}"\``);
  // (a path that can't be read is refused, never taken as no home: L4)
  const f = path.join(home(), 'a-file');
  fs.writeFileSync(f, 'x');
  assert.ok(homeOpenProblem(path.join(f, 'home')) != null, 'ENOTDIR is refused');
  assert.strictEqual(homeOpenProblem(path.join(home(), 'none-yet')), null, 'a home not there yet is not refused');
});

test('install writes its launcher 0600, even over an older 0664 one (high L6)', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const launcher = layout({COUNTINGHOUSE_HOME: h}).launcher;
  fs.chmodSync(launcher, 0o664);
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io2), 0, io2.err);
  assert.strictEqual(fs.statSync(launcher).mode & 0o777, 0o600);
});

test('Windows: a new home whose DACL is not private after makePrivateDirs is refused (high L5)', () => {
  const {ensureHome} = require('../lib/home');
  const ME = 'S-1-5-21-1-2-3-1001';
  const OPEN = {user: ME, owner: ME, otherAces: false, rules: [{sid: 'S-1-1-0', rights: 1245631, type: 'Allow', inheritOnly: false}]};
  assert.throws(() => ensureHome(path.join(home(), 'h2'), 'win32', {makePrivateDirs: () => [OPEN]}), /could not be made private: it is accessible by S-1-1-0/);
});

// the medium on #126's round, 1: a first install is held to the folders it
// would make the home under, before anything is made
test('a first install under a folder another user could write in is refused, and makes nothing', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const r = release();
  const os = require('node:os');
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-first-above-')));
  fs.chmodSync(parent, 0o777);
  try {
    const h = path.join(parent, 'new-home');
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, r.allow), 1);
    assert.match(io.err, /is under .*, and group or others can write in it \(mode 777\); another user could move the home away/);
    assert.ok(!fs.existsSync(h), 'no home made');
  } finally {
    fs.chmodSync(parent, 0o700);
    fs.rmSync(parent, {recursive: true, force: true});
  }
});

// the reviewer's Fable high on #126
test('Windows: a new home that is not empty once its DACL is set is refused (F4)', () => {
  const {ensureHome} = require('../lib/home');
  const ME = 'S-1-5-21-1-2-3-1001';
  const PRIVATE = {user: ME, owner: ME, otherAces: false, rules: [{sid: ME, rights: 2032127, type: 'Allow', inheritOnly: false}]};
  const h = path.join(home(), 'planted');
  assert.throws(() => ensureHome(h, 'win32', {makePrivateDirs: ([d]) => { fs.writeFileSync(path.join(d, 'planted.js'), 'x'); return [PRIVATE]; }}), /is not empty/);
});

test('install replaces a launcher that is a link, never writing through it (F8)', {skip: process.platform === 'win32' && 'links need privileges on Windows'}, async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  const launcher = layout({COUNTINGHOUSE_HOME: h}).launcher;
  const elsewhere = path.join(home(), 'target.js');
  fs.writeFileSync(elsewhere, 'untouched');
  fs.rmSync(launcher);
  fs.symlinkSync(elsewhere, launcher);
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io2), 0, io2.err);
  assert.ok(!fs.lstatSync(launcher).isSymbolicLink(), 'a file now');
  assert.strictEqual(fs.readFileSync(elsewhere, 'utf8'), 'untouched');
});

test('fixHint on a folder grants inheritable full control, so its own files stay reachable (F13)', () => {
  const {fixHint} = require('../lib/win-acl');
  const acl = {user: 'S-1-5-21-1-2-3-1001', owner: 'S-1-5-21-1-2-3-1001', rules: [{sid: 'S-1-1-0'}]};
  assert.match(fixHint('C:\\h', acl, {directory: true}), /\*S-1-5-21-1-2-3-1001:\(OI\)\(CI\)F \*S-1-5-18:\(OI\)\(CI\)F/);
  assert.match(fixHint('C:\\h\\f', acl), /\*S-1-5-21-1-2-3-1001:F \*S-1-5-18:F/);
});

test('only lib/ceiling.js says "the operator\'s ceiling file": an open home is said as the home\'s (F7)', () => {
  const lib = path.join(__dirname, '..', 'lib');
  const found = fs.readdirSync(lib).filter((f) => f.endsWith('.js') && f !== 'ceiling.js' && /the operator's ceiling file \$\{/.test(fs.readFileSync(path.join(lib, f), 'utf8')));
  assert.deepStrictEqual(found, []);
});

test('a home path that is a file is "not a directory", with no fix that fits a folder (the medium on round 2, 8)', {skip: process.platform === 'win32' && 'POSIX modes'}, () => {
  const {homeOpenProblem} = require('../lib/home');
  const f = path.join(home(), 'file-home');
  fs.writeFileSync(f, 'x');
  for (const mode of [0o666, 0o644]) {
    fs.chmodSync(f, mode);
    assert.deepStrictEqual(homeOpenProblem(f), {why: 'it is not a directory', fix: null}, mode.toString(8));
  }
});
