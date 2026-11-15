'use strict';
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
