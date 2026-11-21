'use strict';
require('./tmp-dirs');
// The module store (#413 section 9.1): every module of every installed pack
// in <home>/module-store/<name>/<version>/, one directory per version, with
// its marker; a module two packs share is there once. The runtime stays in
// <home>/app. modules.json records each pack's modules (lib/module-record.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {addPack, removePack} = require('../lib/packs-command');
const {installedPacks} = require('../lib/packs');
const {layout} = require('../lib/home');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm, record} = require('./install-helpers');

const TRIAGE = ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', '@countinghouse/ch-step-redact'];
const stored = (home, name, version) => path.join(home, 'module-store', ...name.split('/'), version);
async function installed(r = release()) {
  const home = tmp('ch-home-');
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io, r.allow), 0, io.err);
  return {home, r, where: layout({COUNTINGHOUSE_HOME: home}), io: () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()})};
}

test('install puts each of the pack\'s modules in <home>/module-store/<name>/<version>, marked, and none in the app or a pack tree', async () => {
  const s = await installed();
  for (const name of TRIAGE) {
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(stored(s.home, name, '0.1.0'), 'package.json'), 'utf8')).name, name);
    assert.ok(fs.existsSync(`${stored(s.home, name, '0.1.0')}.json`), `${name}'s marker`);
    assert.ok(!fs.existsSync(path.join(s.home, 'app', 'node_modules', ...name.split('/'))), `${name} not in the app`);
  }
  assert.ok(!fs.existsSync(path.join(s.home, 'packs')), 'no pack tree');
  assert.deepStrictEqual(fs.readdirSync(path.join(s.home, 'module-store', '@countinghouse', 'ch-step-redact')).sort(), ['0.1.0', '0.1.0.json'], 'no staging left');
});

test('installedPacks names each module\'s store directory and the scenario\'s; its remotes are read from there', async () => {
  const s = await installed();
  const [p] = installedPacks(s.where);
  assert.strictEqual(p.version, '0.1.0');
  assert.strictEqual(p.dir, stored(s.home, '@countinghouse/ch-pack-ci-failure-triage', '0.1.0'));
  assert.deepStrictEqual(Object.keys(p.dirs).sort(), TRIAGE.slice().sort());
  // (its credential's origin, by the one reader: the Reviewer's high review of #98, 2)
  const {declared} = require('../lib/module-credentials');
  assert.strictEqual(declared(s.where, require('../lib/module-record').readModulesRecord(s.where), '@countinghouse/ch-access-github').origin, 'https://api.githubcopilot.com');
});

test('add-pack places the second pack\'s modules beside the first\'s; a module they share is there once', async () => {
  const s = await installed();
  const io = s.io();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, io, s.r.allow), 0, io.err);
  for (const [name, v] of [['@countinghouse/ch-pack-other', '0.3.0'], ['@countinghouse/ch-step-other', '0.2.0']]) assert.ok(fs.existsSync(path.join(stored(s.home, name, v), 'package.json')), name);
  assert.deepStrictEqual(fs.readdirSync(path.join(s.home, 'module-store', '@countinghouse', 'ch-step-redact')).sort(), ['0.1.0', '0.1.0.json'], 'shared: one version');
  assert.deepStrictEqual(installedPacks(s.where).map((p) => [p.name, p.version]), [['ci-failure-triage', '0.1.0'], ['other', '0.3.0']]);
});

test('remove-pack drops the pack from the record; with no running start using them, its own module versions are collected', async () => {
  const s = await installed();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.io(), s.r.allow), 0);
  const io = s.io();
  assert.strictEqual(await removePack({pack: 'other'}, io), 0, io.err);
  assert.deepStrictEqual(Object.keys(record(s.home).packs), ['ci-failure-triage']);
  assert.ok(!fs.existsSync(stored(s.home, '@countinghouse/ch-pack-other', '0.3.0')));
  assert.ok(fs.existsSync(stored(s.home, '@countinghouse/ch-step-redact', '0.1.0')), 'ci-failure-triage still records it');
});

test('a home an earlier ch-local made (packs.json) is read as such: the readers say to install again, and install migrates it', async () => {
  const home = tmp('ch-home-');
  fs.writeFileSync(path.join(home, 'packs.json'), JSON.stringify({runtime: {versions: {}}, packs: {}}));
  const where = layout({COUNTINGHOUSE_HOME: home});
  assert.throws(() => installedPacks(where), {message: 'this home was made by an earlier ch-local; run `npx @countinghouse\/ch-local install` again'});
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: home}});
  assert.strictEqual(await require('../lib/packs-command').status({}, io), 1);
  assert.match(io.err, /made by an earlier ch-local; run `npx @countinghouse\/ch-local install` again/);
  const r = release();
  const inst = fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, inst, r.allow), 0, inst.err);
  assert.ok(!fs.existsSync(path.join(home, 'packs.json')));
  assert.strictEqual(record(home).v, 2);
});
