'use strict';
require('./tmp-dirs');
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
const {installedPacks, declaredRemotes} = require('../lib/packs');
const {ALLOWED_ORIGINS} = require('../lib/allowlist');

const GITHUB = {name: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/',
  credential: {env: 'COUNTINGHOUSE_GITHUB_TOKEN', fallbackEnv: 'GITHUB_TOKEN', header: 'Authorization', scheme: 'Bearer'}};

// each package in a directory of its own, as the store holds it -> {name: dir}
function app(packages) {
  const root = tmp('ch-local-store-');
  const dirs = {};
  for (const [name, countinghouse] of Object.entries(packages)) {
    const at = path.join(root, ...name.split('/'), '1.0.0');
    fs.mkdirSync(at, {recursive: true});
    fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify({name, version: '1.0.0', countinghouse}));
    dirs[name] = at;
  }
  return dirs;
}

test('ALLOWED_ORIGINS pins each token destination and the variables it may receive: today GitHub\'s MCP server only, its described variable', () => {
  // (from this release's module descriptions, version 2: a fallbackEnv is
  // never described, section 6.1)
  assert.deepStrictEqual(ALLOWED_ORIGINS, {'https://api.githubcopilot.com': ['GITHUB_TOKEN']});
  assert.ok(Object.isFrozen(ALLOWED_ORIGINS) && Object.values(ALLOWED_ORIGINS).every(Object.isFrozen));
});

test('installedPacks reads modules.json: every pack, its scenario (by role), its version, its modules at their active versions, their store directories and its credentials', () => {
  const {storeModule, writeHome, setPackCredentials} = require('./store-helpers');
  const {layout} = require('../lib/home');
  const home = tmp('ch-local-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  assert.deepStrictEqual(installedPacks(where), []);
  // the part first in its pack's list: the scenario is found by its role
  storeModule(home, '@countinghouse/ch-access-github', '0.1.0', {countinghouse: {role: 'part'}});
  storeModule(home, '@countinghouse/ch-pack-ci-failure-triage', '0.1.0', {countinghouse: {role: 'scenario'}});
  storeModule(home, '@countinghouse/ch-pack-other', '0.3.0', {countinghouse: {role: 'scenario'}});
  writeHome(home, {'ci-failure-triage': {'@countinghouse/ch-access-github': '0.1.0', '@countinghouse/ch-pack-ci-failure-triage': '0.1.0'},
    other: {'@countinghouse/ch-pack-other': '0.3.0'}});
  setPackCredentials(home, {'ci-failure-triage': ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN'], other: []});
  const store = (n, v) => path.join(home, 'module-store', ...n.split('/'), v);
  const io = {release: require('./fake-io').installedRelease(home)};
  assert.deepStrictEqual(installedPacks(where, undefined, io), [
    {name: 'ci-failure-triage', scenario: '@countinghouse/ch-pack-ci-failure-triage', version: '0.1.0',
      modules: {'@countinghouse/ch-access-github': '0.1.0', '@countinghouse/ch-pack-ci-failure-triage': '0.1.0'},
      dirs: {'@countinghouse/ch-access-github': store('@countinghouse/ch-access-github', '0.1.0'), '@countinghouse/ch-pack-ci-failure-triage': store('@countinghouse/ch-pack-ci-failure-triage', '0.1.0')},
      dir: store('@countinghouse/ch-pack-ci-failure-triage', '0.1.0'),
      packages: ['@countinghouse/ch-access-github', '@countinghouse/ch-pack-ci-failure-triage'], credentials: ['COUNTINGHOUSE_GITHUB_TOKEN']},
    {name: 'other', scenario: '@countinghouse/ch-pack-other', version: '0.3.0',
      modules: {'@countinghouse/ch-pack-other': '0.3.0'}, dirs: {'@countinghouse/ch-pack-other': store('@countinghouse/ch-pack-other', '0.3.0')},
      dir: store('@countinghouse/ch-pack-other', '0.3.0'), packages: ['@countinghouse/ch-pack-other'], credentials: []}]);
  fs.writeFileSync(where.modulesRecord, '{"not": "a record"}');
  assert.throws(() => installedPacks(where), /not a ch-local record/);
});

test('declaredRemotes reads the installed packages\' countinghouse.remotes: origin, variables and the package', () => {
  const dir = app({'@countinghouse/ch-access-github': {role: 'part', remotes: [GITHUB]}, '@countinghouse/ch-step-redact': {role: 'part'}});
  assert.deepStrictEqual(declaredRemotes(dir, ['@countinghouse/ch-access-github', '@countinghouse/ch-step-redact']),
    [{origin: 'https://api.githubcopilot.com', variables: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN'], from: '@countinghouse/ch-access-github'}]);
  const bad = app({'@x/y': {remotes: [{name: 'r', url: 'not a url'}]}});
  assert.deepStrictEqual(declaredRemotes(bad, ['@x/y']), [{origin: null, variables: [], from: '@x/y'}], 'an unreadable URL is kept, to be refused');
  const odd = app({'@x/z': {remotes: [null, 'text', {name: 'r', url: 'https://api.githubcopilot.com/mcp/', credential: 'GITHUB_TOKEN'}]}});
  assert.deepStrictEqual(declaredRemotes(odd, ['@x/z']).map((r) => r.origin), [null, null, null], 'a remote or credential that is not an object is kept, to be refused');
  assert.throws(() => declaredRemotes(dir, ['@countinghouse/not-installed']), /@countinghouse\/not-installed is not in the module store/, 'a listed module missing from the store is a broken install');
  fs.writeFileSync(path.join(dir['@countinghouse/ch-step-redact'], 'package.json'), '{"name": ');
  assert.throws(() => declaredRemotes(dir, ['@countinghouse/ch-step-redact']), /ch-step-redact.*not readable/, 'a corrupt manifest is not "no remotes"');
});

test('a record whose pack names or versions are not a release\'s is refused: they become directory names', () => {
  const {layout} = require('../lib/home');
  const home = tmp('ch-local-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  for (const [pack, modules] of [['../escape', {'@countinghouse/ch-pack-x': '0.1.0'}], ['x', {'@countinghouse/ch-pack-x': '../../0.1.0'}], ['x', {'../../evil': '0.1.0'}]]) {
    const derived = Object.fromEntries(Object.entries(modules).map(([m, v]) => [m, {version: v, role: null}]));
    fs.writeFileSync(where.modulesRecord, JSON.stringify({v: 2, runtime: {versions: {}}, release: null, unreleased: false,
      packs: {[pack]: {from: {release: '1.0.0'}, modules}}, modules: derived, withdrawn: []}));
    assert.throws(() => installedPacks(where), /not a ch-local record/, JSON.stringify([pack, modules]));
  }
});

// Withdrawn packs (maintainer's decision, 2026-11-17)
test('withdrawnPacks: the packs the release does not list; an unreleased install is exempt, a released one never', () => {
  const {withdrawnPacks, withdrawnLine} = require('../lib/packs');
  const packs = [{name: 'kept'}, {name: 'gone'}];
  const allow = {packs: {kept: {packages: [], credentials: []}}};
  assert.deepStrictEqual(withdrawnPacks(packs, {allow, record: {unreleased: false}}).map((p) => p.name), ['gone']);
  // the record is marked unreleased only by --unreleased-pins, which needs
  // CH_LOCAL_DEV=1 (lib/pins.js): the dev intent is on record
  assert.deepStrictEqual(withdrawnPacks(packs, {allow, record: {unreleased: true}}), [], 'unreleased: exempt');
  assert.deepStrictEqual(withdrawnPacks(packs, {allow: {packs: {}}, record: null}).map((p) => p.name), ['kept', 'gone']);
  assert.strictEqual(withdrawnLine('gone'), 'pack gone was withdrawn in this release and was not started; `ch-local remove-pack gone` removes it');
});


// whose home this is (#413 section 9.8): one rule for start and the
// applier, asked first of the running ch-local against the home's (its
// record's), then of the record, by full semver precedence (the Reviewer on
// L2a; the medium review of the refinement)
test('recordRelease: stale (upgraded or rolled back), same, or another release\'s record', () => {
  const {recordRelease} = require('../lib/packs');
  const {layout} = require('../lib/home');
  const where = layout({COUNTINGHOUSE_HOME: tmp('ch-whose-')});
  const io = (self, ours = self) => ({selfVersion: self, release: {release: {version: ours}}});
  const rec = (v, installed = v) => ({release: v == null ? null : {version: v}, runtime: {versions: installed == null ? {} : {'@countinghouse/ch-local': installed}}});
  const st = (x) => [x.state, x.how];
  // (a) the home's ch-local is not this process's: stale, by semver both ways
  assert.deepStrictEqual(st(recordRelease(rec('1.3.0'), io('1.2.0'), where)), ['stale', 'upgraded']);
  assert.deepStrictEqual(st(recordRelease(rec('1.1.0'), io('1.2.0'), where)), ['stale', 'rolled back']);
  assert.strictEqual(recordRelease(rec('1.2.0'), io('1.2.0-rc.1'), where).how, 'upgraded');
  assert.strictEqual(recordRelease(rec('1.2.0-rc.1'), io('1.2.0'), where).how, 'rolled back');
  // (b) the home's own ch-local, its release's record (or unknowns): same
  assert.strictEqual(recordRelease(rec('1.2.0'), io('1.2.0'), where).state, 'same');
  assert.strictEqual(recordRelease(rec(null, '1.2.0'), io('1.2.0'), where).state, 'same');
  assert.strictEqual(recordRelease(rec('1.2.0', '1.2.0+build.7'), io('1.2.0'), where).state, 'same', 'build metadata is no other version');
  assert.strictEqual(recordRelease(rec('1.2.0', '9.0.0'), io(null, '1.2.0'), where).state, 'same', 'the running version not known: never stale');
  // (c) the home's own ch-local, another release's record: other; an
  // unparsable version is never stale, and fails closed (other)
  assert.strictEqual(recordRelease(rec('1.3.0', '1.2.0'), io('1.2.0'), where).state, 'other');
  assert.strictEqual(recordRelease(rec('1.1.0', null), io('1.2.0'), where).state, 'other');
  assert.strictEqual(recordRelease(rec('v1.3', 'garbage'), io('1.2.0'), where).state, 'other');
  // the production default: a ch-local run from outside the home (this
  // checkout) is never stale, whatever the home holds
  assert.strictEqual(recordRelease(rec('1.2.0', '9.9.9'), {release: {release: {version: '1.2.0'}}}, where).state, 'same');
});

test('runsFromHome: only the home\'s own ch-local, by path or through a link', () => {
  const {runsFromHome} = require('../lib/packs');
  const {layout} = require('../lib/home');
  const where = layout({COUNTINGHOUSE_HOME: tmp('ch-home-')});
  const own = path.join(where.app, 'node_modules', '@countinghouse', 'ch-local');
  fs.mkdirSync(own, {recursive: true});
  assert.strictEqual(runsFromHome(where, own), true);
  assert.strictEqual(runsFromHome(where, tmp('ch-checkout-')), false);
  assert.strictEqual(runsFromHome(where), false, 'this checkout is not the home\'s');
  if (process.platform !== 'win32') {
    const link = path.join(tmp('ch-link-'), 'ch-local');
    fs.symlinkSync(own, link);
    assert.strictEqual(runsFromHome(where, link), true);
  }
});
