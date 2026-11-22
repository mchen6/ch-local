'use strict';
require('./tmp-dirs');
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
  // two packs installed, in the module store and modules.json
  const {storeModule, writeHome} = require('./store-helpers');
  storeModule(home, '@countinghouse/ch-pack-ci-failure-triage', '1.0.0', {countinghouse: {role: 'scenario'}});
  storeModule(home, '@countinghouse/ch-pack-other', '1.0.0', {countinghouse: {role: 'scenario'}});
  writeHome(home, {'ci-failure-triage': {'@countinghouse/ch-pack-ci-failure-triage': '1.0.0'}, other: {'@countinghouse/ch-pack-other': '1.0.0'}});
  return {user, home, done: () => fs.rmSync(user, {recursive: true, force: true})};
}
// the running release's pins give each pack its credentials
// (pins version 2: a pack's credentials are its modules' descriptions')
const described = (variable) => ({role: null, credentials: variable == null ? [] : [{variable, origin: 'https://api.githubcopilot.com'}], calls: [], confirmSettings: {}});
const RELEASE = {
  packs: {'ci-failure-triage': {modules: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github']}, other: {modules: ['@countinghouse/ch-pack-other']}},
  modules: {'@countinghouse/ch-pack-ci-failure-triage': described(null), '@countinghouse/ch-access-github': described('COUNTINGHOUSE_GITHUB_TOKEN'), '@countinghouse/ch-pack-other': described('OTHER_TOKEN')}
};
const io = (s, answers) => Object.assign(fakeIo({env: {GITHUB_TOKEN: 'secret-value-123'}, homedir: s.user, answers}), {release: RELEASE});

// the Reviewer's high review of #98's round 2, 6, and its cut in round 3:
// every variable a stored module's remotes name (more than one remote, a
// fallbackEnv), and every variable the store holds a key under
test('the credentials to revoke: every variable an installed module\'s remotes name, and every variable the store holds a key under', async () => {
  const s = setup();
  try {
    const {storeModule} = require('./store-helpers');
    fs.chmodSync(s.home, 0o700);   // (the store refuses a home others can write)
    storeModule(s.home, '@countinghouse/ch-pack-other', '1.0.0', {countinghouse: {role: 'scenario', remotes: [
      {name: 'a', url: 'https://a.example.invalid/', credential: {env: 'A_TOKEN', fallbackEnv: 'A_FALLBACK'}},
      {name: 'b', url: 'https://b.example.invalid/', credential: 'B_TOKEN'}]}});
    require('../lib/credential-store').bind(s.home, '@countinghouse/ch-access-github', 'COUNTINGHOUSE_GITHUB_TOKEN', {origin: 'https://api.githubcopilot.com', source: 'stored', value: 'test-stored-old-1'}, {held: require('./store-helpers').FIXTURE_HELD});
    // a removed pack's module whose key was kept: the store's own entries are named
    require('../lib/credential-store').bind(s.home, '@countinghouse/ch-gone', 'GONE_TOKEN', {origin: 'https://gone.example.invalid', source: 'stored', value: 'test-stored-gone-1'}, {held: require('./store-helpers').FIXTURE_HELD});
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    const line = (u.out.match(/revoke the credentials you gave it: (.*)\n/i) || [])[1] || '';
    for (const v of ['A_TOKEN', 'A_FALLBACK', 'B_TOKEN', 'COUNTINGHOUSE_GITHUB_TOKEN', 'OTHER_TOKEN', 'GONE_TOKEN']) assert.ok(line.split(', ').includes(v), `${v} in ${line}`);
    assert.ok(!u.out.includes('test-stored-old-1'), 'never a value');
  } finally {
    s.done();
  }
});

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
    // (the variables the pack's modules are described with: pins version 2)
    assert.match(u.out, /revoke the credentials you gave it: COUNTINGHOUSE_GITHUB_TOKEN, OTHER_TOKEN\n/i, 'every installed pack\'s, once each');
    assert.ok(!(u.out + u.err).includes('secret-value-123'));
    // (F14, the feature audit: the Claude Code plugin is Claude Code's to
    // remove, said last)
    assert.match(u.out, /If you added the Claude Code plugin, remove it in Claude Code too: `claude plugin uninstall ch-packs@ch-packs`\n$/);
  } finally {
    s.done();
  }
});

test('--keep-data keeps the data and removes the program, the identity secret and the key', async () => {
  const s = setup();
  try {
    // the native shim, as install places it (lib/shim-install.js): program
    fs.mkdirSync(path.join(s.home, 'shim'));
    fs.writeFileSync(path.join(s.home, 'shim', 'ch-shim'), 'x');
    fs.writeFileSync(path.join(s.home, 'shim', 'ch-shim.previous'), 'y');
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({keepData: true}, u), 0, u.err);
    const has = (f) => fs.existsSync(path.join(s.home, f));
    assert.ok(!has('shim'), 'the shim goes with the program');
    for (const kept of ['store/kv.json', 'module_data/ch-access-github/x', 'usage/1.jsonl', 'data/pack-ci-failure-triage/r/fingerprints.json']) assert.ok(has(kept), kept);
    // run/ holds each start's own files: program, not data. settings.json is
    // the user's (with its history): kept, so a reinstall keeps their tightenings.
    for (const gone of ['app', 'bin', 'node', 'store/.identity-secret', 'auth.json', 'modules.json', 'module-store', 'run', 'modules']) assert.ok(!has(gone), gone);
  } finally {
    s.done();
  }
});

// B-own-add (the own-modules design §2.6): the user's own modules' copies
// and their record are program, the user's folders elsewhere untouched;
// an own module's data is data.
test('uninstall: the own modules\' copies and own.json go with the program; their data is kept with --keep-data', async () => {
  const s = setup();
  try {
    const tree = 'a'.repeat(64);
    fs.mkdirSync(path.join(s.home, 'own', 'my-tool', tree), {recursive: true});
    fs.writeFileSync(path.join(s.home, 'own', 'my-tool', tree, 'api.json'), '{}');
    fs.writeFileSync(path.join(s.home, 'own.json'), '{}');
    fs.mkdirSync(path.join(s.home, 'module_data', 'my-tool'), {recursive: true});
    fs.writeFileSync(path.join(s.home, 'module_data', 'my-tool', 'x'), 'x');
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({keepData: true}, u), 0, u.err);
    assert.ok(!/own(\.json)?  \(not ch-local's: left\)/.test(u.out), u.out);
    const has = (f) => fs.existsSync(path.join(s.home, f));
    for (const gone of ['own', 'own.json']) assert.ok(!has(gone), gone);
    assert.ok(has('module_data/my-tool/x'));
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

test('a home whose packs were all removed still names the release\'s credentials to revoke', async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.home, 'packs.json'), JSON.stringify({runtime: {versions: {}}, packs: {}}));
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    assert.match(u.out, /revoke the credentials you gave it: COUNTINGHOUSE_GITHUB_TOKEN/i);
  } finally {
    s.done();
  }
});

test('uninstall removes a leftover packs.lock with the program, and waits for no one: a live holder stops it', async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.home, 'packs.lock'), JSON.stringify({pid: 2147483646, host: require('../lib/lock').lockHost(), at: 'x'}));
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    assert.ok(!fs.existsSync(s.home), 'nothing left, the stale lock included');
  } finally {
    s.done();
  }
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.home, 'packs.lock'), JSON.stringify({pid: process.pid, host: require('../lib/lock').lockHost(), at: 'x'}));
    const u = io(t, ['yes']);
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, /is changing this home/);
    assert.ok(fs.existsSync(path.join(t.home, 'app')));
  } finally {
    t.done();
  }
});
