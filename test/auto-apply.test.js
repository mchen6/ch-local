'use strict';
require('./tmp-dirs');
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
const {chLocal} = require('../lib/command-line');
const {layout} = require('../lib/home');
// a command as the home names it once an install wrote its launcher
// (lib/command-line.js), as a regular expression's source
const cmd = (h, args) => chLocal(layout({COUNTINGHOUSE_HOME: h}), args).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const H = 3600e3;
const TO = '0.1.1';
function home({autoUpgrade = true, installed = '0.1.0', packs = ['ci-failure-triage']} = {}) {
  const h = tmp('ch-auto-');
  // (as an install of the release leaves it: the baseline additions are
  // judged against is the home's own modules, from the store: L4)
  require('./install-helpers').installedHome(h, packs, {runtime: {'@countinghouse/ch-local': installed, countinghouse: '8.0.0'}});
  fs.writeFileSync(path.join(h, 'settings.json'), JSON.stringify({version: 1, values: {autoUpgrade}}));
  return h;
}
const world = (opts = {}) => npmWorld(release(), Object.assign({version: TO}, opts));
const writeStampFile = (h, doc, mode = 0o600) => { const f = path.join(h, 'upgrade-check.json'); fs.writeFileSync(f, JSON.stringify(doc), {mode}); fs.chmodSync(f, mode); };
const stamp = (h) => { try { return JSON.parse(fs.readFileSync(path.join(h, 'upgrade-check.json'), 'utf8')); } catch (e) { return {}; } };
const historyOf = (h) => { try { return fs.readFileSync(path.join(h, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
// pins: the running release's, when a test's differ from the world's
// onFetch: called before each registry request (a home changed meanwhile)
const run = (h, w, {now = Date.now(), env = {}, exec = npm(TO), pins = null, onFetch = null} = {}) => {
  const io = fakeIo({env: Object.assign({COUNTINGHOUSE_HOME: h}, env), exec, fetch: (u, o) => { if (onFetch != null) onFetch(u); return globalThis.fetch(u, o); }});
  const go = () => autoApply({io, now, fromNpm: w != null ? w.fromNpm : {}}).then((r) => Object.assign(r, {io}));
  return w != null && w.pinsDoc != null ? asInstalled(pins || w.pinsDoc.pins, go, w.installed) : go();
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
    assert.match(done.line, new RegExp(`upgraded ch-local 0\\.1\\.0 -> 0\\.1\\.1; ${cmd(h, 'rollback')} undoes it`));
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
    // (version 2: a module's credential sent somewhere new)
    [(d) => { d.modules['@countinghouse/ch-access-github'].credentials = [{variable: 'COUNTINGHOUSE_GITHUB_TOKEN', origin: 'https://api.example.invalid'}]; }, /adds/, null],
    // the installed release pinned nothing of the runtime: a first pin blocks
    [null, /countinghouse: pinned for the first time/, {}]]) {
    const w = await world({at: new Date(now - 200 * H), edit, signedAs: installed});
    try {
      const h = home();
      writeStampFile(h, {firstSeen: {[TO]: now - 200 * H}});
      const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(TO), fetch: (u, o) => globalThis.fetch(u, o)});
      const r = await asInstalled(installedPins || w.pinsDoc.pins, () => autoApply({io, now, fromNpm: w.fromNpm}), w.installed);
      assert.strictEqual(r.outcome, 'needs-upgrade');
      assert.match(r.line, why);
      assert.match(r.line, /run ch-local upgrade/);
      assert.deepStrictEqual(io.execs, []);
    } finally {
      await w.close();
    }
  }
});

// L4: a held release is announced once per version (upgrade-check.json's
// announced), then said no more at each check until a newer one
test('L4: a release held back for what it adds is announced once: the next check says nothing and installs nothing', async() => {
  const now = Date.now();
  const installed = require('../lib/allowlist').ALLOWLIST.self;
  const w = await world({at: new Date(now - 200 * H), signedAs: installed,
    edit: (d) => { d.modules['@countinghouse/ch-access-github'].credentials = [{variable: 'GITHUB_TOKEN', origin: 'https://api.example.invalid'}]; }});
  try {
    const h = home();
    // (an announcement of a version no longer newer is dropped: the medium on L4, 7)
    writeStampFile(h, {firstSeen: {[TO]: now - 200 * H}, announced: [{version: '0.0.1', key: '0123456789abcdef'}]});
    const check = () => {
      const io = fakeIo({env: {COUNTINGHOUSE_HOME: h}, exec: npm(TO), fetch: (u, o) => globalThis.fetch(u, o)});
      return asInstalled(w.pinsDoc.pins, () => autoApply({io, now, fromNpm: w.fromNpm}), w.installed).then((r) => Object.assign(r, {io}));
    };
    const first = await check();
    assert.strictEqual(first.outcome, 'needs-upgrade');
    assert.match(first.line, /run ch-local upgrade/);
    assert.deepStrictEqual(stamp(h).announced.map((e) => e.version), [TO]);
    const again = await check();
    assert.deepStrictEqual([again.outcome, again.line], ['announced', undefined], 'said once');
    assert.deepStrictEqual(again.io.execs, [], 'nothing installed');
    assert.strictEqual(historyOf(h).filter((e) => e.outcome === 'needs-upgrade').length, 1, 'recorded once');
  } finally {
    await w.close();
  }
});

// L4 (#413 rev 3 section 9.6): a home with more than one pack upgrades
// automatically, the release's set installed as one
test('L4: a home with two packs upgrades automatically after the wait: both packs at the release\'s pins', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 100 * H)});
  try {
    const h = home({packs: ['ci-failure-triage', 'other']});
    assert.strictEqual((await run(h, w, {now})).outcome, 'waiting');
    const r = await run(h, w, {now: now + 73 * H});
    assert.strictEqual(r.outcome, 'installed', r.line);
    const after = JSON.parse(fs.readFileSync(path.join(h, 'modules.json'), 'utf8'));
    assert.strictEqual(after.runtime.versions['@countinghouse/ch-local'], TO);
    assert.deepStrictEqual(Object.keys(after.packs).sort(), ['ci-failure-triage', 'other']);
    for (const [p, e] of Object.entries(after.packs)) for (const [m, v] of Object.entries(e.modules)) assert.strictEqual(v, w.pinsDoc.pins[m].version, `${p} ${m}`);
    assert.ok(!historyOf(h).some((e) => e.outcome === 'several-packs'));
  } finally {
    await w.close();
  }
});

// the Reviewer's high on #101, round 2: a home changed while the automatic
// upgrade was prepared is not installed; said once
test('L4: a home changed while the automatic upgrade was prepared: not installed, said once', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 100 * H)});
  try {
    const h = home({packs: ['ci-failure-triage', 'other']});
    assert.strictEqual((await run(h, w, {now})).outcome, 'waiting');
    const file = path.join(h, 'modules.json');
    let changed = null;
    // after the record is judged, before the install: "other" is removed
    const onFetch = () => { if (changed == null) { require('./store-helpers').editHome(h, (r) => { delete r.packs.other; return r; }); changed = fs.readFileSync(file, 'utf8'); } };
    const r = await run(h, w, {now: now + 73 * H, onFetch});
    assert.strictEqual(r.outcome, 'home-changed', r.line);
    assert.strictEqual(r.line, `ch-local ${TO} was not installed: this home changed while the upgrade was prepared; the next check judges it again`);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), changed, 'nothing written');
  } finally {
    await w.close();
  }
});

// the Reviewer's high on L4, 1: a module moving back, and one a pack no
// longer lists, hold nothing, but the session line names them and history
// records them
test('L4: an automatic upgrade that moves a module back and drops one says each, and records the moves', async() => {
  const now = Date.now();
  const REDACT = '@countinghouse/ch-step-redact';
  // (other no longer lists ch-step-redact; ci-failure-triage still does)
  const w = await npmWorld(release({versions: {[REDACT]: '0.0.9'}}), {version: TO, at: new Date(now - 100 * H),
    edit: (doc) => { doc.packs.other.modules = doc.packs.other.modules.filter((m) => m !== REDACT); }});
  try {
    const h = home({packs: ['ci-failure-triage', 'other']});
    // the running release is the one installed: ch-step-redact at its 0.1.0
    const r0 = release();
    const pins = {...w.pinsDoc.pins, [REDACT]: {...w.pinsDoc.pins[REDACT], version: '0.1.0', integrity: r0.pins[REDACT].integrity}};
    const first = await run(h, w, {now, pins});
    assert.strictEqual(first.outcome, 'waiting', first.line);
    const r = await run(h, w, {now: now + 73 * H, pins});
    assert.strictEqual(r.outcome, 'installed', r.line);
    assert.match(r.line, /; ch-step-redact moved back 0\.1\.0 -> 0\.0\.9 \(ci-failure-triage\); ch-step-redact is no longer in other: it stays running through ci-failure-triage/);
    const last = historyOf(h).filter((e) => e.outcome === 'installed').pop();
    assert.deepStrictEqual(last.moves, [{module: REDACT, from: '0.1.0', to: '0.0.9', back: true, packs: ['ci-failure-triage']}]);
    assert.deepStrictEqual(last.dropped, [{module: REDACT, packs: ['other'], keptBy: ['ci-failure-triage']}]);
  } finally {
    await w.close();
  }
});

// the Reviewer on L4: a record that can't be read fails closed, said
test('L4: a home whose record cannot be read is not upgraded automatically, and says so; nothing is fetched', async() => {
  const w = await world();
  try {
    const h = home();
    fs.writeFileSync(path.join(h, 'modules.json'), '{"not": "a record"}');
    const r = await run(h, w);
    assert.strictEqual(r.outcome, 'record-unreadable');
    // (no path named; recorded in history: the Reviewer's high on L4, 7)
    assert.strictEqual(r.line, 'automatic upgrades are paused: this home\'s record can\'t be read: run `ch-local status`');
    assert.deepStrictEqual(w.reg.requests, []);
    const last = fs.readFileSync(path.join(h, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop();
    assert.deepStrictEqual([last.how, last.outcome, last.reason], ['auto', 'record-unreadable', 'RECORD_FORMAT']);
    // an earlier format is told to migrate, not that it can't be read
    const e = home();
    fs.unlinkSync(path.join(e, 'modules.json'));
    fs.writeFileSync(path.join(e, 'packs.json'), '{}');
    const old = await run(e, w);
    assert.strictEqual(old.outcome, 'record-unreadable');
    assert.strictEqual(old.line, 'automatic upgrades are paused: this home was made by an earlier ch-local: run `ch-local install` again to bring it to this one');
    // a development launcher's home keeps its own advice: its pack and --from
    const dev = home();
    fs.unlinkSync(path.join(dev, 'modules.json'));
    fs.writeFileSync(path.join(dev, 'installed.json'), '{"pack": "ci-failure-triage"}');
    assert.strictEqual((await run(dev, w)).line, 'automatic upgrades are paused: this home was made by an earlier development ch-local; run `ch-local install --pack ci-failure-triage --from <dir>` again');
  } finally {
    await w.close();
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
      assert.match(r.line, new RegExp(`run ${cmd(h, 'install')} to repair the relay's settings`), state);
      const after = fs.existsSync(path.join(h, 'shim.json')) ? fs.readFileSync(path.join(h, 'shim.json'), 'utf8') : null;
      assert.strictEqual(after, before, `${state}: never written`);
      assert.ok(historyOf(h).some((e) => e.change === 'shim.json' && new RegExp(`run ${cmd(h, 'install')} to repair`).test(e.notice)), state);
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
  const gone = doc.packs[name].modules;
  delete doc.packs[name];
  const used = new Set([...doc.runtime.packages, ...Object.values(doc.packs).flatMap((p) => p.modules)]);
  // (version 2: a module no pack lists has no description either)
  for (const pkg of gone) if (!used.has(pkg)) { delete doc.pins[pkg]; if (doc.modules != null) delete doc.modules[pkg]; }
};

// Withdrawn packs (maintainer's decision, 2026-11-17): an automatic upgrade to a
// release that withdraws the home's one pack installs it like any other (the
// usual reason is a security problem); the pack's entry stays, the line says
// it is withdrawn, and the next start skips it with the notice.
test('a release that withdraws the home\'s one pack installs automatically: the pack kept, the withdrawal said and recorded', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 100 * H), edit: withdrawFrom('ci-failure-triage')});
  try {
    const h = home();

    assert.strictEqual((await run(h, w, {now})).outcome, 'waiting');
    const r = await run(h, w, {now: now + 73 * H});
    assert.strictEqual(r.outcome, 'installed', r.line);
    assert.match(r.line, new RegExp(`upgraded ch-local 0\\.1\\.0 -> 0\\.1\\.1; ${cmd(h, 'rollback')} undoes it; pack ci-failure-triage was withdrawn in this release and was not started; \`${cmd(h, 'remove-pack ci-failure-triage')}\` removes it`));
    // it stays installed; the record's withdrawn list names its modules
    // (#413 section 9.7)
    const after = JSON.parse(fs.readFileSync(path.join(h, 'modules.json'), 'utf8'));
    assert.strictEqual(after.runtime.versions['@countinghouse/ch-local'], '0.1.1');
    assert.deepStrictEqual(Object.keys(after.packs), ['ci-failure-triage'], 'still recorded');
    // (its modules the release lists in no pack; ch-step-redact stays, as
    // other still lists it)
    assert.deepStrictEqual(after.withdrawn, ['@countinghouse/ch-access-github', '@countinghouse/ch-pack-ci-failure-triage']);
    assert.deepStrictEqual(historyOf(h).filter((e) => e.change === 'withdrawn').map((e) => [e.pack, e.to]), [['ci-failure-triage', '0.1.1']]);
  } finally {
    await w.close();
  }
});

// Withdrawn by the record: a home whose one pack the record lists as
// withdrawn still takes an automatic upgrade; a release that lists it again
// brings it to its pins
// (the Reviewer's high on L4, 4: a pack the record has withdrawn, listed
// again, is served again: new to the running set, so it holds the automatic
// upgrade and is said; ch-local upgrade shows it and installs it)
test('a home whose one pack the record lists as withdrawn, listed again: held, "served again" said, nothing installed', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 100 * H)});
  try {
    const h = home();
    require('./store-helpers').editHome(h, (r) => r, {release: {packs: {}}});
    const before = fs.readFileSync(path.join(h, 'modules.json'), 'utf8');
    const r = await run(h, w, {now: now + 73 * H});
    assert.strictEqual(r.outcome, 'needs-upgrade', r.line);
    assert.match(r.line, /it adds ci-failure-triage is served again: its modules start after the upgrade; a module in ci-failure-triage: /);
    assert.strictEqual(fs.readFileSync(path.join(h, 'modules.json'), 'utf8'), before, 'nothing installed');
  } finally {
    await w.close();
  }
});

// The deep review of #77 (HIGH): an automatic upgrade of a home keeps a held
// pack, its entry and its module versions.
test('an automatic upgrade keeps a held pack: its entry and its module versions', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 100 * H)});
  try {
    const h = home();
    const {storeModule, editHome} = require('./store-helpers');
    const gone = {from: {release: '0.0.9'}, modules: {'@countinghouse/ch-pack-gone': '1.0.0'}};
    const dir = storeModule(h, '@countinghouse/ch-pack-gone', '1.0.0', {countinghouse: {role: 'scenario'}, files: {kept: 'bytes'}});
    editHome(h, (rec) => ({...rec, held: {gone}}));
    assert.strictEqual((await run(h, w, {now})).outcome, 'waiting');
    const r = await run(h, w, {now: now + 73 * H});
    assert.strictEqual(r.outcome, 'installed', r.line);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(h, 'modules.json'), 'utf8')).held, {gone});
    assert.strictEqual(fs.readFileSync(path.join(dir, 'kept'), 'utf8'), 'bytes');
  } finally {
    await w.close();
  }
});

// the medium on B-shim-allow's round 2: an automatic upgrade's shim that
// could not be placed reaches the session's line, with the way back
test('an automatic upgrade whose shim is busy says so in its line, with the way back', async() => {
  const now = Date.now();
  const w = await world({at: new Date(now - 100 * H)});
  const si = require('../lib/shim-install');
  const realPrepare = si.prepareShim;
  const realPlace = si.placeShim;
  si.prepareShim = async () => ({status: 'ready', name: '@countinghouse/ch-shim-linux-x64', version: '0.5.0', binary: Buffer.from('x')});
  si.placeShim = () => { throw Object.assign(new Error('ch-shim.previous could not be removed (EBUSY)'), {code: 'SHIM_BUSY'}); };
  try {
    const h = home();
    await run(h, w, {now});
    const done = await run(h, w, {now: now + 73 * H});
    assert.strictEqual(done.outcome, 'installed', done.line);
    assert.match(done.line, /the shared runtime's new shim could not replace the old one: a session still uses it\. Close that session \(or the client running it\), then run `.*install` to place it/);
  } finally {
    si.prepareShim = realPrepare;
    si.placeShim = realPlace;
    await w.close();
  }
});
