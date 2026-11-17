'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {upgrade} = require('../lib/upgrade');
const {latestVersions} = require('../lib/registry');
const {fakeIo, tmp} = require('./fake-io');

function setup(versions = {'@countinghouse/ch-local': '0.2.0', '@countinghouse/ch-step-redact': '0.1.0'}, {unreleased = false} = {}) {
  const home = tmp('ch-home-');
  const runtime = Object.fromEntries(Object.entries(versions).filter(([n]) => n === '@countinghouse/ch-local' || n === 'countinghouse'));
  const pack = Object.fromEntries(Object.entries(versions).filter(([n]) => runtime[n] == null));
  fs.writeFileSync(path.join(home, 'packs.json'), JSON.stringify({runtime: {versions: runtime}, packs: {'ci-failure-triage': {packages: pack, credentials: []}}, unreleased}));
  return {home, done: () => fs.rmSync(home, {recursive: true, force: true})};
}
// The npm registry's abbreviated metadata, by package.
const registry = (latest) => async (url) => {
  const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', ''));
  return {ok: true, status: 200, json: async () => ({name, 'dist-tags': {latest: latest[name]}})};
};

// `ch-local upgrade` from npm (docs/development/auto-upgrade.md): the newer
// ch-local, checked by its provenance, its pins read from its verified bytes,
// shown with what it adds, and on a yes installed through install. A fake
// registry and the test root reach it only as its test-only argument.
const {npmWorld} = require('./npm-world');
const {release, npm} = require('./install-helpers');
const recordOf = (home) => JSON.parse(fs.readFileSync(path.join(home, 'packs.json'), 'utf8'));
const historyOf = (home) => { try { return fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch (e) { return []; } };
const realFetch = (url, opts) => globalThis.fetch(url, opts);
// at a terminal: the yes is a person's (the review of #48)
const tty = (opts) => Object.assign(fakeIo(opts), {interactive: true});

test('upgrade shows the installed and the newer ch-local, checked; a no changes nothing', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const w = await npmWorld(release());
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['no'], fetch: realFetch});
    const before = fs.readFileSync(path.join(s.home, 'packs.json'), 'utf8');
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.match(io.out, /ch-local 0\.1\.0 -> 0\.2\.0, its provenance checked/);
    assert.match(io.out, /nothing changed/);
    assert.strictEqual(io.asked.length, 1);
    assert.deepStrictEqual(io.execs, []);
    assert.strictEqual(fs.readFileSync(path.join(s.home, 'packs.json'), 'utf8'), before);
  } finally {
    await w.close();
    s.done();
  }
});

test('nothing newer: up to date, nothing asked; a major: checked, shown as a major, and installed only on a yes at a terminal', async () => {
  const s = setup({'@countinghouse/ch-local': '0.2.0'});
  const w = await npmWorld(release());
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.match(io.out, /everything is up to date/);
    assert.deepStrictEqual(io.asked, []);
  } finally {
    await w.close();
    s.done();
  }
  const s2 = setup({'@countinghouse/ch-local': '0.1.0'});
  const w2 = await npmWorld(release(), {version: '1.0.0'});
  try {
    const no = tty({env: {COUNTINGHOUSE_HOME: s2.home}, answers: ['no'], fetch: realFetch});
    assert.strictEqual(await upgrade({}, no, w2.fromNpm), 0, no.err);
    assert.match(no.out, /ch-local 0\.1\.0 -> 1\.0\.0, its provenance checked/);
    assert.match(no.out, /ch-local 1\.0\.0 is a major upgrade: it may change how things work \(an automatic upgrade never takes it\)/);
    assert.strictEqual(no.asked.length, 1);
    assert.deepStrictEqual(no.execs, []);
    const piped = fakeIo({env: {COUNTINGHOUSE_HOME: s2.home}, answers: ['yes'], fetch: realFetch});
    assert.strictEqual(await upgrade({}, piped, w2.fromNpm), 2, 'no terminal: nothing installed');
    const yes = tty({env: {COUNTINGHOUSE_HOME: s2.home}, answers: ['yes'], exec: npm('1.0.0'), fetch: realFetch});
    assert.strictEqual(await upgrade({}, yes, w2.fromNpm), 0, yes.err);
    assert.match(yes.out, /upgraded ch-local 0\.1\.0 -> 1\.0\.0/);
    assert.strictEqual(recordOf(s2.home).runtime.versions['@countinghouse/ch-local'], '1.0.0');
  } finally {
    await w2.close();
    s2.done();
  }
});

test('a development override in force: upgrade refuses, naming it, and fetches nothing', async () => {
  for (const env of [{CH_LOCAL_DEV: '1'}, {CH_LOCAL_REMOTE_MAP: 'https://api.githubcopilot.com=http://127.0.0.1:1'}]) {
    const s = setup({'@countinghouse/ch-local': '0.1.0'});
    try {
      const io = fakeIo({env: Object.assign({COUNTINGHOUSE_HOME: s.home}, env), fetch: realFetch});
      assert.strictEqual(await upgrade({}, io), 1);
      assert.match(io.err, new RegExp(`upgrades are off while a development override is set \\(${Object.keys(env)[0]}\\)`));
      assert.deepStrictEqual(io.fetches, []);
    } finally {
      s.done();
    }
  }
});

test('a release whose provenance fails is never offered: said, recorded, nothing asked or installed', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const w = await npmWorld(release(), {lie: '@countinghouse/ch-local'});
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 1);
    assert.match(io.err, /@countinghouse\/ch-local@0\.2\.0 .*not installed \(PROVENANCE_IDENTITY\)/);
    assert.deepStrictEqual(io.asked, []);
    assert.deepStrictEqual(io.execs, []);
    const h = historyOf(s.home).filter((e) => e.kind === 'upgrade');
    assert.deepStrictEqual(h.map((e) => [e.how, e.outcome, e.to]), [['cli', 'refused', '0.2.0']]);
  } finally {
    await w.close();
    s.done();
  }
});

test('a yes installs the new release from npm through install, recorded in history, rollback named', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const w = await npmWorld(release());
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.strictEqual(recordOf(s.home).runtime.versions['@countinghouse/ch-local'], '0.2.0');
    assert.match(io.out, /upgraded ch-local 0\.1\.0 -> 0\.2\.0; ch-local rollback undoes it/);
    const h = historyOf(s.home).filter((e) => e.kind === 'upgrade');
    assert.deepStrictEqual(h.map((e) => [e.how, e.outcome, e.from, e.to]), [['cli', 'installed', '0.1.0', '0.2.0']]);
    assert.ok(io.fetches.every((u) => u.startsWith(w.reg.url)), 'the fake registry only');
    // the bytes whose pins were read are the bytes installed: fetched once
    assert.strictEqual(w.reg.requests.filter((u) => /ch-local-0\.2\.0\.tgz$/.test(u)).length, 1);
  } finally {
    await w.close();
    s.done();
  }
});

test('identity changes are shown before the question, marked as never taken automatically', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const installed = require('../lib/allowlist').ALLOWLIST.self;
  // the new release names another owner ID for itself; its certificate is
  // still the installed identity's, so it verifies
  const w = await npmWorld(release(), {edit: (doc) => { doc.self.ownerId += 1; }, signedAs: installed});
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['no'], fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.match(io.out, new RegExp(`its identity changes \\(an automatic upgrade never takes these\\):\\n  self's ownerId: ${installed.ownerId} -> ${installed.ownerId + 1}`));
  } finally {
    await w.close();
    s.done();
  }
});

test('what the new release adds is shown before the question', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const w = await npmWorld(release(), {edit: (doc) => { doc.allowedOrigins['https://api.example.invalid'] = ['NEW_TOKEN']; }});
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['no'], fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.match(io.out, /it adds:\n  an origin: https:\/\/api\.example\.invalid/);
  } finally {
    await w.close();
    s.done();
  }
});

test('the registry is asked for abbreviated metadata, one package per request', async () => {
  const io = fakeIo({fetch: registry({'@countinghouse/ch-local': '1.0.0'})});
  assert.deepStrictEqual(await latestVersions(['@countinghouse/ch-local'], io), {'@countinghouse/ch-local': '1.0.0'});
  assert.deepStrictEqual(io.fetches, ['https://registry.npmjs.org/@countinghouse%2Fch-local']);
});

test('the automatic-upgrade setting is off by default, stored on request, and asks the network nothing', async () => {
  const s = setup();
  try {
    // turning it on loosens a guarding setting: asked at a terminal
    const on = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['y']}), {interactive: true});
    assert.strictEqual(await upgrade({auto: 'on'}, on), 0);
    assert.match(on.asked[0], /Loosen autoUpgrade from off to on\?/);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.home, 'settings.json'), 'utf8')), {version: 1, values: {autoUpgrade: true}});
    assert.match(on.out, /installs automatically 72 hours after it is published, and runs new code with your keys; ch-local rollback undoes one/);
    assert.strictEqual(await upgrade({auto: 'off'}, fakeIo({env: {COUNTINGHOUSE_HOME: s.home}})), 0);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(s.home, 'settings.json'), 'utf8')), {version: 1, values: {autoUpgrade: false}});
    assert.deepStrictEqual(on.fetches, []);
  } finally {
    s.done();
  }
});

test('upgrade refuses over an unreleased install until a clean install from a release, and asks the network nothing', async () => {
  const s = setup(undefined, {unreleased: true});
  try {
    const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}});
    assert.strictEqual(await upgrade({}, io), 1);
    assert.match(io.err, /unreleased install.*clean install from a release/);
    assert.deepStrictEqual(io.fetches, []);
  } finally {
    s.done();
  }
});

// docs/development/auto-upgrade.md, "Turning it on": after an install,
// asked once, at a terminal only; off with none, said so
test('offerAuto: at a terminal, asked once (cliSet\'s own question); a yes turns it on; no terminal leaves it off, said', async () => {
  const {offerAuto} = require('../lib/upgrade');
  const {readSettings} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = setup({'@countinghouse/ch-local': '0.2.0'});
  try {
    const where = layout({COUNTINGHOUSE_HOME: s.home});
    const quiet = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}});
    quiet.interactive = false;
    await offerAuto(quiet);
    assert.match(quiet.out, /automatic upgrades are off \(no terminal to ask\); ch-local upgrade --auto on turns them on/);
    assert.deepStrictEqual(quiet.asked, []);
    assert.strictEqual(readSettings(where).values.autoUpgrade, undefined);
    const yes = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes']});
    yes.interactive = true;
    await offerAuto(yes);
    assert.strictEqual(yes.asked.length, 1, 'one question');
    assert.match(yes.out, /72 hours after each is published/);
    assert.strictEqual(readSettings(where).values.autoUpgrade, true);
    // set: never asked again
    const again = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes']});
    again.interactive = true;
    await offerAuto(again);
    assert.deepStrictEqual(again.asked, []);
  } finally {
    s.done();
  }
});

test('offerAuto: a no leaves it off, and still unset is asked at the next install; never asked when already off by choice', async () => {
  const {offerAuto} = require('../lib/upgrade');
  const {readSettings, setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = setup({'@countinghouse/ch-local': '0.2.0'});
  try {
    const where = layout({COUNTINGHOUSE_HOME: s.home});
    const no = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['no']});
    no.interactive = true;
    await offerAuto(no);
    assert.notStrictEqual(readSettings(where).values.autoUpgrade, true);
    setSetting(where, 'autoUpgrade', 'off', {by: 'cli'});
    const later = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes']});
    later.interactive = true;
    await offerAuto(later);
    assert.deepStrictEqual(later.asked, [], 'an answer is kept');
  } finally {
    s.done();
  }
});

// the review of #48 --------------------------------------------------------

test('the yes is a person\'s at a terminal: a piped answer installs nothing; a no, an override and several packs are recorded too', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const w = await npmWorld(release());
  try {
    const piped = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
    assert.strictEqual(await upgrade({}, piped, w.fromNpm), 2);
    assert.match(piped.err, /installing 0\.2\.0 is confirmed at a terminal: run ch-local upgrade in one; nothing changed/);
    assert.deepStrictEqual([piped.asked.length, piped.execs.length], [0, 0]);
    const no = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['no'], fetch: realFetch});
    assert.strictEqual(await upgrade({}, no, w.fromNpm), 0);
    // a 0.x minor: shown as one that may break, still asked
    assert.match(no.out, /under semver a 0\.x minor or 0\.0\.x patch may break what works now/);
    const over = tty({env: {COUNTINGHOUSE_HOME: s.home, CH_LOCAL_DEV: '1'}, answers: ['yes'], fetch: realFetch});
    assert.strictEqual(await upgrade({}, over, w.fromNpm), 1);
    const rec = recordOf(s.home);
    rec.packs.other = {packages: {}, credentials: []};
    fs.writeFileSync(path.join(s.home, 'packs.json'), JSON.stringify(rec));
    const several = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], fetch: realFetch});
    assert.strictEqual(await upgrade({}, several, w.fromNpm), 1);
    assert.deepStrictEqual(historyOf(s.home).map((e) => [e.outcome, e.reason || null]),
      [['no-terminal', null], ['declined', null], ['override', 'CH_LOCAL_DEV'], ['several-packs', null]]);
  } finally {
    await w.close();
    s.done();
  }
});

// A release that withdraws the pack `name`: its entry and the pins of its
// packages that nothing else in the release uses are gone, as a real one's are.
const withdrawFrom = (name) => (doc) => {
  const gone = doc.packs[name].packages;
  delete doc.packs[name];
  const used = new Set([...doc.runtime.packages, ...Object.values(doc.packs).flatMap((p) => p.packages)]);
  for (const pkg of gone) if (!used.has(pkg)) delete doc.pins[pkg];
};

// Withdrawn packs (Matt, 2026-11-17, option 1): a release that no longer
// lists the home's one pack still upgrades (a pack is usually withdrawn for a
// security problem: staying on the old release would keep running it). The
// runtime is installed; the pack's record entry, its files and its data stay
// byte for byte; the notice is said and recorded, as information; start then
// skips the pack.
test('a release that withdraws the home\'s one pack upgrades: the runtime installed, the pack kept byte for byte, the notice said and recorded', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const w = await npmWorld(release(), {edit: withdrawFrom('ci-failure-triage')});
  try {
    const {layout} = require('../lib/home');
    const where = layout({COUNTINGHOUSE_HOME: s.home});
    const entry = recordOf(s.home).packs['ci-failure-triage'];
    const dir = require('../lib/pack-dir').packDir(where, 'ci-failure-triage', require('../lib/pack-dir').packKey(entry.packages));
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(path.join(dir, 'pack-file'), 'the pack\'s own bytes');
    fs.mkdirSync(path.join(where.moduleData, 'ch-pack-ci-failure-triage'), {recursive: true});
    fs.writeFileSync(path.join(where.moduleData, 'ch-pack-ci-failure-triage', 'state.json'), '{"kept":true}');
    const bytes = () => ({pack: fs.readFileSync(path.join(dir, 'pack-file'), 'utf8'), data: fs.readFileSync(path.join(where.moduleData, 'ch-pack-ci-failure-triage', 'state.json'), 'utf8')});
    const before = bytes();
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    // said before the question, and after the install
    assert.match(io.out, /it withdraws:\n  ci-failure-triage \(it stays installed and is not started after the upgrade; `ch-local remove-pack ci-failure-triage` removes it\)/);
    assert.match(io.out, /upgraded ch-local 0\.1\.0 -> 0\.2\.0; ch-local rollback undoes it/);
    assert.match(io.out, /pack ci-failure-triage was withdrawn in this release and was not started; `ch-local remove-pack ci-failure-triage` removes it/);
    assert.doesNotMatch(io.out, /was dropped/);
    const after = recordOf(s.home);
    assert.strictEqual(after.runtime.versions['@countinghouse/ch-local'], '0.2.0', 'the runtime upgraded');
    assert.deepStrictEqual(after.packs, {'ci-failure-triage': entry}, 'the pack\'s entry unchanged');
    assert.deepStrictEqual(bytes(), before, 'its files and data byte for byte');
    const h = historyOf(s.home);
    assert.deepStrictEqual(h.filter((e) => e.kind === 'upgrade').map((e) => [e.outcome, e.to]), [['installed', '0.2.0']]);
    assert.deepStrictEqual(h.filter((e) => e.change === 'withdrawn').map((e) => [e.pack, e.to]), [['ci-failure-triage', '0.2.0']]);
  } finally {
    await w.close();
    s.done();
  }
});

// The runtime-only install (a release that withdraws the pack) runs every
// check a pack install runs on the runtime's packages: their pins, their
// sha512 integrity and their provenance (lib/install.js: names, the pinned
// and lockfile checks, fetchRelease, loadTarballs, lockfileProblem, npm ci,
// the installed version); it skips only placing the pack. A runtime package
// whose provenance or integrity fails is refused: nothing installed, the
// record unchanged.
test('a release that withdraws the pack: its runtime packages are verified as any install\'s; a bad provenance or integrity installs nothing', async () => {
  for (const [what, opts] of [
    ['provenance', {lie: 'countinghouse', edit: withdrawFrom('ci-failure-triage')}],
    ['integrity', {edit: (doc) => { withdrawFrom('ci-failure-triage')(doc); doc.pins.countinghouse.integrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`; }}]
  ]) {
    const s = setup({'@countinghouse/ch-local': '0.1.0'});
    const w = await npmWorld(release(), opts);
    try {
      const before = fs.readFileSync(path.join(s.home, 'packs.json'), 'utf8');
      const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
      assert.strictEqual(await upgrade({}, io, w.fromNpm), 1, `${what}: ${io.err}`);
      assert.match(io.out, /it withdraws:/, `${what}: the runtime-only path`);
      assert.match(io.err, /countinghouse/, `${what}: the package named`);
      assert.match(io.err, /the upgrade to 0\.2\.0 failed; nothing changed/, what);
      assert.deepStrictEqual(io.execs, [], `${what}: npm never ran`);
      assert.strictEqual(fs.readFileSync(path.join(s.home, 'packs.json'), 'utf8'), before, `${what}: the record unchanged`);
      assert.deepStrictEqual(historyOf(s.home).filter((e) => e.kind === 'upgrade').map((e) => e.outcome), ['failed'], what);
      assert.deepStrictEqual(historyOf(s.home).filter((e) => e.change === 'withdrawn'), [], `${what}: no withdrawal recorded`);
    } finally {
      await w.close();
      s.done();
    }
  }
});
