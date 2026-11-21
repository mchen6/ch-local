'use strict';
require('./tmp-dirs');
// ch-local dev-server (A-ownuse): the home's own runtime as a local
// development server for the user's own tools: 127.0.0.1, a fixed port, the
// authoring tools behind an admin key made once and kept (made anew with
// --new-key), never printed, the packs' short environment, nothing of the
// pack install.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const {devServer, linesFor, quotable} = require('../lib/dev-server');

const POSIX = {skip: process.platform === 'win32' && 'POSIX modes'};

function home({runtime = true} = {}) {
  const h = tmp('ch-dev-');
  if (runtime) {
    const app = path.join(h, 'app', 'node_modules', 'countinghouse');
    fs.mkdirSync(app, {recursive: true});
    fs.writeFileSync(path.join(app, 'framework.js'), '');
  }
  return h;
}
function io(h, {free = true, env = {}, up = 'up'} = {}) {
  const f = fakeIo({env: {...env, COUNTINGHOUSE_HOME: h}});
  f.spawned = [];
  f.portFree = async () => free;
  // (the runtime up, or not: the real one is started in the smoke test)
  f.untilUp = async () => up;
  f.trapSignals = (fn) => { f.signal = fn; return () => {}; };
  f.killed = [];
  // (what dev-auth/ holds while the runtime runs: the key ends with it)
  const authFile = (n) => { try { return fs.readFileSync(path.join(h, 'dev-auth', n), 'utf8'); } catch (e) { return null; } };
  f.spawn = (cmd, args, {env: childEnv, control} = {}) => {
    // (a new key is admin-key.new until the runtime is up)
    f.spawned.push({cmd, args, env: childEnv, control, key: authFile('admin-key.new') || authFile('admin-key'), keptAt: authFile('admin-key'), auth: authFile('auth.json')});
    return {pid: 4321, kill: (sig) => f.killed.push(sig), exited: f.exited || Promise.resolve(0)};
  };
  return f;
}
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

test('nothing installed: refused, naming install; a port in use or not a port: refused, naming --port; nothing started', async () => {
  const none = io(home({runtime: false}));
  assert.strictEqual(await devServer({}, none), 1);
  assert.match(none.err, /countinghouse is not installed in .*: install a pack first \(ch-local install\)/);
  const busy = io(home(), {free: false});
  assert.strictEqual(await devServer({}, busy), 2);
  assert.match(busy.err, /port 7531 on 127\.0\.0\.1 is in use: choose another with --port <n> --new-key/);
  const bad = io(home());
  assert.strictEqual(await devServer({port: 70000}, bad), 2);
  assert.deepStrictEqual([...none.spawned, ...busy.spawned, ...bad.spawned], []);
});

test('the home\'s runtime on 127.0.0.1, its port, the local store, the authoring tools behind the file\'s admin key, the user\'s modules', async () => {
  const h = home();
  const f = io(h, {env: {GITHUB_TOKEN: 'from-the-shell', PATH: '/usr/bin'}});
  assert.strictEqual(await devServer({port: 7600}, f), 0, f.err);
  const [{cmd, args, env, control}] = f.spawned;
  assert.strictEqual(cmd, f.node);
  // the home's framework.js, as start.js runs it, through the entry that ends
  // it with dev-server (an IPC channel: control); every path under <home>/dev
  // (the reviewer's high on ch-local#108, 1, 3 and 6)
  assert.deepStrictEqual(args.slice(0, 2), [path.join(__dirname, '..', 'lib', 'dev-runtime.js'), path.join(h, 'app', 'node_modules', 'countinghouse', 'framework.js')]);
  assert.deepStrictEqual(args.slice(2), ['--bindAddr', '127.0.0.1', '--port', '7600', '--store', 'local', '--storePath', path.join(h, 'dev', 'store'),
    '--modulePath', path.join(h, 'dev', 'modules'), '--moduleDataPath', path.join(h, 'dev', 'module_data'),
    '--authProvider', 'file', '--authConfigPath', path.join(h, 'dev-auth', 'auth.json'), '--authoringTools', '--workerThread']);
  assert.strictEqual(control, true);
  assert.strictEqual(f.spawned[0].keptAt, null, 'a new key is kept only once the runtime is up');
  assert.strictEqual(env.GITHUB_TOKEN, undefined, 'the packs\' short environment: no client credential');
  assert.strictEqual(env.PATH, '/usr/bin');
  const {key} = f.spawned[0];
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.deepStrictEqual(JSON.parse(f.spawned[0].auth), {[key]: {userName: 'dev', devices: ['*'], admin: true}});
  assert.ok(!(f.out + f.err).includes(key), 'the key is never printed');
  const lines = (fresh) => linesFor({port: 7600, keyFile: path.join(h, 'dev-auth', 'admin-key'), modules: path.join(h, 'dev', 'modules'), platform: process.platform, fresh});
  assert.deepStrictEqual(f.out.trimEnd().split('\n'), lines(true), 'a new key: the lines to add it');
  // a stable key (Matt, 11-20): kept across starts, the entry from before
  // still works; --new-key replaces it and says how to add it again
  assert.strictEqual(fs.readFileSync(path.join(h, 'dev-auth', 'admin-key'), 'utf8'), key, 'kept on stop');
  const again = io(h);
  assert.strictEqual(await devServer({port: 7600}, again), 0);
  assert.strictEqual(again.spawned[0].key, key, 'the same key');
  assert.deepStrictEqual(again.out.trimEnd().split('\n'), lines(false));
  const rotated = io(h);
  assert.strictEqual(await devServer({port: 7600, newKey: true}, rotated), 0);
  assert.match(rotated.spawned[0].key, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(rotated.spawned[0].key, key, '--new-key: a new key');
  assert.deepStrictEqual(rotated.out.trimEnd().split('\n'), lines(true));
  assert.ok(!(again.out + again.err + rotated.out + rotated.err).includes(rotated.spawned[0].key) && !(again.out + rotated.out).includes(key), 'never printed');
  // a kept key serves the port its entry was added for: another needs
  // --new-key (the medium on the stable key, 1)
  const moved = io(h);
  assert.strictEqual(await devServer({port: 7601}, moved), 2);
  assert.match(moved.err, /entry was added for port 7600: start with --port 7601 --new-key to add it again for this one/);
  assert.deepStrictEqual(moved.spawned, []);
  const movedNew = io(h);
  assert.strictEqual(await devServer({port: 7601, newKey: true}, movedNew), 0);
  assert.strictEqual(fs.readFileSync(path.join(h, 'dev-auth', 'port'), 'utf8'), '7601\n');
  assert.strictEqual(await devServer({port: 7601}, io(h)), 0, 'the new port, kept');
});

// a kept key is used only if it is still one this command made, private
test('a kept key open to others, a link, or not a key: refused, naming --new-key; nothing started', POSIX, async () => {
  const loose = home();
  assert.strictEqual(await devServer({}, io(loose)), 0);
  fs.chmodSync(path.join(loose, 'dev-auth', 'admin-key'), 0o644);
  const l = io(loose);
  assert.strictEqual(await devServer({}, l), 1);
  assert.match(l.err, /admin-key: its mode is 0644, not 0600: start with --new-key to replace it/);
  const linked = home();
  assert.strictEqual(await devServer({}, io(linked)), 0);
  const elsewhere = path.join(linked, 'elsewhere-key');
  fs.writeFileSync(elsewhere, 'a'.repeat(64), {mode: 0o600});
  fs.rmSync(path.join(linked, 'dev-auth', 'admin-key'));
  fs.symlinkSync(elsewhere, path.join(linked, 'dev-auth', 'admin-key'));
  const k = io(linked);
  assert.strictEqual(await devServer({}, k), 1);
  assert.match(k.err, /admin-key: it is not a regular file: start with --new-key to replace it/);
  const junk = home();
  assert.strictEqual(await devServer({}, io(junk)), 0);
  fs.writeFileSync(path.join(junk, 'dev-auth', 'admin-key'), 'not-a-key', {mode: 0o600});
  const j = io(junk);
  assert.strictEqual(await devServer({}, j), 1);
  assert.match(j.err, /is not a key this command made: start with --new-key/);
  assert.deepStrictEqual([...l.spawned, ...k.spawned, ...j.spawned], []);
  // --new-key replaces any of them
  const fixed = io(loose);
  assert.strictEqual(await devServer({newKey: true}, fixed), 0, fixed.err);
  assert.strictEqual(fs.statSync(path.join(loose, 'dev-auth', 'admin-key')).mode & 0o777, 0o600);
});

// the A-ownuse medium, 3 and 5: a home the printed line would break on is
// refused; dev-auth/ is this user's own directory, never a link
test('a home a shell would read in the printed line is refused; a dev-auth that is a link, or open to others, is refused; nothing started', POSIX, async () => {
  for (const odd of ['a"b', 'a$b', 'a`b', 'a\\b', 'a\u201cb']) {
    const h = path.join(tmp('ch-dev-odd-'), odd);
    fs.mkdirSync(path.join(h, 'app', 'node_modules', 'countinghouse'), {recursive: true});
    fs.writeFileSync(path.join(h, 'app', 'node_modules', 'countinghouse', 'framework.js'), '');
    const g = io(h);
    assert.strictEqual(await devServer({}, g), 2, JSON.stringify(odd));
    assert.match(g.err, /holds a character a shell would read .*: set COUNTINGHOUSE_HOME to a plain path/);
    assert.deepStrictEqual(g.spawned, []);
  }
  const linked = home();
  fs.mkdirSync(path.join(linked, 'elsewhere'), {mode: 0o700});
  fs.symlinkSync(path.join(linked, 'elsewhere'), path.join(linked, 'dev-auth'));
  const l = io(linked);
  assert.strictEqual(await devServer({}, l), 1);
  assert.match(l.err, /dev-auth is a link/);
  assert.deepStrictEqual(fs.readdirSync(path.join(linked, 'elsewhere')), [], 'no key written through it');
  const open = home();
  fs.mkdirSync(path.join(open, 'dev-auth'), {mode: 0o755});
  fs.chmodSync(path.join(open, 'dev-auth'), 0o755);
  const o = io(open);
  assert.strictEqual(await devServer({}, o), 1);
  assert.match(o.err, /is open to others/);
  assert.deepStrictEqual([...l.spawned, ...o.spawned], []);
});

test('quotable: PowerShell refuses a single or typographic quote; POSIX the runtime\'s rule', () => {
  assert.strictEqual(quotable("C:\\Users\\O'Brien\\x", 'win32'), null);
  assert.strictEqual(quotable('C:\\Users\\m\u2019s\\x', 'win32'), null);
  assert.strictEqual(quotable('C:\\Users\\m\\x', 'win32'), 'C:\\Users\\m\\x');
  assert.strictEqual(quotable('/home/m/x', 'linux'), '/home/m/x');
  assert.strictEqual(quotable('/home/a\\b/x', 'linux'), null);
});

// the A-ownuse medium, 6: Ctrl-C at a terminal already reached the runtime;
// any other signal is passed on, once
test('signals: every one passed on to the runtime, each time', async () => {
  const h = home();
  let end;
  const f = io(h);
  f.exited = new Promise((r) => { end = r; });
  const done = devServer({}, f);
  await new Promise((r) => setImmediate(r));
  f.signal('SIGINT');
  f.signal('SIGTERM');
  f.signal('SIGTERM');
  end(0);
  assert.strictEqual(await done, 0);
  // every signal passed on, each time (round 1, 6)
  assert.deepStrictEqual(f.killed, ['SIGINT', 'SIGTERM', 'SIGTERM']);
});

test('the key and its auth config are private: dev-auth/ 0700, its files 0600', POSIX, async () => {
  const h = home();
  assert.strictEqual(await devServer({}, io(h)), 0);
  assert.strictEqual(fs.statSync(path.join(h, 'dev-auth')).mode & 0o777, 0o700);
  for (const n of ['admin-key', 'auth.json']) assert.strictEqual(fs.statSync(path.join(h, 'dev-auth', n)).mode & 0o777, 0o600, n);
});

test('the lines said: the URL; with a new key the two Claude Code lines (PowerShell on Windows), else the entry from before and --new-key; where it runs only', () => {
  const at = {port: 7531, keyFile: '/h/dev-auth/admin-key', modules: '/h/dev/modules', platform: 'linux'};
  assert.deepStrictEqual(linesFor({...at, fresh: true}), [
    'countinghouse development server: http://127.0.0.1:7531/mcp (stop it with Ctrl-C)',
    'Its key is new: add it to Claude Code, in another terminal:',
    '  claude mcp remove --scope user countinghouse-dev >/dev/null 2>&1',
    '  claude mcp add --scope user --transport http countinghouse-dev http://127.0.0.1:7531/mcp --header "X-CH-Key: $(cat "/h/dev-auth/admin-key")" >/dev/null 2>&1',
    'Keep your tools\' modules in /h/dev/modules, and load them again after each start. They run here only: not inside your installed packs, not upgraded with them, and not published or shared.'
  ]);
  assert.deepStrictEqual(linesFor({...at, fresh: false}), [
    'countinghouse development server: http://127.0.0.1:7531/mcp (stop it with Ctrl-C)',
    'Claude Code\'s countinghouse-dev entry from before still works. To make a new key, start it again with --new-key.',
    'Keep your tools\' modules in /h/dev/modules, and load them again after each start. They run here only: not inside your installed packs, not upgraded with them, and not published or shared.'
  ]);
  const win = linesFor({port: 7531, keyFile: 'C:\\h\\dev-auth\\admin-key', modules: 'C:\\h\\dev\\modules', platform: 'win32', fresh: true});
  assert.match(win[1], /in another terminal \(PowerShell\):$/);
  // (-LiteralPath: [ ] are no wildcards; the add's own output, which repeats
  // the key, sent nowhere: round 1, 2 and 5)
  assert.strictEqual(win[3], '  claude mcp add --scope user --transport http countinghouse-dev http://127.0.0.1:7531/mcp --header "X-CH-Key: $(Get-Content -LiteralPath \'C:\\h\\dev-auth\\admin-key\')" *> $null');
});

// round 1, 1: nothing is kept or said as working until the runtime is up
test('a runtime that ends before it listens: the new key is not kept, nothing is printed; a kept key is not said to work', async () => {
  const h = home();
  const failed = io(h, {up: 'exited'});
  assert.strictEqual(await devServer({}, failed), 1);
  assert.match(failed.err, /the development server ended before it listened/);
  assert.strictEqual(failed.out, '', 'no lines');
  assert.deepStrictEqual(fs.readdirSync(path.join(h, 'dev-auth')).sort(), [], 'no key kept, no port, no auth.json naming it');
  assert.strictEqual(await devServer({}, io(h)), 0);
  const kept = io(h, {up: 'timeout'});
  assert.strictEqual(await devServer({}, kept), 1);
  assert.match(kept.err, /did not start listening on port 7531/);
  assert.ok(!kept.out.includes('still works'));
  assert.deepStrictEqual(kept.killed, ['SIGTERM'], 'a runtime that never listened is stopped');
});

// round 1, 6, and its medium, 4 and 10: one dev-server per home; a busy port
// with an earlier runtime's pid file names it as a maybe
test('one dev-server per home: a second, while the first runs, is refused naming it; a busy port with an earlier runtime\'s pid is named as a maybe', async () => {
  const h = home();
  let end;
  const first = io(h);
  first.exited = new Promise((r) => { end = r; });
  const running = devServer({}, first);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(fs.readFileSync(path.join(h, 'dev-auth', 'pid'), 'utf8'), '4321\n');
  const second = io(h);
  second.alive = (pid) => pid === process.pid;
  assert.strictEqual(await devServer({port: 7532, newKey: true}, second), 2);
  assert.match(second.err, new RegExp(`another dev-server is running for .* \\(pid ${process.pid}\\): stop it first`));
  assert.deepStrictEqual(second.spawned, []);
  end(0);
  await running;
  assert.deepStrictEqual(fs.readdirSync(path.join(h, 'dev-auth')).sort(), ['admin-key', 'auth.json', 'port'], 'its pid and lock gone when it ends');
  // (a runtime left by a dev-server that was killed: its pid file stays)
  fs.writeFileSync(path.join(h, 'dev-auth', 'pid'), '4321\n', {mode: 0o600});
  const busy = io(h, {free: false});
  busy.alive = (pid) => pid === 4321;
  assert.strictEqual(await devServer({}, busy), 2);
  assert.match(busy.err, /port 7531 on 127\.0\.0\.1 is in use, perhaps by an earlier dev-server's runtime \(pid 4321; check before stopping it\)/);
});
