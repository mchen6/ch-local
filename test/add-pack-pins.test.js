'use strict';
require('./tmp-dirs');
// Between packs from different pins (#413 rev 3 sections 9.2 rule 2, 9.4 and
// 9.5; L1b-2): add-pack takes each module of the pack by section 9.4's table,
// asks Question A or B at a terminal before anything is written, never
// lowers a module's version, and remove-pack puts a module back, or says why
// it stays. Reached through development pins files (--unreleased-pins), as
// in release 1 only a development home reaches it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {addPack, removePack} = require('../lib/packs-command');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm, record} = require('./install-helpers');

const REDACT = '@countinghouse/ch-step-redact';
const CI = '@countinghouse/ch-pack-ci-failure-triage';
const OTHER = '@countinghouse/ch-pack-other';
const pinsFile = (r) => { const f = path.join(tmp('ch-pins-'), 'pins.json'); fs.writeFileSync(f, JSON.stringify({pins: r.pins, runtimeLockfile: r.lockfile})); return f; };
// a development home with ci-failure-triage installed from r1's pins
async function devHome(r1) {
  const home = tmp('ch-home-');
  const env = {COUNTINGHOUSE_HOME: home, CH_LOCAL_DEV: '1'};
  const io = fakeIo({env, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r1.from, unreleasedPins: pinsFile(r1)}, io, {...r1.allow, pins: {}, runtime: {...r1.allow.runtime, lockfile: null}}), 0, io.err);
  const add = async (r2, {interactive = false, answers = []} = {}) => {
    const a = Object.assign(fakeIo({env, exec: npm(), answers}), {interactive});
    const code = await addPack({pack: 'other', from: r2.from, unreleasedPins: pinsFile(r2)}, a, {...r2.allow, pins: {}, runtime: {...r2.allow.runtime, lockfile: null}});
    return {code, io: a};
  };
  // install --pack under development pins meets the same table (the
  // reviewer's answer: in a development home an added pack does)
  const inst = async (r2, {interactive = false, answers = []} = {}) => {
    const a = Object.assign(fakeIo({env, exec: npm(), answers}), {interactive});
    const code = await install({pack: 'other', from: r2.from, unreleasedPins: pinsFile(r2)}, a, {...r2.allow, pins: {}, runtime: {...r2.allow.runtime, lockfile: null}});
    return {code, io: a};
  };
  return {home, env, add, inst};
}
const placed = (home, m, v) => fs.existsSync(path.join(home, 'module-store', ...m.split('/'), v));
const history = (home) => { try { return fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } };
const snapshot = (home) => JSON.stringify({record: record(home), redact: fs.readdirSync(path.join(home, 'module-store', '@countinghouse', 'ch-step-redact')).sort()});

test('not installed: placed; at the same version: skipped, shared', async () => {
  const h = await devHome(release());
  const {code, io} = await h.add(release());
  assert.strictEqual(code, 0, io.err);
  assert.ok(placed(h.home, '@countinghouse/ch-step-other', '0.2.0'));
  assert.match(io.out, /it shares ch-step-redact with the packs already installed/);
  assert.deepStrictEqual(io.asked, []);
});

test('installed newer, no breaking change: skipped, the pack recorded with the installed version; never lowered', async () => {
  const h = await devHome(release({versions: {[REDACT]: '0.1.1'}}));
  const {code, io} = await h.add(release({versions: {[REDACT]: '0.1.0'}}));
  assert.strictEqual(code, 0, io.err);
  assert.strictEqual(record(h.home).packs.other.modules[REDACT], '0.1.1');
  assert.strictEqual(record(h.home).modules[REDACT].version, '0.1.1');
  assert.ok(!placed(h.home, REDACT, '0.1.0'), 'the older version is not placed');
  assert.deepStrictEqual(io.asked, []);
});

test('installed older, no breaking change: the pack\'s version placed and active, its callers named, nothing asked', async () => {
  const h = await devHome(release({versions: {[REDACT]: '0.1.0'}}));
  const {code, io} = await h.add(release({versions: {[REDACT]: '0.1.1'}}));
  assert.strictEqual(code, 0, io.err);
  assert.strictEqual(record(h.home).modules[REDACT].version, '0.1.1');
  assert.match(io.out, /^updated ch-step-redact 0\.1\.0 -> 0\.1\.1; ch-pack-ci-failure-triage uses it too$/m);
  assert.deepStrictEqual(io.asked, []);
});

test('installed older across a breaking change that no installed module calls: updated, nothing asked', async () => {
  const noCall = {extra: {[CI]: {countinghouse: {role: 'scenario', calls: ['ch-access-github/githubService.listRuns']}}}};
  const h = await devHome(release({versions: {[REDACT]: '0.1.0'}, ...noCall}));
  const {code, io} = await h.add(release({versions: {[REDACT]: '0.2.0'}}));
  assert.strictEqual(code, 0, io.err);
  assert.strictEqual(record(h.home).modules[REDACT].version, '0.2.0');
  assert.match(io.out, /^updated ch-step-redact 0\.1\.0 -> 0\.2\.0$/m);
  assert.deepStrictEqual(io.asked, []);
});

test('Question A: installed older across a breaking change that installed modules call', async (t) => {
  const r1 = release({versions: {[REDACT]: '0.1.0'}});
  const r2 = release({versions: {[REDACT]: '0.2.0'}});
  await t.test('with no terminal: refused, exit 2, nothing written', async () => {
    const h = await devHome(r1);
    const before = snapshot(h.home);
    const {code, io} = await h.add(r2);
    assert.strictEqual(code, 2);
    assert.match(io.err, /this install updates ch-step-redact across a major version, which is confirmed at a terminal: run it in one; nothing was installed/);
    assert.strictEqual(snapshot(h.home), before);
  });
  await t.test('No (the default): nothing installed, nothing changed on disk, the answer in the history', async () => {
    const h = await devHome(r1);
    const before = snapshot(h.home);
    const {code, io} = await h.add(r2, {interactive: true, answers: ['']});
    assert.strictEqual(code, 1);
    assert.strictEqual(io.asked.length, 1);
    assert.strictEqual(io.asked[0], 'ch-step-redact 0.1.0 -> 0.2.0 is a major version: it may change how it works.\nThese installed modules call it:\n  ch-pack-ci-failure-triage 0.1.0 (pack ci-failure-triage)\nUpdate ch-step-redact anyway? [y/N] ');
    assert.match(io.err, /nothing was installed/);
    assert.strictEqual(snapshot(h.home), before);
    const line = history(h.home).find((l) => l.module === REDACT);
    assert.deepStrictEqual({by: line.by, from: line.from, to: line.to, callers: line.callers, answer: line.answer}, {by: 'cli', from: '0.1.0', to: '0.2.0', callers: [CI], answer: 'no'});
  });
  await t.test('yes: updated, every module still loads, the way back said', async () => {
    const h = await devHome(r1);
    const {code, io} = await h.add(r2, {interactive: true, answers: ['y']});
    assert.strictEqual(code, 0, io.err);
    assert.strictEqual(record(h.home).modules[REDACT].version, '0.2.0');
    assert.match(io.out, /^updated ch-step-redact 0\.1\.0 -> 0\.2\.0$/m);
    assert.match(io.out, /^ch-pack-ci-failure-triage 0\.1\.0 was written for 0\.1\.x and still loads; if it stops working, `ch-local remove-pack other` puts ch-step-redact back to 0\.1\.0, unless a pack added later relies on the newer version$/m);
    assert.strictEqual(history(h.home).find((l) => l.module === REDACT).answer, 'yes');
  });
});

test('Question B: installed newer across a breaking change than the pack was released with; a yes never lowers it', async (t) => {
  const r1 = release({versions: {[REDACT]: '0.2.0'}});
  const r2 = release({versions: {[REDACT]: '0.1.0'}});
  await t.test('the question names the pack\'s modules that call it; No installs nothing', async () => {
    const h = await devHome(r1);
    const before = snapshot(h.home);
    const {code, io} = await h.add(r2, {interactive: true, answers: ['no']});
    assert.strictEqual(code, 1);
    assert.strictEqual(io.asked[0], 'ch-step-redact 0.2.0 is installed, a newer major version than the pack "other" was released with (0.1.0).\nThese modules of the pack call it and may not work with it:\n  ch-pack-other 0.3.0\nInstall the pack anyway? [y/N] ');
    assert.strictEqual(snapshot(h.home), before);
  });
  await t.test('yes: the pack installed, the module stays at the installed version', async () => {
    const h = await devHome(r1);
    const {code, io} = await h.add(r2, {interactive: true, answers: ['yes']});
    assert.strictEqual(code, 0, io.err);
    assert.strictEqual(record(h.home).modules[REDACT].version, '0.2.0');
    assert.ok(!placed(h.home, REDACT, '0.1.0'), 'never lowered: 0.1.0 not placed');
    assert.ok(OTHER in record(h.home).modules);
  });
});

test('install --pack under development pins meets the same table', async (t) => {
  await t.test('installed newer, no breaking change: never lowered, the pack recorded with the installed version', async () => {
    const h = await devHome(release({versions: {[REDACT]: '0.1.1'}}));
    const {code, io} = await h.inst(release({versions: {[REDACT]: '0.1.0'}}));
    assert.strictEqual(code, 0, io.err);
    // the same 'shares' output as add-pack's (the high review of #94, 10)
    assert.match(io.out, /it shares ch-step-redact with the packs already installed/);
    assert.strictEqual(record(h.home).packs.other.modules[REDACT], '0.1.1');
    assert.strictEqual(record(h.home).modules[REDACT].version, '0.1.1');
    assert.ok(!placed(h.home, REDACT, '0.1.0'), 'the older version is not placed');
    assert.deepStrictEqual(io.asked, []);
  });
  await t.test('installed older, no breaking change: updated, its callers named', async () => {
    const h = await devHome(release({versions: {[REDACT]: '0.1.0'}}));
    const {code, io} = await h.inst(release({versions: {[REDACT]: '0.1.1'}}));
    assert.strictEqual(code, 0, io.err);
    assert.strictEqual(record(h.home).modules[REDACT].version, '0.1.1');
    assert.match(io.out, /^updated ch-step-redact 0\.1\.0 -> 0\.1\.1; ch-pack-ci-failure-triage uses it too$/m);
  });
  await t.test('Question A with no terminal: exit 2, nothing written', async () => {
    const h = await devHome(release({versions: {[REDACT]: '0.1.0'}}));
    const before = snapshot(h.home);
    const {code, io} = await h.inst(release({versions: {[REDACT]: '0.2.0'}}));
    assert.strictEqual(code, 2);
    assert.match(io.err, /this install updates ch-step-redact across a major version, which is confirmed at a terminal: run it in one; nothing was installed/);
    assert.strictEqual(snapshot(h.home), before);
  });
  await t.test('Question A, No: nothing installed, the answer in the history', async () => {
    const h = await devHome(release({versions: {[REDACT]: '0.1.0'}}));
    const before = snapshot(h.home);
    const {code, io} = await h.inst(release({versions: {[REDACT]: '0.2.0'}}), {interactive: true, answers: ['n']});
    assert.strictEqual(code, 1);
    assert.match(io.err, /nothing was installed/);
    assert.strictEqual(snapshot(h.home), before);
    assert.strictEqual(history(h.home).find((l) => l.module === REDACT).answer, 'no');
  });
  await t.test('Question A, yes: updated, the way back said', async () => {
    const h = await devHome(release({versions: {[REDACT]: '0.1.0'}}));
    const {code, io} = await h.inst(release({versions: {[REDACT]: '0.2.0'}}), {interactive: true, answers: ['y']});
    assert.strictEqual(code, 0, io.err);
    assert.strictEqual(record(h.home).modules[REDACT].version, '0.2.0');
    assert.match(io.out, /^ch-pack-ci-failure-triage 0\.1\.0 was written for 0\.1\.x and still loads; if it stops working, `ch-local remove-pack other` puts ch-step-redact back to 0\.1\.0, unless a pack added later relies on the newer version$/m);
  });
  await t.test('Question B, yes: the pack installed, the module stays at the installed version', async () => {
    const h = await devHome(release({versions: {[REDACT]: '0.2.0'}}));
    const {code, io} = await h.inst(release({versions: {[REDACT]: '0.1.0'}}), {interactive: true, answers: ['yes']});
    assert.strictEqual(code, 0, io.err);
    assert.strictEqual(io.asked.length, 1);
    assert.strictEqual(record(h.home).modules[REDACT].version, '0.2.0');
    assert.ok(!placed(h.home, REDACT, '0.1.0'), 'never lowered: 0.1.0 not placed');
    assert.strictEqual(record(h.home).packs.other.modules[REDACT], '0.2.0');
  });
});

test('a --from holding only what the store lacks is enough: a module installed at its pin is read from the store', async () => {
  const {tarballName} = require('../lib/install');
  const h = await devHome(release({versions: {[REDACT]: '0.2.0'}}));
  const r2 = release({versions: {[REDACT]: '0.2.0'}});
  fs.rmSync(path.join(r2.from, tarballName(REDACT, '0.2.0')));
  const {code, io} = await h.add(r2);
  assert.strictEqual(code, 0, io.err);
  assert.ok(OTHER in record(h.home).modules);
});

test('a Question B answer\'s history line says which question it answers', async () => {
  const h = await devHome(release({versions: {[REDACT]: '0.2.0'}}));
  const {code} = await h.add(release({versions: {[REDACT]: '0.1.0'}}), {interactive: true, answers: ['n']});
  assert.strictEqual(code, 1);
  const line = history(h.home).find((l) => l.module === REDACT);
  assert.deepStrictEqual({question: line.question, from: line.from, to: line.to, answer: line.answer}, {question: 'B', from: '0.2.0', to: '0.1.0', answer: 'no'});
});

// The reviewer's high review of #94, 1: a reinstall judges its new pins
// against the active version, its own earlier entry included.
test('install --pack again with a lower pin than the pack itself raised a module to: never lowered silently', async () => {
  const h = await devHome(release({versions: {[REDACT]: '0.1.0'}}));
  assert.strictEqual((await h.add(release({versions: {[REDACT]: '0.2.0'}}), {interactive: true, answers: ['y']})).code, 0);
  const before = snapshot(h.home);
  const no = await h.inst(release({versions: {[REDACT]: '0.1.0'}}));
  assert.strictEqual(no.code, 2, 'Question B, and no terminal');
  assert.match(no.io.err, /this install adds the pack "other" beside ch-step-redact 0\.2\.0, a newer major version than it was released with/);
  assert.strictEqual(snapshot(h.home), before);
  const yes = await h.inst(release({versions: {[REDACT]: '0.1.0'}}), {interactive: true, answers: ['y']});
  assert.strictEqual(yes.code, 0, yes.io.err);
  assert.strictEqual(record(h.home).modules[REDACT].version, '0.2.0');
  assert.strictEqual(record(h.home).packs.other.modules[REDACT], '0.2.0');
});

// The reviewer's high review of #94, 5: a changed home refuses only answers
// given to it; with nothing asked, the lock decides again.
test('nothing asked before the lock: a home that changed meanwhile is decided again, not refused', async () => {
  const table = require('../lib/pack-table');
  const r1 = release({versions: {[REDACT]: '0.1.0'}});
  const h = await devHome(r1);
  const r2 = release({versions: {[REDACT]: '0.1.0'}});
  const spec = r2.allow.packs.other;
  const before = record(h.home);
  const where = {home: h.home, moduleStore: path.join(h.home, 'module-store')};
  const io = fakeIo({env: h.env});
  const got = await table.askAll(where, table.decide(where, before, 'other', spec, r2.pins), 'other', io, () => {});
  assert.strictEqual(got.code, undefined);
  // meanwhile, the pack that shared ch-step-redact went
  const changed = {...before, packs: {}};
  const again = table.recheck(where, changed, 'other', spec, r2.pins, got.signature);
  assert.strictEqual(again.problem, undefined, again.problem);
  assert.strictEqual(again.rows.find((r) => r.module === REDACT).case, 'new');
});

// The reviewer's high review of #94, 6: what the lock would refuse is
// refused before anything is asked, and no answer is written for it.
test('an add the lock would refuse is refused before any question', async () => {
  const h = await devHome(release({versions: {[REDACT]: '0.1.0'}}));
  const r2 = release({versions: {[REDACT]: '0.2.0'}});
  r2.allow.packs.other = {...r2.allow.packs.other, packages: [...r2.allow.packs.other.packages, 'countinghouse']};
  const {code, io} = await h.add(r2, {interactive: true, answers: ['y']});
  assert.strictEqual(code, 1);
  assert.match(io.err, /countinghouse is part of the runtime, not a pack's/);
  assert.deepStrictEqual(io.asked, []);
  assert.deepStrictEqual(history(h.home), []);
});

// The reviewer's high review of #94, 3 and 7: only the tarballs the locked
// path places (and a Question B row's own callers) are read, each once.
test('a module the pack never places needs no tarball, and each tarball is read once', async (t) => {
  const {tarballName} = require('../lib/install');
  for (const [how, run] of [['add-pack', 'add'], ['install --pack', 'inst']]) {
    await t.test(how, async () => {
      const h = await devHome(release({versions: {[REDACT]: '0.1.1'}}));
      const r2 = release({versions: {[REDACT]: '0.1.0'}});
      fs.rmSync(path.join(r2.from, tarballName(REDACT, '0.1.0')));
      const reads = new Map();
      const real = fs.readFileSync;
      fs.readFileSync = function (file, ...rest) {
        if (typeof file === 'string' && file.startsWith(r2.from) && file.endsWith('.tgz')) reads.set(file, (reads.get(file) || 0) + 1);
        return real.call(this, file, ...rest);
      };
      let got;
      try { got = await h[run](r2); } finally { fs.readFileSync = real; }
      assert.strictEqual(got.code, 0, got.io.err);
      assert.strictEqual(record(h.home).packs.other.modules[REDACT], '0.1.1');
      for (const [file, n] of reads) assert.strictEqual(n, 1, `${path.basename(file)} read ${n} times`);
    });
  }
});

// The reviewer's high review of #94, 9: one predicate for "packs from
// different pins", fed with the packs that stay beside the operation's.
test('packs from different pins: one predicate for add-pack, install and remove-pack', () => {
  const {fromOtherPins} = require('../lib/pack-table');
  const rel = (v) => ({release: v});
  const rec = (packs, withdrawn = []) => ({packs: Object.fromEntries(Object.entries(packs).map(([n, from]) => [n, {from, modules: {[`@x/${n}`]: '1.0.0'}}])), withdrawn});
  assert.strictEqual(fromOtherPins(rec({a: rel('1.0.0')}), rel('1.0.0')), false, 'one release');
  assert.strictEqual(fromOtherPins(rec({a: rel('1.0.0')}), rel('1.1.0')), true, 'another release');
  assert.strictEqual(fromOtherPins(rec({a: rel('1.0.0')}), {unreleased: 'd'}), true, 'development pins beside a released pack');
  assert.strictEqual(fromOtherPins(rec({a: {unreleased: 'd'}}), rel('1.0.0')), true, 'a development home');
  // one pins file is no guarantee of one version each: a pack is recorded
  // at a kept newer version (the medium review of the round, 1-3)
  assert.strictEqual(fromOtherPins({...rec({a: {unreleased: 'd'}}), unreleased: true}, {unreleased: 'd'}), true, 'a development home, its own pins file again');
  assert.strictEqual(fromOtherPins({...rec({a: {unreleased: 'd'}, b: {unreleased: 'd'}}), unreleased: true}, null), true, 'remove-pack in a development home');
  assert.strictEqual(fromOtherPins(rec({a: rel('1.0.0')}), rel('1.1.0'), {except: ['a']}), false, 'the packs the operation brings to its pins are not compared');
  assert.strictEqual(fromOtherPins(rec({a: rel('1.0.0')}, ['@x/a']), rel('1.1.0')), false, 'a withdrawn pack never loads');
  assert.strictEqual(fromOtherPins(rec({}), {unreleased: 'd'}), false, 'nothing beside it');
  assert.strictEqual(fromOtherPins(rec({a: rel('1.0.0'), b: rel('1.0.0')}), null), false, 'remove-pack: one release');
  assert.strictEqual(fromOtherPins(rec({a: rel('1.0.0'), b: {unreleased: 'd'}}), null), true, 'remove-pack: two pins');
});

// The reviewer's high review of #94, 2: unknown is never "no callers".
test('a breaking update whose callers cannot be read is refused, never taken for uncalled', async (t) => {
  const r1 = release({versions: {[REDACT]: '0.1.0'}});
  const r2 = release({versions: {[REDACT]: '0.2.0'}});
  const store = (h, m, v, f) => path.join(h.home, 'module-store', ...m.split('/'), v, f);
  await t.test('a caller\'s package.json unreadable', async () => {
    const h = await devHome(r1);
    fs.writeFileSync(store(h, CI, '0.1.0', 'package.json'), '{not json');
    const before = snapshot(h.home);
    const {code, io} = await h.add(r2, {interactive: true, answers: ['y']});
    assert.strictEqual(code, 1);
    assert.match(io.err, /cannot tell which modules call ch-step-redact: ch-pack-ci-failure-triage's package\.json cannot be read; nothing was installed/);
    assert.deepStrictEqual(io.asked, []);
    assert.strictEqual(snapshot(h.home), before);
  });
  await t.test('the module\'s own api.json missing', async () => {
    const h = await devHome(r1);
    fs.rmSync(store(h, REDACT, '0.1.0', 'api.json'));
    const {code, io} = await h.inst(r2, {interactive: true, answers: ['y']});
    assert.strictEqual(code, 1);
    assert.match(io.err, /cannot tell which modules call ch-step-redact: ch-step-redact's api\.json cannot be read; nothing was installed/);
    assert.deepStrictEqual(io.asked, []);
  });
});

test('remove-pack: a module the pack raised goes back; one a remaining pack records stays, the line says which; settings untouched', async () => {
  const h = await devHome(release({versions: {[REDACT]: '0.1.0'}}));
  const settings = path.join(h.home, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({version: 1, values: {'pack.other': true}}));
  const bytes = fs.readFileSync(settings);
  await h.add(release({versions: {[REDACT]: '0.1.1'}}));
  const io = fakeIo({env: h.env});
  assert.strictEqual(await removePack({pack: 'other'}, io), 0, io.err);
  assert.match(io.out, /^put back ch-step-redact 0\.1\.1 -> 0\.1\.0 \(it was updated when other was installed\)$/m);
  assert.strictEqual(record(h.home).modules[REDACT].version, '0.1.0');
  assert.ok(fs.readFileSync(settings).equals(bytes), 'the settings file byte for byte');
  // a module a remaining pack was installed with stays, said
  // (a development home: one pins file throughout still says it)
  const k = await devHome(release({versions: {[REDACT]: '0.1.1'}}));
  await k.add(release({versions: {[REDACT]: '0.1.1'}}));
  const io2 = fakeIo({env: k.env});
  assert.strictEqual(await removePack({pack: 'ci-failure-triage'}, io2), 0, io2.err);
  assert.match(io2.out, /^ch-step-redact stays at 0\.1\.1: the pack other was installed with it$/m);
});

test('remove-pack: a removed module whose credential is stored says it is kept', async () => {
  const h = await devHome(release());
  require('../lib/credential-store').bind(h.home, '@countinghouse/ch-access-github', 'COUNTINGHOUSE_GITHUB_TOKEN', {origin: 'https://api.githubcopilot.com', source: 'stored', value: 'test-stored-value-2'});
  const io = fakeIo({env: h.env});
  assert.strictEqual(await removePack({pack: 'ci-failure-triage'}, io), 0, io.err);
  assert.match(io.out, /the credential stored for ch-access-github is kept: `ch-local credentials remove ch-access-github` removes it/);
  assert.ok(!io.out.includes('test-stored-value-2'));
});
