'use strict';
require('./tmp-dirs');
// B-own-add: `ch-local status` names the user's own modules (the own-modules
// design §2.6, §5 line 11): each with its code's short hash, and on with its
// tools, or why a start would not load it, in a start's words.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const {layout} = require('../lib/home');
const {installedHome} = require('./install-helpers');
const {addModule} = require('../lib/own-command');
const {status} = require('../lib/packs-command');
const {readOwnRecord} = require('../lib/own-record');
const {copyDir} = require('../lib/own-tree');

const SVC = 'urn:countinghouse-test:serviceID:toolService';
function setup() {
  const base = fs.realpathSync.native(tmp('ch-ownstatus-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, {recursive: true});
  installedHome(home, ['ci-failure-triage']);
  const where = layout({COUNTINGHOUSE_HOME: home});
  const dir = path.join(base, 'work', 'mine');
  fs.mkdirSync(path.join(dir, 'handlers', 'toolService'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'my-tool', version: '1.0.0', countinghouse: {role: 'scenario'}}));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: 'my-tool', serviceList: {[SVC]: {actionList: [{name: 'run', description: 'runs'}]}}}}));
  fs.writeFileSync(path.join(dir, 'handlers', 'toolService', 'run.js'), 'module.exports = async () => ({output: {}});\n');
  return {home, where, dir};
}
const io = (home) => Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}, answers: ['y']}), {interactive: true, stdoutTTY: true, alive: () => false, hostname: 'box-1'});
const statusOf = async (home) => { const f = io(home); assert.strictEqual(await status({}, f), 0, f.err); return f.out; };
const ENFORCE = process.platform !== 'win32' || 'enforce on Windows: countinghouse#195';

test('an own module added: listed apart, by its code\'s short hash, on with its tools', {skip: ENFORCE === true ? false : ENFORCE}, async () => {
  const {home, where, dir} = setup();
  assert.strictEqual(await addModule({dir}, io(home), {where}), 0);
  const tree = readOwnRecord(where).modules['my-tool'].tree;
  const out = await statusOf(home);
  assert.match(out, new RegExp(`^own modules:\\n  my-tool \\(own, unpinned, ${tree.slice(0, 12)}\\) +on; tools: run$`, 'm'));
});

test('an own module a start would hold back: why, in a start\'s words (changed; the sandbox)', {skip: ENFORCE === true ? false : ENFORCE}, async () => {
  const {home, where, dir} = setup();
  assert.strictEqual(await addModule({dir}, io(home), {where}), 0);
  const tree = readOwnRecord(where).modules['my-tool'].tree;
  fs.appendFileSync(path.join(copyDir(where, 'my-tool', tree), 'api.json'), ' ');
  assert.match(await statusOf(home), new RegExp(`^  my-tool \\(own, unpinned, ${tree.slice(0, 12)}\\) +not loaded: its files changed since you added it: run \`.*add-module "${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\` again$`, 'm'));
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {moduleSandbox: 'audit'}}));
  assert.match(await statusOf(home), /^ {2}my-tool \(own, unpinned, [0-9a-f]{12}\) +not loaded: its files changed/m, 'the copy first');
});

test('the sandbox set to audit: an intact own module is not loaded, said so', {skip: ENFORCE === true ? false : ENFORCE}, async () => {
  const {home, where, dir} = setup();
  assert.strictEqual(await addModule({dir}, io(home), {where}), 0);
  fs.writeFileSync(where.settings, JSON.stringify({version: 1, values: {moduleSandbox: 'audit'}}));
  assert.match(await statusOf(home), /^ {2}my-tool \(own, unpinned, [0-9a-f]{12}\) +not loaded: own modules run only with the sandbox enforced$/m);
});

test('an own.json that cannot be read: said, the packs still listed', async () => {
  const {home, where} = setup();
  fs.writeFileSync(where.ownRecord, '{');
  const out = await statusOf(home);
  assert.match(out, /^your own modules could not be listed: .*own\.json/m);
  assert.match(out, /^packs:$/m);
});
