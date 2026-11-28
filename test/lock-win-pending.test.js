'use strict';
require('./tmp-dirs');
// On Windows a lock file another process is deleting (delete pending: a
// handle still open on it, as a holder's release meets a reader) refuses a
// new link or an exclusive create onto its name with EPERM (or EACCES) until
// that handle closes. Taking the lock then counts as busy, not an error, and
// is tried again on the wait's own clock; a genuine permission error answers
// EPERM too, so the tries keep a deadline and then fail with that error and
// the lock's path, never as a held lock and never forever (as countinghouse's
// json-file.js does). The same for the stale-lock breaker's exclusive create.
// Elsewhere EPERM is an error at once, as before. Deterministic: linkSync and
// the breaker's write are stubbed, the platform given (io.lockPlatform), the
// clock the wait's own (io.lockNow, io.lockSleep).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const lock = require('../lib/lock');

const LINUX = {skip: process.platform !== 'linux' && 'a holder here is judged from /proc on Linux'};
const home = () => tmp('ch-lockwin-');
// (as Node's own: a link's error names its source, the temporary file, in
// path, and the lock in dest; an exclusive create's names its file in path)
const refused = (code, p, dest = undefined) => Object.assign(new Error(`${code}: operation not permitted, '${p}'${dest != null ? ` -> '${dest}'` : ''}`), dest != null ? {code, path: p, dest} : {code, path: p});
const clockIo = (platform) => {
  const io = Object.assign(fakeIo({}), {lockPlatform: platform});
  io.t = 0;
  io.lockNow = () => io.t;
  // (a wait past a minute on this clock is one that would never end: failed
  // here, never left to run until the heap is gone)
  io.lockSleep = async (ms) => { io.t += ms; if (io.t > 60000) throw new Error(`waited ${io.t} ms on the wait's clock: a wait that never ends`); };
  return io;
};

test('win32: a lock name being deleted (link refused EPERM) is busy, not an error: the lock is taken once the name is free', async (t) => {
  const h = home();
  const file = path.join(h, 'packs.lock');
  let refusals = 3;
  const real = fs.linkSync;
  t.mock.method(fs, 'linkSync', (a, b) => { if (b === file && refusals > 0) { refusals--; throw refused('EPERM', a, b); } return real(a, b); });
  const io = clockIo('win32');
  let ran = false;
  assert.strictEqual(await lock.withLock({home: h}, io, async () => { ran = true; return 0; }), 0, io.err);
  assert.strictEqual(ran, true);
  assert.strictEqual(refusals, 0, 'tried again until the name was free');
  assert.ok(!/another ch-local/.test(io.err), `never said as a held lock: ${io.err}`);
});

for (const code of ['EPERM', 'EACCES']) {
  test(`win32: a link refused ${code} past the deadline fails with that error and the lock's path, never as a held lock, never forever`, async (t) => {
    const h = home();
    const file = path.join(h, 'packs.lock');
    const real = fs.linkSync;
    t.mock.method(fs, 'linkSync', (a, b) => { if (b === file) throw refused(code, a, b); return real(a, b); });
    const io = clockIo('win32');
    let ran = false;
    // (the lock named, never the temporary file the link came from)
    await assert.rejects(lock.withLock({home: h}, io, async () => { ran = true; return 0; }), (e) => e.code === code && e.path === file && e.message.includes(file) && !/\.tmp/.test(e.message));
    assert.strictEqual(ran, false);
    assert.ok(io.t >= 10000 && io.t < 12000, `given up at the deadline, on the wait's clock (${io.t})`);
    assert.ok(!/another ch-local/.test(io.err), io.err);
  });
}

test('elsewhere, a link refused EPERM is an error at once, as before', async (t) => {
  const h = home();
  const file = path.join(h, 'packs.lock');
  const real = fs.linkSync;
  t.mock.method(fs, 'linkSync', (a, b) => { if (b === file) throw refused('EPERM', a, b); return real(a, b); });
  const io = clockIo('linux');
  await assert.rejects(lock.withLock({home: h}, io, async () => 0), (e) => e.code === 'EPERM');
  assert.strictEqual(io.t, 0, 'no wait');
});

test('win32: a stale-lock breaker refused EPERM past the deadline fails with that error and the breaker\'s path, even while waiting: never forever', LINUX, async (t) => {
  const h = home();
  const file = path.join(h, 'packs.lock');
  fs.writeFileSync(file, `${JSON.stringify({pid: 4194301, host: lock.lockHost(), at: 'gone'})}\n`);
  const real = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (p, data, opts) => {
    if (p === `${file}.break`) throw refused('EPERM', p);
    return real(p, data, opts);
  });
  const io = clockIo('win32');
  let ran = false;
  await assert.rejects(lock.withLock({home: h}, io, async () => { ran = true; return 0; }, {wait: true}), (e) => e.code === 'EPERM' && e.path === `${file}.break`);
  assert.strictEqual(ran, false);
  assert.ok(io.t >= 10000 && io.t < 12000, `given up at the deadline (${io.t})`);
});

test('win32: the stale-lock breaker refused EPERM is busy, not an error: the stale lock is cleared at a later look', LINUX, async (t) => {
  const h = home();
  const file = path.join(h, 'packs.lock');
  // a holder here that is gone (no such pid), with no start time recorded
  fs.writeFileSync(file, `${JSON.stringify({pid: 4194301, host: lock.lockHost(), at: 'gone'})}\n`);
  let refusals = 1;
  const real = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (p, data, opts) => {
    if (p === `${file}.break` && refusals > 0) { refusals--; throw refused('EPERM', p); }
    return real(p, data, opts);
  });
  const io = clockIo('win32');
  let ran = false;
  assert.strictEqual(await lock.withLock({home: h}, io, async () => { ran = true; return 0; }, {wait: true}), 0, io.err);
  assert.strictEqual(ran, true);
  assert.strictEqual(refusals, 0);
});

// (lib/settings.js's own loop takes createWhole: a pending name is never taken
// for the lock there; the refusal is thrown at once, as before)
test('createWhole keeps its answer: true, false, or the refusal thrown, never a pending name taken for the lock', (t) => {
  const h = home();
  const file = path.join(h, 'settings.lock');
  const mine = {pid: process.pid, host: 'h', at: 'x'};
  assert.strictEqual(lock.createWhole(file, mine), true);
  assert.strictEqual(lock.createWhole(file, mine), false);
  fs.rmSync(file, {force: true});
  const real = fs.linkSync;
  t.mock.method(fs, 'linkSync', (a, b) => { if (b === file) throw refused('EPERM', a, b); return real(a, b); });
  assert.throws(() => lock.createWhole(file, mine), (e) => e.code === 'EPERM');
  assert.ok(!fs.existsSync(file));
});

// On a real Windows filesystem: a holder's lock file deleted while another
// handle still holds it open (as a reader holds a lock it is reading), then a
// second ch-local takes the lock. Whether the name stays delete-pending (EPERM
// until the handle closes) or is freed at once (POSIX delete semantics, newer
// NTFS) is the filesystem's: the lock is taken either way, and the work runs.
// The handle closes at the wait's first step, on its own clock. On a runner
// whose filesystem frees the name at once this case does not reach the
// pending path (it says which it saw); the stubbed cases above are the ones
// that prove that path.
test('Windows, a real delete-pending lock file: the next ch-local takes the lock once the other handle closes, never an error', {skip: process.platform !== 'win32' && 'a real Windows filesystem'}, async () => {
  const h = home();
  const file = path.join(h, 'packs.lock');
  fs.writeFileSync(file, `${JSON.stringify({pid: process.pid, host: lock.lockHost(), at: 'held'})}\n`);
  let fd = null;
  const io = Object.assign(fakeIo({}), {lockPlatform: 'win32'});
  io.t = 0;
  io.lockNow = () => io.t;
  let steps = 0;
  io.lockSleep = async (ms) => { io.t += ms; steps++; if (fd != null) { fs.closeSync(fd); fd = null; } };
  let ran = false;
  try {
    fd = fs.openSync(file, 'r');
    fs.rmSync(file, {force: true});
    assert.strictEqual(await lock.withLock({home: h}, io, async () => { ran = true; return 0; }), 0, io.err);
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
  assert.strictEqual(ran, true);
  // (which the filesystem did, for the log: a pending name took steps, a freed one none)
  process.stdout.write(`# delete-pending seen: ${steps > 0}\n`);
});

