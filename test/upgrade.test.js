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

test('upgrade shows installed and available versions and does nothing on no', async () => {
  const s = setup();
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['no'], fetch: registry({'@countinghouse/ch-local': '0.3.0', '@countinghouse/ch-step-redact': '0.1.0'})});
    const before = fs.readFileSync(path.join(s.home, 'packs.json'), 'utf8');
    assert.strictEqual(await upgrade({}, io), 0);
    assert.match(io.out, /@countinghouse\/ch-local\s+0\.2\.0 -> 0\.3\.0/);
    assert.match(io.out, /@countinghouse\/ch-step-redact\s+0\.1\.0 \(up to date\)/);
    assert.strictEqual(io.asked.length, 1);
    assert.deepStrictEqual(io.execs, []);
    assert.strictEqual(fs.readFileSync(path.join(s.home, 'packs.json'), 'utf8'), before);
  } finally {
    s.done();
  }
});

test('nothing newer: upgrade says so and asks nothing', async () => {
  const s = setup();
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, fetch: registry({'@countinghouse/ch-local': '0.2.0', '@countinghouse/ch-step-redact': '0.1.0'})});
    assert.strictEqual(await upgrade({}, io), 0);
    assert.match(io.out, /everything is up to date/);
    assert.deepStrictEqual(io.asked, []);
  } finally {
    s.done();
  }
});

test('a yes is answered honestly while nothing is on npm: nothing changes', async () => {
  const s = setup();
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], fetch: registry({'@countinghouse/ch-local': '0.3.0', '@countinghouse/ch-step-redact': '0.1.0'})});
    assert.strictEqual(await upgrade({}, io), 1);
    assert.match(io.err, /installing from npm arrives with the first release/);
    assert.deepStrictEqual(io.execs, []);
  } finally {
    s.done();
  }
});

test('a package npm does not know is shown as not published, not as an error', async () => {
  const s = setup();
  try {
    const fetch = async () => ({ok: false, status: 404, json: async () => ({})});
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, fetch});
    assert.strictEqual(await upgrade({}, io), 0);
    assert.match(io.out, /@countinghouse\/ch-local\s+0\.2\.0 \(not on npm yet\)/);
  } finally {
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
    const on = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}});
    assert.strictEqual(await upgrade({auto: 'on'}, on), 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.home, 'settings.json'), 'utf8')), {autoUpgrade: true});
    assert.match(on.out, /runs new code with your keys/);
    assert.strictEqual(await upgrade({auto: 'off'}, fakeIo({env: {COUNTINGHOUSE_HOME: s.home}})), 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.home, 'settings.json'), 'utf8')), {autoUpgrade: false});
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
