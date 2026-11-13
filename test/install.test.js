'use strict';
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
const {release, npm, pkgDir, record, RUNTIME} = require('./install-helpers');

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
  assert.deepStrictEqual(io.execs.map((e) => e.args.slice(1)), [['ci', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund']]);
  assert.ok(io.execs.every((e) => e.cmd === io.node && /npm-cli\.js$/.test(e.args[0])), 'npm runs as node npm-cli.js, no shell');
  assert.ok(!fs.existsSync(path.join(h, 'app.new')), 'no build directory left');
});

test('install unpacks the pack\'s packages into app/node_modules and records them in packs.json', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  for (const name of TRIAGE) assert.strictEqual(JSON.parse(fs.readFileSync(path.join(pkgDir(h, name), 'package.json'), 'utf8')).name, name);
  assert.ok(fs.existsSync(path.join(pkgDir(h, TRIAGE[0]), 'lib', 'index.js')));
  const rec = record(h);
  assert.deepStrictEqual(rec.runtime.versions, Object.fromEntries(RUNTIME));
  assert.deepStrictEqual(rec.packs, {'ci-failure-triage': {packages: Object.fromEntries(TRIAGE.map((n) => [n, '0.1.0'])), credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']}});
  assert.strictEqual(rec.unreleased, false);
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

test('install names which credential variables are set and which are missing, never a value', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, GITHUB_TOKEN: 'secret-value-123'}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  assert.match(io.out, /GITHUB_TOKEN is set/);
  assert.match(io.out, /COUNTINGHOUSE_GITHUB_TOKEN is not set/);
  assert.ok(!(io.out + io.err).includes('secret-value-123'));
});

test('a reinstall replaces the app: another pack in the record is dropped, and install says so', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, io), 0, io.err);
  await require('../lib/packs-command').addPack({pack: 'other', from: r.from}, io, r.allow);
  const again = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm()});
  assert.strictEqual(await run(r, again), 0, again.err);
  assert.deepStrictEqual(Object.keys(record(h).packs), ['ci-failure-triage']);
  assert.match(again.out, /the pack "other" was dropped; add it again with `ch-local add-pack other`/);
  assert.ok(!fs.existsSync(pkgDir(h, '@countinghouse/ch-pack-other')));
});

test('an unknown pack, or no --from, is refused before anything is read', async () => {
  const r = release(); const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}});
  assert.strictEqual(await install({pack: 'nope', from: r.from}, io, r.allow), 2);
  assert.match(io.err, /unknown pack "nope"; one of: ci-failure-triage, other/);
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}});
  assert.strictEqual(await install({pack: 'ci-failure-triage'}, io2, r.allow), 2);
  assert.match(io2.err, /installing from npm arrives with the first release; pass --from <directory of tarballs>/);
  assert.deepStrictEqual([...io.execs, ...io2.execs, ...io.fetches, ...io2.fetches], []);
});

test('this launcher pins no release yet, and says so; its runtime is ch-local and countinghouse', async () => {
  assert.deepStrictEqual(ALLOWLIST.runtime.packages, ['@countinghouse/ch-local', 'countinghouse']);
  assert.deepStrictEqual(Object.keys(ALLOWLIST.packs), ['ci-failure-triage']);
  const triage = ALLOWLIST.packs['ci-failure-triage'].packages;
  assert.strictEqual(triage[0], '@countinghouse/ch-pack-ci-failure-triage', 'the scenario first');
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
const pinsFile = (r, body) => { const f = path.join(tmp('ch-pins-'), 'pins.json'); fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body)); return f; };

test('--unreleased-pins installs with its pins and lockfile, records the home as unreleased and says so', async () => {
  const r = release(); const h = home();
  const allow = {...r.allow, pins: {}, runtime: {...r.allow.runtime, lockfile: null}};
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}, exec: npm()});
  const f = pinsFile(r, {pins: r.pins, runtimeLockfile: r.lockfile});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: f}, io, allow), 0, io.err);
  assert.strictEqual(record(h).unreleased, true);
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
  const good = {'node_modules/@countinghouse/ch-local': {version: '0.2.0', resolved: 'file:tarballs/countinghouse-ch-local-0.2.0.tgz'},
    'node_modules/countinghouse': {version: '8.0.0', resolved: 'file:tarballs/countinghouse-8.0.0.tgz'},
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
    assert.match(io.err, /--unreleased-pins .*runtimeLockfile/, why);
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
    assert.match(io.err, /runtimeLockfile must be an npm v3 lockfile/);
  }
});

test('--unreleased-pins: a runtime package\'s lockfile version and integrity must be its pin\'s; a bundled dependency needs no URL; a link is refused', async () => {
  const r = release();
  const ch = 'node_modules/countinghouse';
  const cases = [
    [{[ch]: {...r.lockfile.packages[ch], version: '9.9.9'}}, 2, /version 9\.9\.9/],
    [{[ch]: {...r.lockfile.packages[ch], integrity: r.pins['@countinghouse/ch-local'].integrity}}, 2, /integrity/],
    [{'node_modules/left-pad/node_modules/inner': {version: '1.0.0', inBundle: true}}, 0, null],
    [{'node_modules/linked': {resolved: '../elsewhere', link: true}}, 2, /linked/]
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
