'use strict';
// ch-local rollback [--yes] (plan Task 12; business review, 2026-11-12): an
// install over an existing one (today's upgrade, until upgrade installs from
// npm) keeps the previous release's programs, and rollback returns to them in
// one step, one level back.
// - It restores programs only (the runtime, packs and parts, and their record);
//   caches, usage records, settings, the identity secret and client entries stay.
// - A pack the older release lacks stays recorded but is not loaded, and status
//   says it needs the newer release.
// - Undoing a release marked as a security fix names it, says what it fixed
//   and asks; without a terminal it refuses unless --yes.
// - One pack got worse: that is remove-pack on the current release.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {addPack, status} = require('../lib/packs-command');
const {rollback} = require('../lib/rollback');
const {installedPacks} = require('../lib/packs');
const {main} = require('../bin/ch-local');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm, pkgDir, record} = require('./install-helpers');

const REDACT = '@countinghouse/ch-step-redact';
const versionOf = (home, name) => JSON.parse(fs.readFileSync(path.join(pkgDir(home, name), 'package.json'), 'utf8')).version;
const DATA = {
  'store/kv.json': '{"k": 1}', 'store/.identity-secret': 'secret-identity', 'module_data/ch-access-github/x': 'x', 'usage/2026-11-12/1-2.jsonl': '{}\n',
  'data/pack-ci-failure-triage/acme__widgets/fingerprints.json': '{"version": 1, "runs": {}}', 'settings.json': '{"autoUpgrade": false}',
  'installed-clients.json': '{"entries": []}', 'auth.json': '{"keys": []}'
};

// Release 1, then release 2 over it (redact 0.1.0 -> 0.2.0), and some data.
async function upgraded({security = null} = {}) {
  const home = tmp('ch-home-');
  const r1 = release();
  r1.allow.release = {version: '0.2.0', security: null};
  const r2 = release({versions: {[REDACT]: '0.2.0'}});
  r2.allow.release = {version: '0.3.0', security};
  const io = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r1.from}, io(), r1.allow), 0);
  for (const [rel, body] of Object.entries(DATA)) { fs.mkdirSync(path.dirname(path.join(home, rel)), {recursive: true}); fs.writeFileSync(path.join(home, rel), body); }
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, io(), r2.allow), 0);
  return {home, r1, r2};
}
const rio = (home, extra = {}) => Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: home}, ...extra}), {interactive: true}, extra.interactive === false ? {interactive: false} : {});

test('an install over an existing one keeps the previous release; rollback returns to it, keeping caches, usage, settings and the secret', async () => {
  const s = await upgraded();
  assert.strictEqual(versionOf(s.home, REDACT), '0.2.0');
  assert.strictEqual(record(s.home).release.version, '0.3.0');
  const io = rio(s.home);
  assert.strictEqual(await rollback({}, io), 0, io.err);
  assert.strictEqual(versionOf(s.home, REDACT), '0.1.0', 'the previous release\'s programs');
  assert.strictEqual(record(s.home).release.version, '0.2.0');
  for (const [rel, body] of Object.entries(DATA)) assert.strictEqual(fs.readFileSync(path.join(s.home, rel), 'utf8'), body, `${rel} is kept as it was`);
  assert.match(io.out, /rolled back from ch-local 0\.3\.0 to 0\.2\.0/);
  assert.match(io.out, /caches, usage records, settings and the identity secret are unchanged/);
  // One level, both ways: a second rollback returns to the newer release.
  const again = rio(s.home);
  assert.strictEqual(await rollback({}, again), 0, again.err);
  assert.strictEqual(versionOf(s.home, REDACT), '0.2.0');
  assert.ok(!fs.readdirSync(s.home).some((n) => n.startsWith('previous.')), 'no swap directory left');
});

test('with nothing kept, rollback says so and changes nothing', async () => {
  const home = tmp('ch-home-');
  const r = release();
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()}), r.allow), 0);
  const io = rio(home);
  assert.strictEqual(await rollback({}, io), 1);
  assert.match(io.err, /no previous release is kept/);
  const none = rio(path.join(tmp('ch-parent-'), 'missing'));
  assert.strictEqual(await rollback({}, none), 1);
  assert.match(none.err, /nothing is installed/);
});

test('a pack the older release lacks stays recorded but is not loaded, and status says it needs the newer release', async () => {
  const s = await upgraded();
  assert.strictEqual(await addPack({pack: 'other', from: s.r2.from}, fakeIo({env: {COUNTINGHOUSE_HOME: s.home}}), s.r2.allow), 0);
  const io = rio(s.home);
  assert.strictEqual(await rollback({}, io), 0, io.err);
  const rec = record(s.home);
  assert.deepStrictEqual(Object.keys(rec.packs), ['ci-failure-triage']);
  assert.deepStrictEqual(Object.keys(rec.held), ['other']);
  assert.deepStrictEqual(rec.held.other.from, {release: '0.3.0'});
  assert.deepStrictEqual(installedPacks(require('../lib/home').layout({COUNTINGHOUSE_HOME: s.home})).map((p) => p.name), ['ci-failure-triage'], 'start loads only what this release has');
  assert.match(io.out, /the pack "other" needs ch-local 0\.3\.0; it stays recorded and is not loaded/);
  const st = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}});
  await status({}, st);
  assert.match(st.out, /^other: installed under ch-local 0\.3\.0; this release does not have it, so it is not loaded$/m);
  // Forward again: the newer release has it.
  assert.strictEqual(await rollback({}, rio(s.home)), 0);
  assert.deepStrictEqual(Object.keys(record(s.home).packs).sort(), ['ci-failure-triage', 'other']);
  assert.strictEqual(record(s.home).held, undefined);
});

test('rolling back a security-fix release names it and asks; no keeps it; without a terminal it refuses unless --yes', async () => {
  const fixes = 'ch-step-redact missed tokens inside URLs';
  const s = await upgraded({security: {fixes}});
  const no = rio(s.home, {answers: ['no']});
  assert.strictEqual(await rollback({}, no), 1);
  assert.ok(no.asked.length === 1 && no.asked[0].includes('ch-local 0.3.0') && no.asked[0].includes(fixes), no.asked.join('|'));
  assert.strictEqual(versionOf(s.home, REDACT), '0.2.0', 'unchanged on no');
  const headless = rio(s.home, {interactive: false});
  assert.strictEqual(await rollback({}, headless), 1);
  assert.match(headless.err, /0\.3\.0 is a security fix \(ch-step-redact missed tokens inside URLs\); without a terminal, rollback needs --yes/);
  assert.deepStrictEqual(headless.asked, []);
  const forced = rio(s.home, {interactive: false});
  assert.strictEqual(await rollback({yes: true}, forced), 0, forced.err);
  assert.strictEqual(versionOf(s.home, REDACT), '0.1.0');
  assert.match(forced.out, /undid the security fix in ch-local 0\.3\.0/);
  const yes = await upgraded({security: {fixes}});
  const io = rio(yes.home, {answers: ['yes']});
  assert.strictEqual(await rollback({}, io), 0, io.err);
});

test('rollback holds the home\'s lock', async () => {
  const s = await upgraded();
  fs.writeFileSync(path.join(s.home, 'packs.lock'), JSON.stringify({pid: process.pid, host: require('../lib/lock').lockHost(), at: 'x'}));
  const io = rio(s.home);
  assert.strictEqual(await rollback({}, io), 1);
  assert.match(io.err, /is changing this home/);
  assert.strictEqual(versionOf(s.home, REDACT), '0.2.0');
});

test('uninstall removes the kept release with the program', async () => {
  const s = await upgraded();
  assert.ok(fs.existsSync(path.join(s.home, 'previous', 'app')));
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, homedir: tmp('ch-user-'), answers: ['yes']});
  assert.strictEqual(await require('../lib/uninstall').uninstall({keepData: true}, io), 0, io.err);
  assert.ok(!fs.existsSync(path.join(s.home, 'previous')));
  assert.ok(fs.existsSync(path.join(s.home, 'store', 'kv.json')), '--keep-data keeps the data');
});

test('the CLI takes rollback [--yes], and rollback makes no network call', async () => {
  const s = await upgraded();
  const saved = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network call'); };
  try {
    const io = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: s.home}}), {interactive: false});
    assert.strictEqual(await main(['rollback', '--yes'], io), 0, io.err);
    assert.deepStrictEqual(io.fetches, []);
    assert.strictEqual(await main(['rollback', 'extra'], fakeIo({env: {COUNTINGHOUSE_HOME: s.home}})), 2);
  } finally {
    globalThis.fetch = saved;
  }
});

// /code-review medium on rollback.
const realRename = fs.renameSync;
function failRename(match, code = 'EBUSY') {
  fs.renameSync = (a, b) => { if (match(String(a), String(b))) { const e = new Error(code); e.code = code; throw e; } return realRename(a, b); };
}

test('a rename that fails part-way puts everything back: the newer release is never lost', async () => {
  for (const [why, match] of [
    ['the current app cannot be moved aside', (a) => a.endsWith(path.sep + 'app') && !a.includes('previous')],
    ['the kept app cannot be moved in', (a) => a.endsWith(path.join('previous', 'app'))],
    ['the current app cannot be kept', (a, b) => a.includes(`${path.sep}previous.`) && b.endsWith(path.join('previous', 'app'))]
  ]) {
    const s = await upgraded();
    const io = rio(s.home);
    failRename(match);
    let code;
    try { code = await rollback({}, io); } finally { fs.renameSync = realRename; }
    assert.strictEqual(code, 1, why);
    assert.match(io.err, /could not .* \(EBUSY\); is a client running it\? nothing changed/, why);
    assert.strictEqual(versionOf(s.home, REDACT), '0.2.0', `${why}: the newer release is in place`);
    assert.ok(fs.existsSync(path.join(s.home, 'previous', 'app', 'node_modules')), `${why}: the kept release is kept`);
    assert.strictEqual(record(s.home).release.version, '0.3.0');
    assert.ok(!fs.existsSync(path.join(s.home, 'rollback.journal')), why);
    assert.ok(!fs.readdirSync(s.home).some((n) => n.startsWith('previous.')), why);
  }
});

test('a rollback interrupted after the swap is finished by the next rollback; meanwhile every command says so', async () => {
  const s = await upgraded();
  const rec = require('../lib/module-record');
  const realWrite = rec.writeRecordAsIs;
  let calls = 0;
  rec.writeRecordAsIs = (...a) => { calls++; if (calls === 2) throw new Error('killed'); return realWrite(...a); };
  try {
    await assert.rejects(rollback({}, rio(s.home)), /killed/);
  } finally {
    rec.writeRecordAsIs = realWrite;
  }
  assert.ok(fs.existsSync(path.join(s.home, 'rollback.journal')));
  const st = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}});
  assert.strictEqual(await status({}, st), 1);
  assert.match(st.err, /a rollback was interrupted; run `ch-local rollback` to finish it/);
  const fin = rio(s.home);
  assert.strictEqual(await rollback({}, fin), 0, fin.err);
  assert.match(fin.out, /finished the interrupted rollback to 0\.2\.0/);
  assert.strictEqual(versionOf(s.home, REDACT), '0.1.0');
  assert.strictEqual(record(s.home).release.version, '0.2.0', 'the record matches the app');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(s.home, 'previous', 'modules.json'), 'utf8')).release.version, '0.3.0');
  assert.ok(!fs.existsSync(path.join(s.home, 'rollback.journal')));
});

test('a kept release older than rollback itself is refused: it could never come back', async () => {
  const s = await upgraded();
  const file = path.join(s.home, 'previous', 'modules.json');
  const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete kept.release;
  fs.writeFileSync(file, JSON.stringify(kept));
  const io = rio(s.home);
  assert.strictEqual(await rollback({}, io), 1);
  assert.match(io.err, /the kept release predates rollback, so it could not return you here; install it again instead/);
  assert.strictEqual(versionOf(s.home, REDACT), '0.2.0');
});

// #413 section 10: a kept release from before the module store keeps its
// record as packs.json, which this release does not read
test('a kept release from before the module store is refused: it could not return you here', async () => {
  const s = await upgraded();
  const prev = path.join(s.home, 'previous');
  fs.renameSync(path.join(prev, 'modules.json'), path.join(prev, 'packs.json'));
  const io = rio(s.home);
  assert.strictEqual(await rollback({}, io), 1);
  assert.match(io.err, /the kept release predates the module store, so it could not return you here; install it again instead/);
  assert.strictEqual(versionOf(s.home, REDACT), '0.2.0', 'nothing changed');
});

test('held packs: remove-pack removes one, uninstall names its credentials, and an install over them keeps them held', async () => {
  const {removePack} = require('../lib/packs-command');
  const s = await upgraded();
  assert.strictEqual(await addPack({pack: 'other', from: s.r2.from}, fakeIo({env: {COUNTINGHOUSE_HOME: s.home}}), s.r2.allow), 0);
  assert.strictEqual(await rollback({}, rio(s.home)), 0);
  const u = await upgraded();
  assert.strictEqual(await addPack({pack: 'other', from: u.r2.from}, fakeIo({env: {COUNTINGHOUSE_HOME: u.home}}), u.r2.allow), 0);
  assert.strictEqual(await rollback({}, rio(u.home)), 0);
  const un = fakeIo({env: {COUNTINGHOUSE_HOME: u.home}, homedir: tmp('ch-user-'), answers: ['yes']});
  // the running release (after the rollback, r1's) lists other: held only
  // because the restored record lacked it; its pins give its credential
  un.release = u.r1.allow;
  assert.strictEqual(await require('../lib/uninstall').uninstall({}, un), 0, un.err);
  assert.match(un.out, /revoke the credentials you gave it: .*OTHER_TOKEN/i, 'a held pack\'s credential is named too');
  const again = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: s.r1.from}, again, s.r1.allow), 0, again.err);
  // nothing deleted (the deep review of #77): carried as held, not dropped
  assert.doesNotMatch(again.out, /the pack "other" was dropped/);
  assert.ok(record(s.home).held.other != null, JSON.stringify(record(s.home).held));
  // Remove a held pack.
  const t2 = await upgraded();
  assert.strictEqual(await addPack({pack: 'other', from: t2.r2.from}, fakeIo({env: {COUNTINGHOUSE_HOME: t2.home}}), t2.r2.allow), 0);
  assert.strictEqual(await rollback({}, rio(t2.home)), 0);
  const rm = fakeIo({env: {COUNTINGHOUSE_HOME: t2.home}});
  assert.strictEqual(await removePack({pack: 'other'}, rm), 0, rm.err);
  assert.match(rm.out, /removed the held pack "other"/);
  assert.strictEqual(record(t2.home).held, undefined);
});

test('rolling forward labels a pack added under the older release by that release', async () => {
  const s = await upgraded();
  assert.strictEqual(await rollback({}, rio(s.home)), 0);
  assert.strictEqual(await addPack({pack: 'other', from: s.r1.from}, fakeIo({env: {COUNTINGHOUSE_HOME: s.home}}), s.r1.allow), 0);
  assert.strictEqual(await rollback({}, rio(s.home)), 0);
  assert.strictEqual(record(s.home).held.other.from.release, '0.2.0');
});

// The /code-review medium of rollback-2 (2026-11-12).

// Stops a rollback after its swap, before either record is written: the
// journal stays and the apps are already swapped.
async function killedAfterSwap(home) {
  const rec = require('../lib/module-record');
  const realWrite = rec.writeRecordAsIs;
  rec.writeRecordAsIs = () => { throw new Error('killed'); };
  try {
    await assert.rejects(rollback({}, rio(home)), /killed/);
  } finally {
    rec.writeRecordAsIs = realWrite;
  }
  assert.ok(fs.existsSync(path.join(home, 'rollback.journal')));
}

test('an install while a rollback is interrupted refuses and moves nothing', async () => {
  const s = await upgraded();
  await killedAfterSwap(s.home);
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, exec: npm()});
  const listing = (dir) => fs.readdirSync(dir, {recursive: true}).sort();
  const appBefore = listing(path.join(s.home, 'app'));
  const storeBefore = listing(path.join(s.home, 'module-store'));
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: s.r2.from}, io, s.r2.allow), 1);
  assert.match(io.err, /a rollback was interrupted; run `ch-local rollback` to finish it/);
  assert.ok(fs.existsSync(path.join(s.home, 'rollback.journal')), 'the journal is kept');
  // the modules are in the store: nothing of either release moved
  assert.deepStrictEqual(listing(path.join(s.home, 'app')), appBefore, 'the swapped app is untouched');
  assert.deepStrictEqual(listing(path.join(s.home, 'module-store')), storeBefore, 'the module store is untouched');
  assert.ok(fs.existsSync(path.join(s.home, 'previous', 'app', 'node_modules')), 'the newer release is kept');
  const fin = rio(s.home);
  assert.strictEqual(await rollback({}, fin), 0, fin.err);
  assert.strictEqual(record(s.home).release.version, '0.2.0');
});

test('a stale marker from an earlier rollback does not make a finished swap look undone', async () => {
  const s = await upgraded();
  // An earlier rollback that died between its marker and its journal left
  // this in the release that is now kept.
  fs.writeFileSync(path.join(s.home, 'previous', 'app', '.ch-local-rollback-newer'), '2026-01-01T00:00:00.000Z');
  await killedAfterSwap(s.home);
  const fin = rio(s.home);
  assert.strictEqual(await rollback({}, fin), 0, fin.err);
  assert.match(fin.out, /finished the interrupted rollback to 0\.2\.0/);
  assert.strictEqual(versionOf(s.home, REDACT), '0.1.0');
  assert.strictEqual(record(s.home).release.version, '0.2.0', 'the record matches the app');
});

test('an interrupted rollback whose apps are not where it can tell refuses and keeps its journal', async () => {
  const s = await upgraded();
  await killedAfterSwap(s.home);
  fs.rmSync(path.join(s.home, 'app'), {recursive: true, force: true});
  fs.rmSync(path.join(s.home, 'previous', 'app'), {recursive: true, force: true});
  const io = rio(s.home);
  assert.strictEqual(await rollback({}, io), 1);
  assert.match(io.err, /cannot tell how far the interrupted rollback got/);
  assert.ok(fs.existsSync(path.join(s.home, 'rollback.journal')), 'the journal is kept');
});

test('reinstalling the current release keeps the release rollback returns to', async () => {
  const s = await upgraded();
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: s.r2.from}, io, s.r2.allow), 0, io.err);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(s.home, 'previous', 'modules.json'), 'utf8')).release.version, '0.2.0');
  const rb = rio(s.home);
  assert.strictEqual(await rollback({}, rb), 0, rb.err);
  assert.match(rb.out, /rolled back from ch-local 0\.3\.0 to 0\.2\.0/);
  assert.strictEqual(versionOf(s.home, REDACT), '0.1.0');
});

test('uninstall removes an interrupted rollback\'s aside directory too', async () => {
  const s = await upgraded();
  fs.mkdirSync(path.join(s.home, 'previous.ab12cd34', 'app'), {recursive: true});
  fs.writeFileSync(path.join(s.home, 'previous.ab12cd34', 'app', 'x'), 'x');
  const io = fakeIo({env: {COUNTINGHOUSE_HOME: s.home}, homedir: tmp('ch-user-'), answers: ['yes']});
  assert.strictEqual(await require('../lib/uninstall').uninstall({}, io), 0, io.err);
  assert.ok(!fs.existsSync(s.home), 'nothing is left');
});

test('with the current release\'s programs missing, rollback refuses by name', async () => {
  const s = await upgraded();
  fs.rmSync(path.join(s.home, 'app'), {recursive: true, force: true});
  const io = rio(s.home);
  assert.strictEqual(await rollback({}, io), 1);
  assert.match(io.err, /the current release's programs are missing/);
  assert.ok(fs.existsSync(path.join(s.home, 'previous', 'app')), 'the kept release is kept');
});

test('a pack removed on the newer release that the older one has comes back, and rollback says so', async () => {
  const {removePack} = require('../lib/packs-command');
  const s = await upgraded();
  assert.strictEqual(await removePack({pack: 'ci-failure-triage'}, fakeIo({env: {COUNTINGHOUSE_HOME: s.home}})), 0);
  const io = rio(s.home);
  assert.strictEqual(await rollback({}, io), 0, io.err);
  assert.match(io.out, /the pack "ci-failure-triage" comes back with ch-local 0\.2\.0; `ch-local remove-pack ci-failure-triage` removes it again/);
});

test('a security confirmation answered other than yes says that only yes confirms', async () => {
  const s = await upgraded({security: {fixes: 'x'}});
  const io = rio(s.home, {answers: ['y']});
  assert.strictEqual(await rollback({}, io), 1);
  assert.match(io.out, /nothing changed: only "yes" confirms/);
  assert.strictEqual(versionOf(s.home, REDACT), '0.2.0');
});

test('a running daemon is told: a rollback appends an upgrade request, after the home\'s lock is released (the review of #35)', {skip: process.platform === 'win32'}, async () => {
  const s = await upgraded();
  const dir = path.join(s.home, 'run', 'daemon');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(s.home, 'run'), 0o700);
  fs.chmodSync(dir, 0o700);
  const io = rio(s.home);
  assert.strictEqual(await rollback({}, io), 0, io.err);
  const lines = fs.readFileSync(path.join(dir, 'requests'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => l.op), ['upgrade']);
  assert.ok(!fs.existsSync(path.join(s.home, 'packs.lock')), 'and the home\'s lock was released');
  // a rollback that changes nothing asks for nothing
  fs.rmSync(path.join(dir, 'requests'));
  const none = rio(s.home);
  fs.rmSync(path.join(s.home, 'previous'), {recursive: true, force: true});
  assert.notStrictEqual(await rollback({}, none), 0);
  assert.ok(!fs.existsSync(path.join(dir, 'requests')));
});

// the native shim (lib/shim-install.js): rollback brings it in line with the
// release it restores, by the restored record's shim version and which
// binary on disk is that version (versions.json, by content)
test('rollback swaps the shim with the release: the restored record\'s shim comes back, and again forward', async () => {
  const s = await upgraded();
  const patch = (file, shim) => { const rec = JSON.parse(fs.readFileSync(file, 'utf8')); if (shim == null) delete rec.shim; else rec.shim = shim; fs.writeFileSync(file, JSON.stringify(rec)); };
  patch(path.join(s.home, 'modules.json'), {package: '@countinghouse/ch-shim-linux-x64', version: '0.6.0'});
  patch(path.join(s.home, 'previous', 'modules.json'), {package: '@countinghouse/ch-shim-linux-x64', version: '0.5.0'});
  const dir = path.join(s.home, 'shim');
  fs.mkdirSync(dir);
  const exe = process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim';
  const prev = 'ch-shim.previous';
  fs.writeFileSync(path.join(dir, exe), 'new');
  fs.writeFileSync(path.join(dir, prev), 'old');
  const sha = (t) => require('node:crypto').createHash('sha512').update(t).digest('hex');
  fs.writeFileSync(path.join(dir, 'versions.json'), JSON.stringify({[sha('new')]: '0.6.0', [sha('old')]: '0.5.0'}), {mode: 0o600});
  if (process.platform !== 'win32') fs.chmodSync(path.join(dir, 'versions.json'), 0o600);
  assert.strictEqual(await rollback({}, rio(s.home)), 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, exe), 'utf8'), 'old');
  assert.strictEqual(record(s.home).shim.version, '0.5.0');
  assert.strictEqual(await rollback({}, rio(s.home)), 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, exe), 'utf8'), 'new');
  // a rollback finished twice (interrupted, then resumed) aligns by what is
  // there: the second pass moves nothing
  const {alignShim} = require('../lib/shim-install');
  assert.strictEqual(alignShim(s.home, {restored: record(s.home).shim}), 'nothing');
  assert.strictEqual(fs.readFileSync(path.join(dir, exe), 'utf8'), 'new');
});

test('the review of #48: the version rolled back from is declined, so the automatic upgrade never installs it again', async () => {
  const s = await upgraded();
  const left = record(s.home).runtime.versions['@countinghouse/ch-local'];
  assert.strictEqual(await rollback({}, rio(s.home)), 0);
  const {stamp, problem} = require('../lib/upgrade-stamp').readStamp(s.home);
  assert.strictEqual(problem, null);
  assert.deepStrictEqual(stamp.declined, [left]);
  // rolling back again keeps it once
  assert.strictEqual(await rollback({}, rio(s.home)), 0);
  assert.deepStrictEqual(require('../lib/upgrade-stamp').readStamp(s.home).stamp.declined, [left]);
});

// Withdrawn by the record (#413 section 9.7): each record's withdrawn list is
// derived by the release that wrote it, from its own pins, so a rollback
// swaps the records as they are, never re-deriving either
test('a rollback round trip keeps each record\'s own withdrawn list', async () => {
  const s = await upgraded();
  const f = path.join(s.home, 'modules.json');
  const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({...cur, withdrawn: ['@countinghouse/ch-step-redact']}));
  assert.strictEqual(await rollback({}, rio(s.home)), 0);
  assert.deepStrictEqual(record(s.home).withdrawn, [], 'the older release withdrew nothing');
  assert.strictEqual(await rollback({}, rio(s.home)), 0);
  assert.deepStrictEqual(record(s.home).withdrawn, ['@countinghouse/ch-step-redact'], 'the newer release\'s own list, as it wrote it');
});
