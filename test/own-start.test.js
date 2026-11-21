'use strict';
require('./tmp-dirs');
// B-own-add: start loads the user's own modules (lib/start.js; the own-
// modules design §2.2): each from its copy, after the packs, its callees'
// dirs passed, under <home>/own as a modules root; one held back says why,
// to the client and in the held-back file the overview reads.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const {start} = require('../lib/start');
const {layout} = require('../lib/home');
const {storeModule, writeHome} = require('./store-helpers');
const credentialStore = require('../lib/credential-store');
const ownTree = require('../lib/own-tree');
const {writeOwnRecord} = require('../lib/own-record');

const SCENARIO = '@countinghouse/ch-pack-ci-failure-triage';
const ACCESS = '@countinghouse/ch-access-github';
const GH_ORIGIN = 'https://api.githubcopilot.com';
const GITHUB = {name: 'github', transport: 'streamable-http', url: `${GH_ORIGIN}/mcp/`,
  credential: {env: 'COUNTINGHOUSE_GITHUB_TOKEN', fallbackEnv: 'GITHUB_TOKEN', header: 'Authorization', scheme: 'Bearer'}};
const SVC = 'urn:countinghouse-test:serviceID:toolService';

function ownHome() {
  const base = fs.realpathSync.native(tmp('ch-ownstart-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, {mode: 0o700});
  const app = path.join(home, 'app', 'node_modules', 'countinghouse');
  fs.mkdirSync(app, {recursive: true});
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({name: 'countinghouse', version: '1.0.0'}));
  storeModule(home, SCENARIO, '1.0.0', {countinghouse: {role: 'scenario', calls: ['ch-access-github/githubService.listRuns']}});
  storeModule(home, ACCESS, '1.0.0', {countinghouse: {role: 'part', remotes: [GITHUB]}});
  writeHome(home, {'ci-failure-triage': {[SCENARIO]: '1.0.0', [ACCESS]: '1.0.0'}}, {credentials: {'ci-failure-triage': ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']}});
  credentialStore.bind(home, ACCESS, 'COUNTINGHOUSE_GITHUB_TOKEN', {origin: GH_ORIGIN, source: 'stored', value: 'test-stored-value-1'}, {held: require('./store-helpers').FIXTURE_HELD});
  const where = layout({COUNTINGHOUSE_HOME: home});
  const modules = {};
  // an own module placed and recorded as add-module does it
  const addOwn = (name, {friendlyName = name, calls = []} = {}) => {
    const src = path.join(base, 'work', name);
    fs.mkdirSync(path.join(src, 'handlers', 'toolService'), {recursive: true});
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({name, version: '1.0.0', countinghouse: {role: 'scenario', calls}}));
    fs.writeFileSync(path.join(src, 'api.json'), JSON.stringify({device: {friendlyName, serviceList: {[SVC]: {actionList: [{name: 'run'}]}}}}));
    fs.writeFileSync(path.join(src, 'handlers', 'toolService', 'run.js'), 'module.exports = async () => ({output: {}});\n');
    const c = ownTree.checkFolder(src, home);
    const tree = ownTree.treeHash(c.real, c.entries);
    ownTree.placeCopy(where, name, c.real, c.entries, tree);
    modules[name] = {tree, version: '1.0.0', friendlyName, addedAt: new Date(0).toISOString(), from: c.real, calls};
    writeOwnRecord(where, {v: 1, modules});
    return tree;
  };
  return {home, where, addOwn};
}

function io(home) {
  const f = fakeIo({env: {COUNTINGHOUSE_HOME: home}, homedir: '/nowhere'});
  f.pid = 4242;
  f.hostname = 'box-1';
  f.cwd = home;
  f.spawned = [];
  f.trapSignals = () => () => {};
  f.exit = () => {};
  f.alive = (pid) => pid === 4242;
  f.spawn = (cmd, args) => {
    const hb = args.includes('--heldBackFile') ? args[args.indexOf('--heldBackFile') + 1] : null;
    f.spawned.push({args, heldBack: hb != null ? JSON.parse(fs.readFileSync(hb, 'utf8')) : null});
    return {kill: () => {}, exited: Promise.resolve(0)};
  };
  return f;
}
const after = (args, flag) => args.filter((a, i) => args[i - 1] === flag);
const enforceHere = process.platform !== 'win32';

test('an own module loads from its copy after the packs, its callee\'s dir passed once, under <home>/own as a root', {skip: !enforceHere && 'enforce on Windows: countinghouse#195'}, async () => {
  const {home, where, addOwn} = ownHome();
  const tree = addOwn('my-tool', {calls: ['ch-access-github/githubService.listRuns']});
  const f = io(home);
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  const {args, heldBack} = f.spawned[0];
  assert.deepStrictEqual(after(args, '--loadModule'), [path.join(where.moduleStore, ...SCENARIO.split('/'), '1.0.0'), ownTree.copyDir(where, 'my-tool', tree)]);
  assert.deepStrictEqual(after(args, '--partDir'), [path.join(where.moduleStore, '@countinghouse', 'ch-access-github', '1.0.0')]);
  assert.deepStrictEqual(after(args, '--modulesRoot'), [where.moduleStore, where.own]);
  assert.deepStrictEqual(heldBack.modules, []);
  assert.ok(f.err.includes(`ch-local: own modules: my-tool ${tree.slice(0, 12)}\n`), f.err);
  assert.ok(!f.err.includes('loading my-tool'), f.err);
});

test('the sandbox not enforced: the own module held back (sandbox), said; the pack loads', async () => {
  const {home, addOwn} = ownHome();
  addOwn('my-tool');
  const f = io(home);
  assert.strictEqual(await start({passThrough: ['--moduleSandbox', 'audit']}, f), 0, f.err);
  const {args, heldBack} = f.spawned[0];
  assert.strictEqual(after(args, '--loadModule').length, 1);
  assert.deepStrictEqual(heldBack.modules, [{name: 'my-tool', reason: 'sandbox'}]);
  assert.ok(f.err.includes('not loading my-tool: own modules run only with the sandbox enforced'), f.err);
});

test('a copy changed since the yes: held back (changed); a pack module\'s device name: held back (collision, via it)', {skip: !enforceHere && 'enforce on Windows: countinghouse#195'}, async () => {
  const {home, where, addOwn} = ownHome();
  const tree = addOwn('my-changed');
  addOwn('my-gh', {friendlyName: 'ch-access-github'});
  fs.appendFileSync(path.join(ownTree.copyDir(where, 'my-changed', tree), 'api.json'), ' ');
  const f = io(home);
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  const {args, heldBack} = f.spawned[0];
  assert.strictEqual(after(args, '--loadModule').length, 1);
  assert.deepStrictEqual(heldBack.modules, [{name: 'my-changed', reason: 'changed'}, {name: 'my-gh', reason: 'collision', via: ACCESS}]);
  assert.ok(f.err.includes('not loading my-changed: its files changed since you added it: run `'), f.err);
});

test('an own.json that cannot be read: no own module loads, said; the packs load', async () => {
  const {home, where} = ownHome();
  fs.writeFileSync(where.ownRecord, '{');
  const f = io(home);
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.strictEqual(after(f.spawned[0].args, '--loadModule').length, 1);
  assert.match(f.err, /your own modules are not loaded this start: .*own\.json/);
});
