'use strict';
require('./tmp-dirs');
// Many packs in one home (plan Task 12b; reviewer, 2026-11-12): add-pack,
// remove-pack and status, over a home that install made.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {addPack, removePack, status} = require('../lib/packs-command');
const {fakeIo, tmp} = require('./fake-io');
const {devModules, release, npm, pkgDir, record} = require('./install-helpers');

async function installed(r = release(), env = {}) {
  const home = tmp('ch-home-');
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: home, ...env}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, r.allow), 0, io.err);
  // the running release: r's (its pins give each pack its credentials)
  return {home, r, io: (more = {}) => Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home, ...env, ...more}, exec: npm()}), {release: r.allow})};
}

test('add-pack installs a second pack beside the first and shares an installed part at the pinned version', async () => {
  const s = await installed();
  const io = s.io();
  const before = fs.statSync(path.join(pkgDir(s.home, '@countinghouse/ch-step-redact'), 'package.json')).mtimeMs;
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, io, s.r.allow), 0, io.err);
  for (const name of ['@countinghouse/ch-pack-other', '@countinghouse/ch-step-other']) assert.ok(fs.existsSync(path.join(pkgDir(s.home, name), 'package.json')), name);
  assert.strictEqual(fs.statSync(path.join(pkgDir(s.home, '@countinghouse/ch-step-redact'), 'package.json')).mtimeMs, before, 'the shared part is not unpacked again');
  assert.deepStrictEqual(Object.keys(record(s.home).packs), ['ci-failure-triage', 'other']);
  assert.deepStrictEqual(record(s.home).packs.other.modules, {'@countinghouse/ch-pack-other': '0.3.0', '@countinghouse/ch-step-redact': '0.1.0', '@countinghouse/ch-step-other': '0.2.0'});
  assert.match(io.out, /it shares ch-step-redact with the packs already installed/);
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

// #413 sections 9.5 and 9.10: remove-pack takes the pack out of the record;
// a module version another pack records stays, the ones no pack records go
// with collection
test('remove-pack keeps a module version another pack records and collects the ones no pack records', async () => {
  const s = await installed();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.io(), s.r.allow), 0);
  const store = (n, v) => path.join(s.home, 'module-store', ...n.split('/'), v);
  const io = s.io();
  assert.strictEqual(await removePack({pack: 'other'}, io), 0, io.err);
  assert.ok(!fs.existsSync(store('@countinghouse/ch-pack-other', '0.3.0')));
  assert.ok(!fs.existsSync(store('@countinghouse/ch-step-other', '0.2.0')));
  assert.ok(fs.existsSync(store('@countinghouse/ch-step-redact', '0.1.0')), 'ci-failure-triage still records it');
  assert.deepStrictEqual(Object.keys(record(s.home).packs), ['ci-failure-triage']);
  assert.ok(!('@countinghouse/ch-pack-other' in record(s.home).modules));
  const io2 = s.io();
  assert.strictEqual(await removePack({pack: 'other'}, io2), 1);
  assert.match(io2.err, /the pack "other" is not installed/);
});

test('status lists each module with its tools or why it would not load, and its credential from the store, never a value (L1b-1: by module)', async () => {
  const s = await installed();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.io(), s.r.allow), 0);
  const io = s.io({GITHUB_TOKEN: 'secret'});
  assert.strictEqual(await status({}, io), 0, io.err);
  assert.match(io.out, /^  ch-pack-ci-failure-triage 0\.1\.0 +not loaded: calls ch-access-github, which needs a credential: run `ch-local credentials add ch-access-github`$/m);
  assert.match(io.out, /^  ch-pack-other 0\.3\.0 +on; tools: ch_pack_other$/m);
  assert.match(io.out, /^packs:\n  ci-failure-triage +\d+ modules\n  other +\d+ modules$/m);
  require('../lib/credential-store').bind(s.home, '@countinghouse/ch-access-github', 'GITHUB_TOKEN', {origin: 'https://api.githubcopilot.com', source: 'stored', value: 'test-stored-value-1'}, {held: require('./store-helpers').FIXTURE_HELD});
  const after = s.io();
  await status({}, after);
  assert.match(after.out, /^  ch-access-github \S+ +part; credential GITHUB_TOKEN -> https:\/\/api\.githubcopilot\.com \(stored\)$/m);
  assert.match(after.out, /^  ch-pack-ci-failure-triage 0\.1\.0 +on; tools: ci_failure_triage$/m);
  assert.ok(!(io.out + io.err + after.out).includes('secret') && !after.out.includes('test-stored-value-1'));
  assert.ok(!/hidden/.test(io.out + after.out), 'an action without a description is not a tool');
});

test('status, add-pack and every start of an unreleased home say so in one stderr line', async () => {
  const r = release();
  const home = tmp('ch-home-');
  const pins = path.join(tmp('ch-pins-'), 'pins.json');
  fs.writeFileSync(pins, JSON.stringify({pins: r.pins, runtimeLockfile: r.lockfile, modules: devModules(r.allow, r.pins)}));
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

test('add-pack refuses pins whose runtime is not the installed one', async () => {
  const s = await installed();
  const other = release();
  const pins = path.join(tmp('ch-pins-'), 'pins.json');
  const runtimePins = {...other.pins, countinghouse: {...other.pins.countinghouse, version: '9.0.0'}};
  // A consistent pins file for a newer runtime: its lockfile resolves countinghouse 9.0.0 too.
  const lockfile = JSON.parse(JSON.stringify(other.lockfile));
  lockfile.packages['node_modules/countinghouse'] = {version: '9.0.0', resolved: 'file:tarballs/countinghouse-9.0.0.tgz', integrity: other.pins.countinghouse.integrity};
  fs.writeFileSync(pins, JSON.stringify({pins: runtimePins, runtimeLockfile: lockfile, modules: devModules(other.allow, runtimePins)}));
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

test('a record whose pack entries are malformed is refused once, by the record\'s reader, and status answers rather than throws', async () => {
  const base = {v: 2, runtime: {versions: {}}, release: null, unreleased: false, modules: {}, withdrawn: []};
  for (const body of ['{}', JSON.stringify({...base, packs: {x: {}}}), JSON.stringify({...base, packs: {x: {from: {release: '1.0.0'}, modules: {a: 1}}}}),
    JSON.stringify({...base, packs: {x: {from: 'latest', modules: {a: '1.0.0'}}}})]) {
    const home = tmp('ch-home-');
    fs.writeFileSync(path.join(home, 'modules.json'), body);
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

test('a lock is never empty to another ch-local, and an empty one is never taken for stale', async () => {
  const {withLock} = require('../lib/lock');
  const home = tmp('ch-home-');
  const lock = path.join(home, 'packs.lock');
  fs.writeFileSync(lock, '');
  const f = fakeIo({env: {}});
  assert.strictEqual(await withLock({home}, f, async () => 0), 1);
  assert.ok(fs.existsSync(lock), 'kept');
  fs.rmSync(lock);
  let seen = null;
  assert.strictEqual(await withLock({home}, f, async () => { seen = JSON.parse(fs.readFileSync(lock, 'utf8')); return 0; }), 0);
  assert.strictEqual(seen.pid, process.pid, 'whole when first seen');
  assert.ok(!fs.readdirSync(home).some((n) => n.endsWith('.tmp')), 'no temporary file left');
});

// (post-rel packs.lock protocol: another host's clock may be skewed, so its
// lock is never cleared by its age; it is named, with the file to remove)
test('another host\'s lock counts while its heartbeat is fresh, and still once it is stale: named with the file to remove, never cleared', async () => {
  const {withLock, STALE_MS} = require('../lib/lock');
  const home = tmp('ch-home-');
  const lock = path.join(home, 'packs.lock');
  fs.writeFileSync(lock, JSON.stringify({pid: 1, host: 'elsewhere', at: 'x'}));
  const f = fakeIo({env: {}});
  assert.strictEqual(await withLock({home}, f, async () => 0), 1, 'fresh: held');
  const old = new Date(Date.now() - STALE_MS - 1000);
  fs.utimesSync(lock, old, old);
  const g = fakeIo({env: {}});
  assert.strictEqual(await withLock({home}, g, async () => 0), 1, 'stale: still held');
  assert.match(g.err, /or remove .*packs\.lock if nothing is running on elsewhere/);
  assert.ok(fs.existsSync(lock));
});

// Withdrawn by the record (#413 section 9.7): an upgrade to a release that no
// longer lists a pack writes its modules into the record's withdrawn list;
// the pack stays recorded.
function withdrawHeld(home, name) {
  const {editHome} = require('./store-helpers');
  const packs = JSON.parse(fs.readFileSync(path.join(home, 'modules.json'), 'utf8')).packs;
  editHome(home, (r) => r, {release: {packs: Object.fromEntries(Object.entries(packs).filter(([p]) => p !== name).map(([p, e]) => [p, {packages: Object.keys(e.modules)}]))}});
}

test('a pack the record lists as withdrawn: status says so; remove-pack removes it and its module versions; an install that lists it again brings it to its pins', async () => {
  const s = await installed();
  withdrawHeld(s.home, 'ci-failure-triage');
  const st = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}});
  assert.strictEqual(await status({}, st), 0, st.err);
  assert.match(st.out, /ci-failure-triage: withdrawn in this release, so it is not started; `ch-local remove-pack ci-failure-triage` removes it/);
  assert.doesNotMatch(st.out, /no pack is installed/);
  const scenario = path.join(s.home, 'module-store', '@countinghouse', 'ch-pack-ci-failure-triage', '0.1.0');
  assert.ok(fs.existsSync(scenario), 'its files are there while it is recorded');
  const rm = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}});
  assert.strictEqual(await removePack({pack: 'ci-failure-triage'}, rm), 0, rm.err);
  assert.match(rm.out, /removed the withdrawn pack "ci-failure-triage"/);
  assert.deepStrictEqual(record(s.home).packs, {});
  assert.ok(!fs.existsSync(scenario), 'its module versions are collected');
  // an install from a release that lists it again: at its pins, not withdrawn
  const t = await installed();
  withdrawHeld(t.home, 'ci-failure-triage');
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: t.home}, exec: npm()});
  assert.strictEqual(await install({pack: 'other', from: t.r.from}, io, t.r.allow), 0, io.err);
  assert.deepStrictEqual(record(t.home).withdrawn, []);
  assert.match(io.out, /the pack "ci-failure-triage" is at this release's pins/);
  assert.doesNotMatch(io.out, /adds it back|was dropped/);
});

test('the record takes a held pack marked withdrawn, and refuses a withdrawn mark that is not true', () => {
  const {readRecord} = require('../lib/record');
  const home = tmp('ch-held-');
  const write = (held) => fs.writeFileSync(path.join(home, 'packs.json'), JSON.stringify({runtime: {versions: {}}, packs: {}, held}));
  write({p: {packages: {}, credentials: [], installedUnder: '0.1.0', withdrawn: true}});
  assert.strictEqual(readRecord({home, packs: path.join(home, 'packs.json')}).held.p.withdrawn, true);
  write({p: {packages: {}, credentials: [], installedUnder: '0.1.0', withdrawn: 'yes'}});
  assert.throws(() => readRecord({home, packs: path.join(home, 'packs.json')}), /not a ch-local record/);
});

test('remove-pack of a withdrawn pack removes it from the rollback\'s kept record too: a rollback never brings it back', async () => {
  const s = await installed();
  // the kept record (the release before) had the pack, as the current one does
  fs.mkdirSync(path.join(s.home, 'previous'), {recursive: true});
  fs.copyFileSync(path.join(s.home, 'modules.json'), path.join(s.home, 'previous', 'modules.json'));
  withdrawHeld(s.home, 'ci-failure-triage');
  const rm = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}});
  assert.strictEqual(await removePack({pack: 'ci-failure-triage'}, rm), 0, rm.err);
  const kept = JSON.parse(fs.readFileSync(path.join(s.home, 'previous', 'modules.json'), 'utf8'));
  assert.deepStrictEqual(kept.packs, {});
  assert.deepStrictEqual(kept.modules, {});
});

// the medium review of L1a-2, 3: a held pack the running release lists is
// told as one add-pack brings back, never as one this release lacks
test('status of a held pack this release lists says add-pack brings it back', async () => {
  const s = await installed();
  require('./store-helpers').editHome(s.home, (r) => ({...r, held: {other: {from: {release: '0.9.0'}, modules: {'@countinghouse/ch-pack-other': '0.3.0'}}}}));
  const io = s.io();
  assert.strictEqual(await status({}, io), 0, io.err);
  assert.match(io.out, /other: in this release again, not started until added: `ch-local add-pack other` adds it back/);
  assert.doesNotMatch(io.out, /this release does not have it/);
});

// #83's high review, 3: a withdrawn pack's old part never blocks a live pack
test('add-pack is not blocked by a part only a withdrawn pack holds at another version', async () => {
  const s = await installed();
  const {editHome} = require('./store-helpers');
  // a withdrawn pack recording ch-step-other at a version this release does not pin
  editHome(s.home, (r) => ({...r, packs: {...r.packs, old: {from: {release: '0.0.9'}, modules: {'@countinghouse/ch-pack-old': '0.1.0', '@countinghouse/ch-step-other': '0.1.9'}}}}),
    {release: {packs: {'ci-failure-triage': {packages: Object.keys(record(s.home).packs['ci-failure-triage'].modules)}}}});
  const io = s.io();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, io, s.r.allow), 0, io.err);
  assert.strictEqual(record(s.home).packs.other.modules['@countinghouse/ch-step-other'], '0.2.0');
});

// (a module a running client stopped, and a client on another ch-local:
// test/status-by-module.test.js)

