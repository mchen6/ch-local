'use strict';
require('./tmp-dirs');
// B-own-add: an own module's credential (the own-modules design §2.8):
// `credentials add <own module>` works as for a pack's -- the origin the one
// its copy declares, https only, one remote -- and a start gives the key its
// slot, or holds the module back until it has one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {fakeIo, tmp} = require('./fake-io');
const {layout} = require('../lib/home');
const {credentials} = require('../lib/credentials-command');
const mc = require('../lib/module-credentials');
const store = require('../lib/credential-store');
const ownTree = require('../lib/own-tree');
const {writeOwnRecord} = require('../lib/own-record');
const {storeModule, writeHome} = require('./store-helpers');

const POSIX = {skip: process.platform === 'win32' && 'POSIX modes'};
const MINE = 'https://api.mine.example';
const SVC = 'urn:countinghouse-test:serviceID:toolService';
const made = () => `t${crypto.randomBytes(12).toString('hex')}`;

// packMyTool: a pack module of the own module's name, which declares none
function home({packMyTool = false} = {}) {
  const ownName = 'my-tool';
  const base = fs.realpathSync.native(tmp('ch-owncred-'));
  const h = path.join(base, 'home');
  fs.mkdirSync(h, {mode: 0o700});
  fs.chmodSync(h, 0o700);
  storeModule(h, '@countinghouse/ch-pack-ci-failure-triage', '1.0.0', {countinghouse: {role: 'scenario'}});
  if (packMyTool) storeModule(h, 'my-tool', '1.0.0', {countinghouse: {role: 'part'}});
  writeHome(h, {'ci-failure-triage': {'@countinghouse/ch-pack-ci-failure-triage': '1.0.0', ...(packMyTool ? {'my-tool': '1.0.0'} : {})}});
  const where = layout({COUNTINGHOUSE_HOME: h});
  const src = path.join(base, 'work', 'mine');
  fs.mkdirSync(path.join(src, 'handlers', 'toolService'), {recursive: true});
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({name: ownName, version: '1.0.0', countinghouse: {role: 'scenario', remotes: [{name: 'mine', url: `${MINE}/mcp/`, credential: 'MY_TOKEN'}]}}));
  fs.writeFileSync(path.join(src, 'api.json'), JSON.stringify({device: {friendlyName: 'my-tool', serviceList: {[SVC]: {actionList: [{name: 'run'}]}}}}));
  fs.writeFileSync(path.join(src, 'handlers', 'toolService', 'run.js'), 'module.exports = async () => ({output: {}});\n');
  const c = ownTree.checkFolder(src, h);
  const tree = ownTree.treeHash(c.real, c.entries);
  ownTree.placeCopy(where, ownName, c.real, c.entries, tree);
  writeOwnRecord(where, {v: 1, modules: {[ownName]: {tree, version: '1.0.0', friendlyName: 'my-tool', addedAt: new Date(0).toISOString(), from: c.real, calls: []}}});
  return {h, where, tree, record: JSON.parse(fs.readFileSync(where.modulesRecord, 'utf8'))};
}
const io = (h, {terminal = false, stdin = null, typed = null} = {}) => {
  const f = fakeIo({env: {COUNTINGHOUSE_HOME: h}, homedir: '/nowhere'});
  Object.assign(f, {terminal, pid: 4242, hostname: 'box-1'});
  f.exec = async () => ({status: 1, stdout: '', stderr: 'not logged in'});
  if (stdin !== null) f.readStdin = async () => stdin;
  if (typed !== null) f.readHidden = async () => typed;
  return f;
};
const bound = (h, m = 'my-tool') => { const vars = store.readStore(h).modules.get(m); return vars != null ? vars.get('MY_TOKEN') || null : null; };

test('an own module\'s declared credential is among the declarations, read from its copy', () => {
  const {where, record} = home();
  const d = mc.declarations(where, record).get('my-tool');
  assert.ok(d != null, 'declared');
  assert.deepStrictEqual([d.variable, d.origin], ['MY_TOKEN', MINE]);
});

test('credentials add <own module>: from standard input to its declared origin only; at a terminal, named by its code', POSIX, async () => {
  const {h, tree} = home();
  const value = made();
  const wrong = io(h, {stdin: `${value}\n`});
  assert.strictEqual(await credentials({action: 'add', name: 'my-tool', to: 'https://api.example.com'}, wrong), 2);
  assert.match(wrong.err, new RegExp(`my-tool \\(own, ${tree.slice(0, 12)}\\) sends its credential to https://api\\.mine\\.example, not the address given`));
  const ok = io(h, {stdin: `${value}\n`});
  assert.strictEqual(await credentials({action: 'add', name: 'my-tool', to: MINE}, ok), 0, ok.err);
  assert.deepStrictEqual(bound(h), {origin: MINE, source: 'stored', value});
  const typed = made();
  const t = io(h, {terminal: true, typed});
  assert.strictEqual(await credentials({action: 'add', name: 'my-tool'}, t), 0, t.err);
  assert.match(t.out + t.err, new RegExp(`my-tool \\(own, ${tree.slice(0, 12)}\\) declares one credential:`));
  assert.strictEqual(bound(h).value, typed);
});

test('a start gives an own module\'s key its slot; without one it is held back for it', POSIX, async () => {
  const {h, where, record} = home();
  const none = await mc.forStart(where, record, {env: {}, ghToken: async () => ({why: 'none'}), platform: process.platform});
  assert.strictEqual(none.states.get('my-tool').state, 'none');
  assert.strictEqual(none.file.modules['my-tool'], undefined);
  store.bind(h, 'my-tool', 'MY_TOKEN', {origin: MINE, source: 'stored', value: made()}, {held: require('./store-helpers').FIXTURE_HELD});
  const got = await mc.forStart(where, record, {env: {}, ghToken: async () => ({why: 'none'}), platform: process.platform});
  assert.deepStrictEqual(Object.keys(got.file.modules['my-tool']), [MINE]);
});

test('an own module named as a pack module is not declared in its place', () => {
  const {where, record} = home({packMyTool: true});
  assert.strictEqual(mc.declarations(where, record).has('my-tool'), false, 'the pack module of that name declares none');
});
