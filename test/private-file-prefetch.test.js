'use strict';
require('./tmp-dirs');
// readPrivateIn on Windows (cold-start part 3): the folder's ACL and the
// file's in one win-acl prefetch, read at the moment of the read and kept for
// it alone; the checks and their refusals as before (lstat first, the folder
// then the file). Every system: the platform and the ACL reader are given.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {tmp} = require('./fake-io');
const {readPrivateIn} = require('../lib/private-file');
const {privateProblem} = require('../lib/win-acl');

const me = 'S-1-5-21-1-2-3-1001';
const mine = {owner: me, user: me, otherAces: false, rules: [{sid: me, type: 'Allow', rights: 2032127}, {sid: 'S-1-5-18', type: 'Allow', rights: 2032127}]};
const open = {owner: me, user: me, otherAces: false, rules: [{sid: me, type: 'Allow', rights: 2032127}, {sid: 'S-1-5-32-545', type: 'Allow', rights: 1179817}]};
const reader = (aclOf) => {
  const seen = {prefetched: [], single: 0};
  return {seen, acl: {privateProblem, fileAcl: () => { seen.single++; return mine; },
    prefetch: (paths) => { seen.prefetched.push(paths.map((p) => path.resolve(p))); return aclOf; }}};
};

test('Windows: the folder and the file in one prefetch, never a single read; the bytes read', () => {
  const dir = tmp('ch-pf-win-');
  fs.writeFileSync(path.join(dir, 'secret'), 'abc');
  const r = reader(() => mine);
  assert.strictEqual(readPrivateIn(dir, 'secret', 80, 'win32', r.acl).toString(), 'abc');
  assert.deepStrictEqual(r.seen.prefetched, [[path.resolve(dir), path.resolve(dir, 'secret')]]);
  assert.strictEqual(r.seen.single, 0);
});

test('Windows: a file another user can reach is refused as before, from the prefetched ACL; a second read prefetches again (nothing kept)', () => {
  const dir = tmp('ch-pf-win-');
  const file = path.join(dir, 'daemon.json');
  fs.writeFileSync(file, '{}');
  const r = reader((p) => (path.resolve(p) === path.resolve(file) ? open : mine));
  assert.throws(() => readPrivateIn(dir, 'daemon.json', 4096, 'win32', r.acl), /accessible by S-1-5-32-545/);
  assert.throws(() => readPrivateIn(dir, 'daemon.json', 4096, 'win32', r.acl), /accessible by S-1-5-32-545/);
  assert.strictEqual(r.seen.prefetched.length, 2);
  assert.strictEqual(r.seen.single, 0);
});

test('Windows: a missing file is refused by lstat as before; no ACL read of it', () => {
  const dir = tmp('ch-pf-win-');
  const asked = [];
  const acl = {privateProblem, fileAcl: () => mine, prefetch: () => (p) => { asked.push(path.resolve(p)); return mine; }};
  assert.throws(() => readPrivateIn(dir, 'secret', 80, 'win32', acl), (e) => e.code === 'ENOENT');
  assert.deepStrictEqual(asked, [path.resolve(dir)]);
});

// (the medium on part 3: a path the batch couldn't answer goes to the
// caller's own single read, never win-acl's, which would start PowerShell)
test('Windows: a path the batch could not answer goes to the caller\'s own single read', () => {
  const dir = tmp('ch-pf-win-');
  fs.writeFileSync(path.join(dir, 'secret'), 'abc');
  const asked = [];
  const acl = {privateProblem, fileAcl: (p) => { asked.push(path.resolve(p)); return mine; },
    prefetch: (paths, opts) => require('../lib/win-acl').prefetch(paths, Object.assign({}, opts, {run: () => { throw new Error('the run failed'); }}))};
  assert.strictEqual(readPrivateIn(dir, 'secret', 80, 'win32', acl).toString(), 'abc');
  assert.deepStrictEqual(asked, [path.resolve(dir), path.resolve(dir, 'secret')]);
});

test('Windows: a reader with no prefetch is used as before, two single reads', () => {
  const dir = tmp('ch-pf-win-');
  fs.writeFileSync(path.join(dir, 'secret'), 'abc');
  let single = 0;
  assert.strictEqual(readPrivateIn(dir, 'secret', 80, 'win32', {privateProblem, fileAcl: () => { single++; return mine; }}).toString(), 'abc');
  assert.strictEqual(single, 2);
});

