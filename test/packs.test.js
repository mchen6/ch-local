'use strict';
// The packs a home holds and which of them a start loads (spec §2, many packs;
// plan Tasks 11 and 12b): every installed pack whose credential is present,
// and the remote credentials as the union of their declared remotes, each
// origin and each variable checked against the launcher's own ALLOWED_ORIGINS
// (reviewer, 2026-11-12: the variable names are pinned per origin too, so a
// declaration cannot send an unrelated secret to an allowed origin).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {tmp} = require('./fake-io');
const {installedPacks, declaredRemotes, credentialUnion, loadablePacks} = require('../lib/packs');
const {ALLOWED_ORIGINS} = require('../lib/allowlist');

const GITHUB = {name: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/',
  credential: {env: 'COUNTINGHOUSE_GITHUB_TOKEN', fallbackEnv: 'GITHUB_TOKEN', header: 'Authorization', scheme: 'Bearer'}};

function app(packages) {
  const dir = tmp('ch-local-app-');
  for (const [name, countinghouse] of Object.entries(packages)) {
    const at = path.join(dir, 'node_modules', ...name.split('/'));
    fs.mkdirSync(at, {recursive: true});
    fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify({name, version: '1.0.0', countinghouse}));
  }
  return dir;
}

test('ALLOWED_ORIGINS pins each token destination and the variables it may receive: today GitHub\'s MCP server only', () => {
  assert.deepStrictEqual(ALLOWED_ORIGINS, {'https://api.githubcopilot.com': ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']});
  assert.ok(Object.isFrozen(ALLOWED_ORIGINS) && Object.values(ALLOWED_ORIGINS).every(Object.isFrozen));
});

test('installedPacks reads the home\'s record: the pack, its scenario, packages and credentials', () => {
  const home = tmp('ch-local-home-');
  const where = {installed: path.join(home, 'installed.json')};
  assert.deepStrictEqual(installedPacks(where), []);
  fs.writeFileSync(where.installed, JSON.stringify({pack: 'ci-failure-triage', versions: {'@countinghouse/ch-pack-ci-failure-triage': '0.1.0', '@countinghouse/ch-access-github': '0.1.0'}, credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']}));
  assert.deepStrictEqual(installedPacks(where), [{name: 'ci-failure-triage', scenario: '@countinghouse/ch-pack-ci-failure-triage',
    packages: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github'], credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']}]);
});

test('declaredRemotes reads the installed packages\' countinghouse.remotes: origin, variables and the package', () => {
  const dir = app({'@countinghouse/ch-access-github': {role: 'part', remotes: [GITHUB]}, '@countinghouse/ch-step-redact': {role: 'part'}});
  assert.deepStrictEqual(declaredRemotes(dir, ['@countinghouse/ch-access-github', '@countinghouse/ch-step-redact']),
    [{origin: 'https://api.githubcopilot.com', variables: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN'], from: '@countinghouse/ch-access-github'}]);
  const bad = app({'@x/y': {remotes: [{name: 'r', url: 'not a url'}]}});
  assert.deepStrictEqual(declaredRemotes(bad, ['@x/y']), [{origin: null, variables: [], from: '@x/y'}], 'an unreadable URL is kept, to be refused');
  const odd = app({'@x/z': {remotes: [null, 'text', {name: 'r', url: 'https://api.githubcopilot.com/mcp/', credential: 'GITHUB_TOKEN'}]}});
  assert.deepStrictEqual(declaredRemotes(odd, ['@x/z']).map((r) => r.origin), [null, null, null], 'a remote or credential that is not an object is kept, to be refused');
  assert.throws(() => declaredRemotes(dir, ['@countinghouse/not-installed']), /@countinghouse\/not-installed is not installed/, 'a listed package missing from the app is a broken install');
  fs.writeFileSync(path.join(dir, 'node_modules', '@countinghouse', 'ch-step-redact', 'package.json'), '{"name": ');
  assert.throws(() => declaredRemotes(dir, ['@countinghouse/ch-step-redact']), /ch-step-redact.*not readable/, 'a corrupt manifest is not "no remotes"');
});

test('credentialUnion merges one origin\'s variables across packages', () => {
  const a = {origin: 'https://api.githubcopilot.com', variables: ['COUNTINGHOUSE_GITHUB_TOKEN'], from: 'x'};
  const b = {origin: 'https://api.githubcopilot.com', variables: ['GITHUB_TOKEN', 'COUNTINGHOUSE_GITHUB_TOKEN'], from: 'y'};
  assert.deepStrictEqual(credentialUnion([a, b], ALLOWED_ORIGINS), {credentials: {'https://api.githubcopilot.com': ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']}, refused: []});
  assert.deepStrictEqual(credentialUnion([], ALLOWED_ORIGINS), {credentials: {}, refused: []});
});

test('credentialUnion refuses an origin outside ALLOWED_ORIGINS, naming the package and origin', () => {
  const evil = {origin: 'https://collector.example', variables: ['GITHUB_TOKEN'], from: '@someone/ch-step-x'};
  assert.deepStrictEqual(credentialUnion([evil], ALLOWED_ORIGINS).refused, [{from: '@someone/ch-step-x', origin: 'https://collector.example'}]);
  assert.deepStrictEqual(credentialUnion([{origin: null, variables: [], from: '@x/y'}], ALLOWED_ORIGINS).refused, [{from: '@x/y', origin: null}]);
});

test('credentialUnion refuses a variable an allowed origin is not pinned to receive, naming the package, origin and variable', () => {
  const sneaky = {origin: 'https://api.githubcopilot.com', variables: ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY'], from: '@someone/ch-step-x'};
  assert.deepStrictEqual(credentialUnion([sneaky], ALLOWED_ORIGINS).refused,
    [{from: '@someone/ch-step-x', origin: 'https://api.githubcopilot.com', variable: 'AWS_SECRET_ACCESS_KEY'}]);
});

test('loadablePacks leaves out a pack missing a credential and names its variables, never a value', () => {
  const triage = {name: 'ci-failure-triage', credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']};
  const other = {name: 'other', credentials: ['OTHER_TOKEN']};
  const r = loadablePacks([triage, other], {GITHUB_TOKEN: 'secret', OTHER_TOKEN: '${OTHER_TOKEN}'});
  assert.deepStrictEqual(r.load.map((p) => [p.name, p.credential]), [['ci-failure-triage', 'GITHUB_TOKEN']]);
  assert.deepStrictEqual(r.missing, [{name: 'other', variables: ['OTHER_TOKEN']}]);
  assert.ok(!JSON.stringify(r).includes('secret'));
});
