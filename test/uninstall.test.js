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
// (nothing removed, judged by the whole listing and two names removed first,
// never by the last ones: the reviewer's high on #140, M2)
const listing = (h) => fs.readdirSync(h).filter((n) => n !== 'run' && !/\.lock$/.test(n)).sort().join(' ');
const untouched = (h, before) => {
  assert.strictEqual(listing(h), before, 'nothing removed');
  assert.ok(fs.existsSync(path.join(h, 'modules.json')) && fs.existsSync(path.join(h, 'app', 'package.json')), 'the record and app/ kept');
};
const SERVING = /^ch-local uninstall: the shared runtime is still serving; nothing was removed\. Close the clients that use countinghouse; it stops 10 minutes after the last one closes\. Then run `[^`]+uninstall` again\.$/m;

test('A9: a serving shared runtime refuses the removal: nothing removed, how to make it stop said, exit 1', async (t) => {
  const s = setup();
  const before = listing(s.home);
  try {
    plantDaemon(s.home);
    t.mock.method(require('../lib/daemon'), 'daemonServing', async () => ({serving: true, pid: 4242}));
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, SERVING);
    untouched(s.home, before);
  } finally {
    s.done();
  }
});

test('A9: a daemon started while the prompt waits is judged after the yes: refused', async (t) => {
  const s = setup();
  const before = listing(s.home);
  try {
    let up = false;
    t.mock.method(require('../lib/daemon'), 'daemonServing', async () => ({serving: up, pid: 4242}));
    const u = io(s, ['yes']);
    const ask = u.ask;
    u.ask = async (q) => { plantDaemon(s.home); up = true; return ask(q); };
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, SERVING);
    untouched(s.home, before);
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
  const before = listing(s.home);
  try {
    plantDaemon(s.home, {socket: null});
    const {withLockFile} = require('../lib/lock');
    let release = null;
    const held = withLockFile(path.join(runDaemon(s.home), 'start.lock'), runDaemon(s.home), fakeIo({}), () => new Promise((r) => { release = r; }), {wait: true});
    while (release == null) await new Promise((r) => setTimeout(r, 10));
    const u = Object.assign(io(s, ['yes']), {uninstallLockMs: 300});
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, /the shared runtime has been starting or restarting for 0\.3 s; nothing was removed\. Run `[^`]+uninstall` again in a minute\./);
    untouched(s.home, before);
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
  const before = listing(s.home);
  try {
    plantDaemon(s.home);
    const u = Object.assign(io(s, ['yes']), {alive: (pid) => pid === 4242});
    assert.strictEqual(await uninstall({}, u), 1);
    // (judged by the pid alone: the way out if that pid is another program's)
    assert.match(u.err, /^ch-local uninstall: the shared runtime is still serving; nothing was removed\. Close the clients that use countinghouse; it stops 10 minutes after the last one closes\. Then run `[^`]+uninstall` again; if pid 4242's command line \((?:`ps -ww -o args= -p 4242`|Task Manager's Details tab, Command line column)\) does not contain `ch-local\.js daemon`, it is not a countinghouse daemon: remove .*daemon\.json and run it again\.$/m);
    untouched(s.home, before);
  } finally {
    s.done();
  }
});

test('A9: no clock is read: a daemon.json older than this boot whose pid lives still refuses, with the way out', async () => {
  const s = setup();
  const before = listing(s.home);
  try {
    plantDaemon(s.home, {started: '2000-01-01T00:00:00.000Z'});
    const u = Object.assign(io(s, ['yes']), {alive: () => true});
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, /if pid 4242's command line .* does not contain `ch-local\.js daemon`/);
    untouched(s.home, before);
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
    // (renamed aside in one step, then removed: last)
    const at = order.findIndex((n) => /^run\.removing-[0-9a-f]{8}$/.test(n));
    assert.ok(at >= 0 && at === order.length - 1, order.join(' '));
    assert.ok(!order.includes('run'), 'never removed in place');
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
    // (the removal has begun, app/ may be gone: the npx form -- L2)
    assert.match(u.err, /ch-local uninstall: node could not be removed \(EBUSY\)\. Close what has .*node open and run `(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local uninstall` again/);
  } finally {
    t.mock.restoreAll();
    s.done();
  }
});

test('A9: packs.lock is waited for at most the bound while start.lock is held: then refused, nothing removed', async () => {
  const s = setup();
  const before = listing(s.home);
  try {
    const {withLock} = require('../lib/lock');
    const {layout} = require('../lib/home');
    plantDaemon(s.home);
    let release = null;
    let held = null;
    // (taken between the phases, as an install starting then would: from the
    // serving check, which runs under start.lock once packs.lock is let go;
    // the lock file is made before withLock's first await)
    const alive = () => { held = withLock(layout({COUNTINGHOUSE_HOME: s.home}), fakeIo({}), () => new Promise((r) => { release = r; }), {wait: true}); return false; };
    const u = Object.assign(io(s, ['yes']), {alive, uninstallLockMs: 400});
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, /another ch-local was still changing this home after 0\.4 s; nothing was removed\. Run `[^`]+uninstall` again when it is done\./);
    untouched(s.home, before);
    release(0);
    await held;
  } finally {
    s.done();
  }
});

test('A9: a check that threw refuses with no advice to remove anything; a run/ aside a failed removal left is removed by the next run', async (t) => {
  const s = setup();
  try {
    t.mock.method(require('../lib/daemon'), 'daemonServing', async () => { throw Object.assign(new Error('pipe'), {code: 'EPIPE'}); });
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, /still serving; nothing was removed\..* again \(whether it serves could not be checked: EPIPE\)\.$/m);
    assert.doesNotMatch(u.err, /remove /);
  } finally {
    t.mock.restoreAll();
    s.done();
  }
  const s2 = setup();
  try {
    fs.mkdirSync(path.join(s2.home, 'run.removing-0123abcd', 'daemon'), {recursive: true});
    const u = Object.assign(io(s2, ['yes']), {alive: () => false});
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    assert.ok(!fs.existsSync(s2.home), 'the aside went too');
  } finally {
    s2.done();
  }
});

test('A9: a daemon whose socket proves the secret serves, its pid dead or not: refused, with no removal advice', async () => {
  const {fakeRuntime, socketIn} = require('./daemon-fakes');
  const s = setup();
  let rt = null;
  try {
    plantDaemon(s.home, {secret: false});
    const before = listing(s.home);
    const sock = socketIn(runDaemon(s.home));
    rt = await fakeRuntime(runDaemon(s.home), sock);
    fs.writeFileSync(path.join(runDaemon(s.home), 'daemon.json'), JSON.stringify({pid: 4242, socket: sock, started: new Date().toISOString()}), {mode: 0o600});
    const u = Object.assign(io(s, ['yes']), {alive: () => false});
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, SERVING);
    assert.doesNotMatch(u.err, /remove /);
    untouched(s.home, before);
  } finally {
    if (rt != null) await rt.close();
    s.done();
  }
});

test('A9: a daemon.json that can\'t be read (0644) refuses, with the 10-minutes way out', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const s = setup();
  try {
    plantDaemon(s.home);
    fs.chmodSync(path.join(runDaemon(s.home), 'daemon.json'), 0o644);
    const before = listing(s.home);
    const u = Object.assign(io(s, ['yes']), {alive: () => false});
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, /daemon\.json can't be read: if it still can't be read 10 minutes after the last client closed, remove it and run it again\.$/m);
    untouched(s.home, before);
  } finally {
    s.done();
  }
});

test('A9: a start.lock no one here can judge (empty, as a power loss can leave one) names the way out at the bound', async () => {
  const s = setup();
  try {
    fs.mkdirSync(runDaemon(s.home), {recursive: true, mode: 0o700});
    fs.chmodSync(path.join(s.home, 'run'), 0o700);
    fs.writeFileSync(path.join(runDaemon(s.home), 'start.lock'), '');
    const before = listing(s.home);
    const u = Object.assign(io(s, ['yes']), {alive: () => false, uninstallLockMs: 300});
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, /has been starting or restarting for 0\.3 s; nothing was removed\. Run `[^`]+uninstall` again in a minute, or remove .*start\.lock if nothing is running there\./);
    untouched(s.home, before);
  } finally {
    s.done();
  }
});

test('A9: the packs.lock bound elapsing while the removal runs is never said as "nothing was removed"', async (t) => {
  const s = setup();
  try {
    const st = require('../lib/credential-store');
    const real = st.withStoreLock;
    t.mock.method(st, 'withStoreLock', async (...a) => { await new Promise((r) => setTimeout(r, 400)); return real(...a); });
    const realRm = fs.rmSync;
    t.mock.method(fs, 'rmSync', (p, o) => { if (String(p) === path.join(s.home, 'node')) throw Object.assign(new Error('busy'), {code: 'EBUSY'}); return realRm(p, o); });
    const u = Object.assign(io(s, ['yes']), {alive: () => false, uninstallLockMs: 200});
    assert.strictEqual(await uninstall({}, u), 1);
    assert.match(u.err, /node could not be removed \(EBUSY\)/);
    assert.doesNotMatch(u.err, /another ch-local was still changing this home/);
  } finally {
    t.mock.restoreAll();
    s.done();
  }
});
