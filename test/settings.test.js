'use strict';
// ch-local settings (packs in place, part 2, plan Task B4): the allowlist and
// bounds countinghouse_settings has; the CLI, the user at a terminal, may
// loosen a guarding setting, and every change is recorded. start applies the
// settings at spawn, and while it runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {main} = require('../bin/ch-local');
const {loosens, setSetting, readSettings} = require('../lib/settings');
const {layout} = require('../lib/home');
const {install} = require('../lib/install');
const {addPack} = require('../lib/packs-command');
const {start} = require('../lib/start');
const {fakeIo, tmp} = require('./fake-io');
const {release, npm} = require('./install-helpers');

const cli = async (home, ...argv) => { const io = fakeIo({env: {COUNTINGHOUSE_HOME: home}}); const code = await main(argv, io); return {code, io}; };
const history = (home) => fs.readFileSync(path.join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('settings get lists every setting with its default and bounds; set stays within them, and is recorded', async () => {
  const home = tmp('ch-home-');
  const got = await cli(home, 'settings', 'get');
  assert.strictEqual(got.code, 0, got.io.err);
  assert.match(got.io.out, /^maxOutputBytes = 8388608 {2}\(default 8388608; 1048576 to 268435456; guarding\)$/m);
  assert.match(got.io.out, /^locale = en {2}\(default en; en, zh\)$/m);
  for (const [name, value, stored] of [['maxOutputBytes', '64MiB', 64 * 1024 * 1024], ['requestTimeout', '20s', 20000], ['locale', 'zh', 'zh'], ['upgradeCheck', 'weekly', 'weekly']]) {
    const r = await cli(home, 'settings', 'set', name, value);
    assert.strictEqual(r.code, 0, r.io.err);
    assert.strictEqual(readSettings(layout({COUNTINGHOUSE_HOME: home})).values[name], stored);
  }
  const h = history(home);
  assert.deepStrictEqual(h.map((e) => [e.by, e.setting]), [['cli', 'maxOutputBytes'], ['cli', 'requestTimeout'], ['cli', 'locale'], ['cli', 'upgradeCheck']]);
  for (const [name, value, code] of [['maxOutputBytes', '512MiB', /outside the allowed range \(1048576 to 268435456\)/], ['requestTimeout', '1s', /outside/], ['nonsense', '1', /there is no setting named nonsense/]]) {
    const r = await cli(home, 'settings', 'set', name, value);
    assert.strictEqual(r.code, 2);
    assert.match(r.io.err, code);
  }
});

test('the CLI may loosen a guarding setting (the user at a terminal), and says so; anything else may not', async () => {
  const home = tmp('ch-home-');
  const where = layout({COUNTINGHOUSE_HOME: home});
  const r = await cli(home, 'settings', 'set', 'moduleSandbox', 'audit');
  assert.strictEqual(r.code, 0);
  assert.match(r.io.out, /this loosens a guarding setting/);
  assert.throws(() => setSetting(where, 'autoUpgrade', 'on', {by: 'settings tool'}), {code: 'SETTING_LOOSENS_A_GUARD'});
  assert.strictEqual(setSetting(where, 'moduleSandbox', 'enforce', {by: 'settings tool'}).loosened, false, 'tightening is anyone\'s');
});

test('loosens: raising a cap or a timeout, audit, automatic upgrades on and a pack on loosen; the reverse never does', () => {
  const cases = [['maxOutputBytes', 8, 16, true], ['maxOutputBytes', 16, 8, false], ['requestTimeout', 30000, 60000, true], ['moduleSandbox', 'enforce', 'audit', true],
    ['moduleSandbox', 'audit', 'enforce', false], ['autoUpgrade', false, true, true], ['autoUpgrade', true, false, false], ['pack.other', false, true, true], ['pack.other', true, false, false],
    ['locale', 'en', 'zh', false], ['upgradeCheck', 'never', 'daily', false]];
  for (const [name, o, n, want] of cases) assert.strictEqual(loosens(name, o, n), want, `${name} ${o} -> ${n}`);
});

test('an earlier {autoUpgrade} settings file is read as version 1, and upgrade --auto writes through settings', async () => {
  const home = tmp('ch-home-');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({autoUpgrade: true}));
  assert.deepStrictEqual(readSettings(layout({COUNTINGHOUSE_HOME: home})).values, {autoUpgrade: true});
  const r = await cli(home, 'upgrade', '--auto', 'off');
  assert.strictEqual(r.code, 0, r.io.err);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')), {version: 1, values: {autoUpgrade: false}});
});

test('start: a pack turned off is not loaded; the runtime\'s settings are passed unless the client passed them; while running, a pack turned off is unloaded and a live setting is sent', async () => {
  const home = tmp('ch-home-');
  const r = release();
  const cmd = () => fakeIo({env: {COUNTINGHOUSE_HOME: home}, exec: npm()});
  assert.strictEqual(await install({pack: 'ci-failure-triage', from: r.from}, cmd(), r.allow), 0);
  assert.strictEqual(await addPack({pack: 'other', from: r.from}, cmd(), r.allow), 0);
  assert.strictEqual((await cli(home, 'settings', 'set', 'pack.other', 'off')).code, 0);
  assert.strictEqual((await cli(home, 'settings', 'set', 'maxOutputBytes', '16MiB')).code, 0);
  const f = fakeIo({env: {COUNTINGHOUSE_HOME: home, GITHUB_TOKEN: 'secret', OTHER_TOKEN: 'o'}, homedir: '/nowhere'});
  Object.assign(f, {pid: 4242, hostname: 'box-1', cwd: home, alive: () => true, trapSignals: () => () => {}, exit: () => {}});
  const requests = [];
  let end = null;
  let listener = null;
  let args = null;
  f.spawn = (c, a) => {
    args = a;
    return {kill: () => {}, exited: new Promise((resolve) => { end = resolve; }),
      send: (m) => { requests.push(m); setImmediate(() => listener({id: m.id, ok: true})); }, onMessage: (fn) => { listener = fn; }};
  };
  const done = start({passThrough: ['--locale', 'zh']}, f);
  for (let i = 0; end == null && i < 500; i++) await new Promise((res) => setTimeout(res, 10));
  assert.ok(!args.some((a) => a.includes(`${path.sep}other${path.sep}`)), 'other is off: not loaded');
  assert.match(f.err, /not loading other: it is turned off/);
  assert.deepStrictEqual(args.slice(args.indexOf('--maxOutputBytes'), args.indexOf('--maxOutputBytes') + 2), ['--maxOutputBytes', String(16 * 1024 * 1024)]);
  assert.strictEqual(args.filter((a) => a === '--locale').length, 1, 'the client\'s own --locale only');
  assert.strictEqual((await cli(home, 'settings', 'set', 'pack.other', 'on')).code, 0);
  for (let i = 0; requests.length < 1 && i < 500; i++) await new Promise((res) => setTimeout(res, 10));
  assert.deepStrictEqual([requests[0].type, requests[0].name], ['load', 'other']);
  assert.strictEqual((await cli(home, 'settings', 'set', 'requestTimeout', '15s')).code, 0);
  for (let i = 0; requests.length < 2 && i < 500; i++) await new Promise((res) => setTimeout(res, 10));
  assert.deepStrictEqual(requests[1], {type: 'set', name: 'requestTimeout', value: 15000, id: requests[1].id});
  assert.strictEqual((await cli(home, 'settings', 'set', 'pack.ci-failure-triage', 'off')).code, 0);
  for (let i = 0; requests.length < 3 && i < 500; i++) await new Promise((res) => setTimeout(res, 10));
  assert.deepStrictEqual([requests[2].type, requests[2].name, requests[2].notice], ['unload', 'ci-failure-triage', 'ci-failure-triage turned off']);
  end(0);
  await done;
});
