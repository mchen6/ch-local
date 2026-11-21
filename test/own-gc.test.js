'use strict';
require('./tmp-dirs');
// B-own-add: the user's own modules' copies collected, and remove-module
// (the own-modules design §2.6). A copy is kept while own.json names it or
// a live start loaded it; another that carries its marker goes, marker
// first; one without a marker is not ch-local's to take. remove-module
// drops the record's entry and the copies no live start runs, and keeps the
// module's data and key, saying how to remove them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const {layout} = require('../lib/home');
const ownTree = require('../lib/own-tree');
const {readOwnRecord, writeOwnRecord} = require('../lib/own-record');
const {collectOwn, collectStore} = require('../lib/gc');
const {removeModule} = require('../lib/own-command');

const SVC = 'urn:countinghouse-test:serviceID:toolService';
function setup() {
  const base = fs.realpathSync.native(tmp('ch-owngc-'));
  const where = layout({COUNTINGHOUSE_HOME: path.join(base, 'home')});
  fs.mkdirSync(where.home, {recursive: true, mode: 0o700});
  let n = 0;
  // a copy of name placed (its code numbered, so each is another tree)
  const place = (name) => {
    const src = path.join(base, 'work', `${n++}`);
    fs.mkdirSync(path.join(src, 'handlers', 'toolService'), {recursive: true});
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({name, version: '1.0.0', countinghouse: {role: 'scenario'}}));
    fs.writeFileSync(path.join(src, 'api.json'), JSON.stringify({device: {friendlyName: name.replace(/^@[^/]+\//, ''), serviceList: {[SVC]: {actionList: [{name: 'run'}]}}}}));
    fs.writeFileSync(path.join(src, 'handlers', 'toolService', 'run.js'), `module.exports = async () => ({output: {}});\n// ${n}\n`);
    const c = ownTree.checkFolder(src, where.home);
    const tree = ownTree.treeHash(c.real, c.entries);
    ownTree.placeCopy(where, name, c.real, c.entries, tree);
    return {tree, entry: {tree, version: '1.0.0', friendlyName: name.replace(/^@[^/]+\//, ''), addedAt: new Date(0).toISOString(), from: c.real, calls: []}};
  };
  const run = (loaded, pid = 4242) => {
    const dir = path.join(where.run, `here-${pid}-0a1b2c3d`);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({host: 'here', pid, startedAt: Date.now(), loaded}));
  };
  return {where, place, run};
}
const opts = {alive: (pid) => pid === 4242, hostname: 'here', machine: null};
const has = (where, name, tree) => fs.existsSync(ownTree.copyDir(where, name, tree));

test('collectOwn: the recorded copy and one a live start loaded are kept; another marked copy goes, marker first; an unmarked one stays', () => {
  const {where, place, run} = setup();
  const a = place('my-tool');
  const old = place('my-tool');
  const running = place('my-tool');
  const scoped = place('@me/other');
  writeOwnRecord(where, {v: 1, modules: {'my-tool': a.entry}});
  run({'my-tool': running.tree});
  const stray = path.join(where.own, 'my-tool', 'f'.repeat(64));
  fs.mkdirSync(stray);
  const r = collectOwn(where, opts);
  assert.strictEqual(r.problem, undefined);
  assert.ok(has(where, 'my-tool', a.tree) && has(where, 'my-tool', running.tree), 'kept');
  assert.ok(!has(where, 'my-tool', old.tree) && !fs.existsSync(ownTree.markerOf(where, 'my-tool', old.tree)), 'collected with its marker');
  assert.ok(!has(where, '@me/other', scoped.tree) && !fs.existsSync(path.join(where.own, '@me')), 'a scoped one too, its emptied folders with it');
  assert.ok(fs.existsSync(stray), 'no marker: not ch-local\'s to take');
});

test('collectOwn: an own.json or a run that can\'t be read collects nothing, and says why', () => {
  const {where, place, run} = setup();
  const a = place('my-tool');
  fs.writeFileSync(where.ownRecord, '{');
  const r = collectOwn(where, opts);
  assert.match(r.problem, /own\.json/);
  assert.ok(has(where, 'my-tool', a.tree));
  fs.rmSync(where.ownRecord);
  run({});
  fs.writeFileSync(path.join(where.run, 'here-4242-0a1b2c3d', 'run.json'), '{"loaded": ');
  assert.ok(collectOwn(where, opts).problem != null);
  assert.ok(has(where, 'my-tool', a.tree));
});

test('collectStore collects the own copies too', () => {
  const {where, place} = setup();
  const a = place('my-tool');
  const r = collectStore(where, opts);
  assert.ok(!has(where, 'my-tool', a.tree), 'no record names it');
  assert.ok(r.removed.includes(ownTree.copyDir(where, 'my-tool', a.tree)), JSON.stringify(r.removed));
});

test('remove-module: the entry dropped, its copies gone, its data and key kept and named; an unknown name refused', async () => {
  const {where, place} = setup();
  const a = place('my-tool');
  const b = place('@me/other');
  writeOwnRecord(where, {v: 1, modules: {'my-tool': a.entry, '@me/other': b.entry}});
  const data = path.join(where.moduleData, 'my-tool');
  fs.mkdirSync(data, {recursive: true});
  const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: where.home}}), opts);
  assert.strictEqual(await removeModule({name: 'my-tool'}, io, {where}), 0, io.err);
  assert.deepStrictEqual(Object.keys(readOwnRecord(where).modules), ['@me/other']);
  assert.ok(!has(where, 'my-tool', a.tree) && has(where, '@me/other', b.tree));
  assert.ok(fs.existsSync(data), 'its data is kept');
  assert.match(io.out, new RegExp(`^Removed my-tool\\. Its data is kept in ${data.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.$`, 'm'));
  // a key kept is named too (the store a map, read as one)
  const c = place('my-keyed');
  writeOwnRecord(where, {v: 1, modules: {...readOwnRecord(where).modules, 'my-keyed': c.entry}});
  require('../lib/credential-store').bind(where.home, 'my-keyed', 'MY_TOKEN', {origin: 'https://api.mine.example', source: 'stored', value: `t${Date.now()}`}, {held: require('./store-helpers').FIXTURE_HELD});
  const keyed = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: where.home}}), opts);
  assert.strictEqual(await removeModule({name: 'my-keyed'}, keyed, {where}), 0, keyed.err);
  assert.match(keyed.out, /^Removed my-keyed\. Its key is kept: `.*credentials remove my-keyed` removes it\.$/m);
  // by its short name too
  const io2 = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: where.home}}), opts);
  assert.strictEqual(await removeModule({name: 'other'}, io2, {where}), 0, io2.err);
  assert.match(io2.out, /^Removed other\.$/m);
  const io3 = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: where.home}}), opts);
  assert.strictEqual(await removeModule({name: 'nothing-here'}, io3, {where}), 2);
  assert.match(io3.err, /nothing-here is not one of your own modules: `.*status` lists them\./);
});
