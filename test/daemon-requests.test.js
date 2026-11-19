'use strict';
require('./tmp-dirs');
// lib/daemon-requests.js (C3b; #236 section 6, "Upgrade"): an install that
// changed the home appends an upgrade request to <home>/run/daemon/requests,
// which a running daemon watches. Owner-only, appended, never followed
// through a link.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {requestUpgrade, readRequests} = require('../lib/daemon-requests');

const home = () => {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-rq-')));
  fs.mkdirSync(path.join(h, 'run', 'daemon'), {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(h, 'run'), 0o700);
  fs.chmodSync(path.join(h, 'run', 'daemon'), 0o700);
  return h;
};
const file = (h) => path.join(h, 'run', 'daemon', 'requests');

test('an upgrade request is one JSON line, appended, at 0600, under start.lock', {skip: process.platform === 'win32'}, async () => {
  const h = home();
  try {
    assert.strictEqual(await requestUpgrade(h, {now: () => 1700000000000}), true);
    assert.strictEqual(await requestUpgrade(h, {now: () => 1700000000001}), true);
    assert.ok(!fs.existsSync(path.join(h, 'run', 'daemon', 'start.lock')), 'the lock released');
    assert.strictEqual(fs.readFileSync(file(h), 'utf8'), '{"op":"upgrade","at":1700000000000}\n{"op":"upgrade","at":1700000000001}\n');
    assert.strictEqual(fs.statSync(file(h)).mode & 0o777, 0o600);
  } finally { fs.rmSync(h, {recursive: true, force: true}); }
});

test('no daemon directory, or one that is not private, or a link at the file: nothing is written', {skip: process.platform === 'win32'}, async () => {
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-rq-'));
  assert.strictEqual(await requestUpgrade(none), false);
  fs.rmSync(none, {recursive: true, force: true});
  const open = home();
  fs.chmodSync(path.join(open, 'run', 'daemon'), 0o755);
  assert.strictEqual(await requestUpgrade(open), false);
  assert.ok(!fs.existsSync(file(open)));
  fs.rmSync(open, {recursive: true, force: true});
  const linked = home();
  const elsewhere = path.join(linked, 'elsewhere');
  fs.writeFileSync(elsewhere, '');
  fs.symlinkSync(elsewhere, file(linked));
  assert.strictEqual(await requestUpgrade(linked), false);
  assert.strictEqual(fs.readFileSync(elsewhere, 'utf8'), '', 'never written through a link');
  fs.rmSync(linked, {recursive: true, force: true});
});

test('readRequests reads the lines after an offset, by the private-file checks; partial and bad lines are skipped', {skip: process.platform === 'win32'}, async () => {
  const h = home();
  try {
    await requestUpgrade(h, {now: () => 1});
    const a = readRequests(h, 0);
    assert.deepStrictEqual(a.requests, [{op: 'upgrade', at: 1}]);
    fs.appendFileSync(file(h), 'not json\n{"op":"other"}\n{"op":"upgrade","at":2}\n{"op":"upgr');
    const b = readRequests(h, a.offset);
    assert.deepStrictEqual(b.requests, [{op: 'upgrade', at: 2}], 'unknown ops and bad lines skipped');
    assert.strictEqual(fs.readFileSync(file(h), 'utf8').slice(b.offset), '{"op":"upgr', 'a partial line waits');
    fs.chmodSync(file(h), 0o644);
    assert.deepStrictEqual(readRequests(h, 0).requests, [], 'not 0600: not read');
  } finally { fs.rmSync(h, {recursive: true, force: true}); }
});

test('emptyRequests leaves a file that grew after the read: false, nothing lost (the review of #35)', {skip: process.platform === 'win32'}, async () => {
  const {emptyRequests} = require('../lib/daemon-requests');
  const h = home();
  try {
    await requestUpgrade(h, {now: () => 1});
    const a = readRequests(h, 0);
    await requestUpgrade(h, {now: () => 2});
    assert.strictEqual(emptyRequests(h, a.offset), false);
    assert.deepStrictEqual(readRequests(h, a.offset).requests, [{op: 'upgrade', at: 2}], 'the later line still there');
    assert.strictEqual(emptyRequests(h, fs.statSync(file(h)).size), true);
    assert.strictEqual(fs.statSync(file(h)).size, 0);
  } finally { fs.rmSync(h, {recursive: true, force: true}); }
});

test('requestUpgrade waits while start.lock is held, writing nothing, and writes once it is released (the review of #35)', {skip: process.platform === 'win32'}, async () => {
  const {withLockFile} = require('../lib/lock');
  const h = home();
  try {
    let release = null;
    const held = new Promise((r) => { release = r; });
    const dir = path.join(h, 'run', 'daemon');
    const holder = withLockFile(path.join(dir, 'start.lock'), dir, {stderr: {write: () => {}}}, () => held.then(() => 0), {wait: true});
    await new Promise((r) => setTimeout(r, 50));
    let done = false;
    const asking = requestUpgrade(h).then((v) => { done = true; return v; });
    await new Promise((r) => setTimeout(r, 400));
    assert.strictEqual(done, false, 'still waiting on the lock');
    assert.ok(!fs.existsSync(file(h)), 'nothing written meanwhile');
    release();
    await holder;
    assert.strictEqual(await asking, true);
    assert.ok(fs.readFileSync(file(h), 'utf8').includes('"op":"upgrade"'));
  } finally { fs.rmSync(h, {recursive: true, force: true}); }
});

// the review of #39: on Windows the directory's owner and DACL decide, as a
// directory; injected here, so it runs everywhere
test('Windows (injected): a daemon directory whose DACL is not private gets no request; a private one does', async () => {
  const h = home();
  try {
    const dir = path.join(h, 'run', 'daemon');
    const user = 'S-1-5-21-1-2-3-1001';
    const priv = () => ({user, owner: user, otherAces: false, rules: [{sid: user, rights: 2032127, type: 'Allow', inheritOnly: false}]});
    const open = () => ({user, owner: user, otherAces: false, rules: [{sid: 'S-1-1-0', rights: 2032127, type: 'Allow', inheritOnly: false}]});
    const flows = () => ({user, owner: user, otherAces: false, rules: [{sid: 'S-1-1-0', rights: 2032127, type: 'Allow', inheritOnly: true}]});
    for (const acl of [open, flows, () => { throw new Error('denied'); }]) {
      assert.strictEqual(await requestUpgrade(h, {platform: 'win32', fileAcl: acl}), false);
      assert.ok(!fs.existsSync(path.join(dir, 'requests')));
    }
    assert.strictEqual(await requestUpgrade(h, {platform: 'win32', fileAcl: priv}), true);
    assert.strictEqual(readRequests(h, 0).requests.length, 1);
  } finally {
    fs.rmSync(h, {recursive: true, force: true});
  }
});
