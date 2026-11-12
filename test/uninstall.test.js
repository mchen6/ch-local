'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {uninstall} = require('../lib/uninstall');
const {fakeIo, tmp} = require('./fake-io');

// A home as an install and a few runs leave it.
function setup() {
  const user = tmp('ch-user-');
  const home = path.join(user, '.countinghouse');
  const files = {
    'installed.json': JSON.stringify({pack: 'ci-failure-triage', credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']}),
    'settings.json': '{"autoUpgrade": false}',
    'auth.json': '{"keys": ["k"]}',
    'run/4242/remote-credentials.json': '{}',
    'modules/x': 'x',
    'app/package.json': '{}',
    'bin/ch-local.js': '',
    'node/bin/node': '',
    'store/.identity-secret': 's',
    'store/kv.json': '{}',
    'module_data/ch-access-github/x': 'x',
    'usage/1.jsonl': '{}',
    'data/pack-ci-failure-triage/r/fingerprints.json': '{}'
  };
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, f)), {recursive: true});
    fs.writeFileSync(path.join(home, f), body);
  }
  return {user, home, done: () => fs.rmSync(user, {recursive: true, force: true})};
}
const io = (s, answers) => fakeIo({env: {GITHUB_TOKEN: 'secret-value-123'}, homedir: s.user, answers});

test('uninstall lists the home directory and deletes nothing without a yes', async () => {
  const s = setup();
  try {
    const u = io(s, ['no']);
    assert.strictEqual(await uninstall({}, u), 1);
    for (const name of ['app', 'bin', 'node', 'store', 'module_data', 'usage', 'data', 'auth.json']) assert.ok(u.out.includes(name), name);
    assert.strictEqual(u.asked.length, 1, 'asks once');
    assert.ok(fs.existsSync(path.join(s.home, 'app', 'package.json')));
    assert.ok(fs.existsSync(path.join(s.home, 'store', '.identity-secret')));
  } finally {
    s.done();
  }
});

test('on yes everything under the home goes, and the credentials to revoke are named', async () => {
  const s = setup();
  try {
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    assert.ok(!fs.existsSync(s.home));
    assert.match(u.out, /revoke the credentials you gave it: COUNTINGHOUSE_GITHUB_TOKEN, GITHUB_TOKEN/i);
    assert.ok(!(u.out + u.err).includes('secret-value-123'));
  } finally {
    s.done();
  }
});

test('--keep-data keeps the data and removes the program, the identity secret and the key', async () => {
  const s = setup();
  try {
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({keepData: true}, u), 0, u.err);
    const has = (f) => fs.existsSync(path.join(s.home, f));
    for (const kept of ['store/kv.json', 'module_data/ch-access-github/x', 'usage/1.jsonl', 'data/pack-ci-failure-triage/r/fingerprints.json']) assert.ok(has(kept), kept);
    // run/ holds each start's own files: program, not data.
    for (const gone of ['app', 'bin', 'node', 'store/.identity-secret', 'auth.json', 'installed.json', 'settings.json', 'run', 'modules']) assert.ok(!has(gone), gone);
  } finally {
    s.done();
  }
});

// From /code-review medium on #2.
test('uninstall removes only what is ch-local\'s: a home set to a shared directory keeps everything else', async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.home, 'thesis.tex'), 'mine');
    fs.mkdirSync(path.join(s.home, 'photos'));
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    assert.strictEqual(fs.readFileSync(path.join(s.home, 'thesis.tex'), 'utf8'), 'mine');
    assert.ok(fs.existsSync(path.join(s.home, 'photos')));
    assert.ok(!fs.existsSync(path.join(s.home, 'app')));
    assert.match(u.out, /thesis\.tex  \(not ch-local's: left\)/);
  } finally {
    s.done();
  }
});

test('nothing installed: uninstall says so and asks nothing', async () => {
  const user = tmp('ch-user-');
  try {
    const u = fakeIo({env: {}, homedir: user});
    assert.strictEqual(await uninstall({}, u), 0);
    assert.match(u.out, /nothing to uninstall/);
    assert.deepStrictEqual(u.asked, []);
  } finally {
    fs.rmSync(user, {recursive: true, force: true});
  }
});
