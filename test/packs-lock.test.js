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

test('a live holder here with its recorded start time is never cleared by its heartbeat\'s age; renewing, said without the hint and waited for', LINUX, async () => {
  const h = home();
  holderAt(h, {pid: process.pid, host: lock.lockHost(), at: 'x', started: lock.processStarted(process.pid)});
  const now = fakeIo({});
  assert.strictEqual(await lock.withLock({home: h}, now, async() => 0), 1);
  assert.match(now.err, /another ch-local \(pid \d+\) is changing this home; try again when it is done\n/);
  assert.ok(!/remove/.test(now.err), 'no hint to remove a live holder\'s lock');
  // start waits for it (its heartbeat fresh: no cap), until its signal ends the wait
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 600);
  const waiting = Object.assign(fakeIo({}), {lockWaitMs: 100});
  assert.strictEqual(await lock.withLock({home: h}, waiting, async() => 0, {wait: true, signal: ac.signal}), 1);
  assert.ok(fs.existsSync(file(h)), 'the live holder\'s lock stands');
});

// #104's high, 3 and 6: an exact holder here is waited for as long as it
// takes, however old its heartbeat (an install blocking its event loop);
// only a stopped one (/proc state T) is given up on, said with how to
// resume or end it
test('an exact holder here with an hour-old heartbeat is waited for (start can be interrupted); a stopped one (state T) is given up on, with fg / kill -CONT / kill -9', LINUX, async () => {
  const h = home();
  holderAt(h, {pid: process.pid, host: lock.lockHost(), at: 'x', started: lock.processStarted(process.pid)}, HOUR);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 1500);
  const waiting = Object.assign(fakeIo({}), {lockWaitMs: 300});
  const t0 = Date.now();
  assert.strictEqual(await lock.withLock({home: h}, waiting, async() => 0, {wait: true, signal: ac.signal}), 1);
  assert.ok(Date.now() - t0 >= 1400, 'waited past the cap, until interrupted');
  assert.ok(fs.existsSync(file(h)));
  // a stopped holder
  const {spawn} = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  try {
    await new Promise((r) => setTimeout(r, 200));
    process.kill(child.pid, 'SIGSTOP');
    for (let i = 0; i < 50 && lock.processState(child.pid) !== 'T'; i++) await new Promise((r) => setTimeout(r, 20));
    holderAt(h, {pid: child.pid, host: lock.lockHost(), at: 'x', started: lock.processStarted(child.pid)}, HOUR);
    const now = fakeIo({});
    assert.strictEqual(await lock.withLock({home: h}, now, async() => 0), 1);
    assert.match(now.err, new RegExp(`is stopped \\(Ctrl-Z\\): resume it \\(fg, or kill -CONT ${child.pid}\\) to let it finish, or end it \\(kill -9 ${child.pid}\\)`));
    const gives = Object.assign(fakeIo({}), {lockWaitMs: 300});
    assert.strictEqual(await lock.withLock({home: h}, gives, async() => 0, {wait: true}), 1);
    assert.ok(fs.existsSync(file(h)), 'a stopped holder is never cleared');
  } finally {
    child.kill('SIGKILL');
  }
});

// #104's high, 1: an unreaped holder is dead, not exact
test('a zombie holder (/proc state Z) is gone, and its lock is cleared', LINUX, async () => {
  const {spawn} = require('node:child_process');
  // the exec'd sleep never reaps its child: a real zombie
  const parent = spawn('sh', ['-c', 'sleep 0 & echo $!; exec sleep 30'], {stdio: ['ignore', 'pipe', 'ignore']});
  try {
    const pid = Number(await new Promise((r) => parent.stdout.once('data', (d) => r(String(d).trim()))));
    for (let i = 0; i < 100 && lock.processState(pid) !== 'Z'; i++) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(lock.processState(pid), 'Z', 'premise: a zombie');
    const h = home();
    holderAt(h, {pid, host: lock.lockHost(), at: 'x', started: lock.processStarted(pid)});
    const io = fakeIo({});
    assert.strictEqual(await lock.withLock({home: h}, io, async() => 0), 0, io.err);
  } finally {
    parent.kill('SIGKILL');
  }
});

// #104's high, 2 and 7, and the medium on it, 1, 2, 5, 9: where a holder is,
// by the ids it recorded; a host name alone never decides
test('the same boot id is this machine, whatever its host name or namespace: aged by heartbeat; another boot id is this machine before a reboot only with this machine id and name', LINUX, async () => {
  const os = require('node:os');
  const name = os.hostname();
  // a container with its own host name, on this kernel
  const fresh = home();
  holderAt(fresh, {pid: 1, host: 'a1b2c3d4e5f6#pid:[4026599999]', at: 'x', started: '1', boot: lock.bootId()});
  const a = fakeIo({});
  assert.strictEqual(await lock.withLock({home: fresh}, a, async() => 0), 1);
  assert.match(a.err, /\(pid 1 on another PID namespace on this machine \(a container, or the host\)\) is changing this home; try again when it is done\n/);
  assert.ok(!/remove/.test(a.err), 'the same machine: its heartbeat decides, no hint');
  const stale = home();
  holderAt(stale, {pid: 1, host: 'a1b2c3d4e5f6#pid:[4026599999]', at: 'x', started: '1', boot: lock.bootId()}, HOUR);
  assert.strictEqual(await lock.withLock({home: stale}, fakeIo({}), async() => 0), 0, 'stale: cleared, as on this host');
  // another machine of this host name (another boot, no machine id or
  // another): never cleared, though its PID namespace string is ours
  for (const machine of [undefined, 'another-machine-id']) {
    const twin = home();
    holderAt(twin, {pid: 1, host: lock.lockHost(), at: 'x', started: '1', boot: 'another-boot', machine}, HOUR);
    const t = fakeIo({});
    assert.strictEqual(await lock.withLock({home: twin}, t, async() => 0), 1, `another machine named ${name} (${machine})`);
    assert.match(t.err, new RegExp(`on another machine named ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\).* if nothing is running on another machine named`));
    assert.ok(fs.existsSync(file(twin)));
  }
  if (lock.machineId() != null && lock.bootTimeMs() != null) {
    const before = lock.bootTimeMs() - 60 * 1000;
    // this machine before a reboot (renewed last before this kernel booted): gone
    const rebooted = home();
    holderAt(rebooted, {pid: 1, host: lock.lockHost(), at: 'x', started: '1', boot: 'a-boot-before-this-one', machine: lock.machineId()});
    fs.utimesSync(file(rebooted), new Date(before), new Date(before));
    assert.strictEqual(await lock.withLock({home: rebooted}, fakeIo({}), async() => 0), 0, 'from before a reboot: gone');
    // a cloned VM (the same machine id and host name, another boot) renewing
    // after this boot: another machine, never cleared, however old
    // (the reviewer's delta read of 87b28d4)
    const clone = home();
    holderAt(clone, {pid: 1, host: lock.lockHost(), at: 'x', started: '1', boot: 'a-clone-s-boot', machine: lock.machineId()});
    const c = fakeIo({});
    assert.strictEqual(await lock.withLock({home: clone}, c, async() => 0), 1, 'a live clone: held');
    assert.match(c.err, /on another machine named /);
    assert.ok(fs.existsSync(file(clone)), 'never cleared');
  }
  // no boot id: the host string decides, as before
  const unknown = home();
  holderAt(unknown, {pid: 1, host: `${name}#pid:[4026599999]`, at: 'x'}, HOUR);
  const u = fakeIo({});
  assert.strictEqual(await lock.withLock({home: unknown}, u, async() => 0), 1, 'no boot id: never aged');
  assert.match(u.err, /on another machine named .* if nothing is running on another machine named/);
});

// the medium on #104's round 1, 4 and 6: a holder that stopped renewing is
// said as such, with what to do; a stopped one while start waits too
test('an exact holder that has not renewed its lock is said with how to end it if hung; start\'s waiting line says a stopped one is stopped', LINUX, async () => {
  const h = home();
  holderAt(h, {pid: process.pid, host: lock.lockHost(), at: 'x', started: lock.processStarted(process.pid)}, HOUR);
  const now = fakeIo({});
  assert.strictEqual(await lock.withLock({home: h}, now, async() => 0), 1);
  assert.match(now.err, new RegExp(`has not renewed its lock for over 2 minutes; try again when it is done, or if it is hung, end it \\(kill ${process.pid}\\)`));
  const {spawn} = require('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  try {
    await new Promise((r) => setTimeout(r, 200));
    process.kill(child.pid, 'SIGSTOP');
    for (let i = 0; i < 50 && lock.processState(child.pid) !== 'T'; i++) await new Promise((r) => setTimeout(r, 20));
    holderAt(h, {pid: child.pid, host: lock.lockHost(), at: 'x', started: lock.processStarted(child.pid)}, HOUR);
    const waiting = Object.assign(fakeIo({}), {lockWaitMs: 300, lockProgressMs: 50});
    assert.strictEqual(await lock.withLock({home: h}, waiting, async() => 0, {wait: true}), 1);
    assert.match(waiting.err, new RegExp(`waiting for another ch-local \\(pid ${child.pid}\\) .*; it is stopped \\(Ctrl-Z\\): resume it`));
  } finally {
    child.kill('SIGKILL');
  }
});

// #104's high, 4: a holder here with no usable pid is one this host can't judge
test('a holder here with no usable pid is waited for at most the cap, then named with the file to remove', async () => {
  const h = home();
  holderAt(h, {host: lock.lockHost(), at: 'x'});
  const waiting = Object.assign(fakeIo({}), {lockWaitMs: 300});
  assert.strictEqual(await lock.withLock({home: h}, waiting, async() => 0, {wait: true}), 1);
  assert.match(waiting.err, /an unreadable lock .* if nothing is running there/);
});

// the medium on post-rel packs.lock, 4: the cap is per holder, not across a
// series of them
test('a new holder resets start\'s watch: another host\'s lock replaced by a third\'s is waited for afresh', async () => {
  const h = home();
  holderAt(h, {pid: 1, host: 'elsewhere', at: 'a'});
  setTimeout(() => holderAt(h, {pid: 2, host: 'third', at: 'b'}), 250);
  setTimeout(() => fs.rmSync(file(h), {force: true}), 550);
  const waiting = Object.assign(fakeIo({}), {lockWaitMs: 400});
  let ran = false;
  assert.strictEqual(await lock.withLock({home: h}, waiting, async() => { ran = true; return 0; }, {wait: true}), 0, waiting.err);
  assert.strictEqual(ran, true);
});

test('a holder here with no start time recorded (an older ch-local): judged as before, its heartbeat\'s age clears it', async () => {
  const h = home();
  holderAt(h, {pid: process.pid, host: lock.lockHost(), at: 'x'}, HOUR);
  const io = fakeIo({});
  assert.strictEqual(await lock.withLock({home: h}, io, async() => 0), 0, io.err);
});
