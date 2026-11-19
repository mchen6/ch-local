'use strict';
// lib/module-credentials.js (#413 sections 6.4, 6.7 and 10; L5a): each
// module's credential state and its sentence, the slots a start gives its
// runtime, and a slot's identity checked against the store.
const test = require('node:test');
const assert = require('node:assert');
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
function home({accessUrl = `${GH}/mcp/`} = {}) {
  const h = tmp('ch-mc-');
  storeModule(h, ACCESS, '1.0.0', {countinghouse: {role: 'part', remotes: [remote(accessUrl, {env: VAR, header: 'Authorization', scheme: 'Bearer'})]}});
  storeModule(h, OTHER, '1.0.0', {countinghouse: {role: 'part', remotes: [remote(`${OTHER_ORIGIN}/mcp/`, 'OTHER_TOKEN')]}});
  writeHome(h, {p: {[ACCESS]: '1.0.0', [OTHER]: '1.0.0'}});
  const where = layout({COUNTINGHOUSE_HOME: h}, () => '/nowhere');
  return {h, where, record: () => readModulesRecord(where)};
}
const bind = (h, m, v, entry) => store.bind(h, m, v, entry);
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
  assert.match(none.states.get(ACCESS).reason, /your gh login gave no token at this start \(gh is not logged in\): run `gh auth login` and restart your client, or `ch-local credentials add ch-access-github`/);
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
  assert.strictEqual(s.states.get(ACCESS).which, 'needs a credential: run `ch-local credentials add ch-access-github`');
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
  store.unbind(h, ACCESS);
  assert.deepStrictEqual(mc.slotMatches(where, record(), ACCESS, id), {ok: false, why: 'removed'});
  assert.strictEqual(mc.applyStates(where, record(), s.identities).get(ACCESS).state, 'removed');
  // added while running: usable in the store, no slot in this runtime
  bind(h, OTHER, 'OTHER_TOKEN', stored(OTHER_ORIGIN, 'test-value-other'));
  const other = mc.applyStates(where, record(), s.identities).get(OTHER);
  assert.strictEqual(other.state, 'new');
  assert.match(other.reason, /restart your client to load it/);
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
