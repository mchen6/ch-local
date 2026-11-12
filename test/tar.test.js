'use strict';
// lib/tar.js: a pack's or part's tarball unpacked without npm (they have no
// dependencies, #43), strictly: regular files and directories under package/
// only, no links, no .. and no absolute path, within a size cap. A refused
// tarball leaves nothing behind. The reviewer's list (2026-11-12): pax headers
// parsed strictly and every other extended header refused; links, devices and
// FIFOs refused; duplicate paths refused; names that normalise outside
// package/ (backslashes, drive letters) refused; total and per-file size and
// the entry count capped before anything is written; a gzip bomb refused.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {spawnSync} = require('node:child_process');
const {tmp} = require('./fake-io');
const {extractPackage} = require('../lib/tar');
const {npm} = require('../lib/npm');

const {member, tgz, pax} = require('./tgz');
const refuses = (buffer, why, opts) => {
  const dest = path.join(tmp('ch-tar-'), 'pkg');
  assert.throws(() => extractPackage(buffer, dest, opts), (err) => err.code === 'TAR_REFUSED' && why.test(err.message), why.source);
  assert.ok(!fs.existsSync(dest), 'nothing left behind');
};

test('a real npm pack unpacks to the same files', async () => {
  const src = tmp('ch-tar-src-');
  fs.mkdirSync(path.join(src, 'lib', 'deep'), {recursive: true});
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({name: 'tar-fixture', version: '1.0.0', files: ['lib/']}));
  fs.writeFileSync(path.join(src, 'lib', 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(src, 'lib', 'deep', `${'x'.repeat(120)}.js`), 'long name\n');
  const out = tmp('ch-tar-pack-');
  const r = await npm({node: process.execPath, exec: async (cmd, args, {cwd}) => spawnSync(cmd, args, {cwd, encoding: 'utf8'})}, ['pack', '--json', '--pack-destination', out], src);
  assert.strictEqual(r.status, 0, r.stderr);
  const dest = path.join(tmp('ch-tar-dest-'), 'pkg');
  extractPackage(fs.readFileSync(path.join(out, JSON.parse(r.stdout)[0].filename)), dest);
  for (const f of ['package.json', 'lib/a.js', `lib/deep/${'x'.repeat(120)}.js`]) {
    assert.deepStrictEqual(fs.readFileSync(path.join(dest, f)), fs.readFileSync(path.join(src, f)), f);
  }
});

test('regular files and directories under package/ are written, the prefix stripped', () => {
  const dest = path.join(tmp('ch-tar-'), 'pkg');
  extractPackage(tgz(member('package/', {type: '5'}), member('package/package.json', {data: '{}'}), member('package/lib/x.js', {data: 'x'})), dest);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'lib', 'x.js'), 'utf8'), 'x');
  assert.strictEqual(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'), '{}');
});

test('a link, a path out of package/, a .. or an absolute path refuses the tarball, naming the member, and leaves nothing', () => {
  for (const [bad, why] of [
    [member('package/evil', {type: '2', linkname: '/etc/passwd'}), /package\/evil.*link/],
    [member('package/hard', {type: '1', linkname: 'package/package.json'}), /package\/hard.*link/],
    [member('package/../../escape.js', {data: 'x'}), /escape\.js/],
    [member('/etc/cron.d/x', {data: 'x'}), /\/etc\/cron\.d\/x/],
    [member('other/file.js', {data: 'x'}), /other\/file\.js.*package\//],
    [member('package/dev', {type: '3'}), /package\/dev.*type/]
  ]) {
    const dest = path.join(tmp('ch-tar-'), 'pkg');
    assert.throws(() => extractPackage(tgz(member('package/package.json', {data: '{}'}), bad), dest), (err) => err.code === 'TAR_REFUSED' && why.test(err.message), why.source);
    assert.ok(!fs.existsSync(dest), 'nothing left behind');
  }
});

test('a tarball over the size cap, a corrupt header or not gzip at all is refused', () => {
  const dest = path.join(tmp('ch-tar-'), 'pkg');
  assert.throws(() => extractPackage(tgz(member('package/big', {data: 'y'.repeat(5000)})), dest, {maxBytes: 4096}), {code: 'TAR_REFUSED'});
  const broken = Buffer.concat([member('package/a', {data: 'a'}), Buffer.alloc(1024)]);
  broken[150] ^= 0xff;
  assert.throws(() => extractPackage(zlib.gzipSync(broken), dest), /checksum/);
  assert.throws(() => extractPackage(Buffer.from('not a tarball'), dest), {code: 'TAR_REFUSED'});
  assert.ok(!fs.existsSync(dest));
});

test('the destination must not exist yet: a package is never unpacked over another', () => {
  const dest = tmp('ch-tar-exists-');
  assert.throws(() => extractPackage(tgz(member('package/a', {data: 'a'})), dest), /exists/);
});

test('a pax header is parsed strictly: path and times only, applied to the next member', () => {
  const dest = path.join(tmp('ch-tar-'), 'pkg');
  extractPackage(tgz(pax({path: 'package/lib/long-' + 'y'.repeat(150) + '.js', mtime: '1700000000.5'}), member('package/short', {data: 'z'})), dest);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'lib', 'long-' + 'y'.repeat(150) + '.js'), 'utf8'), 'z');
  assert.ok(!fs.existsSync(path.join(dest, 'short')));
  // npm (node-tar) writes path, mtime and size; size must agree with the header.
  extractPackage(tgz(pax({path: 'package/sized', size: '1'}), member('package/x', {data: 'z'})), path.join(tmp('ch-tar-'), 'pkg'));
  refuses(tgz(pax({path: 'package/sized', size: '700'}), member('package/x', {data: 'z'})), /size/);
  refuses(tgz(pax({linkpath: '/etc/passwd'}), member('package/a', {data: 'a'})), /linkpath/);
  refuses(tgz(pax({'SCHILY.xattr.user.x': '1'}), member('package/a', {data: 'a'})), /SCHILY/);
  refuses(tgz(pax({path: 'package/../../x'}), member('package/a', {data: 'a'})), /\.\./);
  refuses(tgz(member('PaxHeader/x', {type: 'x', data: '99 path=package/a\n'}), member('package/a', {data: 'a'})), /pax/);
  refuses(tgz(pax({path: 'package/a'}, 'g'), member('package/a', {data: 'a'})), /type/);
});

test('GNU long names, FIFOs and block devices are refused', () => {
  refuses(tgz(member('././@LongLink', {type: 'L', data: 'package/a'}), member('package/a', {data: 'a'})), /type/);
  refuses(tgz(member('package/fifo', {type: '6'})), /package\/fifo.*type/);
  refuses(tgz(member('package/blk', {type: '4'})), /package\/blk.*type/);
});

test('a duplicate path, also by case or through a file-directory clash, is refused', () => {
  refuses(tgz(member('package/a.js', {data: '1'}), member('package/a.js', {data: '2'})), /package\/a\.js.*twice/);
  refuses(tgz(member('package/A.js', {data: '1'}), member('package/a.js', {data: '2'})), /twice/);
  refuses(tgz(member('package/a', {data: '1'}), member('package/a/b', {data: '2'})), /package\/a/);
});

test('names that would normalise outside package/ on another system are refused', () => {
  for (const name of ['package\\..\\..\\x.js', 'C:/x.js', 'package/C:x.js', 'package/a\\b.js', 'package/./a.js', 'package//a.js']) {
    refuses(tgz(member(name, {data: 'x'})), /./, undefined);
  }
  // In a header NUL ends the name; only a pax path can hide one.
  refuses(tgz(pax({path: 'package/a\u0000/../../b'}), member('package/x', {data: 'x'})), /NUL/);
});

test('the caps hold before anything is written: per file, in total, entries, and a gzip bomb', () => {
  refuses(tgz(member('package/a', {data: 'a'.repeat(3000)})), /package\/a.*per-file/, {maxFileBytes: 2048});
  refuses(tgz(member('package/a', {data: 'a'.repeat(1500)}), member('package/b', {data: 'b'.repeat(1500)})), /total/, {maxBytes: 2560});
  refuses(tgz(member('package/a', {data: 'a'}), member('package/b', {data: 'b'}), member('package/c', {data: 'c'})), /entries/, {maxEntries: 2});
  refuses(zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024)), /size cap|uncompressed/, {maxBytes: 1024 * 1024});
});

// /code-review medium on PR 2.
test('directories that differ only by case or Unicode form are refused, as files are', () => {
  refuses(tgz(member('package/Lib/a.js', {data: 'a'}), member('package/lib/b.js', {data: 'b'})), /package\/lib\/b\.js.*case/);
  refuses(tgz(member('package/Lib/', {type: '5'}), member('package/lib/', {type: '5'})), /case/);
  refuses(tgz(member('package/café/a', {data: 'a'}), member('package/café/b', {data: 'b'})), /case/);
  const dest = path.join(tmp('ch-tar-'), 'pkg');
  extractPackage(tgz(member('package/lib/', {type: '5'}), member('package/lib/a.js', {data: 'a'}), member('package/lib/b.js', {data: 'b'})), dest);
});

test('every character Windows refuses in a name is refused', () => {
  for (const c of ['<', '>', '"', '|', '?', '*', '\u0001', '\u001f']) refuses(tgz(member(`package/a${c}b.js`, {data: 'x'})), /./);
});
