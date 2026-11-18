'use strict';
// Collection of what an earlier ch-local left (#413 section 10): the pack
// trees under <home>/packs/<pack>/<key>/ are no longer placed (the module
// store holds every module: test/gc-store.test.js), and are collected once
// no running start from before names them ({<pack>: <tree key>} in its
// run.json): on this machine while its pid or its runtime's lives, on
// another while its heartbeat is fresh. A tree is renamed aside before it is
// deleted. And a start of this release names in its run.json every module
// version it loaded ({<module>: <version>}).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {addPack} = require('../lib/packs-command');
const {collect} = require('../lib/gc');
const {layout} = require('../lib/home');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm} = require('./install-helpers');

const DAY = 24 * 60 * 60 * 1000;
// a home migrated from packs.json: its record modules.json, its old trees left
function migratedHome() {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  const otherKey = '0.3.0+1a2b3c4d';
  const otherTree = path.join(home, 'packs', 'other', otherKey);
  const triageTree = path.join(home, 'packs', 'ci-failure-triage', '0.1.0+5e6f7a8b');
  for (const t of [otherTree, triageTree]) fs.mkdirSync(path.join(t, 'node_modules'), {recursive: true});
  return {home, where, otherKey, otherTree, triageTree};
}
// a running start's record of what its runtime loaded
function runDir(home, {host = 'here', pid = 4242, startedAt = Date.now(), loaded}) {
  const dir = path.join(home, 'run', `${host}-${pid}-0a1b2c3d`);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({host, pid, startedAt, loaded}));
  return dir;
}

test('a tree from before the store goes at once when no start names it, and its empty pack directory with it', () => {
  const s = migratedHome();
  const result = collect(s.where, {alive: () => false, hostname: 'here'});
  assert.ok(!fs.existsSync(s.otherTree) && !fs.existsSync(s.triageTree));
  assert.ok(!fs.existsSync(path.join(s.home, 'packs', 'other')), 'its empty directory too');
  assert.deepStrictEqual(result.removed.sort(), [s.otherTree, s.triageTree].sort());
});

test('a tree a live start from before names on this host is kept until that start ends', () => {
  const s = migratedHome();
  runDir(s.home, {loaded: {other: s.otherKey}});
  const alive = new Set([4242]);
  collect(s.where, {alive: (pid) => alive.has(pid), hostname: 'here'});
  assert.ok(fs.existsSync(s.otherTree), 'kept: a running start loaded it');
  assert.ok(!fs.existsSync(s.triageTree), 'one it does not name goes');
  alive.clear();
  const result = collect(s.where, {alive: (pid) => alive.has(pid), hostname: 'here'});
  assert.ok(!fs.existsSync(s.otherTree), 'its start ended');
  assert.deepStrictEqual(result.removed, [s.otherTree]);
});

test('another machine\'s start keeps its trees while its heartbeat is fresh (run.json\'s mtime), and not after', () => {
  const s = migratedHome();
  runDir(s.home, {host: 'there', pid: 7, startedAt: Date.now() - DAY + 60000, loaded: {other: s.otherKey}});
  collect(s.where, {alive: () => false, hostname: 'here'});
  assert.ok(fs.existsSync(s.otherTree), 'fresh: kept');
  const {STALE_MS} = require('../lib/gc');
  const result = collect(s.where, {alive: () => false, hostname: 'here', now: Date.now() + STALE_MS + 1000});
  assert.ok(!fs.existsSync(s.otherTree), 'its heartbeat stale: collected');
  assert.ok(result.removed.includes(s.otherTree));
});

test('staging leftovers under the old trees are collected', () => {
  const s = migratedHome();
  runDir(s.home, {loaded: {other: s.otherKey}});
  const stale = path.join(s.home, 'packs', 'other', `${s.otherKey}.new-deadbeef`);
  fs.mkdirSync(stale, {recursive: true});
  collect(s.where, {alive: () => true, hostname: 'here'});
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(s.otherTree));
});

test('start writes run.json naming its host, pid and every module version it loaded', async () => {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  assert.strictEqual(await addPack({pack: 'other', from: r.from}, cmd(), r.allow), 0);
  const {start} = require('../lib/start');
  const seen = [];
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home, GITHUB_TOKEN: 'x', OTHER_TOKEN: 'y'}}), {hostname: 'here', pid: 4242, alive: () => true, cwd: home});
  io.spawn = () => {
    const runs = fs.readdirSync(path.join(home, 'run'));
    seen.push(JSON.parse(fs.readFileSync(path.join(home, 'run', runs[0], 'run.json'), 'utf8')));
    return {exited: Promise.resolve(0), kill() {}, on() {}};
  };
  io.trapSignals = () => () => {};
  assert.strictEqual(await start({passThrough: []}, io), 0, io.err);
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual({host: seen[0].host, pid: seen[0].pid, loaded: seen[0].loaded}, {host: 'here', pid: 4242, loaded: {
    '@countinghouse/ch-pack-ci-failure-triage': '0.1.0', '@countinghouse/ch-access-github': '0.1.0', '@countinghouse/ch-step-redact': '0.1.0',
    '@countinghouse/ch-pack-other': '0.3.0', '@countinghouse/ch-step-other': '0.2.0'}});
});

test('a start from before on this machine keeps its trees while its runtime lives, even after start itself has gone', () => {
  const s = migratedHome();
  const {machineId} = require('../lib/machine');
  const dir = path.join(s.home, 'run', 'here-4242-0a1b2c3d');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({host: 'here', machine: machineId(), pid: 4242, childPid: 4343, startedAt: Date.now(), loaded: {other: s.otherKey}}));
  collect(s.where, {alive: (pid) => pid === 4343, hostname: 'here'});
  assert.ok(fs.existsSync(s.otherTree), 'kept: its runtime still runs');
  collect(s.where, {alive: () => false, hostname: 'here'});
  assert.ok(!fs.existsSync(s.otherTree));
  assert.ok(!fs.readdirSync(path.join(s.home, 'packs')).some((n) => n.includes('.trash-')), 'nothing left aside');
});
