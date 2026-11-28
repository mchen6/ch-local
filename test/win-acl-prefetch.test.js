'use strict';
require('./tmp-dirs');
// winAcl.prefetch (cold-start part 3): several paths' ACLs in one PowerShell
// run, answered one path at a time as fileAcl does. Every system: the runner,
// the lstat and the single read are given (a faked runner), so what is asked
// of PowerShell, and what each path is answered, are seen exactly.
// - each plain file or directory is read in the one run; a link, or a path
//   that isn't there, is never sent (no ACL read through a link, even to look)
//   and is answered by today's single read, with today's answer;
// - a path whose read failed in the batch is answered by today's single read,
//   so its error is exactly today's, and every other path keeps its own;
// - a run that fails as a whole: every path by today's single read.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const winAcl = require('../lib/win-acl');

const ACL = (owner) => ({user: 'S-1-5-21-1-1-1-1000', owner, otherAces: false, rules: [{sid: owner, rights: 2032127, type: 'Allow', inheritOnly: false}]});
const st = (kind) => ({isSymbolicLink: () => kind === 'link', isFile: () => kind === 'file', isDirectory: () => kind === 'dir'});
const kinds = (map) => (p) => { const k = map[path.resolve(p)]; if (k == null) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'}); return st(k); };
const P = (n) => path.resolve(`/h/${n}`);

test('one run reads every plain file and directory; each answered from it; the single read never used', () => {
  const runs = [];
  const run = (script, env) => { runs.push(env.CH_ACL_FILES.split('\n')); return JSON.stringify([ACL('A'), ACL('B')]); };
  const single = () => { throw new Error('the single read was used'); };
  const read = winAcl.prefetch([P('home'), P('home/secret')], {run, lstat: kinds({[P('home')]: 'dir', [P('home/secret')]: 'file'}), single});
  assert.deepStrictEqual(runs, [[P('home'), P('home/secret')]]);
  assert.deepStrictEqual(read(P('home')), ACL('A'));
  assert.deepStrictEqual(read(P('home/secret')), ACL('B'));
});

test('a path whose read failed in the batch gets today\'s single read and its exact error; the others keep their own', () => {
  const run = () => JSON.stringify([ACL('A'), {failed: true}]);
  const today = Object.assign(new Error('Command failed: powershell.exe ... access denied'), {status: 1});
  const asked = [];
  const single = (p) => { asked.push(p); throw today; };
  const read = winAcl.prefetch([P('dir'), P('dir/file')], {run, lstat: kinds({[P('dir')]: 'dir', [P('dir/file')]: 'file'}), single});
  assert.deepStrictEqual(read(P('dir')), ACL('A'));
  assert.throws(() => read(P('dir/file')), (e) => e === today);
  assert.deepStrictEqual(asked, [P('dir/file')]);
});

test('a link, or a path that is not there, is never sent: answered by today\'s single read', () => {
  const runs = [];
  const run = (script, env) => { runs.push(env.CH_ACL_FILES.split('\n')); return JSON.stringify([ACL('A')]); };
  const asked = [];
  const single = (p) => { asked.push(p); return ACL(`single:${path.basename(p)}`); };
  const read = winAcl.prefetch([P('home'), P('link'), P('gone')], {run, lstat: kinds({[P('home')]: 'dir', [P('link')]: 'link'}), single});
  assert.deepStrictEqual(runs, [[P('home')]], 'the link and the missing path not sent');
  assert.deepStrictEqual(read(P('link')), ACL('single:link'));
  assert.deepStrictEqual(read(P('gone')), ACL('single:gone'));
  assert.deepStrictEqual(asked, [P('link'), P('gone')]);
});

test('a path under a listed folder that is a link (or missing) is never sent: no ACL read through a linked folder', () => {
  const runs = [];
  const run = (script, env) => { runs.push(env.CH_ACL_FILES.split('\n')); return JSON.stringify([ACL('O')]); };
  const asked = [];
  const single = (p) => { asked.push(p); return ACL(`single:${path.basename(p)}`); };
  // (lstat of the file goes through the linked folder and finds a file)
  const read = winAcl.prefetch([P('jdir'), P('jdir/secret'), P('other')], {run, lstat: kinds({[P('jdir')]: 'link', [P('jdir/secret')]: 'file', [P('other')]: 'file'}), single});
  assert.deepStrictEqual(runs, [[P('other')]]);
  assert.deepStrictEqual(read(P('other')), ACL('O'));
  assert.deepStrictEqual(read(P('jdir/secret')), ACL('single:secret'));
});

test('a run that fails as a whole: every path by today\'s single read', () => {
  const run = () => { throw new Error('powershell did not start'); };
  const single = (p) => ACL(`single:${path.basename(p)}`);
  const read = winAcl.prefetch([P('a'), P('b')], {run, lstat: kinds({[P('a')]: 'dir', [P('b')]: 'file'}), single});
  assert.deepStrictEqual([read(P('a')), read(P('b'))], [ACL('single:a'), ACL('single:b')]);
  // (and an answer of the wrong shape, as one that fails)
  const odd = winAcl.prefetch([P('a'), P('b')], {run: () => JSON.stringify([ACL('A')]), lstat: kinds({[P('a')]: 'dir', [P('b')]: 'file'}), single});
  assert.deepStrictEqual(odd(P('a')), ACL('single:a'));
});

// (the Reviewer's high read of part 3: a whole run that timed out is no
// slower to a refusal than today's first single read, with today's code)
test('a whole run that timed out: every sent path answers that timeout, no further run', () => {
  let runs = 0;
  const timedOut = Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), {code: 'ETIMEDOUT'});
  const run = () => { runs++; throw timedOut; };
  let single = 0;
  const read = winAcl.prefetch([P('a'), P('a/b')], {run, lstat: kinds({[P('a')]: 'dir', [P('a/b')]: 'file'}), single: () => { single++; return ACL('S'); }});
  assert.throws(() => read(P('a')), (e) => e === timedOut);
  assert.throws(() => read(P('a/b')), (e) => e === timedOut);
  assert.strictEqual(runs, 1);
  assert.strictEqual(single, 0, 'no single read after a timeout');
});

test('a child listed before its folder, or a path differing only by case from one listed, is never sent', () => {
  const runs = [];
  const run = (script, env) => { const l = env.CH_ACL_FILES.split('\n'); runs.push(l); return JSON.stringify(l.map((x) => ACL(path.basename(x)))); };
  const asked = [];
  const single = (p) => { asked.push(p); return ACL(`single:${path.basename(p)}`); };
  const lstat = () => st('file');
  const read = winAcl.prefetch([P('dir/file'), P('dir'), P('Other'), P('other')], {run, lstat, single});
  assert.deepStrictEqual(runs, [[P('dir'), P('Other')]]);
  assert.deepStrictEqual(read(P('dir/file')), ACL('single:file'));
  assert.deepStrictEqual(read(P('other')), ACL('single:other'));
  assert.deepStrictEqual(read(P('dir')), ACL('dir'));
});

test('with no single read given, the fallback is win-acl\'s exported fileAcl (a stub of it is used)', (t) => {
  const asked = [];
  t.mock.method(winAcl, 'fileAcl', (p) => { asked.push(p); return ACL('stub'); });
  const read = winAcl.prefetch([P('a')], {run: () => 'not json', lstat: kinds({[P('a')]: 'dir'})});
  assert.deepStrictEqual(read(P('a')), ACL('stub'));
  assert.deepStrictEqual(asked, [P('a')]);
});

test('the batched script reads each path in a try of its own, as the single one reads it', () => {
  assert.match(winAcl.FILE_ACLS_EACH_SCRIPT, /foreach \(\$f in .*\) \{ try \{ .*\(A \$f\).* \} catch \{ .*failed.* \} \}/);
  assert.ok(winAcl.FILE_ACLS_EACH_SCRIPT.includes(winAcl.ACL_FN.join('\n')), 'the same ACL function: the same objects');
});

test('with the filesystem\'s own lstat: a real folder is sent, a path not there is not', () => {
  const dir = require('./fake-io').tmp('ch-prefetch-');
  const runs = [];
  const run = (script, env) => { runs.push(env.CH_ACL_FILES.split('\n')); return JSON.stringify([ACL('D')]); };
  const read = winAcl.prefetch([dir, path.join(dir, 'missing')], {run, single: (p) => ACL(`single:${path.basename(p)}`)});
  assert.deepStrictEqual(runs, [[path.resolve(dir)]]);
  assert.deepStrictEqual(read(dir), ACL('D'));
  assert.deepStrictEqual(read(path.join(dir, 'missing')), ACL('single:missing'));
});

