'use strict';
require('./tmp-dirs');
const {unhomed} = require('./unhomed');

// lib/module-credentials.js (#413 sections 6.4, 6.7 and 10; L5a): each
// module's credential state and its sentence, the slots a start gives its
// runtime, and a slot's identity checked against the store.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {tmp} = require('./fake-io');
const {storeModule, writeHome} = require('./store-helpers');
const {layout} = require('../lib/home');
const {readModulesRecord} = require('../lib/module-record');
const store = require('../lib/credential-store');
const mc = require('../lib/module-credentials');

const ACCESS = '@countinghouse/ch-access-github';
const OTHER = '@countinghouse/ch-step-other';
const GH = 'https://api.githubcopilot.com';
const OTHER_ORIGIN = 'https://api.other.example';
const VAR = 'COUNTINGHOUSE_GITHUB_TOKEN';
const remote = (url, credential) => ({name: 'r', url, credential});

// A home with ch-access-github (GitHub's origin) and ch-step-other (its own
// origin) installed, each declaring one credential.
// deep: a home at a realistic depth with its launcher there, so hints carry
// a launcher path as long as a user's (the notice cut: #147's M3)
function home({accessUrl = `${GH}/mcp/`, deep = false} = {}) {
  const h = deep ? path.join(tmp('ch-mc-'), 'alexandra', '.countinghouse') : tmp('ch-mc-');
  if (deep) {
    fs.mkdirSync(path.join(h, 'bin'), {recursive: true, mode: 0o700});
    fs.writeFileSync(path.join(h, 'bin', 'ch-local.js'), '');
  }
  storeModule(h, ACCESS, '1.0.0', {countinghouse: {role: 'part', remotes: [remote(accessUrl, {env: VAR, header: 'Authorization', scheme: 'Bearer'})]}});
  storeModule(h, OTHER, '1.0.0', {countinghouse: {role: 'part', remotes: [remote(`${OTHER_ORIGIN}/mcp/`, 'OTHER_TOKEN')]}});
  writeHome(h, {p: {[ACCESS]: '1.0.0', [OTHER]: '1.0.0'}});
  const where = layout({COUNTINGHOUSE_HOME: h}, () => '/nowhere');
  return {h, where, record: () => readModulesRecord(where)};
}
const bind = (h, m, v, entry) => store.bind(h, m, v, entry, {held: require('./store-helpers').FIXTURE_HELD});
const stored = (origin, value) => ({origin, source: 'stored', value});

test('declared: the variable and origin of the one remote with a credential, from the active version', () => {
  const {where, record} = home();
  assert.deepStrictEqual(mc.declared(where, record(), ACCESS), {variable: VAR, origin: GH, remote: 'r', fallback: null});
  assert.deepStrictEqual(mc.declared(where, record(), OTHER), {variable: 'OTHER_TOKEN', origin: OTHER_ORIGIN, remote: 'r', fallback: null});
});

test('forStart: one slot per usable binding, loaded or not; the version 2 file names module, origin, variable and slot; no value in it', async () => {
  const {h, where, record} = home();
  bind(h, ACCESS, VAR, stored(GH, 'test-value-access'));
  bind(h, OTHER, 'OTHER_TOKEN', stored(OTHER_ORIGIN, 'test-value-other'));
  const s = await mc.forStart(where, record(), {env: {PATH: '/bin'}, ghToken: async () => assert.fail('gh asked with no gh binding')});
  assert.deepStrictEqual(s.file, {version: 2, modules: {
    [ACCESS]: {[GH]: {[VAR]: 'COUNTINGHOUSE_CREDENTIAL_1'}},
    [OTHER]: {[OTHER_ORIGIN]: {OTHER_TOKEN: 'COUNTINGHOUSE_CREDENTIAL_2'}}}});
  assert.strictEqual(s.env.COUNTINGHOUSE_CREDENTIAL_1, 'test-value-access');
  assert.strictEqual(s.env.COUNTINGHOUSE_CREDENTIAL_2, 'test-value-other');
  assert.strictEqual(s.env.PATH, '/bin');
  assert.ok(!JSON.stringify(s.file).includes('test-value'));
  const id = s.identities.get(ACCESS);
  assert.deepStrictEqual({...id, digest: undefined}, {variable: VAR, origin: GH, source: 'stored', slot: 'COUNTINGHOUSE_CREDENTIAL_1', digest: undefined});
  assert.strictEqual(id.digest, mc.digest('test-value-access'));
  assert.ok(!JSON.stringify([...s.identities]).includes('test-value'), 'an identity holds a digest, never the value');
});

test('forStart: every inherited COUNTINGHOUSE_CREDENTIAL_* is removed first, so a planted one is never read as a key', async () => {
  const {where, record} = home();
  const s = await mc.forStart(where, record(), {env: {COUNTINGHOUSE_CREDENTIAL_1: 'planted', COUNTINGHOUSE_CREDENTIAL_9: 'planted', KEPT: 'k'}, ghToken: async () => ({why: 'x'})});
  assert.deepStrictEqual(Object.keys(s.env), ['KEPT']);
  assert.deepStrictEqual(s.file, {version: 2, modules: {}});
});

test('forStart: gh is asked once, and only when a binding\'s source is gh; its token gets the slot', async () => {
  const {h, where, record} = home();
  bind(h, ACCESS, VAR, {origin: GH, source: 'gh'});
  let asked = 0;
  const s = await mc.forStart(where, record(), {env: {}, ghToken: async () => { asked += 1; return {token: 'test-gh-token-1'}; }});
  assert.strictEqual(asked, 1);
  assert.strictEqual(s.env.COUNTINGHOUSE_CREDENTIAL_1, 'test-gh-token-1');
  assert.strictEqual(s.identities.get(ACCESS).source, 'gh');
  const none = await mc.forStart(where, record(), {env: {}, ghToken: async () => ({why: 'gh is not logged in'})});
  assert.strictEqual(none.states.get(ACCESS).state, 'gh-gave-none');
  assert.match(none.states.get(ACCESS).reason, /your gh login gave no token at this start \(gh is not logged in\): run `gh auth login` and restart your client, or with the shared runtime run `[^`]+ restart`; or `(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local credentials add ch-access-github`/);
  assert.ok(!('COUNTINGHOUSE_CREDENTIAL_1' in none.env));
});

test('forStart: under an acceptance origin map only a chacc_ value gets a slot', async () => {
  const {h, where, record} = home();
  bind(h, ACCESS, VAR, stored(GH, 'test-real-value'));
  bind(h, OTHER, 'OTHER_TOKEN', stored(OTHER_ORIGIN, 'chacc_test_value'));
  const s = await mc.forStart(where, record(), {env: {}, ghToken: async () => ({why: 'x'}), acceptanceMap: true});
  assert.deepStrictEqual(Object.keys(s.file.modules), [OTHER]);
  assert.strictEqual(s.states.get(ACCESS).state, 'none');
  assert.match(s.states.get(ACCESS).reason, /only an acceptance token is given/);
});

test('stateOf: none, elsewhere (a module now declaring another origin), and a store problem, each with its sentence', async () => {
  const fresh = home();
  let s = await mc.forStart(fresh.where, fresh.record(), {env: {}, ghToken: async () => ({why: 'x'})});
  assert.strictEqual(s.states.get(ACCESS).state, 'none');
  assert.strictEqual(unhomed(s.states.get(ACCESS).which), 'needs a credential: run `npx @countinghouse\/ch-local credentials add ch-access-github`');
  // stored for GitHub's origin; the installed version now sends it elsewhere
  const moved = home({accessUrl: 'https://collector.example/mcp/'});
  bind(moved.h, ACCESS, VAR, stored(GH, 'test-value-access'));
  s = await mc.forStart(moved.where, moved.record(), {env: {}, ghToken: async () => ({why: 'x'})});
  assert.strictEqual(s.states.get(ACCESS).state, 'elsewhere');
  assert.match(s.states.get(ACCESS).reason, /sends its credential somewhere new \(https:\/\/collector\.example; the stored one is for https:\/\/api\.githubcopilot\.com\)/);
  assert.ok(!('COUNTINGHOUSE_CREDENTIAL_1' in s.env), 'no key to an origin it was not entered for');
});

test('slotMatches and applyStates: a removed binding, a changed value, and one added while running', async () => {
  const {h, where, record} = home();
  bind(h, ACCESS, VAR, stored(GH, 'test-value-access'));
  const s = await mc.forStart(where, record(), {env: {}, ghToken: async () => ({why: 'x'})});
  const id = s.identities.get(ACCESS);
  assert.deepStrictEqual(mc.slotMatches(where, record(), ACCESS, id), {ok: true});
  bind(h, ACCESS, VAR, stored(GH, 'test-value-rotated'));
  assert.deepStrictEqual(mc.slotMatches(where, record(), ACCESS, id), {ok: false, why: 'changed'});
  store.unbind(h, ACCESS, {held: require('./store-helpers').FIXTURE_HELD});
  assert.deepStrictEqual(mc.slotMatches(where, record(), ACCESS, id), {ok: false, why: 'removed'});
  assert.strictEqual(mc.applyStates(where, record(), s.identities).get(ACCESS).state, 'removed');
  // added while running: usable in the store, no slot in this runtime
  bind(h, OTHER, 'OTHER_TOKEN', stored(OTHER_ORIGIN, 'test-value-other'));
  const other = mc.applyStates(where, record(), s.identities).get(OTHER);
  assert.strictEqual(other.state, 'new');
  assert.match(other.reason, /restart your client, or with the shared runtime run `[^`]+ restart` to load it/);
});

test('migrateV1: a version 1 entry reads as a binding to GitHub\'s origin under the name the module declares', () => {
  const read = {values: new Map([['GITHUB_TOKEN', {module: ACCESS, value: 'test-v1-value'}]])};
  const out = mc.migrateV1(read, new Map([[ACCESS, {variable: VAR, origin: GH}]]));
  assert.deepStrictEqual(out.get(ACCESS).get(VAR), {origin: GH, source: 'stored', value: 'test-v1-value'});
});

// the /code-review medium on L5a, 1: a client's own token reaches no worker
// the medium on the high round, 10: the environment given is an
// allowlist; a declared name is never stripped from it (one naming PATH
// would strip the runtime's own), and a slot name by any case is
test('forStart: a planted slot name by any case is removed; a declared name that is also the runtime\'s own is kept', async () => {
  const {where, record} = home();
  const s = await mc.forStart(where, record(), {env: {PATH: '/bin', countinghouse_credential_1: 'planted', COUNTINGHOUSE_CREDENTIAL_2: 'planted', OTHER_TOKEN: 'kept-if-given'}, ghToken: async () => ({why: 'x'})});
  assert.deepStrictEqual(s.env, {PATH: '/bin', OTHER_TOKEN: 'kept-if-given'});
});

// The Reviewer's high review of #98, 3: ch-access-github 0.2.0 declares
// GITHUB_TOKEN where 0.1.0 declared COUNTINGHOUSE_GITHUB_TOKEN. A key stored
// under the earlier name is carried to the declared one from either store:
// a version 1 file (section 10, read so) and a version 2 one (written once,
// said once by start).
function homeOn020() {
  const h = tmp('ch-mc-');
  storeModule(h, ACCESS, '0.2.0', {countinghouse: {role: 'part', remotes: [remote(`${GH}/mcp/`, 'GITHUB_TOKEN')]}});
  writeHome(h, {p: {[ACCESS]: '0.2.0'}});
  const where = layout({COUNTINGHOUSE_HOME: h}, () => '/nowhere');
  return {h, where, record: () => readModulesRecord(where)};
}

test('the carry-over, a version 1 store: a key stored under COUNTINGHOUSE_GITHUB_TOKEN reads under GITHUB_TOKEN, the name 0.2.0 declares', () => {
  const {h, where, record} = homeOn020();
  const {dir, file} = store.paths(h);
  require('node:fs').mkdirSync(dir, {recursive: true, mode: 0o700});
  require('node:fs').writeFileSync(file, JSON.stringify({v: 1, values: {[VAR]: {value: 'test_v1_value_1', module: ACCESS}}}), {mode: 0o600});
  const read = mc.bindings(where, record());
  assert.strictEqual(read.v1, true);
  assert.deepStrictEqual(read.bindings.get(ACCESS).get('GITHUB_TOKEN'), {origin: GH, source: 'stored', value: 'test_v1_value_1'});
});

test('the carry-over, a version 2 store: read under the declared name, never rewritten; said each start; another origin is never carried', () => {
  const {h, where, record} = homeOn020();
  bind(h, ACCESS, VAR, stored(GH, 'test-v2-value-1'));
  const read = mc.bindings(where, record());
  assert.deepStrictEqual(read.carried.map(({module, from, to}) => [module, from, to]), [[ACCESS, VAR, 'GITHUB_TOKEN']]);
  assert.deepStrictEqual(read.bindings.get(ACCESS).get('GITHUB_TOKEN'), {origin: GH, source: 'stored', value: 'test-v2-value-1'});
  assert.ok(!read.bindings.get(ACCESS).has(VAR));
  assert.strictEqual(mc.stateOf(ACCESS, mc.declared(where, record(), ACCESS), read).state, 'ok', 'loaded, not "elsewhere"');
  // what a start says, each start while it applies
  assert.deepStrictEqual(mc.carriedLines(read), ['ch-access-github\'s key is read from its earlier name; `npx @countinghouse\/ch-local credentials add ch-access-github` stores it again under GITHUB_TOKEN']);
  // nothing is rewritten: the store keeps the earlier name until the user adds it
  assert.deepStrictEqual([...store.readStore(h).modules.get(ACCESS).keys()], [VAR]);
  // a remove deletes the module's binding whatever its name: nothing carries it back
  store.unbind(h, ACCESS, {held: require('./store-helpers').FIXTURE_HELD});
  const after = mc.bindings(where, record());
  assert.strictEqual(after.bindings.get(ACCESS), undefined);
  assert.deepStrictEqual(mc.carriedLines(after), []);
  // credentials add stores it under the declared name, and the line goes
  bind(h, ACCESS, 'GITHUB_TOKEN', stored(GH, 'test-v2-value-2'));
  assert.deepStrictEqual(mc.carriedLines(mc.bindings(where, record())), []);
  // a key stored for another origin is not this module's GitHub key
  const other = homeOn020();
  bind(other.h, ACCESS, VAR, stored(OTHER_ORIGIN, 'test-v2-value-3'));
  assert.deepStrictEqual(mc.bindings(other.where, other.record()).carried, []);
});

// The Reviewer's high review of #98's round 2, 3: only GitHub's own rename
// is carried
test('the carry-over is GitHub\'s rename only: a third-party module at another origin, or the other direction, is not carried', () => {
  const h = tmp('ch-mc-');
  const THIRD = '@someone/ch-access-x';
  storeModule(h, THIRD, '1.0.0', {countinghouse: {role: 'part', remotes: [remote(`${OTHER_ORIGIN}/mcp/`, 'GITHUB_TOKEN')]}});
  storeModule(h, ACCESS, '0.1.0', {countinghouse: {role: 'part', remotes: [remote(`${GH}/mcp/`, VAR)]}});
  writeHome(h, {p: {[THIRD]: '1.0.0', [ACCESS]: '0.1.0'}});
  const where = layout({COUNTINGHOUSE_HOME: h}, () => '/nowhere');
  bind(h, THIRD, VAR, stored(OTHER_ORIGIN, 'test-third-value-1'));
  bind(h, ACCESS, 'GITHUB_TOKEN', stored(GH, 'test-v2-value-3'));
  assert.deepStrictEqual(mc.bindings(where, readModulesRecord(where)).carried, []);
  assert.strictEqual(mc.stateOf(THIRD, mc.declared(where, readModulesRecord(where), THIRD), mc.bindings(where, readModulesRecord(where))).state, 'elsewhere', 'added again, as L5a says');
});

// (the medium on #98's cut, 8: the case the dropped lock test also held)
test('a credentials directory that is a link to elsewhere is refused, and nothing is written there', {skip: process.platform === 'win32'}, () => {
  const fs = require('node:fs');
  const {h} = homeOn020();
  const elsewhere = tmp('ch-mc-elsewhere-');
  fs.symlinkSync(elsewhere, store.paths(h).dir);
  assert.throws(() => bind(h, ACCESS, 'GITHUB_TOKEN', stored(GH, 'test-v2-value-10')));
  assert.deepStrictEqual(fs.readdirSync(elsewhere), [], 'nothing written there');
});

// the reviewer's high on #147, M3: countinghouse cuts a notice at 200
// characters, so a shared runtime's lines name one way only and fit, with a
// launcher path as long as a user's
test('shared mode: each credential line, as a notice carries it, fits in 200 characters with a realistic launcher path', async () => {
  const {where, h, record} = home({deep: true});
  // (a launcher path longer than a user's own, /home/alexandra/.countinghouse/bin/ch-local.js at 46)
  assert.ok(require('../lib/command-line').chLocal(where, 'restart').length >= 'node "/home/alexandra/.countinghouse/bin/ch-local.js" restart'.length, 'a launcher path as long as a user\'s');
  const NOTICE_MAX = 200;
  const lines = [];
  const gh = await mc.forStart(where, record(), {env: {}, ghToken: async () => ({why: 'gh is not logged in'}), shared: true});
  bind(h, ACCESS, VAR, {origin: GH, source: 'gh'});
  const ghNone = await mc.forStart(where, record(), {env: {}, ghToken: async () => ({why: 'gh is not logged in'}), shared: true});
  lines.push(`not loading ch-access-github: ${ghNone.states.get(ACCESS).reason}`);
  bind(h, ACCESS, VAR, stored(GH, 'test-value-access'));
  const s = await mc.forStart(where, record(), {env: {}, ghToken: async () => ({why: 'x'}), shared: true});
  bind(h, ACCESS, VAR, stored(GH, 'test-value-rotated'));
  const changed = mc.applyStates(where, record(), s.identities, {shared: true}).get(ACCESS);
  store.unbind(h, ACCESS, {held: require('./store-helpers').FIXTURE_HELD});
  const removed = mc.applyStates(where, record(), s.identities, {shared: true}).get(ACCESS);
  bind(h, OTHER, 'OTHER_TOKEN', stored(OTHER_ORIGIN, 'test-value-other'));
  const added = mc.applyStates(where, record(), s.identities, {shared: true}).get(OTHER);
  for (const st of [changed, removed]) {
    lines.push(`ch-access-github unloaded: ${st.reason}`);
    lines.push(`ch-pack-ci-failure-triage unloaded: it calls ch-access-github, which ${st.which}`);
  }
  lines.push(`not loading ch-pack-other: ${added.reason}`);
  lines.push(require('../lib/packs').staleLine('0.2.0', 'upgraded', where, true));
  for (const l of lines) {
    assert.ok(l.length <= NOTICE_MAX, `${l.length}: ${l}`);
    assert.doesNotMatch(l, /restart your client/, 'one way only, in shared mode');
  }
  assert.ok(gh != null);
});
