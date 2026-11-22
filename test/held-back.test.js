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
  // (a home that isn't the default, named before the npx form: auto-apply
  // still carries the line -- the medium on the follow-up to #129, 2)
  assert.ok(isCredentialLine('ch-access-github needs a credential: in your own terminal run `COUNTINGHOUSE_HOME="/home/dev/ch" npx @countinghouse/ch-local credentials add ch-access-github`'));
  assert.ok(isCredentialLine('ch-access-github needs a credential: in your own terminal run `COUNTINGHOUSE_HOME="<its folder>" npx @countinghouse/ch-local credentials add ch-access-github`'));
  assert.ok(!isCredentialLine('ch-access-github needs a credential: in your own terminal run `COUNTINGHOUSE_HOME="/h" rm -rf / credentials add x`'));
  for (const odd of ['/home/a$b/.countinghouse', '/home/a"b/.countinghouse', '/home/a`b/.countinghouse']) {
    const line = credentialLine({launcher: path.join(odd, 'bin', 'ch-local.js')}, '@countinghouse/ch-access-github');
    assert.strictEqual(line, 'ch-access-github needs a credential: in your own terminal run `npx @countinghouse\/ch-local credentials add ch-access-github`', odd);
    assert.ok(isCredentialLine(line), odd);
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
    assert.strictEqual(credentialLine(whereIn(h), 'ch-access-github'), 'ch-access-github needs a credential: in your own terminal run `npx @countinghouse\/ch-local credentials add ch-access-github`');
  }
  assert.strictEqual(safeLauncher(whereIn(path.join(base, 'none')), 'linux'), null, 'none installed');
});

// countinghouse's wire vectors for the file (heldBackFile, copied in
// test/vectors/module-messages.json at c313b561: #534's rule, with gone). A
// checker written from the vectors' rule text is first held to the vectors
// themselves (it takes every accepted file and refuses every refused one).
// Then:
// - every accepted file is written exactly as given from the same verdict;
// - from each refused file's own entries, fields and all, the writer writes
//   only a file the checker takes.
// (the reviewer's high on #106, 3, and round 2, 5; the medium on round 2, 3)
const RULE_REASONS = ['credential', 'off', 'ceiling', 'missing', 'pin', 'withdrawn', 'stopped', 'restart', 'changed', 'gone', 'sandbox', 'collision', 'refused', 'calls'];
const RULE_ROOTS = ['credential', 'off', 'ceiling', 'missing', 'pin', 'withdrawn', 'not-installed'];
const RULE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const rulePackage = (n) => typeof n === 'string' && n.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(n);
const ruleCallee = (n) => typeof n === 'string' && n.length >= 1 && n.length <= 64 && !/[/.\u0000-\u001f\u007f]/.test(n);
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
function ruleTakes(doc) {
  if (!isObj(doc) || doc.v !== 1 || !Array.isArray(doc.modules) || doc.modules.length > 256) return false;
  if (Object.keys(doc).some((k) => !['v', 'modules', 'launcher'].includes(k))) return false;
  const seen = new Set();
  for (const m of doc.modules) {
    if (!isObj(m) || Object.keys(m).some((k) => !['name', 'reason', 'root', 'via', 'code'].includes(k))) return false;
    if (!rulePackage(m.name) || seen.has(m.name) || !RULE_REASONS.includes(m.reason)) return false;
    seen.add(m.name);
    // code exactly on refused
    if ((m.reason === 'refused') !== (m.code !== undefined)) return false;
    if (m.code !== undefined && !(typeof m.code === 'string' && RULE_CODE.test(m.code))) return false;
    // root only on calls; via exactly when root is, or on collision
    if (m.root !== undefined && (m.reason !== 'calls' || !RULE_ROOTS.includes(m.root))) return false;
    if (m.reason === 'collision') {
      if (m.root !== undefined || !rulePackage(m.via)) return false;
    } else {
      if ((m.root !== undefined) !== (m.via !== undefined)) return false;
      if (m.via !== undefined && !(m.root === 'not-installed' ? ruleCallee(m.via) : rulePackage(m.via))) return false;
    }
  }
  return true;
}
test('the runtime\'s heldBackFile vectors: each accepted file is written as given; from a refused file\'s entries, only a file the rule takes', () => {
  const V = require('./vectors/module-messages.json').heldBackFile;
  assert.ok(V.accepted.length >= 7 && V.refused.length >= 23);
  for (const {why, file} of V.accepted) assert.ok(ruleTakes(file), `the checker takes: ${why}`);
  for (const {why, file} of V.refused) assert.ok(!ruleTakes(file), `the checker refuses: ${why}`);
  const h = tmp('ch-held-');   // no launcher here: the vectors carry none
  // (the verdict an entry would come from, every field of it passed on)
  const verdict = (modules) => new Map(modules.map((m) => [m.name, {...m, kind: m.reason, root: m.root === 'not-installed' ? 'not installed' : m.root}]));
  for (const {why, file} of V.accepted) assert.deepStrictEqual(JSON.parse(contentOf(whereIn(h), verdict(file.modules))), file, why);
  for (const {why, file} of V.refused) {
    const entries = Array.isArray(file.modules) ? file.modules.filter(isObj) : [];
    const out = JSON.parse(contentOf(whereIn(h), verdict(entries)));
    assert.ok(ruleTakes(out), `${why}: ${JSON.stringify(out).slice(0, 200)}`);
  }
});

// A-heldback-win: the file is born private on Windows too: the temporary
// file is made by win-acl createPrivate (an owner-only protected DACL, in
// the call that creates it), then renamed in place
test('the win32 branch: the file is made by createPrivate under a temporary name, then renamed (POSIX rename semantics here)', () => {
  const dir = tmp('ch-held-win-');
  const made = [];
  const acl = {createPrivate: (file, data) => { made.push(path.basename(file)); fs.writeFileSync(file, data, {flag: 'wx'}); }};
  const file = write(dir, '{"v":1,"modules":[]}\n', {platform: 'win32', acl});
  assert.strictEqual(made.length, 1);
  assert.match(made[0], /^\.held-back\.json\.\d+\.\d+\.tmp$/, 'a temporary name, made exclusively');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"v":1,"modules":[]}\n');
  assert.deepStrictEqual(fs.readdirSync(dir), [FILE], 'renamed in place');
});

// (the Windows leg: in a directory whose ACL grants Users read, inherited by
// what is made there, a plain file is not private, and the real write is:
// nothing inherited; the medium on A-heldback-win, 1)
test('on Windows a real write is this user\'s alone even where the directory grants others read', {skip: process.platform !== 'win32' && 'Windows ACLs'}, () => {
  const winAcl = require('../lib/win-acl');
  const dir = tmp('ch-held-acl-');
  const granted = require('node:child_process').spawnSync('icacls', [dir, '/grant', '*S-1-5-32-545:(OI)(CI)(R)'], {encoding: 'utf8', windowsHide: true});
  assert.strictEqual(granted.status, 0, `${granted.stdout}${granted.stderr}`);
  const plain = path.join(dir, 'plain.json');
  fs.writeFileSync(plain, '{}');
  assert.notStrictEqual(winAcl.privateProblem(plain, winAcl.fileAcl(plain)), null, 'premise: a plain file there inherits the grant');
  const file = write(dir, '{"v":1,"modules":[]}\n');
  assert.strictEqual(winAcl.privateProblem(file, winAcl.fileAcl(file)), null);
});

// E10 (A-own-gone): an own module whose copy is gone is written as gone, a
// reason and never a root (countinghouse #534, c313b561)
test('an own module whose copy is gone: written with reason gone, apart from changed; a caller\'s chain never roots at it', () => {
  const h = tmp('ch-held-');
  const out = JSON.parse(contentOf(whereIn(h), new Map([
    ['my-tool', {kind: 'gone', reason: 'its copy is gone'}],
    ['other-tool', {kind: 'changed', reason: 'its files changed'}],
    ['caller-tool', {kind: 'calls', root: 'gone', via: 'my-tool'}]])));
  assert.deepStrictEqual(out.modules, [{name: 'my-tool', reason: 'gone'}, {name: 'other-tool', reason: 'changed'}, {name: 'caller-tool', reason: 'calls'}]);
});
