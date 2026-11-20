'use strict';
require('./tmp-dirs');
// ch-local dev-server (A-ownuse): the home's own runtime as a local
// development server for the user's own tools: 127.0.0.1, a fixed port, the
// authoring tools behind an admin key made once and never printed, the
// packs' short environment, nothing of the pack install.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const {devServer, linesFor} = require('../lib/dev-server');

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
  f.trapSignals = () => () => {};
  f.spawn = (cmd, args, {env: childEnv} = {}) => { f.spawned.push({cmd, args, env: childEnv}); return {kill: () => {}, exited: Promise.resolve(0)}; };
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
    '--authProvider', 'file', '--authConfigPath', path.join(h, 'dev-auth', 'auth.json'), '--authoringTools', '--workerThread', '--modulePath', path.join(h, 'dev', 'modules')]);
  assert.strictEqual(env.GITHUB_TOKEN, undefined, 'the packs\' short environment: no client credential');
  assert.strictEqual(env.PATH, '/usr/bin');
  const key = fs.readFileSync(path.join(h, 'dev-auth', 'admin-key'), 'utf8');
  assert.match(key, /^[0-9a-f]{64}$/);
  const auth = JSON.parse(fs.readFileSync(valueOf(args, '--authConfigPath'), 'utf8'));
  assert.deepStrictEqual(auth, {[key]: {userName: 'dev', devices: ['*'], admin: true}});
  assert.ok(!(f.out + f.err).includes(key), 'the key is never printed');
  assert.deepStrictEqual(f.out.trimEnd().split('\n'), linesFor({port: 7600, keyFile: path.join(h, 'dev-auth', 'admin-key'), modules: path.join(h, 'dev', 'modules'), platform: process.platform}));
  // a second start keeps the key, so Claude Code's entry stays valid
  const again = io(h);
  assert.strictEqual(await devServer({port: 7600}, again), 0);
  assert.strictEqual(fs.readFileSync(path.join(h, 'dev-auth', 'admin-key'), 'utf8'), key);
});

test('the key and its auth config are private: dev-auth/ 0700, its files 0600', POSIX, async () => {
  const h = home();
  assert.strictEqual(await devServer({}, io(h)), 0);
  assert.strictEqual(fs.statSync(path.join(h, 'dev-auth')).mode & 0o777, 0o700);
  for (const f of ['admin-key', 'auth.json']) assert.strictEqual(fs.statSync(path.join(h, 'dev-auth', f)).mode & 0o777, 0o600, f);
});

test('the lines said: the URL, the one Claude Code line reading the key in the shell (PowerShell on Windows), and where it runs only', () => {
  const posix = linesFor({port: 7531, keyFile: '/h/dev-auth/admin-key', modules: '/h/dev/modules', platform: 'linux'});
  assert.deepStrictEqual(posix, [
    'countinghouse development server: http://127.0.0.1:7531/mcp (stop it with Ctrl-C)',
    'Add it to Claude Code once, in another terminal:',
    '  claude mcp add --scope user --transport http countinghouse-dev http://127.0.0.1:7531/mcp --header "X-CH-Key: $(cat "/h/dev-auth/admin-key")"',
    'Its tools load modules from /h/dev/modules. They run here only: not inside your installed packs, not upgraded with them, and not published or shared.'
  ]);
  const win = linesFor({port: 7531, keyFile: 'C:\\h\\dev-auth\\admin-key', modules: 'C:\\h\\dev\\modules', platform: 'win32'});
  assert.strictEqual(win[2], '  claude mcp add --scope user --transport http countinghouse-dev http://127.0.0.1:7531/mcp --header "X-CH-Key: $(Get-Content \'C:\\h\\dev-auth\\admin-key\')"');
});
