'use strict';
// Packs in place (part 2, plan Task B2): a pack tree no live start uses is
// collected, after every install, add-pack, remove-pack and rollback. Kept:
// the current record's, the rollback target's, a held pack's, and any a
// running start's run.json names (this host's while its pid lives; another
// host's, on a shared disk, until its run is a day old).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {addPack, removePack} = require('../lib/packs-command');
const {collect} = require('../lib/gc');
const {packKey} = require('../lib/pack-dir');
const {layout} = require('../lib/home');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm, record} = require('./install-helpers');

const DAY = 24 * 60 * 60 * 1000;
async function twoPacks() {
  const home = tmp('ch-home-');
  const r = release();
  const io = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io(), r.allow), 0);
  assert.strictEqual(await addPack({pack: 'other', from: r.from}, io(), r.allow), 0);
  const where = layout({COUNTINGHOUSE_HOME: home});
  const otherKey = packKey(record(home).packs.other.packages);
  return {home, r, io, where, otherKey, otherTree: path.join(home, 'packs', 'other', otherKey)};
}
// a running start's record of what its runtime loaded
function runDir(home, {host = 'here', pid = 4242, startedAt = Date.now(), loaded}) {
  const dir = path.join(home, 'run', `${host}-${pid}-0a1b2c3d`);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({host, pid, startedAt, loaded}));
  return dir;
}

test('a removed pack\'s tree goes at once when no start uses it; the current packs\' stay', async () => {
  const s = await twoPacks();
  assert.strictEqual(await removePack({pack: 'other'}, s.io()), 0);
  assert.ok(!fs.existsSync(s.otherTree), 'collected');
  assert.ok(!fs.existsSync(path.join(s.home, 'packs', 'other')), 'its empty directory too');
  const triage = path.join(s.home, 'packs', 'ci-failure-triage', packKey(record(s.home).packs['ci-failure-triage'].packages));
  assert.ok(fs.existsSync(triage));
});

test('a tree a live start on this host names is kept until that start ends', async () => {
  const s = await twoPacks();
  runDir(s.home, {loaded: {other: s.otherKey}});
  const alive = new Set([4242]);
  const io = Object.assign(s.io(), {hostname: 'here', alive: (pid) => alive.has(pid)});
  assert.strictEqual(await removePack({pack: 'other'}, io), 0);
  assert.ok(fs.existsSync(s.otherTree), 'kept: a running start loaded it');
  alive.clear();
  const result = collect(s.where, {alive: (pid) => alive.has(pid), hostname: 'here'});
  assert.ok(!fs.existsSync(s.otherTree), 'its start ended');
  assert.deepStrictEqual(result.removed, [s.otherTree]);
});

test('another host\'s start keeps its trees until its run is a day old', () => {
  return twoPacks().then(async (s) => {
    assert.strictEqual(await removePack({pack: 'other'}, Object.assign(s.io(), {hostname: 'here'})), 0);
    // removed already (no start named it); put it back as another host's start would hold it
    fs.mkdirSync(path.join(s.otherTree, 'node_modules'), {recursive: true});
    runDir(s.home, {host: 'there', pid: 7, startedAt: Date.now() - DAY + 60000, loaded: {other: s.otherKey}});
    collect(s.where, {alive: () => false, hostname: 'here'});
    assert.ok(fs.existsSync(s.otherTree), 'under a day: kept');
    const result = collect(s.where, {alive: () => false, hostname: 'here', now: Date.now() + 120000});
    assert.ok(!fs.existsSync(s.otherTree), 'a day old: collected');
    assert.ok(result.removed.includes(s.otherTree));
  });
});

test('the rollback target\'s trees, a held pack\'s, and the current ones are never collected; staging leftovers are', async () => {
  const s = await twoPacks();
  const prevKey = packKey({'@countinghouse/ch-pack-ci-failure-triage': '0.0.9'});
  const prevTree = path.join(s.home, 'packs', 'ci-failure-triage', prevKey);
  fs.mkdirSync(path.join(prevTree, 'node_modules'), {recursive: true});
  fs.mkdirSync(path.join(s.home, 'previous'), {recursive: true});
  fs.writeFileSync(path.join(s.home, 'previous', 'packs.json'), JSON.stringify({runtime: {versions: {}}, packs: {'ci-failure-triage': {packages: {'@countinghouse/ch-pack-ci-failure-triage': '0.0.9'}, credentials: []}}}));
  const stale = path.join(s.home, 'packs', 'ci-failure-triage', `${prevKey}.new-deadbeef`);
  fs.mkdirSync(stale, {recursive: true});
  const stray = path.join(s.home, 'packs', 'gone', '1.0.0+00000000');
  fs.mkdirSync(path.join(stray, 'node_modules'), {recursive: true});
  const result = collect(s.where, {alive: () => false, hostname: 'here'});
  assert.ok(fs.existsSync(prevTree), 'the rollback target');
  assert.ok(fs.existsSync(s.otherTree), 'a current pack');
  assert.ok(!fs.existsSync(stale), 'a staging leftover');
  assert.ok(!fs.existsSync(stray), 'a tree no record names');
  assert.deepStrictEqual(result.removed.sort(), [stale, stray].sort());
  assert.ok(result.kept.some((k) => k.dir === prevTree && k.why === 'rollback'));
});

test('start writes run.json naming its host, pid and the trees it loaded', async () => {
  const s = await twoPacks();
  const {start} = require('../lib/start');
  const seen = [];
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: s.home, GITHUB_TOKEN: 'x', OTHER_TOKEN: 'y'}}), {hostname: 'here', pid: 4242, alive: () => true, cwd: s.home});
  io.spawn = () => {
    const runs = fs.readdirSync(path.join(s.home, 'run'));
    seen.push(JSON.parse(fs.readFileSync(path.join(s.home, 'run', runs[0], 'run.json'), 'utf8')));
    return {exited: Promise.resolve(0), kill() {}, on() {}};
  };
  io.trapSignals = () => () => {};
  assert.strictEqual(await start({passThrough: []}, io), 0, io.err);
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual({host: seen[0].host, pid: seen[0].pid, loaded: seen[0].loaded},
    {host: 'here', pid: 4242, loaded: {'ci-failure-triage': packKey(record(s.home).packs['ci-failure-triage'].packages), other: s.otherKey}});
});
