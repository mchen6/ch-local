'use strict';
require('./tmp-dirs');
// The stored credentials' lock (post-rel cred-race): every change to the
// store (credentials add, credentials remove, uninstall's removal) is made
// under <home>/credentials.lock, lib/lock.js's protocol with its started
// and ageOtherHosts options. Two changes made at once both land; a removed
// key never comes back; an add beside an uninstall either lands first and is
// removed, or finds nothing installed and stores nothing; a held lock is
// said and nothing is changed; a holder whose lock was taken over writes
// nothing. Values are made here, never literals.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {fakeIo, tmp} = require('./fake-io');
const store = require('../lib/credential-store');
const lock = require('../lib/lock');
const {credentials} = require('../lib/credentials-command');

const POSIX = {skip: process.platform === 'win32' && 'POSIX modes'};
const made = () => `t${crypto.randomBytes(12).toString('hex')}`;
const ACCESS = '@countinghouse/ch-access-github';
const VAR = 'COUNTINGHOUSE_GITHUB_TOKEN';
const ORIGIN = 'https://api.githubcopilot.com';
const OTHER = '@countinghouse/ch-other-step';
const OTHER_ORIGIN = 'https://other.example.invalid';

// an installed home: the access module and OTHER, each declaring one
// credential
function home() {
  const h = tmp('ch-credlock-');
  fs.chmodSync(h, 0o700);
  const {storeModule, writeHome} = require('./store-helpers');
  const pkgs = {
    '@countinghouse/ch-pack-ci-failure-triage': {role: 'scenario'},
    [ACCESS]: {role: 'part', remotes: [{name: 'github', url: `${ORIGIN}/mcp/`, credential: VAR}]},
    [OTHER]: {role: 'part', remotes: [{name: 'other', url: `${OTHER_ORIGIN}/mcp/`, credential: 'OTHER_TOKEN'}]},
  };
  for (const [name, countinghouse] of Object.entries(pkgs)) storeModule(h, name, '1.0.0', {countinghouse});
  writeHome(h, {'ci-failure-triage': Object.fromEntries(Object.keys(pkgs).map((n) => [n, '1.0.0']))});
  return h;
}
const io = (h, extra = {}) => Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h}, homedir: '/nowhere'}),
  {terminal: false, stdinIsTTY: false, pid: 4242, hostname: 'box-1'}, extra);
const valueOf = (h, m, v) => {
  const vars = store.readStore(h).modules.get(m);
  const b = vars != null ? vars.get(v) : null;
  return b != null ? b.value || b.source : null;
};
// an add on standard input, in this process
const add = (h, module, value, to, extra = {}) => credentials({action: 'add', name: module, to, restart: false}, io(h, {readStdin: async() => value, ...extra}));
const lockFile = (h) => path.join(h, store.LOCK);
const writeLock = (h, holder, ageMs = 0) => {
  fs.writeFileSync(lockFile(h), `${JSON.stringify(holder)}\n`);
  if (ageMs > 0) { const t = new Date(Date.now() - ageMs); fs.utimesSync(lockFile(h), t, t); }
};

// a change in a process of its own (test/cred-race-child.js); -> {done:
// Promise<{code, err}>, ready: a promise that its pause has begun}
function child(args) {
  const ready = path.join(tmp('ch-credlock-ready-'), 'ready');
  const p = spawn(process.execPath, [path.join(__dirname, 'cred-race-child.js'), JSON.stringify({...args, ready})], {stdio: ['ignore', 'pipe', 'pipe']});
  let err = '';
  p.stderr.on('data', (d) => { err += d; });
  p.stdout.on('data', () => {});
  const done = new Promise((resolve) => p.on('close', (code) => resolve({code, err})));
  const readyP = (async() => {
    const until = Date.now() + 20000;
    while (!fs.existsSync(ready) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    if (!fs.existsSync(ready)) throw new Error(`the child never paused: ${err}`);
  })();
  return {done, ready: readyP};
}

test('two adds at once, for two modules: both are stored (on main one was lost: each wrote the store it read before the other wrote)', POSIX, async () => {
  const h = home();
  const a = made();
  const b = made();
  // the first pauses between its read and its write; the second runs meanwhile
  const first = child({op: 'add', home: h, user: tmp('ch-credlock-user-'), name: 'ch-access-github', value: a, to: ORIGIN, slowMs: 1500});
  await first.ready;
  const second = await add(h, 'ch-other-step', b, OTHER_ORIGIN);
  const r = await first.done;
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(second, 0);
  assert.strictEqual(valueOf(h, ACCESS, VAR), a);
  assert.strictEqual(valueOf(h, OTHER, 'OTHER_TOKEN'), b);
  assert.ok(!fs.existsSync(lockFile(h)), 'the lock released');
});

test('a remove beside an add: the removed key never comes back (on main the add wrote back the store it read before the remove)', POSIX, async () => {
  const h = home();
  const kept = made();
  const {FIXTURE_HELD} = require('./store-helpers');
  store.bind(h, ACCESS, VAR, {origin: ORIGIN, source: 'stored', value: made()}, {held: FIXTURE_HELD});
  store.bind(h, OTHER, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value: made()}, {held: FIXTURE_HELD});
  // the add (a rotated key for OTHER) pauses between its read and its write;
  // the remove of the access module's key runs meanwhile
  const adding = child({op: 'add', home: h, user: tmp('ch-credlock-user-'), name: 'ch-other-step', value: kept, to: OTHER_ORIGIN, slowMs: 1500});
  await adding.ready;
  const removed = await credentials({action: 'remove', name: 'ch-access-github', restart: false}, io(h));
  const r = await adding.done;
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(removed, 0);
  assert.strictEqual(valueOf(h, ACCESS, VAR), null, 'the removed key stays removed');
  assert.strictEqual(valueOf(h, OTHER, 'OTHER_TOKEN'), kept);
});

test('a remove of the last key beside an add: the add\'s key is kept (on main the remove deleted the file the add had just written)', POSIX, async () => {
  const h = home();
  const kept = made();
  store.bind(h, ACCESS, VAR, {origin: ORIGIN, source: 'stored', value: made()}, {held: require('./store-helpers').FIXTURE_HELD});
  // the remove (the store's one key: it removes the file) pauses before it
  // does; the add of OTHER's key runs meanwhile
  const removing = child({op: 'remove', home: h, user: tmp('ch-credlock-user-'), name: 'ch-access-github', slowMs: 1500});
  await removing.ready;
  const added = await add(h, 'ch-other-step', kept, OTHER_ORIGIN);
  const r = await removing.done;
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(added, 0);
  assert.strictEqual(valueOf(h, ACCESS, VAR), null);
  assert.strictEqual(valueOf(h, OTHER, 'OTHER_TOKEN'), kept, 'the add\'s key kept');
});

test('an add, then an uninstall --keep-data beside it: the uninstall waits, removes the key, and names it (on main the add recreated the store after the uninstall)', POSIX, async () => {
  const h = home();
  const user = tmp('ch-credlock-user-');
  const adding = child({op: 'add', home: h, user, name: 'ch-other-step', value: made(), to: OTHER_ORIGIN, slowMs: 1500});
  await adding.ready;
  const u = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h}, homedir: user, answers: ['yes']}), {pid: 4243, hostname: 'box-1'});
  const code = await require('../lib/uninstall').uninstall({keepData: true}, u);
  const r = await adding.done;
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(code, 0, u.err);
  assert.ok(!fs.existsSync(path.join(h, 'credentials')), 'no store left after the uninstall');
  assert.match(u.out, /Revoke the credentials you gave it: .*OTHER_TOKEN/);
});

test('an uninstall, then an add beside it: the add waits, finds nothing installed, and stores nothing', POSIX, async () => {
  const h = home();
  const user = tmp('ch-credlock-user-');
  const removing = child({op: 'uninstall', home: h, user, keepData: true, slowMs: 1500});
  await removing.ready;
  const f = io(h, {readStdin: async() => made()});
  const code = await credentials({action: 'add', name: 'ch-other-step', to: OTHER_ORIGIN, restart: false}, f);
  const r = await removing.done;
  assert.strictEqual(r.code, 0, r.err);
  assert.notStrictEqual(code, 0);
  assert.match(f.err, /no longer installed|nothing is installed/);
  assert.ok(!fs.existsSync(path.join(h, 'credentials')), 'no store made');
});

test('a live holder: said with its command, exit 1, nothing changed; never taken, however old its heartbeat on this host is not', async () => {
  const h = home();
  writeLock(h, {pid: process.pid, host: lock.lockHost(), at: 'x', started: lock.processStarted(process.pid), doing: 'ch-local credentials remove'});
  const f = io(h, {readStdin: async() => made(), credentialsLockWaitMs: 300});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-other-step', to: OTHER_ORIGIN, restart: false}, f), 1);
  assert.match(f.err, new RegExp(`another ch-local \\(pid ${process.pid}, \`ch-local credentials remove\`\\) is changing the stored credentials; nothing was changed\\. Try again when it is done\\.\\n`));
  // said at once that it waits, never a silent wait (the medium, 6)
  assert.match(f.err, /^ch-local: waiting for another ch-local \(pid \d+\) to finish changing the stored credentials\n/);
  assert.strictEqual(valueOf(h, OTHER, 'OTHER_TOKEN'), null);
  assert.ok(fs.existsSync(lockFile(h)), 'the holder\'s lock left as it was');
});

test('a dead holder\'s lock is cleared and the change goes on', async () => {
  const h = home();
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => dead.on('close', r));
  writeLock(h, {pid: dead.pid, host: lock.lockHost(), at: 'x'});
  const value = made();
  assert.strictEqual(await add(h, 'ch-other-step', value, OTHER_ORIGIN), 0);
  assert.strictEqual(valueOf(h, OTHER, 'OTHER_TOKEN'), value);
});

test('a reused PID (alive, another start time) holds the store\'s lock no longer, nor packs.lock', {skip: process.platform !== 'linux' && 'start times are read on Linux'}, async () => {
  const h = home();
  const holder = {pid: process.pid, host: lock.lockHost(), at: 'x', started: '1'};
  writeLock(h, holder);
  const value = made();
  assert.strictEqual(await add(h, 'ch-other-step', value, OTHER_ORIGIN), 0);
  assert.strictEqual(valueOf(h, OTHER, 'OTHER_TOKEN'), value);
  // packs.lock is on the same options now (post-rel packs.lock protocol):
  // the reused PID is gone there too
  fs.writeFileSync(path.join(h, 'packs.lock'), JSON.stringify(holder));
  const f = io(h);
  assert.strictEqual(await lock.withLock({home: h}, f, async() => 0), 0, f.err);
});

test('another host\'s lock is never cleared by its age: named, with the file to remove if nothing runs there', async () => {
  const h = home();
  writeLock(h, {pid: 1, host: 'elsewhere', at: 'x', doing: 'ch-local credentials add'}, 60 * 60 * 1000);
  const f = io(h, {readStdin: async() => made(), credentialsLockWaitMs: 300});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-other-step', to: OTHER_ORIGIN, restart: false}, f), 1);
  assert.ok(f.err.includes(`another ch-local (pid 1 on elsewhere, \`ch-local credentials add\`) is changing the stored credentials; nothing was changed. Try again when it is done, or remove ${lockFile(h)} if nothing is running on elsewhere.`), f.err);
  assert.strictEqual(valueOf(h, OTHER, 'OTHER_TOKEN'), null);
});

test('no home: the lock\'s function never runs unlocked, and no lock or home is made', async () => {
  const h = path.join(tmp('ch-credlock-'), 'absent');
  let ran = false;
  await assert.rejects(store.withStoreLock(h, io(h), 'test', async() => { ran = true; return 0; }), /nothing is installed/);
  assert.strictEqual(ran, false);
  assert.ok(!fs.existsSync(h));
  assert.strictEqual(await store.withStoreLock(h, io(h), 'test', async() => { ran = true; return 0; }, {missing: () => 7}), 7);
  assert.strictEqual(ran, false);
});

test('an uninstall whose store lock can\'t be made, or is held, says so and removes nothing, never an unhandled error', async () => {
  const uninstall = (h, extra = {}) => {
    const u = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h}, homedir: tmp('ch-credlock-user-'), answers: ['yes']}), {pid: 4244, hostname: 'box-1'}, extra);
    return require('../lib/uninstall').uninstall({}, u).then((code) => ({code, u}));
  };
  // can't be made (packs.lock can: the store's own lock fails, as a full
  // disk or a link refused would make it)
  const h = home();
  const real = store.withStoreLock;
  store.withStoreLock = async() => { throw new store.StoreProblem(`${lockFile(h)} could not be made (EACCES); nothing was changed`, 'CREDENTIALS_WRITE'); };
  let r;
  try { r = await uninstall(h); } finally { store.withStoreLock = real; }
  assert.strictEqual(r.code, 1);
  assert.match(r.u.err, /credentials\.lock could not be made \(EACCES\); nothing was removed\n/);
  assert.ok(fs.existsSync(path.join(h, 'modules.json')), 'the record kept');
  // held by a live ch-local
  const k = home();
  writeLock(k, {pid: process.pid, host: lock.lockHost(), at: 'x', started: lock.processStarted(process.pid), doing: 'ch-local credentials add'});
  const held = await uninstall(k, {credentialsLockWaitMs: 300});
  assert.strictEqual(held.code, 1);
  assert.match(held.u.out, /nothing was removed/);
  assert.match(held.u.err, /`ch-local credentials add`\) is changing the stored credentials/);
  assert.ok(fs.existsSync(path.join(k, 'modules.json')), 'the record kept');
});

test('bind and unbind without the lock\'s held are refused, nothing written', () => {
  const h = home();
  assert.throws(() => store.bind(h, OTHER, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value: made()}), (e) => e.code === 'CREDENTIALS_LOCK');
  assert.throws(() => store.unbind(h, OTHER), (e) => e.code === 'CREDENTIALS_LOCK');
  assert.ok(!fs.existsSync(path.join(h, 'credentials')));
});

// The one case STALE_MS can't prevent (the reviewer on the design): a holder
// stopped past it (SIGSTOP, a suspended laptop) has its lock cleared and
// another enters. The first's write is then refused just before its rename.
test('a holder whose lock was taken over before its rename writes nothing, says so, and the other holder\'s change stands', POSIX, async () => {
  const h = home();
  const theirs = made();
  const ownFile = require('../lib/own-file');
  const write = ownFile.writeOwnFile;
  let tookOver = false;
  ownFile.writeOwnFile = (file, data, opts) => {
    if (!tookOver && file.endsWith('credentials.json')) {
      tookOver = true;
      // between this holder's read and its rename: its lock cleared as
      // stale, and another ch-local in it, storing its own change
      fs.rmSync(lockFile(h), {force: true});
      writeLock(h, {pid: 99999, host: lock.lockHost(), at: 'y'});
      write(file, `${JSON.stringify({v: 2, modules: {[OTHER]: {OTHER_TOKEN: {origin: OTHER_ORIGIN, source: 'stored', value: theirs}}}}, null, 2)}\n`);
    }
    return write(file, data, opts);
  };
  let f;
  try {
    f = io(h, {readStdin: async() => made()});
    assert.strictEqual(await credentials({action: 'add', name: 'ch-access-github', to: ORIGIN, restart: false}, f), 1);
  } finally {
    ownFile.writeOwnFile = write;
  }
  assert.match(f.err, /another ch-local took over the stored credentials' lock while this change was being made\. Nothing was changed\./);
  assert.strictEqual(valueOf(h, ACCESS, VAR), null, 'nothing of this holder\'s written');
  assert.strictEqual(valueOf(h, OTHER, 'OTHER_TOKEN'), theirs, 'the other holder\'s change intact');
  assert.ok(fs.existsSync(lockFile(h)), 'the other holder\'s lock is never removed by this one');
});

test('Windows (win-acl stubbed): a lock taken over before the rename leaves the file as it was', async () => {
  const h = home();
  const me = 'S-1-5-21-1-2-3-1001';
  const mine = {owner: me, user: me, otherAces: false, rules: [{sid: me, type: 'Allow', rights: 2032127}, {sid: 'S-1-5-18', type: 'Allow', rights: 2032127}]};
  const {privateProblem} = require('../lib/win-acl');
  const acl = {privateProblem, fileAcl: () => mine, makePrivateDirs: (dirs) => dirs.map(() => mine), createPrivate: (file, data) => fs.writeFileSync(file, data, {flag: 'wx'})};
  const lost = () => { throw Object.assign(new Error('gone'), {code: 'LOCK_LOST'}); };
  // lost from the start: nothing made, the directory included
  assert.throws(() => store.bind(h, OTHER, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value: made()}, {platform: 'win32', acl, held: store.testOnlyHeld(lost)}),
    (e) => e.code === 'CREDENTIALS_LOCK');
  assert.ok(!fs.existsSync(path.join(h, 'credentials')));
  // lost after the directory is made, before the rename: the file as it was
  // (none), no temporary file left
  let checks = 0;
  const later = store.testOnlyHeld(() => { checks += 1; if (checks > 1) lost(); });
  assert.throws(() => store.bind(h, OTHER, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value: made()}, {platform: 'win32', acl, held: later}),
    (e) => e.code === 'CREDENTIALS_LOCK');
  assert.strictEqual(checks, 2, 'checked before the directory and before the rename');
  assert.ok(!fs.existsSync(path.join(h, 'credentials', 'credentials.json')));
  assert.deepStrictEqual(fs.readdirSync(path.join(h, 'credentials')).filter((n) => n.endsWith('.tmp')), [], 'no temporary file left');
});

// the reviewer's high on #102, 7: held is branded (minted by withStoreLock
// into the store's own WeakSet); the test-only factory's name is nowhere
// else under lib/ or bin/, however a module imports the store
test('held is branded: a look-alike is refused; the test-only factory and the fixtures\' held are nowhere in lib/ or bin/ but its definition', () => {
  const h = home();
  assert.throws(() => store.bind(h, OTHER, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value: made()}, {held: {check() {}}}), (e) => e.code === 'CREDENTIALS_LOCK');
  assert.throws(() => store.unbind(h, OTHER, {held: Object.freeze({check() {}})}), (e) => e.code === 'CREDENTIALS_LOCK');
  assert.ok(!fs.existsSync(path.join(h, 'credentials')));
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(c|m)?js$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(root, 'lib'));
  walk(path.join(root, 'bin'));
  const using = files.filter((f) => /testOnlyHeld|FIXTURE_HELD/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f).split(path.sep).join('/'));
  assert.deepStrictEqual(using, ['lib/credential-store.js']);
  const text = fs.readFileSync(path.join(root, 'lib', 'credential-store.js'), 'utf8');
  assert.ok(!/FIXTURE_HELD/.test(text));
  // defined there, and nothing in the store calls it
  assert.match(text, /^function testOnlyHeld\(/m);
  assert.ok(!/\btestOnlyHeld\s*\(/.test(text.replace(/^function testOnlyHeld\(.*$/m, '')), 'never called in the store, with or without arguments');
});

// the reviewer's high on #102, 1: with no home, remove never shows back its
// argument (it may be a pasted key)
test('remove with no home: refused, the argument never shown back', async () => {
  const h = path.join(tmp('ch-credlock-'), 'absent');
  const pasted = made();
  const f = io(h);
  assert.strictEqual(await credentials({action: 'remove', name: pasted, restart: false}, f), 2);
  assert.ok(!f.out.includes(pasted) && !f.err.includes(pasted), 'never echoed');
  assert.match(f.err, /that is not an installed module that declares a credential/);
  const g = io(h);
  assert.strictEqual(await credentials({action: 'remove', restart: false}, g), 2);
  assert.ok(!/undefined/.test(g.out + g.err));
});

// the reviewer's high on #102, 4: a holder whose lock was taken over never
// recreates credentials/ (an uninstall removed it meanwhile)
test('a taken-over holder makes no credentials directory', () => {
  const h = home();
  const lost = store.testOnlyHeld(() => { throw Object.assign(new Error('gone'), {code: 'LOCK_LOST'}); });
  assert.throws(() => store.bind(h, OTHER, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value: made()}, {held: lost}), (e) => e.code === 'CREDENTIALS_LOCK');
  assert.ok(!fs.existsSync(path.join(h, 'credentials')), 'no credentials/ made');
});

// the reviewer's high on #102, 2 and 3: uninstall's store section removes
// the keys first; one that can't be removed leaves the record and says so;
// a home a waiter's lock keeps is said as left, never an unhandled error
test('uninstall: a store that can\'t be removed leaves the record and says so, exit 1; a home kept by a waiter is said as left', async () => {
  const uninstall = (h) => {
    const u = Object.assign(fakeIo({env: {COUNTINGHOUSE_HOME: h}, homedir: tmp('ch-credlock-user-'), answers: ['yes']}), {pid: 4245, hostname: 'box-1'});
    return require('../lib/uninstall').uninstall({}, u).then((code) => ({code, u}));
  };
  const h = home();
  const value = made();
  assert.strictEqual(await add(h, 'ch-other-step', value, OTHER_ORIGIN), 0);
  const rmSync = fs.rmSync;
  fs.rmSync = function(p, ...rest) {
    if (path.basename(String(p)) === 'credentials') throw Object.assign(new Error('busy'), {code: 'EBUSY'});
    return rmSync.call(this, p, ...rest);
  };
  let r;
  try { r = await uninstall(h); } finally { fs.rmSync = rmSync; }
  assert.strictEqual(r.code, 1);
  assert.match(r.u.err, /the stored credentials could not be removed \(EBUSY\)\. Close what has .* open and run `npx @countinghouse\/ch-local uninstall` again; meanwhile revoke the credentials you gave it: .*OTHER_TOKEN/);
  assert.ok(!/nothing was removed/.test(r.u.out), 'said once');
  assert.ok(fs.existsSync(path.join(h, 'modules.json')), 'the record left, so it can be run again');
  assert.strictEqual(valueOf(h, OTHER, 'OTHER_TOKEN'), value);
  assert.strictEqual((await uninstall(h)).code, 0, 'run again: done');

  // (the medium on round 1, 1) the record failing after the keys went: said
  // with the keys to revoke, exit 1, never an unhandled error
  const j = home();
  assert.strictEqual(await add(j, 'ch-other-step', made(), OTHER_ORIGIN), 0);
  fs.rmSync = function(p, ...rest) {
    if (path.basename(String(p)) === 'modules.json') throw Object.assign(new Error('perm'), {code: 'EPERM'});
    return rmSync.call(this, p, ...rest);
  };
  let rec;
  try { rec = await uninstall(j); } finally { fs.rmSync = rmSync; }
  assert.strictEqual(rec.code, 1);
  assert.match(rec.u.err, /the record \(the stored credentials are removed\) could not be removed \(EPERM\)\..*revoke the credentials you gave it: .*OTHER_TOKEN/);
  assert.ok(!fs.existsSync(path.join(j, 'credentials')));

  const k = home();
  const rmdirSync = fs.rmdirSync;
  fs.rmdirSync = function(p, ...rest) {
    if (String(p) === k) throw Object.assign(new Error('not empty'), {code: 'ENOTEMPTY'});
    return rmdirSync.call(this, p, ...rest);
  };
  let left;
  try { left = await uninstall(k); } finally { fs.rmdirSync = rmdirSync; }
  assert.strictEqual(left.code, 0, left.u.err);
  assert.match(left.u.out, /itself could not be removed \(ENOTEMPTY\) and is left/);
  assert.match(left.u.out, /Revoke the credentials you gave it: /);
});

// the reviewer's high on #102's round 1, 3: another host's lock is waited
// out to the cap whatever its mtime says (that host's clock), then said with
// the file to remove; never refused at once
test('another host\'s lock, however old its mtime, is waited out to the cap, then said with the file to remove', async () => {
  const h = home();
  writeLock(h, {pid: 1, host: 'elsewhere', at: 'x'}, 60 * 60 * 1000);
  const f = io(h, {readStdin: async() => made(), credentialsLockWaitMs: 400});
  const t0 = Date.now();
  assert.strictEqual(await credentials({action: 'add', name: 'ch-other-step', to: OTHER_ORIGIN, restart: false}, f), 1);
  assert.ok(Date.now() - t0 >= 350, `waited to the cap (${Date.now() - t0} ms)`);
  assert.match(f.err, /or remove .*credentials\.lock if nothing is running on elsewhere\./);
});

// the reviewer's high on #102's round 1, 2: a dead holder whose clearing is
// held up (a young .break, another waiter mid-clear) is waited for, never
// refused at once naming the dead pid
test('a dead holder whose lock can\'t be cleared yet is waited for, and the change goes on once it can', async () => {
  const h = home();
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => dead.on('close', r));
  // (a fresh heartbeat: gone by its dead pid alone, never by its age; a
  // cap of a few seconds, so a lost timer fails fast: the medium, 5)
  writeLock(h, {pid: dead.pid, host: lock.lockHost(), at: 'x'});
  fs.writeFileSync(`${lockFile(h)}.break`, '1');
  setTimeout(() => fs.rmSync(`${lockFile(h)}.break`, {force: true}), 400);
  const value = made();
  const f = io(h, {readStdin: async() => value, credentialsLockWaitMs: 5000});
  assert.strictEqual(await credentials({action: 'add', name: 'ch-other-step', to: OTHER_ORIGIN, restart: false}, f), 0, f.err);
  assert.strictEqual(valueOf(h, OTHER, 'OTHER_TOKEN'), value);
});

// the reviewer's high on #102's round 1, 1: a held is for its own home
test('a held from one home\'s lock writes no other home', async () => {
  const a = home();
  const b = home();
  const code = await store.withStoreLock(a, io(a), 'test', async(held) => {
    assert.throws(() => store.bind(b, OTHER, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value: made()}, {held}), (e) => e.code === 'CREDENTIALS_LOCK');
    assert.throws(() => store.unbind(b, OTHER, {held}), (e) => e.code === 'CREDENTIALS_LOCK');
    store.bind(a, OTHER, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value: made()}, {held});
    return 0;
  });
  assert.strictEqual(code, 0);
  assert.ok(!fs.existsSync(path.join(b, 'credentials')));
  assert.notStrictEqual(valueOf(a, OTHER, 'OTHER_TOKEN'), null);
});

// the medium on #102's round 1, 1, 4 and 6: the home by its real path
test('a held is for its home\'s real lock file: another spelling of it is taken; a link re-pointed to another home is refused, there and in uninstall\'s check', POSIX, async () => {
  const a = home();
  const b = home();
  const alias = path.join(tmp('ch-credlock-alias-'), 'home');
  fs.symlinkSync(a, alias);
  const code = await store.withStoreLock(a, io(a), 'test', async(held) => {
    // the same home, spelled through a link: taken
    store.bind(alias, OTHER, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value: made()}, {held});
    // the link re-pointed to b: refused, nothing written there
    fs.rmSync(alias);
    fs.symlinkSync(b, alias);
    assert.throws(() => store.bind(alias, OTHER, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value: made()}, {held}), (e) => e.code === 'CREDENTIALS_LOCK');
    assert.throws(() => store.checkHeld(held, b), (e) => e.code === 'CREDENTIALS_LOCK');
    store.checkHeld(held, a);
    return 0;
  });
  assert.strictEqual(code, 0);
  assert.notStrictEqual(valueOf(a, OTHER, 'OTHER_TOKEN'), null);
  assert.ok(!fs.existsSync(path.join(b, 'credentials')));
});

