'use strict';
// Many packs in one home (plan Task 12b; reviewer, 2026-11-12): add-pack,
// remove-pack and status, over a home that install made.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {addPack, removePack, status} = require('../lib/packs-command');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm, pkgDir, record} = require('./install-helpers');

async function installed(r = release(), env = {}) {
  const home = tmp('ch-home-');
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: home, ...env}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, r.allow), 0, io.err);
  return {home, r, io: (more = {}) => fakeIo({env: {COUNTINGHOUSE_HOME: home, ...env, ...more}, exec: npm()})};
}

test('add-pack installs a second pack beside the first and shares an installed part at the pinned version', async () => {
  const s = await installed();
  const io = s.io();
  const before = fs.statSync(path.join(pkgDir(s.home, '@countinghouse/ch-step-redact'), 'package.json')).mtimeMs;
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, io, s.r.allow), 0, io.err);
  for (const name of ['@countinghouse/ch-pack-other', '@countinghouse/ch-step-other']) assert.ok(fs.existsSync(path.join(pkgDir(s.home, name), 'package.json')), name);
  assert.strictEqual(fs.statSync(path.join(pkgDir(s.home, '@countinghouse/ch-step-redact'), 'package.json')).mtimeMs, before, 'the shared part is not unpacked again');
  assert.deepStrictEqual(Object.keys(record(s.home).packs), ['ci-failure-triage', 'other']);
  assert.deepStrictEqual(record(s.home).packs.other.packages, {'@countinghouse/ch-pack-other': '0.3.0', '@countinghouse/ch-step-redact': '0.1.0', '@countinghouse/ch-step-other': '0.2.0'});
  assert.match(io.out, /shares @countinghouse\/ch-step-redact/);
  assert.deepStrictEqual(io.execs, [], 'no npm: packs are unpacked');
});

test('add-pack refuses a pack the release does not pin', async () => {
  const s = await installed();
  const io = s.io();
  assert.strictEqual(await addPack({pack: 'nope', from: s.r.from}, io, s.r.allow), 2);
  assert.match(io.err, /the pack "nope" is not in this ch-local release's allowlist/);
  const unpinned = {...s.r.allow, pins: {...s.r.allow.pins}};
  delete unpinned.pins['@countinghouse/ch-step-other'];
  const io2 = s.io();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, io2, unpinned), 1);
  assert.match(io2.err, /no release of the pack "other" is pinned/);
  assert.ok(!fs.existsSync(pkgDir(s.home, '@countinghouse/ch-pack-other')));
});

test('add-pack refuses a part installed at another version, saying to upgrade, and adds nothing', async () => {
  const s = await installed();
  const newer = release({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
  const io = s.io();
  assert.strictEqual(await addPack({pack: 'other', from: newer.from}, io, newer.allow), 1);
  assert.match(io.err, /@countinghouse\/ch-step-redact is installed at 0\.1\.0, but this release pins 0\.2\.0 for "other"; install the newer release/);
  assert.ok(!fs.existsSync(pkgDir(s.home, '@countinghouse/ch-pack-other')));
  assert.deepStrictEqual(Object.keys(record(s.home).packs), ['ci-failure-triage']);
});

test('add-pack touches no client file', async () => {
  const user = tmp('ch-user-');
  const cursor = path.join(user, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(cursor), {recursive: true});
  const bytes = '{"mcpServers": {"countinghouse": {"command": "node", "args": ["x", "start", "--stdio"]}}}\n';
  fs.writeFileSync(cursor, bytes);
  const s = await installed();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, homedir: user, exec: npm()});
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, io, s.r.allow), 0, io.err);
  assert.strictEqual(fs.readFileSync(cursor, 'utf8'), bytes);
  assert.deepStrictEqual(fs.readdirSync(user), ['.cursor']);
});

test('add-pack refuses a package with npm dependencies and leaves the home as it was', async () => {
  const s = await installed();
  const bad = release({extra: {'@countinghouse/ch-step-other': {dependencies: {'left-pad': '1.3.0'}}}});
  const io = s.io();
  assert.strictEqual(await addPack({pack: 'other', from: bad.from}, io, bad.allow), 1);
  assert.match(io.err, /ch-step-other declares npm dependencies/);
  for (const name of ['@countinghouse/ch-pack-other', '@countinghouse/ch-step-other']) assert.ok(!fs.existsSync(pkgDir(s.home, name)), name);
  assert.ok(!fs.readdirSync(path.join(s.home, 'app', 'node_modules')).some((n) => n.startsWith('.ch-local')), 'no staging left');
  assert.deepStrictEqual(Object.keys(record(s.home).packs), ['ci-failure-triage']);
});

test('add-pack before any install says to install first; an installed pack is left alone', async () => {
  const r = release();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: tmp('ch-home-')}});
  assert.strictEqual(await addPack({pack: 'other', from: r.from}, io, r.allow), 1);
  assert.match(io.err, /nothing is installed yet; run `ch-local install --pack other/);
  const s = await installed();
  const again = s.io();
  assert.strictEqual(await addPack({pack: 'ci-failure-triage', from: s.r.from}, again, s.r.allow), 0);
  assert.match(again.out, /already installed/);
});

test('remove-pack keeps a part another pack calls and removes one no pack calls', async () => {
  const s = await installed();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.io(), s.r.allow), 0);
  const io = s.io();
  assert.strictEqual(await removePack({pack: 'other'}, io), 0, io.err);
  assert.ok(!fs.existsSync(pkgDir(s.home, '@countinghouse/ch-pack-other')));
  assert.ok(!fs.existsSync(pkgDir(s.home, '@countinghouse/ch-step-other')));
  assert.ok(fs.existsSync(pkgDir(s.home, '@countinghouse/ch-step-redact')), 'ci-failure-triage still calls it');
  assert.match(io.out, /kept @countinghouse\/ch-step-redact/);
  assert.deepStrictEqual(Object.keys(record(s.home).packs), ['ci-failure-triage']);
  const io2 = s.io();
  assert.strictEqual(await removePack({pack: 'other'}, io2), 1);
  assert.match(io2.err, /the pack "other" is not installed/);
});

test('status lists each pack with its tools and names a pack\'s missing variables, never a value', async () => {
  const s = await installed();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.io(), s.r.allow), 0);
  const io = s.io({GITHUB_TOKEN: 'secret'});
  assert.strictEqual(await status({}, io), 0, io.err);
  assert.match(io.out, /^ci-failure-triage 0\.1\.0\n  tools: ci_failure_triage\n  credential: GITHUB_TOKEN\n/m);
  assert.match(io.out, /^other 0\.3\.0\n  tools: ch_pack_other\n  not loaded: set OTHER_TOKEN in the environment/m);
  assert.ok(!(io.out + io.err).includes('secret'));
  assert.ok(!/hidden/.test(io.out), 'an action without a description is not a tool');
});

test('status, add-pack and every start of an unreleased home say so in one stderr line', async () => {
  const r = release();
  const home = tmp('ch-home-');
  const pins = path.join(tmp('ch-pins-'), 'pins.json');
  fs.writeFileSync(pins, JSON.stringify({pins: r.pins, runtimeLockfile: r.lockfile}));
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: home, CH_LOCAL_DEV: '1'}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from, unreleasedPins: pins}, io, {...r.allow, pins: {}}), 0, io.err);
  const add = fakeIo({env: {COUNTINGHOUSE_HOME: home}});
  assert.strictEqual(await addPack({pack: 'other', from: r.from}, add, r.allow), 0, add.err);
  assert.strictEqual(record(home).unreleased, true, 'a released add-pack does not make the home released');
  const st = fakeIo({env: {COUNTINGHOUSE_HOME: home}});
  await status({}, st);
  for (const f of [add, st]) assert.strictEqual(f.err.split('\n').filter((l) => /unreleased/.test(l)).length, 1);
});

// /code-review medium on PR 2.
test('a pack name that is an Object.prototype key is simply not installed', async () => {
  const s = await installed();
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const io = s.io();
    assert.strictEqual(await removePack({pack: name}, io), 1, name);
    assert.match(io.err, /is not installed/);
  }
  const r = release();
  const io = s.io();
  assert.strictEqual(await addPack({pack: 'constructor', from: r.from}, io, r.allow), 2);
  assert.match(io.err, /not in this ch-local release's allowlist/);
});

test('status says a pack that needs no credential is loaded, as start does', async () => {
  const r = release();
  r.allow.packs['ci-failure-triage'].credentials = [];
  const s = await installed(r);
  const io = s.io();
  await status({}, io);
  assert.match(io.out, /ci-failure-triage 0\.1\.0\n  tools: ci_failure_triage\n  credential: none needed\n/);
  assert.ok(!/set  in/.test(io.out));
});

test('add-pack refuses pins whose runtime is not the installed one', async () => {
  const s = await installed();
  const other = release();
  const pins = path.join(tmp('ch-pins-'), 'pins.json');
  const runtimePins = {...other.pins, countinghouse: {...other.pins.countinghouse, version: '9.0.0'}};
  // A consistent pins file for a newer runtime: its lockfile resolves countinghouse 9.0.0 too.
  const lockfile = JSON.parse(JSON.stringify(other.lockfile));
  lockfile.packages['node_modules/countinghouse'] = {version: '9.0.0', resolved: 'file:tarballs/countinghouse-9.0.0.tgz'};
  fs.writeFileSync(pins, JSON.stringify({pins: runtimePins, runtimeLockfile: lockfile}));
  const io = s.io({CH_LOCAL_DEV: '1'});
  assert.strictEqual(await addPack({pack: 'other', from: other.from, unreleasedPins: pins}, io, other.allow), 1);
  assert.match(io.err, /pins countinghouse 9\.0\.0, but the installed runtime is 8\.0\.0/);
  assert.ok(!fs.existsSync(pkgDir(s.home, '@countinghouse/ch-pack-other')));
});

test('a part at another version names a way forward that exists: a clean install from the newer release, then add-pack', async () => {
  const s = await installed();
  const newer = release({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
  const io = s.io();
  assert.strictEqual(await addPack({pack: 'other', from: newer.from}, io, newer.allow), 1);
  assert.match(io.err, /install the newer release with `ch-local install --pack ci-failure-triage --from <its directory>`, then add-pack other/);
});

test('remove-pack records the removal first, so a package that cannot be deleted leaves start working, and says what is left', async () => {
  const s = await installed();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.io(), s.r.allow), 0);
  const real = fs.rmSync;
  try {
    fs.rmSync = (p, o) => { if (String(p).endsWith('ch-pack-other')) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return real(p, o); };
    const io = s.io();
    assert.strictEqual(await removePack({pack: 'other'}, io), 1);
    assert.match(io.err, /could not delete .*ch-pack-other \(EBUSY\)/);
  } finally {
    fs.rmSync = real;
  }
  assert.deepStrictEqual(Object.keys(record(s.home).packs), ['ci-failure-triage'], 'the record no longer lists it');
  assert.ok(!fs.existsSync(pkgDir(s.home, '@countinghouse/ch-step-other')), 'the rest went');
});

test('a home made by an earlier development launcher (installed.json only) is told to reinstall', async () => {
  const home = tmp('ch-home-');
  fs.writeFileSync(path.join(home, 'installed.json'), JSON.stringify({pack: 'ci-failure-triage', versions: {}, credentials: []}));
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: home}});
  assert.strictEqual(await status({}, io), 1);
  assert.match(io.out + io.err, /made by an earlier development ch-local; run `ch-local install --pack ci-failure-triage --from <dir>` again/);
});

// The reviewer's high review of #5.
test('install, add-pack and remove-pack hold the home\'s lock: a live holder stops them, a dead one is cleared', async () => {
  const s = await installed();
  const lock = path.join(s.home, 'packs.lock');
  fs.writeFileSync(lock, JSON.stringify({pid: process.pid, host: require('../lib/lock').lockHost(), at: new Date().toISOString()}));
  const io = s.io();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, io, s.r.allow), 1);
  assert.match(io.err, new RegExp(`another ch-local \\(pid ${process.pid}\\) is changing this home`));
  const io2 = s.io();
  assert.strictEqual(await removePack({pack: 'ci-failure-triage'}, io2), 1);
  assert.match(io2.err, /is changing this home/);
  const io3 = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: s.r.from}, io3, s.r.allow), 1);
  assert.match(io3.err, /is changing this home/);
  fs.writeFileSync(lock, JSON.stringify({pid: 2147483646, host: require('../lib/lock').lockHost(), at: new Date().toISOString()}));
  const io4 = s.io();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, io4, s.r.allow), 0, io4.err);
  assert.ok(!fs.existsSync(lock), 'released after');
});

test('a record whose pack entries are malformed is refused once, by readRecord, and status answers rather than throws', async () => {
  for (const body of ['{}', JSON.stringify({runtime: {versions: {}}, packs: {x: {}}}), JSON.stringify({runtime: {versions: {}}, packs: {x: {packages: {a: 1}, credentials: []}}}),
    JSON.stringify({runtime: {versions: {}}, packs: {x: {packages: {}, credentials: 'GITHUB_TOKEN'}}})]) {
    const home = tmp('ch-home-');
    fs.writeFileSync(path.join(home, 'packs.json'), body);
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: home}});
    assert.strictEqual(await status({}, io), 1, body);
    assert.match(io.err, /is not a ch-local record/, body);
  }
});

// /code-review medium on the #5 high-review round.
test('a stale lock is cleared by one ch-local only: a second one that saw the same dead holder does not remove the first one\'s new lock', async () => {
  const {withLock} = require('../lib/lock');
  const home = tmp('ch-home-');
  const where = {home};
  const lock = path.join(home, 'packs.lock');
  const {lockHost} = require('../lib/lock');
  fs.writeFileSync(lock, JSON.stringify({pid: 2147483646, host: lockHost(), at: new Date().toISOString()}));
  const io = fakeIo({env: {}});
  let inner = null;
  // While the first holds the lock it took over, a second arrives that read the dead holder earlier.
  const stale = fs.readFileSync(lock, 'utf8');
  const first = await withLock(where, io, async () => {
    const io2 = fakeIo({env: {}});
    // The second one's first read of the lock is from before the first took it over.
    const real = fs.readFileSync;
    let once = true;
    fs.readFileSync = (p, ...rest) => { if (once && String(p) === lock) { once = false; return stale; } return real(p, ...rest); };
    try {
      inner = await withLock(where, io2, async () => 0);
    } finally {
      fs.readFileSync = real;
    }
    assert.match(io2.err, /is changing this home/);
    assert.ok(fs.existsSync(lock), 'the first one\'s lock is still there');
    return 0;
  });
  assert.strictEqual(first, 0);
  assert.strictEqual(inner, 1);
  assert.ok(!fs.existsSync(lock));
});

test('the lock never creates the home: add-pack and remove-pack on a home that does not exist leave it absent', async () => {
  const home = path.join(tmp('ch-parent-'), 'missing');
  const r = release();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: home}});
  assert.strictEqual(await removePack({pack: 'x'}, io), 1);
  assert.strictEqual(await addPack({pack: 'other', from: r.from}, io, r.allow), 1);
  assert.ok(!fs.existsSync(home));
});

test('a holder in another PID namespace on the same host name is not taken for dead', () => {
  const {lockHost} = require('../lib/lock');
  const tag = lockHost();
  assert.ok(tag.startsWith(require('node:os').hostname()));
  if (process.platform === 'linux') assert.match(tag, /#pid:\[\d+\]$/, 'the PID namespace is part of the host on Linux');
});
