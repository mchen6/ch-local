'use strict';
require('./tmp-dirs');
// ch-local dev-server (A-ownuse): the home's own runtime as a local
// development server for the user's own tools: 127.0.0.1, a fixed port, the
// authoring tools behind an admin key made anew each start, removed when it
// stops and never printed, the packs' short environment, nothing of the pack
// install.
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
  assert.match(busy.err, /port 7531 on 127\.0\.0\.1 is in use: choose another with --port <n>/);
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
  assert.deepStrictEqual(f.out.trimEnd().split('\n'), linesFor({port: 7600, keyFile: path.join(h, 'dev-auth', 'admin-key'), modules: path.join(h, 'dev', 'modules'), platform: process.platform}));
  // the key ends with the server; the next start has a new one (a key taken
  // while it was down is dead: the reviewer on the A-ownuse medium, 1)
  assert.deepStrictEqual(fs.readdirSync(path.join(h, 'dev-auth')), [], 'removed on stop');
  const again = io(h);
  assert.strictEqual(await devServer({port: 7600}, again), 0);
  assert.match(again.spawned[0].key, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(again.spawned[0].key, key, 'a new key each start');
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
  const f = io(h);
  // (read while the runtime runs: the files end with it)
  const modes = {};
  const spawn = f.spawn;
  f.spawn = (...a) => { for (const n of ['admin-key', 'auth.json']) modes[n] = fs.statSync(path.join(h, 'dev-auth', n)).mode & 0o777; return spawn(...a); };
  assert.strictEqual(await devServer({}, f), 0);
  assert.strictEqual(fs.statSync(path.join(h, 'dev-auth')).mode & 0o777, 0o700);
  assert.deepStrictEqual(modes, {'admin-key': 0o600, 'auth.json': 0o600});
});

test('the lines said: the URL, the two Claude Code lines run again each start (PowerShell on Windows), and where it runs only', () => {
  const posix = linesFor({port: 7531, keyFile: '/h/dev-auth/admin-key', modules: '/h/dev/modules', platform: 'linux'});
  assert.deepStrictEqual(posix, [
    'countinghouse development server: http://127.0.0.1:7531/mcp (stop it with Ctrl-C)',
    'It has a new key each time it starts. Add it to Claude Code again now, in another terminal:',
    '  claude mcp remove --scope user countinghouse-dev',
    '  claude mcp add --scope user --transport http countinghouse-dev http://127.0.0.1:7531/mcp --header "X-CH-Key: $(cat "/h/dev-auth/admin-key")"',
    'Keep your tools\' modules in /h/dev/modules, and load them again after each start. They run here only: not inside your installed packs, not upgraded with them, and not published or shared.'
  ]);
  const win = linesFor({port: 7531, keyFile: 'C:\\h\\dev-auth\\admin-key', modules: 'C:\\h\\dev\\modules', platform: 'win32'});
  assert.match(win[1], /in another terminal \(PowerShell\):$/);
  assert.strictEqual(win[3], '  claude mcp add --scope user --transport http countinghouse-dev http://127.0.0.1:7531/mcp --header "X-CH-Key: $(Get-Content \'C:\\h\\dev-auth\\admin-key\')"');
});
