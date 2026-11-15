'use strict';
// lib/auto-apply.js, `ch-local upgrade --apply-auto` (docs/development/
// auto-upgrade.md, "The child that applies it", "The 72-hour wait",
// "Announcements"): it re-checks everything itself, then installs a newer
// release only 72 h after the later of its publish attestation's log time
// and when this install first saw it. A fake registry and the test root, as
// its test-only argument.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {autoApply, rootExpired} = require('../lib/auto-apply');
const {npmWorld} = require('./npm-world');
const {release, npm} = require('./install-helpers');
const {fakeIo, tmp} = require('./fake-io');

const H = 3600e3;
function home({autoUpgrade = true, installed = '0.1.0', packs = ['ci-failure-triage']} = {}) {
  const h = tmp('ch-auto-');
  fs.writeFileSync(path.join(h, 'packs.json'), JSON.stringify({runtime: {versions: {'@countinghouse/ch-local': installed, countinghouse: '8.0.0'}},
    packs: Object.fromEntries(packs.map((p) => [p, {packages: {}, credentials: []}]))}));
  fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({version: 1, values: {autoUpgrade}}));
  return h;
}
const stamp = (h) => { try { return JSON.parse(fs.readFileSync(path.join(h, 'upgrade-check.json'), 'utf8')); } catch (e) { return {}; } };
const run = (h, w, {now = Date.now(), env = {}, exec = npm()} = {}) => {
  const io = fakeIo({env: Object.assign({COUNTINGHOUSE_HOME: h}, env), exec, fetch: (u, o) => globalThis.fetch(u, o)});
  return autoApply({io, now, fromNpm: w != null ? w.fromNpm : {}}).then((r) => Object.assign(r, {io}));
};

test('off, or a development override: nothing fetched, the override named', async() => {
  const w = await npmWorld(release());
  try {
    const off = await run(home({autoUpgrade: false}), w);
    assert.strictEqual(off.outcome, 'off');
    for (const env of [{CH_LOCAL_DEV: '1'}, {CH_LOCAL_REMOTE_MAP: 'x=y'}]) {
      const r = await run(home(), w, {env});
      assert.strictEqual(r.outcome, 'override');
      assert.match(r.line, new RegExp(`automatic upgrades are off while a development override is set \\(${Object.keys(env)[0]}\\)`));
    }
    assert.deepStrictEqual(w.reg.requests, []);
  } finally {
    await w.close();
  }
});

test('the wait: from the later of the publish log time and first seen; 71 h is too soon, 73 h installs', async() => {
  const now = Date.now();
  const w = await npmWorld(release(), {at: new Date(now - 100 * H)});
  try {
    const h = home();
    // first seen now, though signed 100 h ago: waits from now
    const first = await run(h, w, {now});
    assert.strictEqual(first.outcome, 'waiting');
    assert.match(first.line, /ch-local 0\.2\.0 is available; it installs automatically after /);
    assert.strictEqual(stamp(h).firstSeen['0.2.0'], now);
    assert.strictEqual((await run(h, w, {now: now + 71 * H})).outcome, 'waiting');
    const done = await run(h, w, {now: now + 73 * H});
    assert.strictEqual(done.outcome, 'installed', done.line);
    assert.match(done.line, /upgraded ch-local 0\.1\.0 -> 0\.2\.0; ch-local rollback undoes it/);
  } finally {
    await w.close();
  }
});

test('a version published 1 h ago waits 72 h from its publish time even if seen long before', async() => {
  const now = Date.now();
  const w = await npmWorld(release(), {at: new Date(now - 1 * H)});
  try {
    const h = home();
    fs.writeFileSync(path.join(h, 'upgrade-check.json'), JSON.stringify({firstSeen: {'0.2.0': now - 500 * H}}));
    assert.strictEqual((await run(h, w, {now})).outcome, 'waiting');
  } finally {
    await w.close();
  }
});

test('identity changes or additions block: announced, never installed', async() => {
  const now = Date.now();
  const installed = require('../lib/allowlist').ALLOWLIST.self;
  for (const [edit, why] of [[(d) => { d.self.ownerId += 1; }, /identity changes/], [(d) => { d.allowedOrigins['https://api.example.invalid'] = ['NEW_TOKEN']; }, /adds/]]) {
    const w = await npmWorld(release(), {at: new Date(now - 200 * H), edit, signedAs: installed});
    try {
      const h = home();
      fs.writeFileSync(path.join(h, 'upgrade-check.json'), JSON.stringify({firstSeen: {'0.2.0': now - 200 * H}}));
      const r = await run(h, w, {now});
      assert.strictEqual(r.outcome, 'needs-upgrade');
      assert.match(r.line, why);
      assert.match(r.line, /run ch-local upgrade/);
      assert.deepStrictEqual(r.io.execs, []);
    } finally {
      await w.close();
    }
  }
});

test('a verification failure is remembered by version and root; a transport failure never is', async() => {
  const now = Date.now();
  const w = await npmWorld(release(), {lie: '@countinghouse/ch-local'});
  try {
    const h = home();
    const r = await run(h, w, {now});
    assert.strictEqual(r.outcome, 'refused');
    assert.match(r.line, /@countinghouse\/ch-local@0\.2\.0's provenance did not verify|not installed/);
    assert.strictEqual(stamp(h).refused.length, 1);
    const before = w.reg.requests.length;
    const again = await run(h, w, {now: now + H});
    assert.strictEqual(again.outcome, 'remembered');
    assert.ok(w.reg.requests.length - before <= 1, 'only the packument asked again');
  } finally {
    await w.close();
  }
  // the registry down: unreachable, not remembered
  const h2 = home();
  const down = await run(h2, {fromNpm: {registry: 'http://127.0.0.1:9/'}}, {now});
  assert.strictEqual(down.outcome, 'unreachable');
  assert.deepStrictEqual(stamp(h2).refused || [], []);
});

test('seven days with no successful check is announced', async() => {
  const now = Date.now();
  const h = home();
  fs.writeFileSync(path.join(h, 'upgrade-check.json'), JSON.stringify({lastSuccess: now - 8 * 24 * H}));
  const r = await run(h, {fromNpm: {registry: 'http://127.0.0.1:9/'}}, {now});
  assert.strictEqual(r.outcome, 'unreachable');
  assert.match(r.line, /no upgrade check has succeeded for 7 days/);
});

test('an expired root: announced at every check, nothing fetched', () => {
  const root = {certificateAuthorities: [{validFor: {start: '2021-01-01T00:00:00Z', end: '2022-01-01T00:00:00Z'}}, {validFor: {start: '2022-01-01T00:00:00Z', end: '2023-01-01T00:00:00Z'}}]};
  assert.strictEqual(rootExpired(root, Date.UTC(2024, 0, 1)), true);
  assert.strictEqual(rootExpired(root, Date.UTC(2022, 6, 1)), false);
  assert.strictEqual(rootExpired({certificateAuthorities: [{validFor: {start: '2022-01-01T00:00:00Z'}}]}, Date.UTC(2030, 0, 1)), false, 'an open window');
  assert.strictEqual(rootExpired(require('../lib/sigstore/trusted-root.json'), Date.now()), false, 'the shipped root is current');
});

test('the CLI: `ch-local upgrade --apply-auto` runs it and prints its line; with --auto it is a usage error', async() => {
  const {main} = require('../bin/ch-local');
  const h = home();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: h, CH_LOCAL_DEV: '1'}});
  assert.strictEqual(await main(['upgrade', '--apply-auto'], io), 0);
  assert.match(io.out, /automatic upgrades are off while a development override is set \(CH_LOCAL_DEV\)/);
  assert.deepStrictEqual(io.fetches, []);
  const io2 = fakeIo({env: {COUNTINGHOUSE_HOME: h}});
  assert.strictEqual(await main(['upgrade', '--apply-auto', '--auto', 'on'], io2), 2);
});
