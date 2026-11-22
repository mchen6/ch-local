'use strict';
require('./tmp-dirs');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {uninstall} = require('../lib/uninstall');
const {fakeIo, tmp} = require('./fake-io');

// A home as an install and a few runs leave it.
function setup() {
  const user = tmp('ch-user-');
  const home = path.join(user, '.countinghouse');
  const files = {
    'settings.json': '{"autoUpgrade": false}',
    'auth.json': '{"keys": ["k"]}',
    'run/4242/remote-credentials.json': '{}',
    'modules/x': 'x',
    'app/package.json': '{}',
    'bin/ch-local.js': '',
    'node/bin/node': '',
    'store/.identity-secret': 's',
    'store/kv.json': '{}',
    'module_data/ch-access-github/x': 'x',
    'usage/1.jsonl': '{}',
    'data/pack-ci-failure-triage/r/fingerprints.json': '{}'
  };
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(home, f)), {recursive: true});
    fs.writeFileSync(path.join(home, f), body);
  }
  // two packs installed, in the module store and modules.json
  const {storeModule, writeHome} = require('./store-helpers');
  storeModule(home, '@countinghouse/ch-pack-ci-failure-triage', '1.0.0', {countinghouse: {role: 'scenario'}});
  storeModule(home, '@countinghouse/ch-pack-other', '1.0.0', {countinghouse: {role: 'scenario'}});
  writeHome(home, {'ci-failure-triage': {'@countinghouse/ch-pack-ci-failure-triage': '1.0.0'}, other: {'@countinghouse/ch-pack-other': '1.0.0'}});
  return {user, home, done: () => fs.rmSync(user, {recursive: true, force: true})};
}
// the running release's pins give each pack its credentials
// (pins version 2: a pack's credentials are its modules' descriptions')
const described = (variable) => ({role: null, credentials: variable == null ? [] : [{variable, origin: 'https://api.githubcopilot.com'}], calls: [], confirmSettings: {}});
const RELEASE = {
  packs: {'ci-failure-triage': {modules: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github']}, other: {modules: ['@countinghouse/ch-pack-other']}},
  modules: {'@countinghouse/ch-pack-ci-failure-triage': described(null), '@countinghouse/ch-access-github': described('COUNTINGHOUSE_GITHUB_TOKEN'), '@countinghouse/ch-pack-other': described('OTHER_TOKEN')}
};
const io = (s, answers) => Object.assign(fakeIo({env: {GITHUB_TOKEN: 'secret-value-123'}, homedir: s.user, answers}), {release: RELEASE});

// the Reviewer's high review of #98's round 2, 6, and its cut in round 3:
// every variable a stored module's remotes name (more than one remote, a
// fallbackEnv), and every variable the store holds a key under
test('the credentials to revoke: every variable an installed module\'s remotes name, and every variable the store holds a key under', async () => {
  const s = setup();
  try {
    const {storeModule} = require('./store-helpers');
    fs.chmodSync(s.home, 0o700);   // (the store refuses a home others can write)
    storeModule(s.home, '@countinghouse/ch-pack-other', '1.0.0', {countinghouse: {role: 'scenario', remotes: [
      {name: 'a', url: 'https://a.example.invalid/', credential: {env: 'A_TOKEN', fallbackEnv: 'A_FALLBACK'}},
      {name: 'b', url: 'https://b.example.invalid/', credential: 'B_TOKEN'}]}});
    require('../lib/credential-store').bind(s.home, '@countinghouse/ch-access-github', 'COUNTINGHOUSE_GITHUB_TOKEN', {origin: 'https://api.githubcopilot.com', source: 'stored', value: 'test-stored-old-1'}, {held: require('./store-helpers').FIXTURE_HELD});
    // a removed pack's module whose key was kept: the store's own entries are named
    require('../lib/credential-store').bind(s.home, '@countinghouse/ch-gone', 'GONE_TOKEN', {origin: 'https://gone.example.invalid', source: 'stored', value: 'test-stored-gone-1'}, {held: require('./store-helpers').FIXTURE_HELD});
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    const line = (u.out.match(/revoke the credentials you gave it: (.*)\n/i) || [])[1] || '';
    for (const v of ['A_TOKEN', 'A_FALLBACK', 'B_TOKEN', 'COUNTINGHOUSE_GITHUB_TOKEN', 'OTHER_TOKEN', 'GONE_TOKEN']) assert.ok(line.split(', ').includes(v), `${v} in ${line}`);
    assert.ok(!u.out.includes('test-stored-old-1'), 'never a value');
  } finally {
    s.done();
  }
});

test('uninstall lists the home directory and deletes nothing without a yes', async () => {
  const s = setup();
  try {
    const u = io(s, ['no']);
    assert.strictEqual(await uninstall({}, u), 1);
    for (const name of ['app', 'bin', 'node', 'store', 'module_data', 'usage', 'data', 'auth.json']) assert.ok(u.out.includes(name), name);
    assert.strictEqual(u.asked.length, 1, 'asks once');
    assert.ok(fs.existsSync(path.join(s.home, 'app', 'package.json')));
    assert.ok(fs.existsSync(path.join(s.home, 'store', '.identity-secret')));
  } finally {
    s.done();
  }
});

test('on yes everything under the home goes, and the credentials to revoke are named', async () => {
  const s = setup();
  try {
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    assert.ok(!fs.existsSync(s.home));
    // (the variables the pack's modules are described with: pins version 2)
    assert.match(u.out, /revoke the credentials you gave it: COUNTINGHOUSE_GITHUB_TOKEN, OTHER_TOKEN\n/i, 'every installed pack\'s, once each');
    assert.ok(!(u.out + u.err).includes('secret-value-123'));
    // (F14, the feature audit: the Claude Code plugin is Claude Code's to
    // remove, said last)
    assert.match(u.out, /If you added the Claude Code plugin, remove it in Claude Code too: `claude plugin uninstall ch-packs@ch-packs`\n$/);
  } finally {
    s.done();
  }
});

test('--keep-data keeps the data and removes the program, the identity secret and the key', async () => {
  const s = setup();
  try {
    // the native shim, as install places it (lib/shim-install.js): program
    fs.mkdirSync(path.join(s.home, 'shim'));
    fs.writeFileSync(path.join(s.home, 'shim', 'ch-shim'), 'x');
    fs.writeFileSync(path.join(s.home, 'shim', 'ch-shim.previous'), 'y');
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({keepData: true}, u), 0, u.err);
    const has = (f) => fs.existsSync(path.join(s.home, f));
    assert.ok(!has('shim'), 'the shim goes with the program');
    for (const kept of ['store/kv.json', 'module_data/ch-access-github/x', 'usage/1.jsonl', 'data/pack-ci-failure-triage/r/fingerprints.json']) assert.ok(has(kept), kept);
    // run/ holds each start's own files: program, not data. settings.json is
    // the user's (with its history): kept, so a reinstall keeps their tightenings.
    for (const gone of ['app', 'bin', 'node', 'store/.identity-secret', 'auth.json', 'modules.json', 'module-store', 'run', 'modules']) assert.ok(!has(gone), gone);
  } finally {
    s.done();
  }
});

// B-own-add (the own-modules design §2.6): the user's own modules' copies
// and their record are program, the user's folders elsewhere untouched;
// an own module's data is data.
test('uninstall: the own modules\' copies and own.json go with the program; their data is kept with --keep-data', async () => {
  const s = setup();
  try {
    const tree = 'a'.repeat(64);
    fs.mkdirSync(path.join(s.home, 'own', 'my-tool', tree), {recursive: true});
    fs.writeFileSync(path.join(s.home, 'own', 'my-tool', tree, 'api.json'), '{}');
    fs.writeFileSync(path.join(s.home, 'own.json'), '{}');
    fs.mkdirSync(path.join(s.home, 'module_data', 'my-tool'), {recursive: true});
    fs.writeFileSync(path.join(s.home, 'module_data', 'my-tool', 'x'), 'x');
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({keepData: true}, u), 0, u.err);
    assert.ok(!/own(\.json)?  \(not ch-local's: left\)/.test(u.out), u.out);
    const has = (f) => fs.existsSync(path.join(s.home, f));
    for (const gone of ['own', 'own.json']) assert.ok(!has(gone), gone);
    assert.ok(has('module_data/my-tool/x'));
  } finally {
    s.done();
  }
});

// From /code-review medium on #2.
test('uninstall removes only what is ch-local\'s: a home set to a shared directory keeps everything else', async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.home, 'thesis.tex'), 'mine');
    fs.mkdirSync(path.join(s.home, 'photos'));
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    assert.strictEqual(fs.readFileSync(path.join(s.home, 'thesis.tex'), 'utf8'), 'mine');
    assert.ok(fs.existsSync(path.join(s.home, 'photos')));
    assert.ok(!fs.existsSync(path.join(s.home, 'app')));
    assert.match(u.out, /thesis\.tex  \(not ch-local's: left\)/);
  } finally {
    s.done();
  }
});

test('nothing installed: uninstall says so and asks nothing', async () => {
  const user = tmp('ch-user-');
  try {
    const u = fakeIo({env: {}, homedir: user});
    assert.strictEqual(await uninstall({}, u), 0);
    assert.match(u.out, /nothing to uninstall/);
    assert.deepStrictEqual(u.asked, []);
  } finally {
    fs.rmSync(user, {recursive: true, force: true});
  }
});

test('a home whose packs were all removed still names the release\'s credentials to revoke', async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.home, 'packs.json'), JSON.stringify({runtime: {versions: {}}, packs: {}}));
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    assert.match(u.out, /revoke the credentials you gave it: COUNTINGHOUSE_GITHUB_TOKEN/i);
  } finally {
    s.done();
  }
});

test('uninstall removes a leftover packs.lock with the program, and waits for no one: a live holder stops it', async () => {
  const s = setup();
  try {
    fs.writeFileSync(path.join(s.home, 'packs.lock'), JSON.stringify({pid: 2147483646, host: require('../lib/lock').lockHost(), at: 'x'}));
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    assert.ok(!fs.existsSync(s.home), 'nothing left, the stale lock included');
  } finally {
    s.done();
  }
  const t = setup();
  try {
    fs.writeFileSync(path.join(t.home, 'packs.lock'), JSON.stringify({pid: process.pid, host: require('../lib/lock').lockHost(), at: 'x'}));
    const u = io(t, ['yes']);
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, /is changing this home/);
    assert.ok(fs.existsSync(path.join(t.home, 'app')));
  } finally {
    t.done();
  }
});

// A9 (the final pass): uninstall removed the home under a running shared
// runtime. Under start.lock (where no daemon is starting, restarting or in
// its backoff), one that serves, judged as a starting daemon judges it (the
// socket daemon.json names proves the secret), refuses the removal; anything
// else is stale. Then start.lock, packs.lock: the daemon's own order.
const runDaemon = (h) => path.join(h, 'run', 'daemon');
function plantDaemon(h, {socket = path.join(runDaemon(h), 'sessions.sock'), secret = true, started = new Date().toISOString()} = {}) {
  fs.mkdirSync(runDaemon(h), {recursive: true, mode: 0o700});
  fs.chmodSync(path.join(h, 'run'), 0o700);
  fs.chmodSync(runDaemon(h), 0o700);
  fs.writeFileSync(path.join(runDaemon(h), 'daemon.json'), JSON.stringify({pid: 4242, socket, started}), {mode: 0o600});
  if (secret) fs.writeFileSync(path.join(runDaemon(h), 'secret'), require('node:crypto').randomBytes(32).toString('hex'), {mode: 0o600});
}
const SERVING = /^ch-local uninstall: the shared runtime is still serving; nothing was removed\. Close the clients that use countinghouse; it stops 10 minutes after the last one closes\. Then run `[^`]+uninstall` again\.$/m;

test('A9: a serving shared runtime refuses the removal: nothing removed, how to make it stop said, exit 1', async (t) => {
  const s = setup();
  try {
    plantDaemon(s.home);
    t.mock.method(require('../lib/daemon'), 'daemonServing', async () => ({serving: true, pid: 4242}));
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, SERVING);
    assert.ok(fs.existsSync(path.join(s.home, 'settings.json')) && fs.existsSync(path.join(s.home, 'store', 'kv.json')), 'nothing removed');
  } finally {
    s.done();
  }
});

test('A9: a daemon started while the prompt waits is judged after the yes: refused', async (t) => {
  const s = setup();
  try {
    let up = false;
    t.mock.method(require('../lib/daemon'), 'daemonServing', async () => ({serving: up, pid: 4242}));
    const u = io(s, ['yes']);
    const ask = u.ask;
    u.ask = async (q) => { plantDaemon(s.home); up = true; return ask(q); };
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, SERVING);
    assert.ok(fs.existsSync(path.join(s.home, 'settings.json')), 'nothing removed');
  } finally {
    s.done();
  }
});

test('A9: a daemon.json a crash left (a secret, nothing serving at its socket, its pid gone) is stale: removed as today', async () => {
  const s = setup();
  try {
    plantDaemon(s.home);
    const u = Object.assign(io(s, ['yes']), {alive: () => false});
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    assert.ok(!fs.existsSync(s.home));
  } finally {
    s.done();
  }
});

test('A9: a daemon restarting (start.lock held, daemon.json\'s socket null) is waited for, bounded: refused at the bound, nothing removed', async () => {
  const s = setup();
  try {
    plantDaemon(s.home, {socket: null});
    const {withLockFile} = require('../lib/lock');
    let release = null;
    const held = withLockFile(path.join(runDaemon(s.home), 'start.lock'), runDaemon(s.home), fakeIo({}), () => new Promise((r) => { release = r; }), {wait: true});
    while (release == null) await new Promise((r) => setTimeout(r, 10));
    const u = Object.assign(io(s, ['yes']), {uninstallLockMs: 300});
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, /the shared runtime has been starting or restarting for 0\.3 s; nothing was removed\. Run `[^`]+uninstall` again in a minute\./);
    assert.ok(fs.existsSync(path.join(s.home, 'settings.json')), 'nothing removed');
    release(0);
    await held;
  } finally {
    s.done();
  }
});

test('A9: the daemon\'s order, start.lock then packs.lock: a runtime starting under start.lock takes packs.lock while uninstall waits', async () => {
  const s = setup();
  try {
    plantDaemon(s.home, {socket: null});
    const {withLockFile, withLock} = require('../lib/lock');
    const {layout} = require('../lib/home');
    let release = null;
    const order = [];
    // (as the daemon restarts: start.lock held, then its runtime's start
    // takes packs.lock; it would wait forever on an uninstall holding it)
    const held = withLockFile(path.join(runDaemon(s.home), 'start.lock'), runDaemon(s.home), fakeIo({}), async () => {
      await new Promise((r) => { release = r; });
      await withLock(layout({COUNTINGHOUSE_HOME: s.home}), fakeIo({}), async () => { order.push('the runtime took packs.lock'); return 0; }, {wait: true});
      fs.rmSync(path.join(runDaemon(s.home), 'daemon.json'));
      return 0;
    }, {wait: true});
    while (release == null) await new Promise((r) => setTimeout(r, 10));
    const u = Object.assign(io(s, ['yes']), {uninstallLockMs: 20000});
    const done = uninstall({}, u);
    await new Promise((r) => setTimeout(r, 200));
    release();
    assert.strictEqual(await held, 0);
    assert.strictEqual(await done, 0, u.err);
    assert.deepStrictEqual(order, ['the runtime took packs.lock']);
    assert.ok(!fs.existsSync(s.home));
  } finally {
    s.done();
  }
});

test('A9: a daemon whose socket answers nothing but whose pid lives (draining, or between a crash and its restart) refuses the removal', async () => {
  const s = setup();
  try {
    plantDaemon(s.home);
    const u = Object.assign(io(s, ['yes']), {alive: (pid) => pid === 4242});
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, SERVING);
    assert.ok(fs.existsSync(path.join(s.home, 'settings.json')), 'nothing removed');
  } finally {
    s.done();
  }
});

test('A9: a daemon.json from before this boot is stale, its pid since reused', {skip: process.platform !== 'linux' && 'the boot time is read on Linux'}, async () => {
  const s = setup();
  try {
    plantDaemon(s.home, {started: '2000-01-01T00:00:00.000Z'});
    const u = Object.assign(io(s, ['yes']), {alive: () => true});
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    assert.ok(!fs.existsSync(s.home));
  } finally {
    s.done();
  }
});

test('A9: run/ (where start.lock is held) goes last, after everything else', async (t) => {
  const s = setup();
  try {
    const real = fs.rmSync;
    const order = [];
    t.mock.method(fs, 'rmSync', (p, o) => { if (path.dirname(String(p)) === s.home) order.push(path.basename(String(p))); return real(p, o); });
    const u = Object.assign(io(s, ['yes']), {alive: () => false});
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    const at = order.indexOf('run');
    assert.ok(at >= 0 && order.slice(at + 1).every((n) => !['app', 'node', 'bin', 'modules', 'store', 'settings.json'].includes(n)), order.join(' '));
  } finally {
    t.mock.restoreAll();
    s.done();
  }
});

test('A9: a removal that fails is said with the way on, never thrown', async (t) => {
  const s = setup();
  try {
    const real = fs.rmSync;
    t.mock.method(fs, 'rmSync', (p, o) => { if (String(p) === path.join(s.home, 'node')) throw Object.assign(new Error('busy'), {code: 'EBUSY'}); return real(p, o); });
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, /ch-local uninstall: node could not be removed \(EBUSY\)\. Close what has .*node open and run `[^`]+uninstall` again/);
  } finally {
    t.mock.restoreAll();
    s.done();
  }
});
