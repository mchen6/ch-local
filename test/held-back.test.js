'use strict';
require('./tmp-dirs');
// The held-back file start passes the runtime (countinghouse #490
// --heldBackFile; A-firstrun d1): availability's verdict as package names and
// reason classes, in the shape the runtime accepts, written private.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {tmp} = require('./fake-io');
const {contentOf, write, FILE} = require('../lib/held-back');

const av = (entries) => ({unavailable: new Map(entries)});
const whereIn = (h) => ({launcher: path.join(h, 'bin', 'ch-local.js')});

test('each held-back top-level module by its name and reason; calls with its root and via; not installed as not-installed', () => {
  const h = tmp('ch-held-');
  const doc = JSON.parse(contentOf(whereIn(h), av([
    ['@countinghouse/ch-pack-ci-failure-triage', {kind: 'calls', root: 'credential', via: '@countinghouse/ch-access-github'}],
    ['@countinghouse/ch-pack-other', {kind: 'off', root: 'off', via: null}],
    ['@countinghouse/ch-pack-gone', {kind: 'calls', root: 'not installed', via: 'ch-nowhere'}],
    ['@countinghouse/ch-pack-capped', {kind: 'ceiling', root: 'ceiling', via: null}]
  ])));
  assert.deepStrictEqual(doc, {v: 1, modules: [
    {name: '@countinghouse/ch-pack-ci-failure-triage', reason: 'calls', root: 'credential', via: '@countinghouse/ch-access-github'},
    {name: '@countinghouse/ch-pack-other', reason: 'off'},
    {name: '@countinghouse/ch-pack-gone', reason: 'calls', root: 'not-installed', via: 'ch-nowhere'},
    {name: '@countinghouse/ch-pack-capped', reason: 'ceiling'}
  ]}, 'no launcher: none installed');
});

test('nothing but names and reason classes: a name off the npm rule is left out; a chain it can\'t name is calls alone; at most 256', () => {
  const h = tmp('ch-held-');
  const doc = JSON.parse(contentOf(whereIn(h), av([
    ['Not-A-Name', {kind: 'off'}],
    ['-leading', {kind: 'off'}],
    ['ok-name', {kind: 'calls', root: 'credential', via: '~bad'}],
    ['other-ok', {kind: 'something-new'}]
  ])));
  assert.deepStrictEqual(doc.modules, [{name: 'ok-name', reason: 'calls'}]);
  const many = av(Array.from({length: 300}, (_, i) => [`m${i}`, {kind: 'off'}]));
  assert.strictEqual(JSON.parse(contentOf(whereIn(h), many)).modules.length, 256);
});

test('the launcher is the kernel\'s real path of <home>/bin/ch-local.js, when there is one', () => {
  const h = tmp('ch-held-');
  fs.mkdirSync(path.join(h, 'bin'));
  fs.writeFileSync(path.join(h, 'bin', 'ch-local.js'), '');
  const doc = JSON.parse(contentOf(whereIn(h), av([])));
  assert.strictEqual(doc.launcher, fs.realpathSync.native(path.join(h, 'bin', 'ch-local.js')));
});

test('written whole and private: a regular file under its own name, 0600 (POSIX), replaced in place', {skip: process.platform === 'win32' && 'the ACL is win-acl\'s, tested there'}, () => {
  const dir = tmp('ch-held-run-');
  const file = write(dir, '{"v":1,"modules":[]}\n');
  assert.strictEqual(file, path.join(dir, FILE));
  const st = fs.lstatSync(file);
  assert.ok(st.isFile() && !st.isSymbolicLink());
  assert.strictEqual(st.mode & 0o777, 0o600);
  write(dir, '{"v":1,"modules":[{"name":"x","reason":"off"}]}\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"v":1,"modules":[{"name":"x","reason":"off"}]}\n');
  assert.deepStrictEqual(fs.readdirSync(dir), [FILE], 'no temporary file left');
});
