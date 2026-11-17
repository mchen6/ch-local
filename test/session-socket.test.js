'use strict';
// C4c: where the shared runtime listens (lib/session-socket.js): a random
// named pipe per runtime start on Windows; on POSIX the run directory's
// socket, or the long-home fallback in $TMPDIR/ch-<uid>/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ss = require('../lib/session-socket');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ss-')));

test('Windows: a named pipe of the form, a new random name at each runtime start, never a path', () => {
  const runDir = 'C:\\Users\\u\\.countinghouse\\run\\daemon';
  const a = ss.socketFor(runDir, {platform: 'win32'});
  const b = ss.socketFor(runDir, {platform: 'win32'});
  assert.match(a.socket, /^\\\\\.\\pipe\\countinghouse-[0-9a-f]{32}$/);
  assert.strictEqual(ss.isPipeName(a.socket), true);
  assert.notStrictEqual(a.socket, b.socket, 'random per start');
  assert.strictEqual(a.fallback, null);
  assert.strictEqual(ss.socketFor(runDir, {platform: 'win32', random: () => Buffer.alloc(16, 0xab)}).socket, `\\\\.\\pipe\\countinghouse-${'ab'.repeat(16)}`);
});

test('a daemon.json socket a daemon of this home may have chosen: any pipe of the form on Windows; exactly socketFor\'s on POSIX', () => {
  const runDir = '/home/u/.countinghouse/run/daemon';
  assert.strictEqual(ss.socketOk(ss.newPipeName(), 'C:\\x', {platform: 'win32'}), true);
  for (const bad of ['\\\\.\\pipe\\other-0123456789abcdef0123456789abcdef', '\\\\.\\pipe\\countinghouse-0123', 'C:\\x\\sessions.sock', null, 42]) {
    assert.strictEqual(ss.socketOk(bad, 'C:\\x', {platform: 'win32'}), false, String(bad));
  }
  assert.strictEqual(ss.socketOk(path.join(runDir, 'sessions.sock'), runDir, {platform: 'linux'}), true);
  assert.strictEqual(ss.socketOk(path.join(runDir, 'other.sock'), runDir, {platform: 'linux'}), false);
  assert.strictEqual(ss.socketOk(ss.newPipeName(), runDir, {platform: 'linux'}), false, 'no pipe on POSIX');
});

test('POSIX: the run directory\'s socket while it fits the limit (107 bytes on Linux, 103 on macOS); past it, $TMPDIR/ch-<uid>/sessions.sock', {skip: process.platform === 'win32' && 'POSIX only: POSIX paths, built with the host\'s path module'}, () => {
  const env = {TMPDIR: '/var/folders/xy/T'};
  const short = '/home/u/.countinghouse/run/daemon';
  assert.deepStrictEqual(ss.socketFor(short, {platform: 'linux', env, uid: 1000}), {socket: `${short}/sessions.sock`, fallback: null});
  // exactly at the limit, and one past it
  const at = (max) => `/${'a'.repeat(max - '/sessions.sock'.length - 1)}`;
  assert.strictEqual(Buffer.byteLength(path.join(at(107), 'sessions.sock')), 107);
  assert.strictEqual(ss.socketFor(at(107), {platform: 'linux', env, uid: 1000}).fallback, null);
  assert.deepStrictEqual(ss.socketFor(`${at(107)}b`, {platform: 'linux', env, uid: 1000}), {socket: '/var/folders/xy/T/ch-1000/sessions.sock', fallback: '/var/folders/xy/T/ch-1000'});
  assert.strictEqual(ss.socketFor(at(104), {platform: 'darwin', env, uid: 501}).fallback, '/var/folders/xy/T/ch-501', 'macOS: 103');
  assert.strictEqual(ss.socketFor(at(103), {platform: 'darwin', env, uid: 501}).fallback, null);
  // a relative or missing TMPDIR: the system's temporary directory
  assert.strictEqual(ss.fallbackSocket({env: {TMPDIR: 'relative'}, uid: 7}), path.join(os.tmpdir(), 'ch-7', 'sessions.sock'));
  assert.strictEqual(ss.fallbackSocket({env: {}, uid: 7}), path.join(os.tmpdir(), 'ch-7', 'sessions.sock'));
});

test('the fallback directory: made 0700, a wrong mode put right, a link or a file refused', {skip: process.platform === 'win32' && 'POSIX only: Windows has no fallback'}, () => {
  const base = tmp();
  try {
    const dir = path.join(base, 'ch-1000');
    assert.strictEqual(ss.socketDirProblem(dir), null);
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
    fs.chmodSync(dir, 0o755);
    assert.strictEqual(ss.socketDirProblem(dir), null);
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700, 'put right');
    const link = path.join(base, 'ch-1001');
    fs.symlinkSync(dir, link);
    assert.match(String(ss.socketDirProblem(link)), /not a directory/);
    const file = path.join(base, 'ch-1002');
    fs.writeFileSync(file, '');
    assert.match(String(ss.socketDirProblem(file)), /not a directory/);
    assert.match(String(ss.socketDirProblem(path.join(base, 'missing', 'ch-1003'))), /could not be made/);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});
