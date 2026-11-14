'use strict';
// Packs in place (part 2, plan Task B1; docs/superpowers/specs/
// 2026-11-14-packs-in-place-and-settings-tool-design.md in countinghouse):
// each pack version in a tree of its own, <home>/packs/<name>/<version>/,
// where <version> is its scenario's. A running start keeps using the tree it
// loaded while another version is installed beside it. The runtime stays in
// <home>/app. A home made before keeps working from its flat app.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {addPack, removePack} = require('../lib/packs-command');
const {installedPacks, declaredRemotes} = require('../lib/packs');
const {layout} = require('../lib/home');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm, record} = require('./install-helpers');

const TRIAGE = ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', '@countinghouse/ch-step-redact'];
const {packKey} = require('../lib/pack-dir');
// a pack's tree, by its recorded packages (scenario version + hash)
const keyOf = (home, pack) => packKey(record(home).packs[pack].packages);
const tree = (home, pack) => path.join(home, 'packs', pack, keyOf(home, pack), 'node_modules');
async function installed(r = release()) {
  const home = tmp('ch-home-');
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, r.allow), 0, io.err);
  return {home, r, where: layout({COUNTINGHOUSE_HOME: home}), io: () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()})};
}

test('install puts the pack\'s packages in <home>/packs/<name>/<scenario version>+<hash>/node_modules, and none in the app', async () => {
  const s = await installed();
  for (const name of TRIAGE) {
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tree(s.home, 'ci-failure-triage'), ...name.split('/'), 'package.json'), 'utf8')).name, name);
    assert.ok(!fs.existsSync(path.join(s.home, 'app', 'node_modules', ...name.split('/'))), `${name} not in the app`);
  }
  assert.deepStrictEqual(fs.readdirSync(path.join(s.home, 'packs', 'ci-failure-triage')), [keyOf(s.home, 'ci-failure-triage')], 'no staging left');
  assert.match(keyOf(s.home, 'ci-failure-triage'), /^0\.1\.0\+[0-9a-f]{8}$/);
});

test('installedPacks names each pack\'s own tree and scenario directory; its remotes are read from there', async () => {
  const s = await installed();
  const [p] = installedPacks(s.where);
  assert.strictEqual(p.version, '0.1.0');
  assert.strictEqual(p.base, path.join(s.home, 'packs', 'ci-failure-triage', keyOf(s.home, 'ci-failure-triage')));
  assert.strictEqual(p.dir, path.join(tree(s.home, 'ci-failure-triage'), '@countinghouse', 'ch-pack-ci-failure-triage'));
  assert.deepStrictEqual(declaredRemotes(p.base, p.packages).map((d) => d.origin), ['https://api.githubcopilot.com']);
});

test('add-pack puts the second pack in its own tree, with its own copy of a part the first one shares', async () => {
  const s = await installed();
  const io = s.io();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, io, s.r.allow), 0, io.err);
  for (const name of ['@countinghouse/ch-pack-other', '@countinghouse/ch-step-redact', '@countinghouse/ch-step-other']) {
    assert.ok(fs.existsSync(path.join(tree(s.home, 'other'), ...name.split('/'), 'package.json')), name);
  }
  assert.ok(fs.existsSync(path.join(tree(s.home, 'ci-failure-triage'), '@countinghouse', 'ch-step-redact', 'package.json')), 'the first pack\'s copy stays');
  assert.deepStrictEqual(installedPacks(s.where).map((p) => [p.name, p.version]), [['ci-failure-triage', '0.1.0'], ['other', '0.3.0']]);
});

test('remove-pack drops the pack from the record; with no running start using its tree, the tree is collected (task B2; gc.test.js keeps one a start uses)', async () => {
  const s = await installed();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.io(), s.r.allow), 0);
  const otherTree = tree(s.home, 'other');
  const io = s.io();
  assert.strictEqual(await removePack({pack: 'other'}, io), 0, io.err);
  assert.deepStrictEqual(Object.keys(record(s.home).packs), ['ci-failure-triage']);
  assert.ok(!fs.existsSync(otherTree));
});

test('a home made before (its packs in the flat app) still names each pack\'s directory there', async () => {
  const s = await installed();
  // as an earlier ch-local left it: every package in <home>/app/node_modules
  const triageTree = tree(s.home, 'ci-failure-triage');
  for (const name of TRIAGE) {
    const to = path.join(s.home, 'app', 'node_modules', ...name.split('/'));
    fs.mkdirSync(path.dirname(to), {recursive: true});
    fs.renameSync(path.join(triageTree, ...name.split('/')), to);
  }
  fs.rmSync(path.join(s.home, 'packs'), {recursive: true, force: true});
  const [p] = installedPacks(s.where);
  assert.strictEqual(p.base, path.join(s.home, 'app'));
  assert.strictEqual(p.dir, path.join(s.home, 'app', 'node_modules', '@countinghouse', 'ch-pack-ci-failure-triage'));
  assert.deepStrictEqual(declaredRemotes(p.base, p.packages).map((d) => d.origin), ['https://api.githubcopilot.com']);
});
