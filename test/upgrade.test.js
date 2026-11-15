'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {upgrade} = require('../lib/upgrade');
const {latestVersions} = require('../lib/registry');
const {fakeIo, tmp} = require('./fake-io');

function setup(versions = {'@countinghouse/ch-local': '0.2.0', '@countinghouse/ch-step-redact': '0.1.0'}, {unreleased = false} = {}) {
  const home = tmp('ch-home-');
  const runtime = Object.fromEntries(Object.entries(versions).filter(([n]) => n === '@countinghouse/ch-local' || n === 'countinghouse'));
  const pack = Object.fromEntries(Object.entries(versions).filter(([n]) => runtime[n] == null));
  fs.writeFileSync(path.join(home, 'packs.json'), JSON.stringify({runtime: {versions: runtime}, packs: {'ci-failure-triage': {packages: pack, credentials: []}}, unreleased}));
  return {home, done: () => fs.rmSync(home, {recursive: true, force: true})};
}
// The npm registry's abbreviated metadata, by package.
const registry = (latest) => async (url) => {
  const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
  return {ok: true, status: 200, json: async () => ({name, 'dist-tags': {latest: latest[name]}})};
};

// `ch-local upgrade` from npm (docs/development/auto-upgrade.md): the newer
// ch-local, checked by its provenance, its pins read from its verified bytes,
// shown with what it adds, and on a yes installed through install. A fake
// registry and the test root reach it only as its test-only argument.
const {npmWorld} = require('./npm-world');
const {release, npm} = require('./install-helpers');
const recordOf = (home) => JSON.parse(fs.readFileSync(path.join(home, 'packs.json'), 'utf8'));
const historyOf = (home) => { try { return fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch (e) { return []; } };
const realFetch = (url, opts) => globalThis.fetch(url, opts);

test('upgrade shows the installed and the newer ch-local, checked; a no changes nothing', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const w = await npmWorld(release());
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['no'], fetch: realFetch});
    const before = fs.readFileSync(path.join(s.home, 'packs.json'), 'utf8');
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.match(io.out, /ch-local 0\.1\.0 -> 0\.2\.0, its provenance checked/);
    assert.match(io.out, /nothing changed/);
    assert.strictEqual(io.asked.length, 1);
    assert.deepStrictEqual(io.execs, []);
    assert.strictEqual(fs.readFileSync(path.join(s.home, 'packs.json'), 'utf8'), before);
  } finally {
    await w.close();
    s.done();
  }
});

test('nothing newer: up to date, nothing asked; a major: announced, nothing asked or installed', async () => {
  const s = setup({'@countinghouse/ch-local': '0.2.0'});
  const w = await npmWorld(release());
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.match(io.out, /everything is up to date/);
    assert.deepStrictEqual(io.asked, []);
  } finally {
    await w.close();
    s.done();
  }
  const s2 = setup({'@countinghouse/ch-local': '0.1.0'});
  const w2 = await npmWorld(release(), {version: '1.0.0'});
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s2.home}, fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w2.fromNpm), 0, io.err);
    assert.match(io.out, /ch-local 1\.0\.0 is a major upgrade/);
    assert.deepStrictEqual(io.asked, []);
    assert.deepStrictEqual(io.execs, []);
  } finally {
    await w2.close();
    s2.done();
  }
});

test('a development override in force: upgrade refuses, naming it, and fetches nothing', async () => {
  for (const env of [{CH_LOCAL_DEV: '1'}, {CH_LOCAL_REMOTE_MAP: 'https://api.githubcopilot.com=http://127.0.0.1:1'}]) {
    const s = setup({'@countinghouse/ch-local': '0.1.0'});
    try {
      const io = fakeIo({env: Object.assign({COUNTINGHOUSE_HOME: s.home}, env), fetch: realFetch});
      assert.strictEqual(await upgrade({}, io), 1);
      assert.match(io.err, new RegExp(`upgrades are off while a development override is set \\(${Object.keys(env)[0]}\\)`));
      assert.deepStrictEqual(io.fetches, []);
    } finally {
      s.done();
    }
  }
});

test('a release whose provenance fails is never offered: said, recorded, nothing asked or installed', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const w = await npmWorld(release(), {lie: '@countinghouse/ch-local'});
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 1);
    assert.match(io.err, /@countinghouse\/ch-local@0\.2\.0 .*not installed \(PROVENANCE_IDENTITY\)/);
    assert.deepStrictEqual(io.asked, []);
    assert.deepStrictEqual(io.execs, []);
    const h = historyOf(s.home).filter((e) => e.kind === 'upgrade');
    assert.deepStrictEqual(h.map((e) => [e.how, e.outcome, e.to]), [['cli', 'refused', '0.2.0']]);
  } finally {
    await w.close();
    s.done();
  }
});

test('a yes installs the new release from npm through install, recorded in history, rollback named', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const w = await npmWorld(release());
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.strictEqual(recordOf(s.home).runtime.versions['@countinghouse/ch-local'], '0.2.0');
    assert.match(io.out, /upgraded ch-local 0\.1\.0 -> 0\.2\.0; ch-local rollback undoes it/);
    const h = historyOf(s.home).filter((e) => e.kind === 'upgrade');
    assert.deepStrictEqual(h.map((e) => [e.how, e.outcome, e.from, e.to]), [['cli', 'installed', '0.1.0', '0.2.0']]);
    assert.ok(io.fetches.every((u) => u.startsWith(w.reg.url)), 'the fake registry only');
    // the bytes whose pins were read are the bytes installed: fetched once
    assert.strictEqual(w.reg.requests.filter((u) => /ch-local-0\.2\.0\.tgz$/.test(u)).length, 1);
  } finally {
    await w.close();
    s.done();
  }
});

test('what the new release adds is shown before the question', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const w = await npmWorld(release(), {edit: (doc) => { doc.allowedOrigins['https://api.example.invalid'] = ['NEW_TOKEN']; }});
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['no'], fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.match(io.out, /it adds:\n  an origin: https:\/\/api\.example\.invalid/);
  } finally {
    await w.close();
    s.done();
  }
});

test('the registry is asked for abbreviated metadata, one package per request', async () => {
  const io = fakeIo({fetch: registry({'@countinghouse/ch-local': '1.0.0'})});
  assert.deepStrictEqual(await latestVersions(['@countinghouse/ch-local'], io), {'@countinghouse/ch-local': '1.0.0'});
  assert.deepStrictEqual(io.fetches, ['https://registry.npmjs.org/@countinghouse%2Fch-local']);
});

test('the automatic-upgrade setting is off by default, stored on request, and asks the network nothing', async () => {
  const s = setup();
  try {
    // turning it on loosens a guarding setting: asked at a terminal
    const on = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['y']}), {interactive: true});
    assert.strictEqual(await upgrade({auto: 'on'}, on), 0);
    assert.match(on.asked[0], /Loosen autoUpgrade from off to on\?/);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.home, 'settings.json'), 'utf8')), {version: 1, values: {autoUpgrade: true}});
    assert.match(on.out, /announces them; installing them automatically arrives with the first release, and will run new code with your keys/);
    assert.strictEqual(await upgrade({auto: 'off'}, fakeIo({env: {COUNTINGHOUSE_HOME: s.home}})), 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.home, 'settings.json'), 'utf8')), {version: 1, values: {autoUpgrade: false}});
    assert.deepStrictEqual(on.fetches, []);
  } finally {
    s.done();
  }
});

test('upgrade refuses over an unreleased install until a clean install from a release, and asks the network nothing', async () => {
  const s = setup(undefined, {unreleased: true});
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}});
    assert.strictEqual(await upgrade({}, io), 1);
    assert.match(io.err, /unreleased install.*clean install from a release/);
    assert.deepStrictEqual(io.fetches, []);
  } finally {
    s.done();
  }
});
