'use strict';
require('./tmp-dirs');
// B-own-add: `ch-local add-module <dir>` (lib/own-command.js; the own-
// modules design §2.1, §5). The user's own act at a terminal; the code
// copied under its hash and recorded; each module it calls installed here
// and named, with no claim about what those reach (R7/R8, release 1.1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const {layout} = require('../lib/home');
const {installedHome} = require('./install-helpers');
const {addModule} = require('../lib/own-command');
const {readOwnRecord} = require('../lib/own-record');

const SVC = 'urn:countinghouse-test:serviceID:toolService';
function writeModule(dir, {name = 'my-tool', friendlyName = 'my-tool', calls = [], extra = ''} = {}) {
  fs.mkdirSync(path.join(dir, 'handlers', 'toolService'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', countinghouse: {role: 'scenario', calls}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName, serviceList: {[SVC]: {actionList: [{name: 'run'}]}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'toolService', 'run.js'), `module.exports = async () => ({output: {ok: true}});\n${extra}`);
  return fs.realpathSync.native(dir);
}
function setup() {
  const base = fs.realpathSync.native(tmp('ch-owncmd-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, {recursive: true});
  installedHome(home, ['ci-failure-triage']);
  const where = layout({COUNTINGHOUSE_HOME: home});
  return {base, home, where};
}
const ioWith = (home, answers, interactive = true) => Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}, answers}), {interactive, stdoutTTY: interactive});
const GH = 'https://api.githubcopilot.com';

test('asked at a terminal only: elsewhere refused, naming the command', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const io = ioWith(home, [], false);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /add-module asks you, in your own terminal: run `.*add-module ".+mine"` there\./);
  assert.strictEqual(readOwnRecord(where), null);
});

test('a terminal on standard input whose output is not one: refused, nothing asked (the lines must be seen)', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const io = Object.assign(ioWith(home, ['y']), {stdoutTTY: false});
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /add-module asks you, in your own terminal: run `.*add-module ".+mine"` there\./);
  assert.deepStrictEqual(io.asked, []);
  assert.strictEqual(readOwnRecord(where), null);
});

test('a pack\'s part called: named, with no claim about its key; on yes copied and recorded', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'), {calls: ['ch-access-github/githubService.listRuns']});
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 0, io.err);
  assert.match(io.out, /^Add your own module my-tool 1\.0\.0 \(code [0-9a-f]{12}, 3 files\)\?$/m);
  assert.match(io.out, /^It runs inside the same countinghouse runtime as your packs\.$/m);
  assert.match(io.out, /^It can connect to the internet and send what it is given\.$/m);
  assert.ok(io.out.includes('It calls ch-access-github.'), io.out);
  // (R7: the question makes no claim about keys its calls reach)
  assert.ok(!/key|reach/i.test(io.out.split('\n').filter((l) => l.startsWith('It calls')).join('\n')), io.out);
  assert.deepStrictEqual(io.asked, ['Add it? [y/N] ']);
  assert.match(io.out, /Added my-tool \(own, [0-9a-f]{12}\): your clients see it now\./);
  const r = readOwnRecord(where).modules['my-tool'];
  assert.deepStrictEqual([r.calls, r.from, r.friendlyName], [['ch-access-github/githubService.listRuns'], dir, 'my-tool']);
  assert.strictEqual(r.reach, undefined, 'nothing recorded of what it reaches (R8)');
  assert.ok(fs.existsSync(path.join(where.own, 'my-tool', r.tree, 'api.json')));
});

test('a pack\'s scenario called: composes, named as itself, nothing said of what it reaches', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'), {calls: ['ch-pack-ci-failure-triage/s.ci_failure_triage']});
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 0, io.err);
  assert.ok(io.out.includes('It calls ch-pack-ci-failure-triage.'), io.out);
  assert.ok(!io.out.includes('ch-access-github') && !io.out.includes(GH), io.out);
});

test('refused: a callee nothing installed answers; a pack module\'s name; another module\'s device name', async () => {
  const {base, home, where} = setup();
  const cases = [
    [writeModule(path.join(base, 'work', 'a'), {calls: ['ch-nowhere/s.go']}), /my-tool calls ch-nowhere\/s\.go, and nothing installed here answers it: install the pack it belongs to, or remove the call\./],
    [writeModule(path.join(base, 'work', 'b'), {name: '@countinghouse/ch-step-redact'}), /scope is countinghouse's own/],
    [writeModule(path.join(base, 'work', 'c'), {name: 'my-redact', friendlyName: 'ch-step-redact'}), /my-redact's device name ch-step-redact is already used by @countinghouse\/ch-step-redact: change it in its api\.json\./]
  ];
  for (const [dir, want] of cases) {
    const io = ioWith(home, ['y']);
    assert.strictEqual(await addModule({dir}, io, {where}), 2, io.out);
    assert.match(io.err, want);
    assert.deepStrictEqual(io.asked, [], 'never asked');
  }
  assert.strictEqual(readOwnRecord(where), null);
});

test('no: nothing copied, nothing recorded', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const io = ioWith(home, ['n']);
  assert.strictEqual(await addModule({dir}, io, {where}), 1);
  assert.match(io.err, /my-tool was not added/);
  assert.strictEqual(readOwnRecord(where), null);
  assert.strictEqual(fs.existsSync(where.own), false);
});

test('the same code again: nothing asked; changed code: asked again, the new copy recorded', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  assert.strictEqual(await addModule({dir}, ioWith(home, ['y']), {where}), 0);
  const first = readOwnRecord(where).modules['my-tool'].tree;
  const again = ioWith(home, []);
  assert.strictEqual(await addModule({dir}, again, {where}), 0);
  assert.deepStrictEqual(again.asked, []);
  assert.match(again.out, /my-tool [0-9a-f]{12} is already added: nothing changed\./);
  fs.appendFileSync(path.join(dir, 'handlers', 'toolService', 'run.js'), '// edited\n');
  const changed = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, changed, {where}), 0);
  assert.deepStrictEqual(changed.asked, ['Add it? [y/N] ']);
  assert.notStrictEqual(readOwnRecord(where).modules['my-tool'].tree, first);
});

test('a key or data already kept for the name is said before the yes', async () => {
  const {base, home, where} = setup();
  fs.mkdirSync(path.join(where.moduleData, 'my-tool'), {recursive: true});
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const io = ioWith(home, ['n']);
  await addModule({dir}, io, {where});
  assert.ok(io.out.includes(`and the data kept in ${path.join(where.moduleData, 'my-tool')}`), io.out);
});
