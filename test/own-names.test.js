'use strict';
require('./tmp-dirs');
// B-own-add: names between the packs and the user's own modules (the own-
// modules design §2.4). A module's data and key are kept by its name, so a
// pack that would bring a name or device name an own module holds is
// refused, naming remove-module; and add-module refuses a name the
// release's pins or runtime packages hold.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {addPack} = require('../lib/packs-command');
const {addModule} = require('../lib/own-command');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm} = require('./install-helpers');
const {layout} = require('../lib/home');
const {readOwnRecord, writeOwnRecord} = require('../lib/own-record');
const ownTree = require('../lib/own-tree');

const SVC = 'urn:countinghouse-test:serviceID:toolService';
function writeModule(dir, {name, friendlyName}) {
  fs.mkdirSync(path.join(dir, 'handlers', 'toolService'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '1.0.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName, serviceList: {[SVC]: {actionList: [{name: 'run'}]}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'toolService', 'run.js'), 'module.exports = async () => ({output: {}});\n');
  return fs.realpathSync.native(dir);
}
async function installed() {
  const base = fs.realpathSync.native(tmp('ch-ownnames-'));
  const home = path.join(base, 'home');
  const r = release();
  const io = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, io(), r.allow), 0);
  const where = layout({COUNTINGHOUSE_HOME: home});
  // the installed runtime can enforce here, Windows included (countinghouse#195)
  fs.mkdirSync(path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'fs-broker'), {recursive: true});
  fs.writeFileSync(path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'fs-broker', 'virtual-drive.js'), '');
  // an own module, placed and recorded as add-module does it
  const own = (name, friendlyName) => {
    const c = ownTree.checkFolder(writeModule(path.join(base, 'work', name), {name, friendlyName}), home);
    const tree = ownTree.treeHash(c.real, c.entries);
    ownTree.placeCopy(where, name, c.real, c.entries, tree);
    const modules = (readOwnRecord(where) || {modules: {}}).modules;
    writeOwnRecord(where, {v: 1, modules: {...modules, [name]: {tree, version: '1.0.0', friendlyName, addedAt: new Date(0).toISOString(), from: c.real, calls: []}}});
  };
  return {base, home, where, r, io, own};
}

test('add-pack refuses a pack that brings a device name an own module holds, naming remove-module; nothing added', async () => {
  const s = await installed();
  s.own('my-other', 'ch-step-other');
  const f = s.io();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, f, s.r.allow), 1);
  assert.match(f.err, /ch-step-other is the device name of your own module my-other: remove it first \(`.*remove-module my-other`\), or give yours another name and add it again; nothing was added/);
  assert.ok(!('other' in JSON.parse(fs.readFileSync(s.where.modulesRecord, 'utf8')).packs));
});

test('an install that would bring an own module\'s device name is refused too; an own.json that can\'t be read refuses it', async () => {
  const s = await installed();
  s.own('my-redact', 'ch-step-redact');
  // (an upgrade that moves it: the release brings the name again)
  const r2 = release({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
  const f = s.io();
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, f, r2.allow), 1);
  assert.match(f.err, /ch-step-redact is the device name of your own module my-redact: remove it first/);
  fs.writeFileSync(s.where.ownRecord, '{');
  const g = s.io();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, g, s.r.allow), 1);
  assert.match(g.err, /your own modules could not be read \(.*own\.json.*\); nothing was added/);
});

test('add-module refuses a name the runtime\'s packages or the release\'s pins hold', async () => {
  const s = await installed();
  const dir = writeModule(path.join(s.base, 'work', 'rt'), {name: 'countinghouse', friendlyName: 'my-rt'});
  const f = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['y']}), {interactive: true, stdoutTTY: true});
  f.release = s.r.allow;
  assert.strictEqual(await addModule({dir}, f, {where: s.where}), 2);
  assert.match(f.err, /countinghouse is a name this release holds: give your module another name in its package\.json\./);
  assert.deepStrictEqual(f.asked, []);
});

// the reviewer on #116 (a): a pack module whose short name is an own
// module's name is refused too
test('add-pack refuses a pack module whose short name is an own module\'s name', async () => {
  const s = await installed();
  s.own('ch-step-other', 'my-other-device');
  const f = s.io();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, f, s.r.allow), 1);
  assert.match(f.err, /@countinghouse\/ch-step-other's short name is the name of your own module ch-step-other: remove it first/);
});
