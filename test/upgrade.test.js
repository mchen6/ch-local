'use strict';
require('./tmp-dirs');
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
  const given = Object.fromEntries(Object.entries(versions).filter(([n]) => runtime[n] == null));
  // the pack's modules (its scenario when none is given): modules.json by
  // its own writer
  const pack = Object.keys(given).length > 0 ? given : {'@countinghouse/ch-pack-ci-failure-triage': '0.1.0'};
  require('./store-helpers').writeHome(home, {'ci-failure-triage': pack}, {runtime, unreleased});
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
const {npmWorld, asInstalled} = require('./npm-world');
const {release, npm} = require('./install-helpers');
// a command as the home names it once an install wrote its launcher
// (lib/command-line.js), as a regular expression's source
const cmd = (h, args) => require('../lib/command-line').chLocal(require('../lib/home').layout({COUNTINGHOUSE_HOME: h}), args).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const recordOf = (home) => JSON.parse(fs.readFileSync(path.join(home, 'modules.json'), 'utf8'));
const historyOf = (home) => { try { return fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch (e) { return []; } };
const realFetch = (url, opts) => globalThis.fetch(url, opts);
// at a terminal: the yes is a person's (the review of #48)
const tty = (opts) => Object.assign(fakeIo(opts), {interactive: true});

test('upgrade shows the installed and the newer ch-local, checked; a no changes nothing', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const w = await npmWorld(release());
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['no'], fetch: realFetch});
    const before = fs.readFileSync(path.join(s.home, 'modules.json'), 'utf8');
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.match(io.out, /ch-local 0\.1\.0 -> 0\.2\.0, its provenance checked/);
    assert.match(io.out, /nothing changed/);
    assert.strictEqual(io.asked.length, 1);
    assert.deepStrictEqual(io.execs, []);
    assert.strictEqual(fs.readFileSync(path.join(s.home, 'modules.json'), 'utf8'), before);
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
    assert.match(io.out, new RegExp(`upgraded ch-local 0\\.1\\.0 -> 0\\.2\\.0; ${cmd(s.home, 'rollback')} undoes it`));
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
  // (as an install leaves it: additions are judged against the home's own
  // modules, from the store: L4)
  require('./install-helpers').installedHome(s.home, ['ci-failure-triage'], {runtime: {'@countinghouse/ch-local': '0.1.0'}});
  // (version 2: a module's key sent to a new origin)
  const w = await npmWorld(release(), {edit: (doc) => { doc.modules['@countinghouse/ch-access-github'].credentials = [{variable: 'GITHUB_TOKEN', origin: 'https://api.example.invalid'}]; }});
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['no'], fetch: realFetch});
    // (the running ch-local is the installed release: its pins verify the
    // store's modules, the Reviewer's high on L4, 3)
    assert.strictEqual(await asInstalled(w.pinsDoc.pins, () => upgrade({}, io, w.fromNpm), w.installed), 0, io.err);
    assert.match(io.out, /it adds:\n  ch-access-github's key goes to https:\/\/api\.example\.invalid as GITHUB_TOKEN \(was https:\/\/api\.githubcopilot\.com as GITHUB_TOKEN\)\n/);
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

test('the yes is a person\'s at a terminal: a piped answer installs nothing; a no and an override are recorded too', async () => {
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
    assert.deepStrictEqual(historyOf(s.home).map((e) => [e.outcome, e.reason || null]),
      [['no-terminal', null], ['declined', null], ['override', 'CH_LOCAL_DEV']]);
  } finally {
    await w.close();
    s.done();
  }
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

// Withdrawn packs (maintainer's decision, 2026-11-17): a release that no longer
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
    // the pack's scenario in the module store
    const dir = require('./store-helpers').storeModule(s.home, '@countinghouse/ch-pack-ci-failure-triage', '0.1.0',
      {countinghouse: {role: 'scenario'}, files: {'pack-file': 'the pack\'s own bytes'}});
    fs.mkdirSync(path.join(where.moduleData, 'ch-pack-ci-failure-triage'), {recursive: true});
    fs.writeFileSync(path.join(where.moduleData, 'ch-pack-ci-failure-triage', 'state.json'), '{"kept":true}');
    const bytes = () => ({pack: fs.readFileSync(path.join(dir, 'pack-file'), 'utf8'), data: fs.readFileSync(path.join(where.moduleData, 'ch-pack-ci-failure-triage', 'state.json'), 'utf8')});
    const before = bytes();
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    // said before the question, and after the install
    assert.match(io.out, /it withdraws:\n  ci-failure-triage \(it stays installed and is not started after the upgrade; `ch-local remove-pack ci-failure-triage` removes it\)/);
    assert.match(io.out, new RegExp(`upgraded ch-local 0\\.1\\.0 -> 0\\.2\\.0; ${cmd(s.home, 'rollback')} undoes it`));
    assert.match(io.out, new RegExp(`pack ci-failure-triage was withdrawn in this release and was not started; \`${cmd(s.home, 'remove-pack ci-failure-triage')}\` removes it`));
    assert.doesNotMatch(io.out, /was dropped/);
    const after = recordOf(s.home);
    assert.strictEqual(after.runtime.versions['@countinghouse/ch-local'], '0.2.0', 'the runtime upgraded');
    // the pack stays recorded as it was; the record's withdrawn list names its
    // modules, so start and a running start's applier never load it (#413
    // section 9.7)
    assert.deepStrictEqual(after.packs['ci-failure-triage'], entry, 'its entry kept');
    assert.deepStrictEqual(after.withdrawn, ['@countinghouse/ch-pack-ci-failure-triage']);
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
      const before = fs.readFileSync(path.join(s.home, 'modules.json'), 'utf8');
      const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
      assert.strictEqual(await upgrade({}, io, w.fromNpm), 1, `${what}: ${io.err}`);
      assert.match(io.out, /it withdraws:/, `${what}: the runtime-only path`);
      assert.match(io.err, /countinghouse/, `${what}: the package named`);
      assert.match(io.err, /the upgrade to 0\.2\.0 failed; nothing changed/, what);
      assert.deepStrictEqual(io.execs, [], `${what}: npm never ran`);
      assert.strictEqual(fs.readFileSync(path.join(s.home, 'modules.json'), 'utf8'), before, `${what}: the record unchanged`);
      assert.deepStrictEqual(historyOf(s.home).filter((e) => e.kind === 'upgrade').map((e) => e.outcome), ['failed'], what);
      assert.deepStrictEqual(historyOf(s.home).filter((e) => e.change === 'withdrawn'), [], `${what}: no withdrawal recorded`);
    } finally {
      await w.close();
      s.done();
    }
  }
});

// Withdrawn by the record (#413 section 9.7): a home whose one pack the
// record's withdrawn list names (an earlier upgrade's pins wrote it) still
// upgrades: a later release may be the security fix it needs. A release that
// lists it again brings it to its pins, with nothing to add back.
test('a home whose one pack the record lists as withdrawn still upgrades; a release that lists it again brings it to its pins', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  require('./store-helpers').editHome(s.home, (r) => r, {release: {packs: {}}});
  assert.deepStrictEqual(recordOf(s.home).withdrawn, ['@countinghouse/ch-pack-ci-failure-triage']);
  const w = await npmWorld(release());
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.match(io.out, /upgraded ch-local 0\.1\.0 -> 0\.2\.0/);
    const rec = recordOf(s.home);
    assert.deepStrictEqual(rec.withdrawn, [], 'listed again: no longer withdrawn');
    assert.strictEqual(rec.packs['ci-failure-triage'].modules['@countinghouse/ch-pack-ci-failure-triage'], '0.1.0', 'at this release\'s pins');
    assert.doesNotMatch(io.out, /adds it back/);
  } finally {
    await w.close();
    s.done();
  }
});

// The deep review of #77 (HIGH): a later full upgrade keeps a held pack (one
// a rollback's restored release lacked), its entry and its module versions
// in the store (Matt's "nothing deleted").
test('a full upgrade keeps a held pack: its entry and its module versions', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const {storeModule, editHome} = require('./store-helpers');
  const gone = {from: {release: '0.0.9'}, modules: {'@countinghouse/ch-pack-gone': '1.0.0'}};
  const dir = storeModule(s.home, '@countinghouse/ch-pack-gone', '1.0.0', {countinghouse: {role: 'scenario'}, files: {kept: 'the pack\'s own bytes'}});
  editHome(s.home, (r) => ({...r, held: {gone}}));
  const nw = await npmWorld(release());
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, nw.fromNpm), 0, io.err);
    assert.deepStrictEqual(recordOf(s.home).held, {gone}, 'held as it was');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'kept'), 'utf8'), 'the pack\'s own bytes', 'its store version kept');
  } finally {
    await nw.close();
    s.done();
  }
});

// the medium review of L1a-2, 1: a pack the record lists as withdrawn is no
// pack an upgrade serves, so one live pack beside it still upgrades
test('a home with one pack and one the record lists as withdrawn upgrades: not "several packs"', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const {editHome} = require('./store-helpers');
  editHome(s.home, (r) => ({...r, packs: {...r.packs, gone: {from: {release: '0.0.9'}, modules: {'@countinghouse/ch-pack-gone': '1.0.0'}}}}),
    {release: {packs: {'ci-failure-triage': {packages: Object.keys(recordOf(s.home).packs['ci-failure-triage'].modules)}}}});
  assert.deepStrictEqual(recordOf(s.home).withdrawn, ['@countinghouse/ch-pack-gone']);
  const w = await npmWorld(release());
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.match(io.out, /upgraded ch-local 0\.1\.0 -> 0\.2\.0/);
    assert.ok(!historyOf(s.home).some((e) => e.outcome === 'several-packs'));
    assert.ok(recordOf(s.home).packs.gone != null, 'the withdrawn pack stays recorded');
  } finally {
    await w.close();
    s.done();
  }
});

// L4 (#413 rev 3 section 9.6): a release is a tested set, installed as one.
// Two packs share ch-step-redact at 0.2.0; ch-step-other is at 0.1.0. The
// release pins ch-step-redact at 0.1.0 (back) and ch-step-other at 0.2.0.
const TRIAGE_MODS = {'@countinghouse/ch-pack-ci-failure-triage': '0.1.0', '@countinghouse/ch-access-github': '0.1.0', '@countinghouse/ch-step-redact': '0.2.0'};
const OTHER_MODS = {'@countinghouse/ch-pack-other': '0.3.0', '@countinghouse/ch-step-redact': '0.2.0', '@countinghouse/ch-step-other': '0.1.0'};
function twoPacks() {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const {storeModule, editHome} = require('./store-helpers');
  // (the store holds the versions the release does not pin, which it must
  // keep, never sweep; one it pins comes from the release itself: install
  // never puts other contents under a version the record names)
  for (const [m, v] of [['@countinghouse/ch-step-redact', '0.2.0'], ['@countinghouse/ch-step-other', '0.1.0']]) storeModule(s.home, m, v, {countinghouse: {role: 'part'}, files: {kept: `${m}@${v}`}});
  editHome(s.home, (r) => ({...r, packs: {'ci-failure-triage': {from: {release: '0.1.0'}, modules: TRIAGE_MODS}, other: {from: {release: '0.1.0'}, modules: OTHER_MODS}}}));
  return s;
}
const stored = (home, m, v) => path.join(home, 'module-store', ...m.split('/'), v);

test('L4: a home with two packs upgrades as one release: every pack to its pins, no version asked, each moving module said once with its packs, a move back said', async () => {
  const s = twoPacks();
  const w = await npmWorld(release());
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.match(io.out, /its modules move:\n  ch-step-other 0\.1\.0 -> 0\.2\.0 \(other\)\n  ch-step-redact 0\.2\.0 -> 0\.1\.0, back to an earlier version \(ci-failure-triage, other\)\n/);
    assert.strictEqual(io.asked.length, 1, 'one question, the upgrade\'s own');
    assert.match(io.out, new RegExp(`upgraded ch-local 0\\.1\\.0 -> 0\\.2\\.0; ${cmd(s.home, 'rollback')} undoes it`));
    const rec = recordOf(s.home);
    assert.strictEqual(rec.packs['ci-failure-triage'].modules['@countinghouse/ch-step-redact'], '0.1.0');
    assert.deepStrictEqual(rec.packs.other.modules, {'@countinghouse/ch-pack-other': '0.3.0', '@countinghouse/ch-step-redact': '0.1.0', '@countinghouse/ch-step-other': '0.2.0'});
    assert.strictEqual(rec.modules['@countinghouse/ch-step-redact'].version, '0.1.0', 'the version that loads is the one the preview said');
    assert.ok(!historyOf(s.home).some((e) => e.outcome === 'several-packs'));
  } finally {
    await w.close();
    s.done();
  }
});

// the Reviewer on the L4 plan: a module moves back in one pack while another
// pack (here withdrawn by the release, so not moved) holds it at the newer
// version. The preview, what the store keeps and which version loads agree.
test('L4: a module moving back in one pack while a withdrawn pack holds it newer: said for the pack that moves it, both versions kept, the moved one loads', async () => {
  const s = twoPacks();
  const w = await npmWorld(release(), {edit: withdrawFrom('other')});
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
    // (the running release serves both packs: start's rule, the Reviewer's
    // high on #101, round 2)
    assert.strictEqual(await asInstalled(w.pinsDoc.pins, () => upgrade({}, io, w.fromNpm), w.installed), 0, io.err);
    assert.match(io.out, /it withdraws:\n  other /);
    assert.match(io.out, /its modules move:\n  ch-step-redact 0\.2\.0 -> 0\.1\.0, back to an earlier version \(ci-failure-triage\)\n/);
    assert.doesNotMatch(io.out, /ch-step-other 0\.1\.0 ->/, 'a withdrawn pack\'s modules do not move');
    const rec = recordOf(s.home);
    assert.strictEqual(rec.packs['ci-failure-triage'].modules['@countinghouse/ch-step-redact'], '0.1.0');
    assert.strictEqual(rec.packs.other.modules['@countinghouse/ch-step-redact'], '0.2.0', 'the withdrawn pack keeps its own');
    assert.strictEqual(rec.modules['@countinghouse/ch-step-redact'].version, '0.1.0', 'the live pack\'s version loads, as the preview said');
    for (const v of ['0.1.0', '0.2.0']) assert.ok(fs.existsSync(stored(s.home, '@countinghouse/ch-step-redact', v)), `ch-step-redact ${v} kept in the store`);
    assert.strictEqual(fs.readFileSync(path.join(stored(s.home, '@countinghouse/ch-step-redact', '0.2.0'), 'kept'), 'utf8'), '@countinghouse/ch-step-redact@0.2.0');
  } finally {
    await w.close();
    s.done();
  }
});

// L4 (#413 rev 3 sections 9.3 and 9.6; C's L4 notes): additions are judged
// against what the home has installed, each module described from the store
// at the version the record names, not against the bundled pins of the
// ch-local that runs. Here the home keeps ch-access-github at 0.0.9, whose
// manifest declares no key; the release's sends one, so it is said, though
// the bundled pins already describe that key.
test('L4: what a release adds is judged against the home\'s installed modules, not the bundled pins: a key a module kept off its pin never sent is said', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  const {storeModule, editHome} = require('./store-helpers');
  storeModule(s.home, '@countinghouse/ch-access-github', '0.0.9', {countinghouse: {role: 'part'}});
  editHome(s.home, (r) => ({...r, packs: {'ci-failure-triage': {from: {release: '0.1.0'},
    modules: {'@countinghouse/ch-pack-ci-failure-triage': '0.1.0', '@countinghouse/ch-access-github': '0.0.9', '@countinghouse/ch-step-redact': '0.1.0'}}}}));
  const w = await npmWorld(release());
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['no'], fetch: realFetch});
    assert.strictEqual(await upgrade({}, io, w.fromNpm), 0, io.err);
    assert.match(io.out, /it adds:\n(  .*\n)*  ch-access-github sends a key \(GITHUB_TOKEN\) to https:\/\/api\.githubcopilot\.com/);
  } finally {
    await w.close();
    s.done();
  }
});

// the medium on L4, 4 and 5: moves and drops are judged per pack, against
// that pack's own list in the new release; a pack the release lists again
// (relisted after a withdrawal) is counted
test('L4: releaseMoves judges each pack against its own new list: a module moved to a pack not installed is no longer listed here; a relisted pack\'s moves are said', () => {
  const {releaseMoves} = require('../lib/upgrade');
  const record = {packs: {a: {modules: {m: '1.0.0', p: '1.0.0'}}, back: {modules: {q: '2.0.0'}}},
    modules: {m: {version: '1.0.0'}, p: {version: '1.0.0'}, q: {version: '2.0.0'}}};
  // m now listed only under y (not installed); back relisted, q moving back
  const allow = {packs: {a: {modules: ['p']}, y: {modules: ['m']}, back: {modules: ['q']}}, pins: {m: {version: '1.1.0'}, p: {version: '1.0.1'}, q: {version: '1.9.0'}}};
  assert.deepStrictEqual(releaseMoves(record, allow, ['a', 'back']), {
    moves: [{module: 'p', from: '1.0.0', to: '1.0.1', back: false, packs: ['a']}, {module: 'q', from: '2.0.0', to: '1.9.0', back: true, packs: ['back']}],
    dropped: [{module: 'm', packs: ['a'], keptBy: []}]
  });
  // (a module one pack drops and another moved pack keeps stays running
  // through it: the Reviewer's high on L4, 6)
  const both = {packs: {a: {modules: {m: '1.0.0'}}, b: {modules: {m: '1.0.0'}}}, modules: {m: {version: '1.0.0'}}};
  const keep = {packs: {a: {modules: []}, b: {modules: ['m']}}, pins: {m: {version: '1.0.0'}}};
  const r = releaseMoves(both, keep, ['a', 'b']);
  assert.deepStrictEqual(r.dropped, [{module: 'm', packs: ['a'], keptBy: ['b']}]);
  assert.deepStrictEqual(require('../lib/upgrade').movesLines(r), ['it no longer lists:\n  m (a): it stays running through b']);
  // a pack not served (withdrawn in the record, say) keeps nothing running
  assert.deepStrictEqual(releaseMoves(both, keep, ['a', 'b'], ['a']).dropped, [{module: 'm', packs: ['a'], keptBy: []}]);
});

// the medium on L4, 3: every pack an install moves is held to the operator's
// allowlist, not only the one named
test('L4: an upgrade moving a pack the operator\'s allowlist refuses moves nothing, and says which', async () => {
  const s = twoPacks();
  // the runtime's ceiling reader, as an installed runtime has it: the
  // triage pack's modules only
  const dir = path.join(s.home, 'app', 'node_modules', 'countinghouse', 'lib');
  fs.mkdirSync(dir, {recursive: true});
  const ceiling = {state: 'trusted', file: '/etc/countinghouse/ceiling.json', ceiling: {forbid: [], conversation: true,
    modules: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', '@countinghouse/ch-step-redact']}};
  fs.writeFileSync(path.join(dir, 'settings-ceiling.js'), `module.exports = {readCeiling: () => (${JSON.stringify(ceiling)})};\n`);
  require('../lib/ceiling').resetForTests();
  const w = await npmWorld(release());
  try {
    const before = recordOf(s.home);
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
    assert.notStrictEqual(await upgrade({}, io, w.fromNpm), 0);
    assert.match(io.err, /the pack "other" is not allowed on this machine/);
    assert.deepStrictEqual(recordOf(s.home).packs, before.packs, 'nothing moved');
  } finally {
    require('../lib/ceiling').resetForTests();
    await w.close();
    s.done();
  }
});


// the Reviewer's high on L4, 4: a pack the record has withdrawn that the
// release lists again is served again: the preview says so, its modules are
// what it adds, and its credentials are asked for, though nothing else of
// the home is served
test('L4: a withdrawn pack listed again: "served again" before the question; installed as a pack, its credentials asked', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  require('./install-helpers').installedHome(s.home, ['ci-failure-triage'], {runtime: {'@countinghouse/ch-local': '0.1.0'}});
  require('./store-helpers').editHome(s.home, (r) => r, {release: {packs: {}}});
  assert.ok(recordOf(s.home).withdrawn.length > 0);
  const w = await npmWorld(release());
  try {
    const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
    assert.strictEqual(await asInstalled(w.pinsDoc.pins, () => upgrade({}, io, w.fromNpm), w.installed), 0, io.err);
    assert.match(io.out, /it adds:\n  ci-failure-triage is served again: its modules start after the upgrade\n/);
    assert.deepStrictEqual(recordOf(s.home).withdrawn, []);
    assert.ok(io.err.split('\n').includes(`ch-access-github needs a credential: in your own terminal run \`node "${require('fs').realpathSync.native(require('path').join(s.home, 'bin', 'ch-local.js'))}" credentials add ch-access-github\``), io.err);
  } finally {
    await w.close();
    s.done();
  }
});

// the Reviewer's high on #101, round 2: install acts only on the record the
// upgrade judged; a home changed during the question or the fetch refuses,
// and nothing is written
const changedDuring = async (s, w, {when, change}) => {
  const io = tty({env: {COUNTINGHOUSE_HOME: s.home}, answers: ['yes'], exec: npm(), fetch: realFetch});
  if (when === 'question') {
    const ask = io.ask;
    io.ask = async (q) => { change(); return ask(q); };
  } else {
    const write = io.stdout.write.bind(io.stdout);
    io.stdout.write = (x) => { if (/^fetching \d+ package/.test(String(x))) change(); return write(x); };
  }
  const code = await asInstalled(w.pinsDoc.pins, () => upgrade({}, io, w.fromNpm), w.installed);
  return {code, io};
};
test('L4: a home changed while the upgrade was prepared refuses: a pack added during the question, one removed or a rollback during the fetch', async () => {
  const s = setup({'@countinghouse/ch-local': '0.1.0'});
  require('./install-helpers').installedHome(s.home, ['ci-failure-triage', 'other'], {runtime: {'@countinghouse/ch-local': '0.1.0'}});
  const file = path.join(s.home, 'modules.json');
  const both = fs.readFileSync(file, 'utf8');
  require('./store-helpers').editHome(s.home, (r) => { delete r.packs.other; return r; });
  const one = fs.readFileSync(file, 'utf8');
  const w = await npmWorld(release());
  try {
    const cases = [
      ['a pack added during the question', one, 'question', () => fs.writeFileSync(file, both)],
      ['a pack removed during the fetch', both, 'fetch', () => fs.writeFileSync(file, one)],
      // (a rollback: the same packs, another version)
      ['a rollback during the fetch', one, 'fetch', () => {
        const r = JSON.parse(one);
        r.packs['ci-failure-triage'].modules['@countinghouse/ch-step-redact'] = '0.0.9';
        r.modules['@countinghouse/ch-step-redact'].version = '0.0.9';
        fs.writeFileSync(file, JSON.stringify(r));
      }]
    ];
    for (const [what, start, when, change] of cases) {
      fs.writeFileSync(file, start);
      let changed = null;
      const {code, io} = await changedDuring(s, w, {when, change: () => { change(); changed = fs.readFileSync(file, 'utf8'); }});
      assert.strictEqual(code, 1, `${what}: ${io.err}`);
      assert.match(io.err, /this home changed while the upgrade was prepared; run it again; nothing was installed/, what);
      // the record is the changed one, untouched: no pack it lacks is written back
      assert.strictEqual(fs.readFileSync(file, 'utf8'), changed, `${what}: nothing written`);
    }
  } finally {
    await w.close();
    s.done();
  }
});

// the medium on #101 round 2, 3: a pack the record holds as live that
// neither the running release nor the new one lists is withdrawn by this
// upgrade (its modules go into the record's withdrawn list), so it is said
test('releaseSelection: start\'s running rule; withdrawn is every pack the record has not withdrawn that the release does not list', () => {
  const {releaseSelection} = require('../lib/packs');
  const rec = {packs: {a: {modules: {m: '1.0.0'}}, x: {modules: {n: '1.0.0'}}, w: {modules: {k: '1.0.0'}}}, modules: {m: {version: '1.0.0'}, n: {version: '1.0.0'}, k: {version: '1.0.0'}}, withdrawn: ['k']};
  const running = {packs: {a: {modules: ['m']}, w: {modules: ['k']}}};
  // the new release lists a and w (w served again), not x
  assert.deepStrictEqual(releaseSelection(rec, {packs: {a: {modules: ['m']}, w: {modules: ['k']}}}, running), {withdrawn: ['x'], served: ['a', 'w'], target: {pack: 'a'}});
  // it lists only w: a is withdrawn, w is the target
  assert.deepStrictEqual(releaseSelection(rec, {packs: {w: {modules: ['k']}}}, running), {withdrawn: ['a', 'x'], served: ['w'], target: {pack: 'w'}});
  // none: the runtime only
  assert.deepStrictEqual(releaseSelection(rec, {packs: {}}, running).target, {runtimeOnly: true});
});
