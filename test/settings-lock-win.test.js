'use strict';
require('./tmp-dirs');
// The settings lock (lib/settings.js withSettingsLock) on Windows: a lock name
// another process is deleting refuses a new link with EPERM (or EACCES) until
// that handle closes, as lib/lock.js's own lock meets it (#197). Within the
// settings lock's own wait that counts as busy, tried again, and at its
// deadline the refusal itself is thrown, the lock named: a genuine
// permission error answers EPERM too. A wait of 0 (start's event loop) throws
// it at once, as before; elsewhere EPERM is an error at once, as before.
// Every pass of the loop keeps the deadline, the one that finds the lock
// released (a stat that finds no file) included, and a stat refused on a
// pending name is busy too. Deterministic: linkSync and statSync are stubbed,
// the platform, the clock and the sleep given.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {tmp} = require('./fake-io');
const {withSettingsLock} = require('../lib/settings');

const refused = (code, p, dest = undefined) => Object.assign(new Error(`${code}: operation not permitted, '${p}'${dest != null ? ` -> '${dest}'` : ''}`), dest != null ? {code, path: p, dest} : {code, path: p});
const clock = () => {
  const c = {t: 0, sleeps: 0};
  c.now = () => c.t;
  // (a wait past a minute on this clock is one that would never end)
  c.sleep = (ms) => { c.t += ms; c.sleeps++; if (c.t > 60000) throw new Error(`waited ${c.t} ms: a wait that never ends`); };
  return c;
};
const setup = () => { const home = tmp('ch-setlock-'); return {where: {home}, lock: path.join(home, 'settings.lock')}; };

test('win32: a settings lock name being deleted (link refused EPERM) is busy: the change runs once the name is free', (t) => {
  const {where, lock} = setup();
  let refusals = 3;
  const real = fs.linkSync;
  t.mock.method(fs, 'linkSync', (a, b) => { if (b === lock && refusals > 0) { refusals--; throw refused('EPERM', a, b); } return real(a, b); });
  const c = clock();
  assert.strictEqual(withSettingsLock(where, () => 'done', {platform: 'win32', now: c.now, sleep: c.sleep}), 'done');
  assert.strictEqual(refusals, 0);
  assert.ok(c.sleeps >= 3);
  assert.ok(!fs.existsSync(lock), 'released');
});

for (const code of ['EPERM', 'EACCES']) {
  test(`win32: a link refused ${code} past the wait throws that error with the lock named; the change never runs`, (t) => {
    const {where, lock} = setup();
    const real = fs.linkSync;
    t.mock.method(fs, 'linkSync', (a, b) => { if (b === lock) throw refused(code, a, b); return real(a, b); });
    const c = clock();
    let ran = false;
    assert.throws(() => withSettingsLock(where, () => { ran = true; }, {platform: 'win32', now: c.now, sleep: c.sleep}), (e) => e.code === code && e.path === lock && e.message.includes(lock) && !/\.tmp/.test(e.message));
    assert.strictEqual(ran, false);
    assert.ok(c.t >= 5000 && c.t < 6000, `given up at the wait's end (${c.t})`);
  });
}

test('win32 with a wait of 0 (start), or elsewhere: a link refused EPERM is thrown at once, as before', (t) => {
  const {where, lock} = setup();
  const real = fs.linkSync;
  t.mock.method(fs, 'linkSync', (a, b) => { if (b === lock) throw refused('EPERM', a, b); return real(a, b); });
  for (const [platform, waitMs] of [['win32', 0], ['linux', 5000]]) {
    const c = clock();
    assert.throws(() => withSettingsLock(where, () => 0, {platform, waitMs, now: c.now, sleep: c.sleep}), (e) => e.code === 'EPERM', platform);
    assert.strictEqual(c.sleeps, 0, `${platform}: no wait`);
  }
});

test('a lock that is there to the link but gone to the stat, again and again: the wait ends at its deadline, SETTINGS_BUSY, never a spin', (t) => {
  const {where, lock} = setup();
  const real = fs.linkSync;
  // (a loop with no deadline fails here, where the error escapes it)
  let links = 0;
  t.mock.method(fs, 'linkSync', (a, b) => { if (b === lock) { if (++links > 100000) throw new Error('a loop with no deadline'); throw Object.assign(new Error('EEXIST'), {code: 'EEXIST'}); } return real(a, b); });
  let stats = 0;
  const realStat = fs.statSync;
  t.mock.method(fs, 'statSync', (p, o) => {
    if (p === lock) { stats++; throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'}); }
    return realStat(p, o);
  });
  const c = clock();
  assert.throws(() => withSettingsLock(where, () => 0, {platform: 'linux', now: c.now, sleep: c.sleep}), {code: 'SETTINGS_BUSY'});
  assert.ok(c.t >= 5000 && c.t < 6000, `${c.t}`);
});

test('win32: a stat refused EPERM on the lock (its name being deleted) is busy; past the wait, that error', (t) => {
  const {where, lock} = setup();
  const real = fs.linkSync;
  // (a loop with no deadline fails here, where the error escapes it)
  let links = 0;
  t.mock.method(fs, 'linkSync', (a, b) => { if (b === lock) { if (++links > 100000) throw new Error('a loop with no deadline'); throw Object.assign(new Error('EEXIST'), {code: 'EEXIST'}); } return real(a, b); });
  let stats = 0;
  const realStat = fs.statSync;
  t.mock.method(fs, 'statSync', (p, o) => { if (p === lock) { stats++; throw refused('EPERM', p); } return realStat(p, o); });
  const c = clock();
  assert.throws(() => withSettingsLock(where, () => 0, {platform: 'win32', now: c.now, sleep: c.sleep}), (e) => e.code === 'EPERM' && e.path === lock);
  assert.ok(c.t >= 5000 && c.t < 6000, `${c.t}`);
});
