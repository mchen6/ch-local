'use strict';
require('./tmp-dirs');
// B-own-add: the user's own modules in what loads (lib/availability.js with
// `own`; the own-modules design §2.2). An own module is top-level, after
// the packs; it loads only from an intact copy, only under enforce, only
// when no pack module has its name; it composes with what is installed,
// and a pack module never resolves a call to one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {availability} = require('../lib/availability');
const {layout} = require('../lib/home');
const {tmp} = require('./fake-io');
const {storeModule, writeHome} = require('./store-helpers');
const ownTree = require('../lib/own-tree');

const A = '@t/ch-pack-a';
const X = '@t/ch-step-x';
const Y = '@t/ch-step-y';
const PACKS = {a: {[A]: '1.0.0', [X]: '1.0.0', [Y]: '1.0.0'}};
const RELEASE = {packs: {a: {packages: [A, X, Y]}}, pins: {[A]: {version: '1.0.0'}, [X]: {version: '1.0.0'}, [Y]: {version: '1.0.0'}}};
const NONE = {ceiling: () => null, off: () => null, credential: () => null};
const SVC = 'urn:countinghouse-test:serviceID:toolService';

function home({aCalls = ['ch-step-x/s.go']} = {}) {
  const dir = fs.realpathSync.native(tmp('ch-ownav-'));
  const where = layout({COUNTINGHOUSE_HOME: path.join(dir, 'home')});
  const roles = {[A]: ['scenario', aCalls], [X]: ['part', []], [Y]: ['part', []]};
  for (const [m, v] of Object.entries(PACKS.a)) storeModule(where.home, m, v, {countinghouse: {role: roles[m][0], calls: roles[m][1]}});
  const record = writeHome(where.home, PACKS);
  const modules = Object.create(null);
  // an own module written in a work folder and placed as add-module places it
  const addOwn = (name, {friendlyName = name, calls = []} = {}) => {
    const src = path.join(dir, 'work', name);
    fs.mkdirSync(path.join(src, 'handlers', 'toolService'), {recursive: true});
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({name, version: '1.0.0', countinghouse: {role: 'scenario', calls}}));
    fs.writeFileSync(path.join(src, 'api.json'), JSON.stringify({device: {friendlyName, serviceList: {[SVC]: {actionList: [{name: 'run'}]}}}}));
    fs.writeFileSync(path.join(src, 'handlers', 'toolService', 'run.js'), 'module.exports = async () => ({output: {}});\n');
    const c = ownTree.checkFolder(src, where.home);
    assert.strictEqual(c.problems, undefined, JSON.stringify(c.problems));
    const tree = ownTree.treeHash(c.real, c.entries);
    ownTree.placeCopy(where, name, c.real, c.entries, tree);
    modules[name] = {tree, version: '1.0.0', friendlyName, addedAt: new Date(0).toISOString(), from: c.real, calls};
    return tree;
  };
  const ownRecord = {v: 1, modules};
  return {where, record, addOwn, ownRecord, dir};
}
const run = (h, {sandboxOk = true, seams = NONE} = {}) => availability(h.where, h.record, {release: RELEASE, seams, own: {record: h.ownRecord, sandboxOk}});

test('an intact own module that calls a pack\'s part: a unit after the packs, from its copy, with the part in its closure', () => {
  const h = home();
  const tree = h.addOwn('my-tool', {calls: ['ch-step-x/s.go']});
  const av = run(h);
  assert.deepStrictEqual(av.units.map((u) => u.name), [A, 'my-tool']);
  const u = av.units[1];
  assert.deepStrictEqual([u.own, u.version, u.dir, u.short, u.scenario, u.packs], [true, tree, ownTree.copyDir(h.where, 'my-tool', tree), 'my-tool', 'my-tool', []]);
  assert.deepStrictEqual(u.modules, {'my-tool': tree, [X]: '1.0.0'});
  assert.strictEqual(u.dirs[X], path.join(h.where.moduleStore, '@t', 'ch-step-x', '1.0.0'));
  assert.ok(av.tops.has('my-tool'));
});

test('a copy changed since the yes: held back (changed), the line naming add-module on its folder', () => {
  const h = home();
  const tree = h.addOwn('my-tool');
  fs.chmodSync(path.join(ownTree.copyDir(h.where, 'my-tool', tree), 'api.json'), 0o644);   // (read-only: a change takes a chmod first)
  fs.appendFileSync(path.join(ownTree.copyDir(h.where, 'my-tool', tree), 'api.json'), ' ');
  const u = run(h).unavailable.get('my-tool');
  assert.deepStrictEqual([u.kind, u.via], ['changed', null]);
  assert.strictEqual(u.line, `not loading my-tool: its files changed since you added it: run \`npx @countinghouse\/ch-local add-module "${h.ownRecord.modules['my-tool'].from}"\` again`);
});

test('the sandbox not enforced: every own module held back (sandbox); the packs load', () => {
  const h = home();
  h.addOwn('my-tool');
  const av = run(h, {sandboxOk: false});
  assert.deepStrictEqual(av.units.map((u) => u.name), [A]);
  const u = av.unavailable.get('my-tool');
  assert.deepStrictEqual([u.kind, u.line], ['sandbox', 'not loading my-tool: own modules run only with the sandbox enforced']);
});

test('a pack module\'s package name or device name: the own module held back (collision, via it); the pack loads', () => {
  const h = home();
  h.addOwn(Y);
  h.addOwn('my-y', {friendlyName: 'ch-step-x'});
  const av = run(h);
  assert.deepStrictEqual(av.units.map((u) => u.name), [A]);
  assert.deepStrictEqual(av.units[0].modules, {[A]: '1.0.0', [X]: '1.0.0'}, 'the pack\'s call finds its own part');
  // (the own module of a pack module's name: apart, never under that name's key)
  assert.strictEqual(av.unavailable.has(Y), false);
  const byName = av.shadowed.get(Y);
  assert.deepStrictEqual([byName.kind, byName.via, byName.line], ['collision', Y, `not loading your own module ch-step-y: pack module ${Y} uses its name`]);
  const byDevice = av.unavailable.get('my-y');
  assert.deepStrictEqual([byDevice.kind, byDevice.via, byDevice.line], ['collision', X, `not loading my-y: pack module ${X} uses its name`]);
});

test('a pack module never resolves a call to an own module, even one of the name it calls', () => {
  const h = home({aCalls: ['ch-step-z/s.go']});
  h.addOwn('my-z', {friendlyName: 'ch-step-z'});
  const av = run(h);
  const a = av.unavailable.get(A);
  assert.deepStrictEqual([a.kind, a.root, a.via], ['calls', 'not installed', 'ch-step-z']);
  assert.deepStrictEqual(av.units.map((u) => u.name), ['my-z']);
});

test('an own module whose callee is held back is held back through it; one calling another own module has it in its closure', () => {
  const h = home();
  h.addOwn('my-off', {calls: ['ch-pack-a/s.go']});
  const t2 = h.addOwn('my-base');
  h.addOwn('my-top', {calls: ['my-base/s.go']});
  const off = {...NONE, off: (m) => (m === A ? 'it is turned off' : null)};
  const av = run(h, {seams: off});
  const u = av.unavailable.get('my-off');
  assert.deepStrictEqual([u.kind, u.root, u.via], ['calls', 'off', A]);
  const top = av.units.find((x) => x.name === 'my-top');
  assert.deepStrictEqual(top.modules, {'my-top': top.version, 'my-base': t2});
});

test('the seams are asked of an own module too: the ceiling and off', () => {
  const h = home();
  h.addOwn('my-tool');
  const off = {...NONE, off: (m) => (m === 'my-tool' ? 'it is turned off' : null)};
  assert.strictEqual(run(h, {seams: off}).unavailable.get('my-tool').kind, 'off');
  const ceiling = {...NONE, ceiling: (m) => (m === 'my-tool' ? 'it is not on the operator\'s list' : null)};
  assert.strictEqual(run(h, {seams: ceiling}).unavailable.get('my-tool').kind, 'ceiling');
});

test('without `own`, nothing of own.json is read', () => {
  const h = home();
  h.addOwn('my-tool');
  const av = availability(h.where, h.record, {release: RELEASE, seams: NONE});
  assert.deepStrictEqual(av.units.map((u) => u.name), [A]);
  assert.strictEqual(av.unavailable.has('my-tool'), false);
});
