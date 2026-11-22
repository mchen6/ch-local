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
const enforceFile = (where) => path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'fs-broker', 'virtual-drive.js');
function setup() {
  const base = fs.realpathSync.native(tmp('ch-owncmd-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, {recursive: true, mode: 0o700});
  fs.chmodSync(home, 0o700);
  installedHome(home, ['ci-failure-triage']);
  const where = layout({COUNTINGHOUSE_HOME: home});
  // the installed runtime can enforce here, Windows included (its
  // fs-broker virtual drive: countinghouse#195; lib/sandbox-support.js)
  fs.mkdirSync(path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'fs-broker'), {recursive: true});
  fs.writeFileSync(enforceFile(where), '');
  return {base, home, where};
}
const ioWith = (home, answers, interactive = true) => Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}, answers}), {interactive, stdoutTTY: interactive});
const GH = 'https://api.githubcopilot.com';

test('asked at a terminal only: elsewhere refused, naming the command', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const io = ioWith(home, [], false);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /add-module asks you, in your own terminal: run `.*add-module ".+mine"`(?: \(with COUNTINGHOUSE_HOME set to "[^"]+"\))? there\./);
  assert.strictEqual(readOwnRecord(where), null);
});

test('a terminal on standard input whose output is not one: refused, nothing asked (the lines must be seen)', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const io = Object.assign(ioWith(home, ['y']), {stdoutTTY: false});
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /add-module asks you, in your own terminal: run `.*add-module ".+mine"`(?: \(with COUNTINGHOUSE_HOME set to "[^"]+"\))? there\./);
  assert.deepStrictEqual(io.asked, []);
  assert.strictEqual(readOwnRecord(where), null);
});

test('a pack\'s part called: named, with no claim about its key; on yes copied and recorded', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'), {calls: ['ch-access-github/s.ch_access_github']});
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
  assert.deepStrictEqual([r.calls, r.from, r.friendlyName], [['ch-access-github/s.ch_access_github'], dir, 'my-tool']);
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
  assert.ok(io.out.includes(`It will use the data kept in ${path.join(where.moduleData, 'my-tool')}. Remove it first if this is a different module: delete ${path.join(where.moduleData, 'my-tool')}.`), io.out);
});

test('the sandbox set to audit, or one the runtime can\'t enforce here: refused before anything is asked', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {moduleSandbox: 'audit'}}));
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /Own modules run only with the sandbox enforced: run `.*settings set moduleSandbox enforce`(?: \(with COUNTINGHOUSE_HOME set to "[^"]+"\))? first\./);
  assert.deepStrictEqual(io.asked, []);
  fs.rmSync(where.settings);
  // (an installed runtime without the virtual drive: no enforce on Windows)
  fs.rmSync(enforceFile(where));
  const win = Object.assign(ioWith(home, ['y']), {platform: 'win32'});
  assert.strictEqual(await addModule({dir}, win, {where}), 2);
  assert.match(win.err, /Own modules run only with the sandbox enforced, and the installed runtime can't enforce it on this computer\./);
  assert.deepStrictEqual(win.asked, []);
  assert.strictEqual(readOwnRecord(where), null);
});

test('a key already stored for the name is said before the yes, with where it goes (the store a map, read as one)', async () => {
  const {base, home, where} = setup();
  require('../lib/credential-store').bind(home, 'my-tool', 'MY_TOKEN', {origin: 'https://api.mine.example', source: 'stored', value: `t${Date.now()}`}, {held: require('./store-helpers').FIXTURE_HELD});
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const io = ioWith(home, ['n']);
  await addModule({dir}, io, {where});
  assert.ok(io.out.includes('It will use the key already stored for my-tool (sent only to https://api.mine.example). Remove it first if this is a different module: `'), io.out);
});

test('the permissions it declares are said, and that the enforced sandbox grants none; a control character in them is shown as ?', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.countinghouse.permissions = {fs: [{path: '/etc/hosts', access: 'r'}], net: [{host: 'api.example.com'}], env: ['MY_SETTING', 'X\u001b[2K']};
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  const io = ioWith(home, ['n']);
  await addModule({dir}, io, {where});
  assert.ok(io.out.includes('It asks for the path /etc/hosts (read), the network host api.example.com, the environment variables MY_SETTING, X?[2K; under the enforced sandbox it gets none of them.\n'), io.out);
  assert.ok(!io.out.includes('\u001b'), 'no escape reaches the terminal');
});

test('a tool name a pack\'s scenario already lists is refused before the yes (the runtime would not load it)', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const api = JSON.parse(fs.readFileSync(path.join(dir, 'api.json'), 'utf8'));
  api.device.serviceList[SVC].actionList = [{name: 'ci_failure_triage'}];
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify(api));
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /my-tool's tool ci_failure_triage is already a tool of @countinghouse\/ch-pack-ci-failure-triage: rename the action in its api\.json\./);
  assert.deepStrictEqual(io.asked, []);
});

// The /code-review medium on B-own-add.
test('what the question shows is what is hashed: package.json swapped after it was read is refused, nothing asked (3)', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const io = ioWith(home, ['y']);
  const swap = () => fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'my-tool', version: '1.0.0', countinghouse: {role: 'scenario', calls: ['ch-access-github/s.ch_access_github']}}));
  assert.strictEqual(await addModule({dir}, io, {where, afterRead: swap}), 1);
  assert.match(io.err, /the folder changed while it was being added: run add-module again/);
  assert.deepStrictEqual(io.asked, []);
  assert.strictEqual(readOwnRecord(where), null);
});

test('a permission value is cut and its spaces collapsed: nothing long can push the question\'s lines away (4)', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.countinghouse.permissions = {fs: [{path: `x${' '.repeat(300)}It calls nothing.${'y'.repeat(500)}`, access: 'r'}]};
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  const io = ioWith(home, ['n']);
  await addModule({dir}, io, {where});
  const line = io.out.split('\n').find((l) => l.startsWith('It asks for'));
  assert.ok(line != null && line.length < 200 && !/ {2}/.test(line) && line.includes('…'), line);
});

test('a copy changed after it was added is repaired by adding its folder again (2)', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  assert.strictEqual(await addModule({dir}, ioWith(home, ['y']), {where}), 0);
  const tree = readOwnRecord(where).modules['my-tool'].tree;
  const copy = require('../lib/own-tree').copyDir(where, 'my-tool', tree);
  fs.chmodSync(path.join(copy, 'api.json'), 0o644);   // (read-only: a change takes a chmod first)
  fs.appendFileSync(path.join(copy, 'api.json'), ' ');
  const again = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, again, {where}), 0, again.err);
  assert.deepStrictEqual(again.asked, ['Add it? [y/N] '], 'asked again: its copy is not the code that was said yes to');
  assert.strictEqual(require('../lib/own-tree').copyIntact(where, 'my-tool', tree), true);
});

test('a device name a pack module calls is refused, installed or not (1)', async () => {
  const {base, home, where} = setup();
  const triage = path.join(where.moduleStore, '@countinghouse', 'ch-pack-ci-failure-triage', '0.1.0', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(triage, 'utf8'));
  pkg.countinghouse.calls.push('ch-nowhere/s.go');
  fs.writeFileSync(triage, JSON.stringify(pkg));
  const dir = writeModule(path.join(base, 'work', 'mine'), {name: 'my-nowhere', friendlyName: 'ch-nowhere'});
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /my-nowhere's device name ch-nowhere is one @countinghouse\/ch-pack-ci-failure-triage calls: change it in its api\.json\./);
});

test('a call to a service or action the callee does not declare is refused (7)', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'), {calls: ['ch-access-github/s.sendAll']});
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /my-tool calls ch-access-github\/s\.sendAll, and ch-access-github has no such action: correct the call in its package\.json\./);
});

test('names held in the store or by a module that can\'t be read: refused (6)', async () => {
  const {base, home, where} = setup();
  // a name only the store holds (a leftover version)
  fs.mkdirSync(path.join(where.moduleStore, 'my-tool', '1.0.0'), {recursive: true});
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /my-tool is already used here by pack module my-tool/);
  fs.rmSync(path.join(where.moduleStore, 'my-tool'), {recursive: true});
  // an installed module whose files can't be read: its names are not known
  fs.rmSync(path.join(where.moduleStore, '@countinghouse', 'ch-step-redact', '0.1.0', 'api.json'));
  const io2 = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io2, {where}), 1);
  assert.match(io2.err, /@countinghouse\/ch-step-redact's files can't be read here, so the names it holds are not known: run `.*install` again first\./);
  assert.deepStrictEqual(io2.asked, []);
});

test('the sandbox as a start runs it: audit the ceiling forbids is enforce, and adding is not refused (9)', async () => {
  const {base, home, where} = setup();
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {moduleSandbox: 'audit'}}));
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const io = ioWith(home, ['n']);
  const ceiling = {state: 'trusted', file: '/etc/ch-ceiling.json', ceiling: {forbid: ['moduleSandbox']}};
  assert.strictEqual(await addModule({dir}, io, {where, ceiling}), 1);
  assert.deepStrictEqual(io.asked, ['Add it? [y/N] ']);
});

test('nothing installed (no record): add-module says to install first; nothing copied (#113 high, 3)', async () => {
  const {base, home, where} = setup();
  fs.rmSync(where.modulesRecord);
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /nothing is installed yet: run `.*install --pack <name>`(?: \(with COUNTINGHOUSE_HOME set to "[^"]+"\))? first; your own modules run with what it installs\./);
  assert.deepStrictEqual(io.asked, []);
  assert.strictEqual(readOwnRecord(where), null);
});

test('calls listed twice or more than 256: refused before the yes, nothing copied (#113 high, 4)', async () => {
  const {base, home, where} = setup();
  const twice = writeModule(path.join(base, 'work', 'twice'), {calls: ['ch-access-github/s.ch_access_github', 'ch-access-github/s.ch_access_github']});
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir: twice}, io, {where}), 2);
  assert.match(io.err, /my-tool lists the call ch-access-github\/s\.ch_access_github twice: list each call once in its package\.json\./);
  const many = writeModule(path.join(base, 'work', 'many'), {calls: Array.from({length: 257}, (_, i) => `ch-x${i}/s.go`)});
  const io2 = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir: many}, io2, {where}), 2);
  assert.match(io2.err, /my-tool lists more than 256 calls: an own module lists at most 256\./);
  assert.deepStrictEqual([io.asked, io2.asked], [[], []]);
  assert.strictEqual(readOwnRecord(where), null);
});

test('a name another\'s is once Windows trims its trailing dots: refused (#113 high, 1)', async () => {
  const {base, home, where} = setup();
  fs.mkdirSync(path.join(where.moduleStore, 'my-tool.', '1.0.0'), {recursive: true});
  const dir = writeModule(path.join(base, 'work', 'mine'));
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /my-tool is already used here by pack module my-tool\./);
});

test('module text in a refusal is shown with nothing that moves the cursor (#113 high, trivia)', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'), {calls: ['ch-\u001b[2Knowhere/s.go']});
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.ok(!io.err.includes('\u001b'), JSON.stringify(io.err));
  assert.match(io.err, /my-tool calls ch-\?\[2Knowhere\/s\.go, and nothing installed here answers it/);
});

// the medium on #113's round 1
test('more than 256 calls is refused before any duplicate is looked for', async () => {
  const {base, home, where} = setup();
  const calls = Array.from({length: 300}, () => 'ch-x/s.go');
  const dir = writeModule(path.join(base, 'work', 'many'), {calls});
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /lists more than 256 calls/);
});

test('names compared by their Windows key against every holder: a re-add beside a store "my-tool.", a release\'s "my-tool."', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  assert.strictEqual(await addModule({dir}, ioWith(home, ['y']), {where}), 0);
  fs.appendFileSync(path.join(dir, 'handlers', 'toolService', 'run.js'), '// edited\n');
  fs.mkdirSync(path.join(where.moduleStore, 'my-tool.', '1.0.0'), {recursive: true});
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /my-tool is already used here by pack module my-tool\./);
  fs.rmSync(path.join(where.moduleStore, 'my-tool.'), {recursive: true});
  const rel = ioWith(home, ['y']);
  rel.release = {runtime: {packages: []}, packs: {}, pins: {'my-tool.': {version: '1.0.0'}}};
  assert.strictEqual(await addModule({dir}, rel, {where}), 2);
  assert.match(rel.err, /my-tool is a name this release holds/);
});

// the reviewer's re-probe of #113: a copy that can't be replaced after the
// yes is a fail line, never a crash; nothing recorded, the old copy marked
test('a repair that cannot replace the old copy fails with a line after the yes', {skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0)}, async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'));
  assert.strictEqual(await addModule({dir}, ioWith(home, ['y']), {where}), 0);
  const tree = readOwnRecord(where).modules['my-tool'].tree;
  const ot = require('../lib/own-tree');
  const file = path.join(ot.copyDir(where, 'my-tool', tree), 'api.json');
  fs.chmodSync(file, 0o000);
  try {
    const io = ioWith(home, ['y']);
    assert.strictEqual(await addModule({dir}, io, {where}), 1);
    assert.match(io.err, /your module's copy could not be replaced \(EACCES\): nothing was added/);
    assert.ok(fs.existsSync(ot.markerOf(where, 'my-tool', tree)), 'the old copy stays marked');
  } finally { fs.chmodSync(file, 0o444); }
});

// the reviewer on #116 (a): an own name equal to an installed module's
// short name is refused (one name, one module, in every command)
test('an own name that is an installed module\'s short name is refused', async () => {
  const {base, home, where} = setup();
  const dir = writeModule(path.join(base, 'work', 'mine'), {name: 'ch-step-redact', friendlyName: 'my-redact'});
  const io = ioWith(home, ['y']);
  assert.strictEqual(await addModule({dir}, io, {where}), 2);
  assert.match(io.err, /ch-step-redact is the short name of @countinghouse\/ch-step-redact here: give your module another name in its package\.json\./);
  assert.deepStrictEqual(io.asked, []);
});
