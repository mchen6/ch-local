'use strict';
require('./tmp-dirs');
// lib/describe-module.js (#413 section 9.3; L5b): what the pins say of a
// module, from its own package.json. One pure reader, shared by the release
// step (scripts/describe-release.js), install's description check, and the
// upgrade preview, so the three never judge a manifest differently.
const test = require('node:test');
const assert = require('node:assert');
const {describeModule, friendlyNames, describeProblem} = require('../lib/describe-module');

const KEY_ORIGIN = 'https://api.example.test';
const toPackage = new Map([['github', '@countinghouse/ch-access-github'], ['redact', '@countinghouse/ch-step-redact']]);
const manifest = (ch) => ({name: '@countinghouse/ch-pack-x', version: '1.0.0', countinghouse: ch});

test('a module with no remotes, calls or settings is described empty', () => {
  assert.deepStrictEqual(describeModule(manifest({}), toPackage), {role: null, credentials: [], calls: [], confirmSettings: {}});
  assert.deepStrictEqual(describeModule({name: 'a', version: '1.0.0'}, toPackage), {role: null, credentials: [], calls: [], confirmSettings: {}});
  // its role recorded (the Reviewer's high review of #98, 6)
  assert.strictEqual(describeModule(manifest({role: 'part'}), toPackage).role, 'part');
  assert.match(describeModule(manifest({role: 7}), toPackage).problem, /countinghouse\.role is neither scenario nor part/);
  // only the roles the runtime knows (the medium on #98's high round, 10)
  assert.match(describeModule(manifest({role: 'parts'}), toPackage).problem, /neither scenario nor part/);
});

test('a credential in the string form and in the object form: its variable and its remote\'s origin; fallbackEnv never', () => {
  assert.deepStrictEqual(describeModule(manifest({remotes: [{name: 'gh', url: `${KEY_ORIGIN}/mcp/`, credential: 'GITHUB_TOKEN'}]}), toPackage).credentials,
    [{variable: 'GITHUB_TOKEN', origin: KEY_ORIGIN}]);
  assert.deepStrictEqual(describeModule(manifest({remotes: [{name: 'gh', url: `${KEY_ORIGIN}/mcp/`, credential: {env: 'GH_KEY', fallbackEnv: 'OTHER', header: 'X-Key'}}]}), toPackage).credentials,
    [{variable: 'GH_KEY', origin: KEY_ORIGIN}]);
  // a remote with no credential describes none
  assert.deepStrictEqual(describeModule(manifest({remotes: [{name: 'pub', url: `${KEY_ORIGIN}/mcp/`}]}), toPackage).credentials, []);
});

test('calls are package names, each once, sorted, mapped from the friendly names before the slash', () => {
  const d = describeModule(manifest({calls: ['redact/run', 'github/issues', 'github/pulls']}), toPackage);
  assert.deepStrictEqual(d.calls, ['@countinghouse/ch-access-github', '@countinghouse/ch-step-redact']);
});

test('confirm settings: each one marked confirm, with its default, or null with none; an unmarked one is not described', () => {
  const d = describeModule(manifest({settings: {
    shareStats: {type: 'boolean', default: false, confirm: true},
    endpoint: {type: 'string', format: 'url', confirm: true},
    units: {type: 'enum', values: ['a', 'b'], default: 'a'},
    loose: {type: 'boolean', default: true, confirm: 'yes'}
  }}), toPackage);
  assert.deepStrictEqual(d.confirmSettings, {endpoint: null, shareStats: false});
});

test('a string setting is confirm as the runtime rules it, marked or not (countinghouse confirmRule; the medium on L5b, 5)', () => {
  const d = describeModule(manifest({settings: {defaultRepo: {type: 'string'}, label: {type: 'string', default: 'x'}, on: {type: 'boolean', default: true}}}), toPackage);
  assert.deepStrictEqual(d.confirmSettings, {defaultRepo: null, label: 'x'});
});

test('what cannot be described is a problem, never a guess', () => {
  const p = (ch) => describeModule(manifest(ch), toPackage).problem;
  assert.match(p({calls: ['nowhere/x']}), /calls nowhere, which is no module of this release/);
  assert.match(p({remotes: [{url: `${KEY_ORIGIN}/a`, credential: 'A'}, {url: `${KEY_ORIGIN}/b`, credential: 'B'}]}), /more than one credential/);
  assert.match(p({remotes: [{url: 'http://plain.test/', credential: 'A'}]}), /credential's remote is not an https origin/);
  assert.match(p({remotes: [{url: `${KEY_ORIGIN}/`, credential: 'lower-case'}]}), /credential's variable/);
  assert.match(p({remotes: 'x'}), /remotes/);
  assert.match(p({calls: 'x'}), /calls/);
  assert.match(p({settings: []}), /settings/);
  assert.match(describeModule(null, toPackage).problem, /no package\.json/);
});

test('friendlyNames: each module\'s api.json device.friendlyName to its package; one shared by two is a problem', () => {
  const ok = friendlyNames({'@countinghouse/ch-access-github': {device: {friendlyName: 'github'}}, '@countinghouse/ch-step-redact': {device: {friendlyName: 'redact'}}});
  assert.deepStrictEqual([...ok.map], [['github', '@countinghouse/ch-access-github'], ['redact', '@countinghouse/ch-step-redact']]);
  assert.match(friendlyNames({a: {device: {friendlyName: 'x'}}, b: {device: {friendlyName: 'x'}}}).problem, /x is the friendly name of both a and b/);
  // one with none cannot be called, and is no problem
  assert.deepStrictEqual([...friendlyNames({a: null, b: {device: {friendlyName: 'y'}}}).map], [['y', 'b']]);
});

test('describeProblem names the part that differs: role, credential, calls, a confirm setting', () => {
  const want = {role: 'part', credentials: [{variable: 'A', origin: KEY_ORIGIN}], calls: ['p'], confirmSettings: {s: false}};
  assert.strictEqual(describeProblem(want, {...want, role: 'scenario'}), 'its role');
  // field by field: the same credential in another key order is the same
  assert.strictEqual(describeProblem(want, {...want, credentials: [{origin: KEY_ORIGIN, variable: 'A'}]}), null);
  assert.strictEqual(describeProblem(want, JSON.parse(JSON.stringify(want))), null);
  assert.strictEqual(describeProblem(want, {...want, credentials: [{variable: 'A', origin: 'https://elsewhere.test'}]}), 'its credential destination');
  assert.strictEqual(describeProblem(want, {...want, calls: ['p', 'q']}), 'its calls');
  assert.strictEqual(describeProblem(want, {...want, confirmSettings: {s: true}}), 'its confirm setting s');
  assert.strictEqual(describeProblem(want, {...want, confirmSettings: {}}), 'its confirm setting s');
  assert.strictEqual(describeProblem(want, {...want, confirmSettings: {s: false, t: null}}), 'its confirm setting t');
});

// The one reader of a credential (the Reviewer's high review of #98, 2):
// install's description, the runtime binding and uninstall all read it so
test('credentialOf: the string form (0.2.0\'s) and the object form name the variable; fallbackEnv is kept apart; more than one is a problem', () => {
  const {credentialOf} = require('../lib/describe-module');
  assert.deepStrictEqual(credentialOf([{name: 'github', url: `${KEY_ORIGIN}/mcp/`, credential: 'GITHUB_TOKEN'}]).credential,
    {variable: 'GITHUB_TOKEN', origin: KEY_ORIGIN, remote: 'github', fallback: null});
  assert.deepStrictEqual(credentialOf([{name: 'gh', url: `${KEY_ORIGIN}/mcp/`, credential: {env: 'GH_KEY', fallbackEnv: 'OTHER'}}]).credential,
    {variable: 'GH_KEY', origin: KEY_ORIGIN, remote: 'gh', fallback: 'OTHER'});
  assert.deepStrictEqual(credentialOf([{name: 'pub', url: `${KEY_ORIGIN}/mcp/`}]), {credential: null});
  assert.deepStrictEqual(credentialOf(undefined), {credential: null});
  assert.match(credentialOf([{url: `${KEY_ORIGIN}/a`, credential: 'A_KEY'}, {url: `${KEY_ORIGIN}/b`, credential: 'B_KEY'}]).problem, /more than one credential/);
  assert.match(credentialOf([{url: 'not a url', credential: 'A_KEY'}]).problem, /not an https origin/);
});
