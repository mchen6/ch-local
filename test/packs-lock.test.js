'use strict';
require('./tmp-dirs');
// packs.lock on the stored credentials' lock options (post-rel packs.lock
// protocol, the reviewer 11-20; lib/lock.js withLock): a reused PID is gone
// (started); another host's lock is never taken for gone by its age
// (ageOtherHosts: false), and start waits for one at most its cap
// (waitRemoteMs), then says it with the file to remove; a live holder here
// with its recorded start time is never taken for gone by age, however old
// its heartbeat (trustStarted: a long install isn't stolen); the hint to
// remove the file is said only where nothing here can tell whether its
// holder runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const lock = require('../lib/lock');

const LINUX = {skip: process.platform !== 'linux' && 'start times are read on Linux'};
const home = () => tmp('ch-packslock-');
const file = (h) => path.join(h, 'packs.lock');
const holderAt = (h, holder, ageMs = 0) => {
  fs.writeFileSync(file(h), `${JSON.stringify(holder)}\n`);
  if (ageMs > 0) { const t = new Date(Date.now() - ageMs); fs.utimesSync(file(h), t, t); }
};
const HOUR = 60 * 60 * 1000;

test('a holder records its start time; a reused PID (alive, another start time) is gone, and the change goes on', LINUX, async () => {
  const h = home();
  holderAt(h, {pid: process.pid, host: lock.lockHost(), at: 'x', started: '1'});
  let seen = null;
  const io = fakeIo({});
  assert.strictEqual(await lock.withLock({home: h}, io, async() => { seen = JSON.parse(fs.readFileSync(file(h), 'utf8')); return 0; }), 0, io.err);
  assert.strictEqual(seen.pid, process.pid);
  assert.strictEqual(seen.started, lock.processStarted(process.pid), 'its own start time recorded');
});

test('another host\'s hour-old lock is never cleared: refused at once with the file to remove; start waits at most its cap, then says the same', async () => {
  const h = home();
  holderAt(h, {pid: 1, host: 'elsewhere', at: 'x'}, HOUR);
  const now = fakeIo({});
  assert.strictEqual(await lock.withLock({home: h}, now, async() => 0), 1);
  assert.match(now.err, new RegExp(`another ch-local \\(pid 1 on elsewhere\\) is changing this home; try again when it is done, or remove ${file(h).replace(/[.\\/]/g, '\\$&')} if nothing is running on elsewhere\\n`));
  const waiting = Object.assign(fakeIo({}), {lockWaitMs: 400});
  const t0 = Date.now();
  let ran = false;
  assert.strictEqual(await lock.withLock({home: h}, waiting, async() => { ran = true; return 0; }, {wait: true}), 1);
  assert.ok(Date.now() - t0 >= 350, 'waited to the cap');
  assert.strictEqual(ran, false);
  assert.match(waiting.err, /if nothing is running on elsewhere/);
  assert.ok(fs.existsSync(file(h)), 'never cleared');
});

test('a lock that can\'t be read: start waits at most its cap, then names the file', async () => {
  const h = home();
  fs.writeFileSync(file(h), 'not json');
  const waiting = Object.assign(fakeIo({}), {lockWaitMs: 300});
  assert.strictEqual(await lock.withLock({home: h}, waiting, async() => 0, {wait: true}), 1);
  assert.match(waiting.err, /an unreadable lock .*packs\.lock\) is changing this home; .* if nothing is running there/);
});

test('a live holder here with its recorded start time is never cleared by its heartbeat\'s age; said without the hint; start waits for it', LINUX, async () => {
  const h = home();
  holderAt(h, {pid: process.pid, host: lock.lockHost(), at: 'x', started: lock.processStarted(process.pid)}, HOUR);
  const now = fakeIo({});
  assert.strictEqual(await lock.withLock({home: h}, now, async() => 0), 1);
  assert.match(now.err, /another ch-local \(pid \d+\) is changing this home; try again when it is done\n/);
  assert.ok(!/remove/.test(now.err), 'no hint to remove a live holder\'s lock');
  // start waits for it (no cap for a holder here), until its signal ends the wait
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 600);
  const waiting = Object.assign(fakeIo({}), {lockWaitMs: 100});
  assert.strictEqual(await lock.withLock({home: h}, waiting, async() => 0, {wait: true, signal: ac.signal}), 1);
  assert.ok(fs.existsSync(file(h)), 'the live holder\'s lock stands');
});

test('a holder here with no start time recorded (an older ch-local): judged as before, its heartbeat\'s age clears it', async () => {
  const h = home();
  holderAt(h, {pid: process.pid, host: lock.lockHost(), at: 'x'}, HOUR);
  const io = fakeIo({});
  assert.strictEqual(await lock.withLock({home: h}, io, async() => 0), 0, io.err);
});
