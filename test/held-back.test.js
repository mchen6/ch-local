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
const held = (entries) => av(entries).unavailable;
const whereIn = (h) => ({launcher: path.join(h, 'bin', 'ch-local.js')});

test('each held-back top-level module by its name and reason; calls with its root and via; not installed as not-installed', () => {
  const h = tmp('ch-held-');
  const doc = JSON.parse(contentOf(whereIn(h), held([
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
  const doc = JSON.parse(contentOf(whereIn(h), held([
    ['Not-A-Name', {kind: 'off'}],
    ['-leading', {kind: 'off'}],
    ['ok-name', {kind: 'calls', root: 'credential', via: '~bad'}],
    ['other-ok', {kind: 'something-new'}]
  ])));
  assert.deepStrictEqual(doc.modules, [{name: 'ok-name', reason: 'calls'}]);
  const many = av(Array.from({length: 300}, (_, i) => [`m${i}`, {kind: 'off'}]));
  assert.strictEqual(JSON.parse(contentOf(whereIn(h), many.unavailable)).modules.length, 256);
});

test('the launcher is the kernel\'s real path of <home>/bin/ch-local.js, when there is one', () => {
  const h = tmp('ch-held-');
  fs.mkdirSync(path.join(h, 'bin'));
  fs.writeFileSync(path.join(h, 'bin', 'ch-local.js'), '');
  const doc = JSON.parse(contentOf(whereIn(h), held([])));
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

// the medium on d1, 6 and 7: the credential line names the launcher by its
// real path, the one the overview names; a path a shell would read inside
// double quotes gives the bare form instead
test('the credential line: the launcher\'s real path in the launcher form; a path with a shell character in the bare form; both matched', () => {
  const {credentialLine, isCredentialLine} = require('../lib/credentials-command');
  const h = tmp('ch-held-');
  fs.mkdirSync(path.join(h, 'bin'));
  fs.writeFileSync(path.join(h, 'bin', 'ch-local.js'), '');
  const real = fs.realpathSync.native(path.join(h, 'bin', 'ch-local.js'));
  const good = credentialLine(whereIn(h), '@countinghouse/ch-access-github');
  assert.strictEqual(good, `ch-access-github needs a credential: in your own terminal run \`node "${real}" credentials add ch-access-github\``);
  assert.ok(isCredentialLine(good));
  for (const odd of ['/home/a$b/.countinghouse', '/home/a"b/.countinghouse', '/home/a`b/.countinghouse']) {
    const line = credentialLine({launcher: path.join(odd, 'bin', 'ch-local.js')}, '@countinghouse/ch-access-github');
    assert.strictEqual(line, 'ch-access-github needs a credential: in your own terminal run `ch-local credentials add ch-access-github`', odd);
    assert.ok(isCredentialLine(line));
  }
});

// the reviewer's high on #106, 3: a callee not installed by the runtime's own
// rule (1 to 64 characters, no / or .), else the entry is calls alone (the
// runtime would refuse the whole file)
test('a callee not installed is named only as the runtime takes one; otherwise the entry is calls alone', () => {
  const h = tmp('ch-held-');
  const doc = JSON.parse(contentOf(whereIn(h), av([
    ['ok-a', {kind: 'calls', root: 'not installed', via: 'ch-nowhere'}],
    ['ok-b', {kind: 'calls', root: 'not installed', via: 'my.tool'}],
    ['ok-c', {kind: 'calls', root: 'not installed', via: 'x'.repeat(65)}]
  ]).unavailable));
  assert.deepStrictEqual(doc.modules, [
    {name: 'ok-a', reason: 'calls', root: 'not-installed', via: 'ch-nowhere'},
    {name: 'ok-b', reason: 'calls'},
    {name: 'ok-c', reason: 'calls'}
  ]);
});

// the reviewer's high on #106, 7: the runtime reads at most 64 KiB
test('the file never passes 64 KiB: entries stop before it would', () => {
  const h = tmp('ch-held-');
  const long = av(Array.from({length: 256}, (_, i) => [`@${'s'.repeat(100)}/${'m'.repeat(100)}-${i}`, {kind: 'calls', root: 'credential', via: `@${'v'.repeat(100)}/${'w'.repeat(100)}`}]));
  const text = contentOf(whereIn(h), long.unavailable);
  assert.ok(Buffer.byteLength(text) <= 64 * 1024, String(Buffer.byteLength(text)));
  assert.ok(JSON.parse(text).modules.length > 0 && JSON.parse(text).modules.length < 256);
});

// the reviewer's high on #106, 5, 6 and 8: one launcher helper, the runtime's
// rule: a backslash off Windows, a typographic quote, or no launcher at all
// gives none, and the credential line's bare form
test('the launcher, the runtime\'s rule: none for a missing one, a backslash off Windows or a typographic quote; then the bare form', {skip: process.platform === 'win32' && 'POSIX names'}, () => {
  const {credentialLine} = require('../lib/credentials-command');
  const {safeLauncher} = require('../lib/home');
  const base = tmp('ch-held-');
  for (const name of ['a\\b', 'a\u201cb', 'a\u2019b']) {
    const h = path.join(base, name);
    fs.mkdirSync(path.join(h, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(h, 'bin', 'ch-local.js'), '');
    assert.strictEqual(safeLauncher(whereIn(h), 'linux'), null, JSON.stringify(name));
    assert.strictEqual(JSON.parse(contentOf(whereIn(h), new Map())).launcher, undefined);
    assert.strictEqual(credentialLine(whereIn(h), 'ch-access-github'), 'ch-access-github needs a credential: in your own terminal run `ch-local credentials add ch-access-github`');
  }
  assert.strictEqual(safeLauncher(whereIn(path.join(base, 'none')), 'linux'), null, 'none installed');
});
