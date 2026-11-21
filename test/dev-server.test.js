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
    const bin = path.join(h, 'app', 'node_modules', 'countinghouse', 'bin');
    fs.mkdirSync(bin, {recursive: true});
    fs.writeFileSync(path.join(bin, 'countinghouse'), '');
  }
  return h;
}
function io(h, {free = true, env = {}} = {}) {
  const f = fakeIo({env: {...env, COUNTINGHOUSE_HOME: h}});
  f.spawned = [];
  f.portFree = async () => free;
  f.trapSignals = (fn) => { f.signal = fn; return () => {}; };
  f.killed = [];
  // (what dev-auth/ holds while the runtime runs: the key ends with it)
  const authFile = (n) => { try { return fs.readFileSync(path.join(h, 'dev-auth', n), 'utf8'); } catch (e) { return null; } };
  f.spawn = (cmd, args, {env: childEnv} = {}) => {
    f.spawned.push({cmd, args, env: childEnv, key: authFile('admin-key'), auth: authFile('auth.json')});
    return {kill: (sig) => f.killed.push(sig), exited: f.exited || Promise.resolve(0)};
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
  const [{cmd, args, env}] = f.spawned;
  assert.strictEqual(cmd, f.node);
  assert.strictEqual(args[0], path.join(h, 'app', 'node_modules', 'countinghouse', 'bin', 'countinghouse'));
  assert.deepStrictEqual(args.slice(1), ['--bindAddr', '127.0.0.1', '--port', '7600', '--store', 'local', '--storePath', path.join(h, 'dev', 'store'),
    '--authProvider', 'file', '--authConfigPath', path.join(h, 'dev-auth', 'auth.json'), '--authoringTools', '--workerThread'], 'no --modulePath: it loads nothing without --moduleRegistry');
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
    fs.mkdirSync(path.join(h, 'app', 'node_modules', 'countinghouse', 'bin'), {recursive: true});
    fs.writeFileSync(path.join(h, 'app', 'node_modules', 'countinghouse', 'bin', 'countinghouse'), '');
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
test('signals: SIGINT at a terminal is not sent again; another is passed on once', async () => {
  const h = home();
  let end;
  const f = io(h);
  f.exited = new Promise((r) => { end = r; });
  f.stdinIsTTY = true;
  const done = devServer({}, f);
  await new Promise((r) => setImmediate(r));
  f.signal('SIGINT');
  f.signal('SIGTERM');
  f.signal('SIGTERM');
  end(0);
  assert.strictEqual(await done, 0);
  assert.deepStrictEqual(f.killed, ['SIGTERM']);
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
    '  claude mcp remove --scope user countinghouse-dev',
    '  claude mcp add --scope user --transport http countinghouse-dev http://127.0.0.1:7531/mcp --header "X-CH-Key: $(cat "/h/dev-auth/admin-key")"',
    'Keep your tools\' modules in /h/dev/modules, and load them again after each start. They run here only: not inside your installed packs, not upgraded with them, and not published or shared.'
  ]);
  assert.deepStrictEqual(linesFor({...at, fresh: false}), [
    'countinghouse development server: http://127.0.0.1:7531/mcp (stop it with Ctrl-C)',
    'Claude Code\'s countinghouse-dev entry from before still works. To make a new key, start it again with --new-key.',
    'Keep your tools\' modules in /h/dev/modules, and load them again after each start. They run here only: not inside your installed packs, not upgraded with them, and not published or shared.'
  ]);
  const win = linesFor({port: 7531, keyFile: 'C:\\h\\dev-auth\\admin-key', modules: 'C:\\h\\dev\\modules', platform: 'win32', fresh: true});
  assert.match(win[1], /in another terminal \(PowerShell\):$/);
  assert.strictEqual(win[3], '  claude mcp add --scope user --transport http countinghouse-dev http://127.0.0.1:7531/mcp --header "X-CH-Key: $(Get-Content \'C:\\h\\dev-auth\\admin-key\')"');
});
