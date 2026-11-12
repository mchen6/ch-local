'use strict';
// ch-local install --pack <name> --from <dir>: the allowlisted tarballs at
// their pinned versions and integrity into <home>/app, by npm ci from a
// generated package.json and lockfile. npm is stubbed through io.exec.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {ALLOWLIST} = require('../lib/allowlist');
const {fakeIo, tmp} = require('./fake-io');

const integrityOf = (bytes) => 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
const PACKAGES = [['@countinghouse/ch-local', '0.2.0', 'countinghouse-ch-local-0.2.0.tgz'], ['@countinghouse/ch-step-redact', '0.1.0', 'countinghouse-ch-step-redact-0.1.0.tgz'], ['countinghouse', '7.2.0', 'countinghouse-7.2.0.tgz']];

// A tarball directory and an allowlist pinning exactly its bytes.
function setup() {
  const from = tmp('ch-tarballs-');
  const home = tmp('ch-home-');
  const pins = {};
  for (const [name, version, file] of PACKAGES) {
    const bytes = Buffer.from(`fake tarball of ${name}@${version}`);
    fs.writeFileSync(path.join(from, file), bytes);
    pins[name] = {version, integrity: integrityOf(bytes)};
  }
  const allow = {packs: {'ci-failure-triage': {packages: PACKAGES.map(([n]) => n), credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']}}, pins};
  return {from, home, allow, done: () => { fs.rmSync(from, {recursive: true, force: true}); fs.rmSync(home, {recursive: true, force: true}); }};
}

// npm as the stub sees it: the lock step writes a lockfile, ci installs the launcher.
const npm = (version = '0.2.0') => (cmd, args, {cwd}) => {
  if (args.includes('--package-lock-only')) fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{"lockfileVersion": 3}\n');
  if (args.includes('ci')) {
    const dir = path.join(cwd, 'node_modules', '@countinghouse', 'ch-local');
    fs.mkdirSync(path.join(dir, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: '@countinghouse/ch-local', version}));
    fs.writeFileSync(path.join(dir, 'bin', 'ch-local.js'), '');
  }
  return {status: 0, stdout: '', stderr: ''};
};

const run = (s, io, args = {}) => install({pack: 'ci-failure-triage', from: s.from, ...args}, io, s.allow);

test('install writes app/package.json with exact versions and runs npm ci', async () => {
  const s = setup();
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, exec: npm()});
    assert.strictEqual(await run(s, io), 0, io.err);
    const app = path.join(s.home, 'app');
    const pkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.private, true);
    assert.deepStrictEqual(pkg.dependencies, Object.fromEntries(PACKAGES.map(([n, , f]) => [n, `file:tarballs/${f}`])));
    assert.deepStrictEqual(pkg.chLocal, {pack: 'ci-failure-triage', versions: Object.fromEntries(PACKAGES.map(([n, v]) => [n, v]))});
    for (const [, , f] of PACKAGES) assert.ok(fs.existsSync(path.join(app, 'tarballs', f)), f);
    assert.ok(fs.existsSync(path.join(app, 'package-lock.json')), 'the lockfile');
    assert.deepStrictEqual(io.execs.map((e) => e.args.slice(1)), [
      ['install', '--package-lock-only', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'],
      ['ci', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund']
    ]);
    assert.ok(io.execs.every((e) => e.cmd === io.node && /npm-cli\.js$/.test(e.args[0])), 'npm runs as node npm-cli.js, no shell');
    assert.ok(!fs.existsSync(path.join(s.home, 'app.new')), 'no build directory left');
  } finally {
    s.done();
  }
});

test('install writes the installed command at <home>/bin/ch-local.js, running the installed launcher', async () => {
  const s = setup();
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, exec: npm()});
    assert.strictEqual(await run(s, io), 0, io.err);
    const shim = fs.readFileSync(path.join(s.home, 'bin', 'ch-local.js'), 'utf8');
    assert.ok(shim.includes(JSON.stringify(path.join(s.home, 'app', 'node_modules', '@countinghouse', 'ch-local', 'bin', 'ch-local.js'))));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.home, 'installed.json'), 'utf8')).pack, 'ci-failure-triage');
  } finally {
    s.done();
  }
});

test('install from tarballs refuses a package not on the allowlist', async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.from, 'countinghouse-ch-evil-1.0.0.tgz'), 'evil');
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, exec: npm()});
    assert.strictEqual(await run(s, io), 1);
    assert.match(io.err, /countinghouse-ch-evil-1\.0\.0\.tgz is not on this launcher's allowlist/);
    assert.deepStrictEqual(io.execs, []);
    assert.ok(!fs.existsSync(path.join(s.home, 'app')));
  } finally {
    s.done();
  }
});

test('install refuses a tarball whose integrity differs', async () => {
  const s = setup();
  try {
    fs.appendFileSync(path.join(s.from, 'countinghouse-ch-step-redact-0.1.0.tgz'), 'tampered');
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, exec: npm()});
    assert.strictEqual(await run(s, io), 1);
    assert.match(io.err, /@countinghouse\/ch-step-redact@0\.1\.0: the tarball's integrity is not the pinned one/);
    assert.deepStrictEqual(io.execs, []);
  } finally {
    s.done();
  }
});

test('a pinned package missing from the directory is named, nothing installed', async () => {
  const s = setup();
  try {
    fs.rmSync(path.join(s.from, 'countinghouse-7.2.0.tgz'));
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, exec: npm()});
    assert.strictEqual(await run(s, io), 1);
    assert.match(io.err, /countinghouse@7\.2\.0: no countinghouse-7\.2\.0\.tgz in /);
    assert.deepStrictEqual(io.execs, []);
  } finally {
    s.done();
  }
});

test('a failing npm leaves the previous install in place', async () => {
  const s = setup();
  try {
    fs.mkdirSync(path.join(s.home, 'app'), {recursive: true});
    fs.writeFileSync(path.join(s.home, 'app', 'marker'), 'previous');
    const failing = (cmd, args, opts) => (args.includes('ci') ? {status: 1, stdout: '', stderr: 'npm ERR! network'} : npm()(cmd, args, opts));
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, exec: failing});
    assert.strictEqual(await run(s, io), 1);
    assert.match(io.err, /npm ci failed/);
    assert.match(io.err, /npm ERR! network/);
    assert.strictEqual(fs.readFileSync(path.join(s.home, 'app', 'marker'), 'utf8'), 'previous');
    assert.ok(!fs.existsSync(path.join(s.home, 'app.new')));
  } finally {
    s.done();
  }
});

test('an installed launcher whose version is not the pinned one is refused', async () => {
  const s = setup();
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, exec: npm('9.9.9')});
    assert.strictEqual(await run(s, io), 1);
    assert.match(io.err, /installed @countinghouse\/ch-local is 9\.9\.9, not the pinned 0\.2\.0/);
    assert.ok(!fs.existsSync(path.join(s.home, 'app')));
  } finally {
    s.done();
  }
});

test('install names which credential variables are set and which are missing, never a value', async () => {
  const s = setup();
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home, GITHUB_TOKEN: 'secret-value-123'}, exec: npm()});
    assert.strictEqual(await run(s, io), 0, io.err);
    assert.match(io.out, /GITHUB_TOKEN is set/);
    assert.match(io.out, /COUNTINGHOUSE_GITHUB_TOKEN is not set/);
    assert.ok(!(io.out + io.err).includes('secret-value-123'));
  } finally {
    s.done();
  }
});

test('an unknown pack, or no --from, is refused before anything is read', async () => {
  const s = setup();
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}});
    assert.strictEqual(await install({pack: 'nope', from: s.from}, io, s.allow), 2);
    assert.match(io.err, /unknown pack "nope"; one of: ci-failure-triage/);
    const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}});
    assert.strictEqual(await install({pack: 'ci-failure-triage'}, io2, s.allow), 2);
    assert.match(io2.err, /installing from npm arrives with the first release; pass --from <directory of tarballs>/);
    assert.deepStrictEqual([...io.execs, ...io2.execs, ...io.fetches, ...io2.fetches], []);
  } finally {
    s.done();
  }
});

test('this launcher pins no release yet, and says so', async () => {
  assert.deepStrictEqual(Object.keys(ALLOWLIST.packs), ['ci-failure-triage']);
  assert.ok(ALLOWLIST.packs['ci-failure-triage'].packages.includes('@countinghouse/ch-local'));
  const s = setup();
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}});
    assert.strictEqual(await install({pack: 'ci-failure-triage', from: s.from}, io), 1);
    assert.match(io.err, /no release of the pack "ci-failure-triage" is pinned in this ch-local yet/);
  } finally {
    s.done();
  }
});
