'use strict';
// lib/auto-apply.js, `ch-local upgrade --apply-auto` (docs/development/
// auto-upgrade.md, "The child that applies it", "The 72-hour wait",
// "Announcements"): it re-checks everything itself, then installs a newer
// release only 72 h after the later of its publish attestation's log time
// and when this install first saw it. A fake registry and the test root, as
// its test-only argument. The installed release is 0.1.0 and the new one
// 0.1.1, a patch (a 0.x minor is treated as a major, the review of #48).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {autoApply, rootExpired} = require('../lib/auto-apply');
const {npmWorld, asInstalled} = require('./npm-world');
const {release, npm} = require('./install-helpers');
const {fakeIo, tmp} = require('./fake-io');

const H = 3600e3;
const TO = '0.1.1';
function home({autoUpgrade = true, installed = '0.1.0', packs = ['ci-failure-triage']} = {}) {
  const h = tmp('ch-auto-');
  fs.writeFileSync(path.join(h, 'packs.json'), JSON.stringify({runtime: {versions: {'@countinghouse/ch-local': installed, countinghouse: '8.0.0'}},
    packs: Object.fromEntries(packs.map((p) => [p, {packages: {}, credentials: []}]))}));
  fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({version: 1, values: {autoUpgrade}}));
  return h;
}
const world = (opts = {}) => npmWorld(release(), Object.assign({version: TO}, opts));
const writeStampFile = (h, doc, mode = 0o600) => { const f = path.join(h, 'upgrade-check.json'); fs.writeFileSync(f, JSON.stringify(doc), {mode}); fs.chmodSync(f, mode); };
const stamp = (h) => { try { return JSON.parse(fs.readFileSync(path.join(h, 'upgrade-check.json'), 'utf8')); } catch (e) { return {}; } };
const historyOf = (h) => { try { return fs.readFileSync(path.join(h, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
const run = (h, w, {now = Date.now(), env = {}, exec = npm(TO)} = {}) => {
  const io = fakeIo({env: Object.assign({COUNTINGHOUSE_HOME: h}, env), exec, fetch: (u, o) => globalThis.fetch(u, o)});
  const go = () => autoApply({io, now, fromNpm: w != null ? w.fromNpm : {}}).then((r) => Object.assign(r, {io}));
  return w != null && w.pinsDoc != null ? asInstalled(w.pinsDoc.pins, go) : go();
};

test('off, or a development override: nothing fetched, the override named', async() => {
  const w = await world();
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

test('the wait: from the later of the publish log time and first seen; 71 h is too soon, 73 h installs, saying only its line', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 100 * H)});
  try {
    const h = home();
    // first seen now, though signed 100 h ago: waits from now
    const first = await run(h, w, {now});
    assert.strictEqual(first.outcome, 'waiting');
    assert.match(first.line, /ch-local 0\.1\.1 is available; it installs automatically after /);
    assert.strictEqual(stamp(h).firstSeen[TO], now);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(path.join(h, 'upgrade-check.json')).mode & 0o777, 0o600, 'written private');
    assert.strictEqual((await run(h, w, {now: now + 71 * H})).outcome, 'waiting');
    const done = await run(h, w, {now: now + 73 * H});
    assert.strictEqual(done.outcome, 'installed', done.line);
    assert.match(done.line, /upgraded ch-local 0\.1\.0 -> 0\.1\.1; ch-local rollback undoes it/);
    // the install's own lines (paths, credentials) stay out of what the child prints
    assert.strictEqual(done.io.out, '');
    assert.strictEqual(done.io.err, '');
  } finally {
    await w.close();
  }
});

test('a version published 1 h ago waits 72 h from its publish time even if seen long before', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 1 * H)});
  try {
    const h = home();
    writeStampFile(h, {firstSeen: {[TO]: now - 500 * H}});
    assert.strictEqual((await run(h, w, {now})).outcome, 'waiting');
  } finally {
    await w.close();
  }
});

test('the review of #48: a malformed or future first-seen, or a stamp that is not private, waits; it never installs', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 1 * H)});
  try {
    for (const bad of ['x', {}, [1, 2], null, true, now + 1000 * H, -5, 1e400]) {
      const h = home();
      writeStampFile(h, {firstSeen: {[TO]: bad}});
      const r = await run(h, w, {now});
      assert.strictEqual(r.outcome, 'waiting', JSON.stringify(bad));
      assert.strictEqual(stamp(h).firstSeen[TO], now, `reset to now: ${JSON.stringify(bad)}`);
    }
    // POSIX: a stamp group or others could write, or a link: not read, so the wait starts again
    if (process.platform === 'win32') return;
    const h = home();
    writeStampFile(h, {firstSeen: {[TO]: now - 500 * H}}, 0o666);
    const r = await run(h, w, {now});
    assert.strictEqual(r.outcome, 'waiting');
    assert.ok(historyOf(h).some((e) => e.outcome === 'stamp-reset' && /group or others/.test(e.reason)));
    assert.strictEqual(fs.statSync(path.join(h, 'upgrade-check.json')).mode & 0o777, 0o600, 'written back private');
    // a link in its place: not followed
    const h2 = home();
    const elsewhere = path.join(tmp('ch-elsewhere-'), 'stamp.json');
    fs.writeFileSync(elsewhere, JSON.stringify({firstSeen: {[TO]: now - 500 * H}}), {mode: 0o600});
    fs.symlinkSync(elsewhere, path.join(h2, 'upgrade-check.json'));
    assert.strictEqual((await run(h2, w, {now})).outcome, 'waiting');
    assert.strictEqual(JSON.parse(fs.readFileSync(elsewhere, 'utf8')).firstSeen[TO], now - 500 * H, 'the link\'s target untouched');
  } finally {
    await w.close();
  }
});

test('identity changes, a first pin, or additions block: announced, never installed', async() => {
  const now = Date.now();
  const installed = require('../lib/allowlist').ALLOWLIST.self;
  for (const [edit, why, installedPins] of [
    [(d) => { d.self.ownerId += 1; }, /identity changes/, null],
    [(d) => { d.allowedOrigins['https://api.example.invalid'] = ['NEW_TOKEN']; }, /adds/, null],
    // the installed release pinned nothing of the runtime: a first pin blocks
    [null, /countinghouse: pinned for the first time/, {}]]) {
    const w = await world({at: new Date(now - 200 * H), edit, signedAs: installed});
    try {
      const h = home();
      writeStampFile(h, {firstSeen: {[TO]: now - 200 * H}});
      const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(TO), fetch: (u, o) => globalThis.fetch(u, o)});
      const r = await asInstalled(installedPins || w.pinsDoc.pins, () => autoApply({io, now, fromNpm: w.fromNpm}));
      assert.strictEqual(r.outcome, 'needs-upgrade');
      assert.match(r.line, why);
      assert.match(r.line, /run ch-local upgrade/);
      assert.deepStrictEqual(io.execs, []);
    } finally {
      await w.close();
    }
  }
});

test('the review of #48: a 0.x minor is a major here, announced and never installed', async() => {
  const now = Date.now();
  const w = await world({version: '0.2.0', at: new Date(now - 200 * H)});
  try {
    const h = home();
    writeStampFile(h, {firstSeen: {'0.2.0': now - 200 * H}});
    const r = await run(h, w, {now, exec: npm('0.2.0')});
    assert.strictEqual(r.outcome, 'major');
    assert.match(r.line, /0\.2\.0 may break what 0\.1\.0 does .*run ch-local upgrade/);
    assert.deepStrictEqual(r.io.execs, []);
  } finally {
    await w.close();
  }
});

test('the re-check of #48: a major is never installed here, nothing of it fetched but the packument', async() => {
  const now = Date.now();
  const w = await world({version: '1.0.0', at: new Date(now - 200 * H)});
  try {
    const h = home();
    writeStampFile(h, {firstSeen: {'1.0.0': now - 200 * H}});
    const r = await run(h, w, {now, exec: npm('1.0.0')});
    assert.strictEqual(r.outcome, 'major');
    assert.match(r.line, /ch-local 1\.0\.0 is a major upgrade: run ch-local upgrade to install it/);
    assert.deepStrictEqual(r.io.execs, []);
    assert.ok(!w.reg.requests.some((u) => u.endsWith('.tgz')));
  } finally {
    await w.close();
  }
});

test('the re-check of #48: with shim.json missing or invalid, an automatic install still never writes it; it says to repair it, and records that', async() => {
  const now = Date.now();
  for (const state of ['missing', 'invalid']) {
    const w = await world({at: new Date(now - 200 * H)});
    try {
      const h = home();
      writeStampFile(h, {firstSeen: {[TO]: now - 200 * H}});
      if (state === 'invalid') fs.writeFileSync(path.join(h, 'shim.json'), '{"node": "relative"}', {mode: 0o600});
      const before = fs.existsSync(path.join(h, 'shim.json')) ? fs.readFileSync(path.join(h, 'shim.json'), 'utf8') : null;
      const r = await run(h, w, {now, env: {PATH: '/a/client/config/path', HOME: '/a/client/home'}});
      assert.strictEqual(r.outcome, 'installed', r.line);
      assert.match(r.line, /run ch-local install to repair the relay's settings/, state);
      const after = fs.existsSync(path.join(h, 'shim.json')) ? fs.readFileSync(path.join(h, 'shim.json'), 'utf8') : null;
      assert.strictEqual(after, before, `${state}: never written`);
      assert.ok(historyOf(h).some((e) => e.change === 'shim.json' && /run ch-local install to repair/.test(e.notice)), state);
    } finally {
      await w.close();
    }
  }
});

test('the review of #48: a version a rollback left is never installed again here', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 200 * H)});
  try {
    const h = home();
    writeStampFile(h, {firstSeen: {[TO]: now - 200 * H}, declined: [TO]});
    const r = await run(h, w, {now});
    assert.strictEqual(r.outcome, 'declined');
    assert.deepStrictEqual(r.io.execs, []);
  } finally {
    await w.close();
  }
});

test('the review of #48: an automatic install keeps shim.json as it is: the session\'s environment never reaches it', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 200 * H)});
  try {
    const h = home();
    writeStampFile(h, {firstSeen: {[TO]: now - 200 * H}});
    const shimJson = require('../lib/shim-config').writeShimJson(h, {node: process.execPath, env: {PATH: '/the/install/path', HOME: '/the/install/home'}, platform: process.platform});
    const before = fs.readFileSync(path.join(h, 'shim.json'), 'utf8');
    const r = await run(h, w, {now, env: {PATH: '/a/client/config/path', HOME: '/a/client/home', TMPDIR: '/a/client/tmp'}});
    assert.strictEqual(r.outcome, 'installed', r.line);
    assert.strictEqual(fs.readFileSync(path.join(h, 'shim.json'), 'utf8'), before);
    assert.strictEqual(shimJson.env.PATH, '/the/install/path');
  } finally {
    await w.close();
  }
});

test('a verification failure is remembered by version and root; a transport failure, or attestations not there yet, never is', async() => {
  const now = Date.now();
  const w = await world({lie: '@countinghouse/ch-local'});
  try {
    const h = home();
    const r = await run(h, w, {now});
    assert.strictEqual(r.outcome, 'refused');
    assert.match(r.line, /@countinghouse\/ch-local@0\.1\.1.*not installed/);
    assert.strictEqual(stamp(h).refused.length, 1);
    const before = w.reg.requests.length;
    const again = await run(h, w, {now: now + H});
    assert.strictEqual(again.outcome, 'remembered');
    assert.ok(w.reg.requests.length - before <= 1, 'only the packument asked again');
  } finally {
    await w.close();
  }
  // no attestations on the registry (a 404): tried again, not remembered
  const w2 = await world();
  try {
    w2.reg.attest('@countinghouse/ch-local', TO, null);
    const h = home();
    const r = await run(h, w2, {now});
    assert.strictEqual(r.outcome, 'not-yet', r.line);
    assert.deepStrictEqual(stamp(h).refused, []);
  } finally {
    await w2.close();
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
  writeStampFile(h, {lastSuccess: now - 8 * 24 * H});
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

// A release that withdraws the pack `name`: its entry and the pins of its
// packages that nothing else in the release uses are gone, as a real one's are.
const withdrawFrom = (name) => (doc) => {
  const gone = doc.packs[name].packages;
  delete doc.packs[name];
  const used = new Set([...doc.runtime.packages, ...Object.values(doc.packs).flatMap((p) => p.packages)]);
  for (const pkg of gone) if (!used.has(pkg)) delete doc.pins[pkg];
};

// Withdrawn packs (Matt, 2026-11-17, option 1): an automatic upgrade to a
// release that withdraws the home's one pack installs it like any other (the
// usual reason is a security problem); the pack's entry stays, the line says
// it is withdrawn, and the next start skips it with the notice.
test('a release that withdraws the home\'s one pack installs automatically: the pack kept, the withdrawal said and recorded', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 100 * H), edit: withdrawFrom('ci-failure-triage')});
  try {
    const h = home();
    const entry = JSON.parse(fs.readFileSync(path.join(h, 'packs.json'), 'utf8')).packs['ci-failure-triage'];
    assert.strictEqual((await run(h, w, {now})).outcome, 'waiting');
    const r = await run(h, w, {now: now + 73 * H});
    assert.strictEqual(r.outcome, 'installed', r.line);
    assert.match(r.line, /upgraded ch-local 0\.1\.0 -> 0\.1\.1; ch-local rollback undoes it; pack ci-failure-triage was withdrawn in this release and was not started; `ch-local remove-pack ci-failure-triage` removes it/);
    const after = JSON.parse(fs.readFileSync(path.join(h, 'packs.json'), 'utf8'));
    assert.strictEqual(after.runtime.versions['@countinghouse/ch-local'], '0.1.1');
    assert.deepStrictEqual(after.packs, {}, 'no longer an installed pack');
    assert.deepStrictEqual(after.held, {'ci-failure-triage': {...entry, installedUnder: '0.1.0', withdrawn: true}}, 'held, marked withdrawn');
    assert.deepStrictEqual(historyOf(h).filter((e) => e.change === 'withdrawn').map((e) => [e.pack, e.to]), [['ci-failure-triage', '0.1.1']]);
  } finally {
    await w.close();
  }
});

// The review of the held design: a home whose only pack an upgrade withdrew
// still takes an automatic upgrade, runtime only; a release that lists the
// pack again says how to add it back.
test('a home whose only pack is held as withdrawn still upgrades automatically; a release listing it again says so', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 100 * H)});
  try {
    const h = home({packs: []});
    const f = path.join(h, 'packs.json');
    fs.writeFileSync(f, JSON.stringify({...JSON.parse(fs.readFileSync(f, 'utf8')), held: {'ci-failure-triage': {packages: {}, credentials: [], installedUnder: '0.0.9', withdrawn: true}}}));
    assert.strictEqual((await run(h, w, {now})).outcome, 'waiting');
    const r = await run(h, w, {now: now + 73 * H});
    assert.strictEqual(r.outcome, 'installed', r.line);
    assert.match(r.line, /pack ci-failure-triage is in this release again: `ch-local add-pack ci-failure-triage` adds it back/);
  } finally {
    await w.close();
  }
});
