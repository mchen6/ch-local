'use strict';
// Packs in place (part 2, plan Task B3): a running start watches the home and
// applies each pack change to its runtime over the control channel: load,
// unload, reload, one at a time, each with its notice; every change in
// <home>/history.jsonl; run.json kept to what is loaded.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {install} = require('../lib/install');
const {addPack, removePack} = require('../lib/packs-command');
const {start} = require('../lib/start');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm} = require('./install-helpers');

const until = async (cond, ms = 10000) => {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 20))) if (cond()) return;
  throw new Error('timed out waiting');
};

// A running start over an installed home, with a runtime that answers each
// control request with `answer(msg)` (default ok) and runs until end().
async function running({answer = () => ({ok: true}), timeoutMs, passThrough = [], duringSpawn = null} = {}) {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  const f = fakeIo({env: {COUNTINGHOUSE_HOME: home, GITHUB_TOKEN: 'secret', OTHER_TOKEN: 'other-secret'}, homedir: '/nowhere'});
  Object.assign(f, {pid: 4242, hostname: 'box-1', cwd: home, alive: () => true, trapSignals: () => () => {}, exit: () => {}, controlTimeoutMs: timeoutMs});
  const requests = [];
  let end = null;
  let listener = null;
  let spawnedArgs = null;
  f.spawn = (c, args) => {
    spawnedArgs = args;
    if (duringSpawn != null) duringSpawn(home);
    return {
      kill: () => {},
      exited: new Promise((resolve) => { end = resolve; }),
      send: (msg) => {
        requests.push(msg);
        const reply = answer(msg);
        if (reply != null) setImmediate(() => listener({id: msg.id, ...reply}));
      },
      onMessage: (fn) => { listener = fn; }
    };
  };
  const done = start({passThrough}, f);
  await until(() => end != null);
  const runDir = () => path.join(home, 'run', fs.readdirSync(path.join(home, 'run'))[0]);
  return {home, r, f, requests, cmd, done, args: () => spawnedArgs, end: () => end(0), runDir,
    history: () => (fs.existsSync(path.join(home, 'history.jsonl')) ? fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [])};
}

test('start spawns its runtime with the control channel', async () => {
  const s = await running();
  assert.deepStrictEqual(s.args().slice(s.args().indexOf('--controlChannel'), s.args().indexOf('--controlChannel') + 2), ['--controlChannel', 'ipc']);
  s.end();
  assert.strictEqual(await s.done, 0);
});

test('add-pack while running: one load request with the pack\'s own tree, credentials file and notice; history and run.json follow', async () => {
  const s = await running();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.requests.length === 1);
  const [load] = s.requests;
  assert.strictEqual(load.type, 'load');
  assert.strictEqual(load.name, 'other');
  assert.strictEqual(load.notice, 'other added 0.3.0');
  assert.ok(load.scenario.startsWith(path.join(s.home, 'packs', 'other')), load.scenario);
  assert.ok(fs.existsSync(load.remoteCredentials));
  await until(() => s.history().length === 1);
  assert.deepStrictEqual((({pack, change, notice, by}) => ({pack, change, notice, by}))(s.history()[0]), {pack: 'other', change: 'added', notice: 'other added 0.3.0', by: 'start'});
  assert.ok(!JSON.stringify(s.history()).includes('secret'), 'never a value');
  const run = JSON.parse(fs.readFileSync(path.join(s.runDir(), 'run.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(run.loaded).sort(), ['ci-failure-triage', 'other']);
  assert.match(s.f.err, /other added 0\.3\.0/);
  s.end();
  await s.done;
});

test('remove-pack while running: one unload request; reinstalling a changed release reloads', async () => {
  const s = await running();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.requests.length === 1);
  assert.strictEqual(await removePack({pack: 'other'}, s.cmd()), 0);
  await until(() => s.requests.length === 2);
  assert.deepStrictEqual([s.requests[1].type, s.requests[1].name, s.requests[1].notice], ['unload', 'other', 'other removed']);
  const r2 = release({versions: {'@countinghouse/ch-step-redact': '0.2.0'}});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
  await until(() => s.requests.length === 3);
  assert.deepStrictEqual([s.requests[2].type, s.requests[2].name, s.requests[2].notice], ['reload', 'ci-failure-triage', 'ci-failure-triage updated 0.1.0 → 0.1.0']);
  s.end();
  await s.done;
});

test('a refused request is recorded and said, and nothing is marked loaded; a runtime that never answers is a restart', async () => {
  const s = await running({answer: (m) => (m.name === 'other' ? {ok: false, code: 'PART_VERSION_CONFLICT', message: 'two versions'} : {ok: true})});
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => s.history().length === 1);
  assert.match(s.history()[0].problem, /^PART_VERSION_CONFLICT/);
  assert.match(s.f.err, /other added 0\.3\.0: not applied in place \(PART_VERSION_CONFLICT\); restart your client/);
  const run = JSON.parse(fs.readFileSync(path.join(s.runDir(), 'run.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(run.loaded), ['ci-failure-triage']);
  s.end();
  await s.done;

  const silent = await running({answer: () => null, timeoutMs: 200});
  assert.strictEqual(await addPack({pack: 'other', from: silent.r.from}, silent.cmd(), silent.r.allow), 0);
  await until(() => silent.history().length === 1);
  assert.match(silent.f.err, /not applied in place \(CONTROL_NO_ANSWER\); restart your client/);
  silent.end();
  await silent.done;
});

test('two changes in quick succession are applied one at a time, in order; the last state is what is loaded', async () => {
  const s = await running();
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  assert.strictEqual(await removePack({pack: 'other'}, s.cmd()), 0);
  await new Promise((r) => setTimeout(r, 2500));   // past the poll, whatever the watch saw
  const kinds = s.requests.map((m) => `${m.type} ${m.name}`);
  // either both seen (load then unload) or only the final state (nothing to do)
  assert.ok(JSON.stringify(kinds) === JSON.stringify(['load other', 'unload other']) || kinds.length === 0, JSON.stringify(kinds));
  const run = JSON.parse(fs.readFileSync(path.join(s.runDir(), 'run.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(run.loaded), ['ci-failure-triage']);
  s.end();
  await s.done;
});

test('a change that cannot be applied in place is said, never fatal: start runs on', async () => {
  const s = await running();
  // its run directory replaced by a file: nothing can be written in it now
  const dir = s.runDir();
  fs.rmSync(dir, {recursive: true, force: true});
  fs.writeFileSync(dir, 'not a directory');
  assert.strictEqual(await addPack({pack: 'other', from: s.r.from}, s.cmd(), s.r.allow), 0);
  await until(() => /could not be applied in place|not applied in place/.test(s.f.err));
  s.end();
  assert.strictEqual(await s.done, 0);
});

test('a setting changed between start reading the home and watching it is still applied; one the client passes itself stands', async () => {
  const {setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = await running({passThrough: ['--locale', 'en'],
    duringSpawn: (home) => setSetting(layout({COUNTINGHOUSE_HOME: home}), 'maxOutputBytes', '4MiB', {by: 'cli'})});
  await until(() => s.requests.some((m) => m.type === 'set'));
  assert.deepStrictEqual(s.requests.filter((m) => m.type === 'set').map((m) => [m.name, m.value]), [['maxOutputBytes', 4 * 1024 * 1024]]);
  setSetting(layout({COUNTINGHOUSE_HOME: s.home}), 'locale', 'zh', {by: 'cli'});
  await until(() => /locale set to zh: your client passes --locale itself/.test(s.f.err));
  assert.ok(!s.requests.some((m) => m.type === 'set' && m.name === 'locale'), 'never sent');
  s.end();
  await s.done;
});

test('after a runtime update, packs are not loaded or reloaded into the old runtime: said once, and recorded', async () => {
  const s = await running();
  const r2 = release({versions: {'@countinghouse/ch-step-redact': '0.2.0', countinghouse: '8.0.1'}});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r2.from}, s.cmd(), r2.allow), 0);
  await until(() => /a runtime update applies at the next start/.test(s.f.err));
  await new Promise((r) => setTimeout(r, 2500));
  assert.deepStrictEqual(s.requests.filter((m) => m.type === 'reload' || m.type === 'load'), []);
  assert.strictEqual(s.history().filter((e) => e.change === 'runtime update').length, 1);
  s.end();
  await s.done;
});

test('a live requestTimeout change is sent in the runtime\'s unit, seconds', async () => {
  const {setSetting} = require('../lib/settings');
  const {layout} = require('../lib/home');
  const s = await running();
  setSetting(layout({COUNTINGHOUSE_HOME: s.home}), 'requestTimeout', '20s', {by: 'cli'});
  await until(() => s.requests.some((m) => m.type === 'set' && m.name === 'requestTimeout'));
  assert.deepStrictEqual(s.requests.filter((m) => m.type === 'set').map((m) => [m.name, m.value]), [['requestTimeout', 20]]);
  s.end();
  await s.done;
});
