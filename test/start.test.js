'use strict';
// ch-local start --stdio (plan Task 11; reviewer, 2026-11-12): the
// single-identity profile of LM1 with every installed pack whose credential is
// present, the one per-user store, the sandbox never off, the remote
// credentials as the union of the loaded packs' remotes, and the defaultRepo
// device config from the working directory's origin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const {start, repoFromRemote} = require('../lib/start');
const {main} = require('../bin/ch-local');

const GITHUB = {name: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/',
  credential: {env: 'COUNTINGHOUSE_GITHUB_TOKEN', fallbackEnv: 'GITHUB_TOKEN', header: 'Authorization', scheme: 'Bearer'}};
const SCENARIO = '@countinghouse/ch-pack-ci-failure-triage';

// A home with ci-failure-triage installed: installed.json and the app's packages.
function installedHome({remotes = [GITHUB]} = {}) {
  const home = tmp('ch-local-start-');
  const pkgs = {[SCENARIO]: {role: 'scenario'}, '@countinghouse/ch-access-github': {role: 'part', remotes}, countinghouse: null};
  for (const [name, countinghouse] of Object.entries(pkgs)) {
    const at = path.join(home, 'app', 'node_modules', ...name.split('/'));
    fs.mkdirSync(at, {recursive: true});
    fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify({name, version: '1.0.0', ...(countinghouse ? {countinghouse} : {})}));
  }
  fs.writeFileSync(path.join(home, 'installed.json'), JSON.stringify({pack: 'ci-failure-triage',
    versions: Object.fromEntries(Object.keys(pkgs).map((n) => [n, '1.0.0'])), credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']}));
  return home;
}

function io(home, {env = {GITHUB_TOKEN: 'secret'}, origin = 'https://github.com/octo/widgets.git', exit = 0} = {}) {
  const f = fakeIo({env: {...env, COUNTINGHOUSE_HOME: home}, homedir: '/nowhere',
    exec: (cmd, args) => (args.includes('get-url') ? (origin == null ? {status: 2, stdout: '', stderr: 'no origin'} : {status: 0, stdout: `${origin}\n`, stderr: ''}) : {status: 0, stdout: '', stderr: ''})});
  f.pid = 4242;
  f.cwd = '/work/widgets';
  f.spawned = [];
  f.alive = (pid) => pid === 4242 || pid === 7;
  // What the runtime would see when it starts: its args, its environment, the
  // config directory's files (by relative path) and the remote credentials.
  f.spawn = (cmd, args, {env: childEnv} = {}) => {
    const dir = args[args.indexOf('--deviceConfigPath') + 1];
    const config = {};
    const walk = (d, rel) => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else config[r] = JSON.parse(fs.readFileSync(path.join(d, e.name), 'utf8')); } };
    if (fs.existsSync(dir)) walk(dir, '');
    const rc = args[args.indexOf('--remoteCredentials') + 1];
    f.spawned.push({cmd, args, env: childEnv, config, remoteCredentials: JSON.parse(fs.readFileSync(rc, 'utf8'))});
    return Promise.resolve(exit);
  };
  return f;
}

const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

test('start runs the profile: local store, enforce, the one store, no auth file, no usageDir, no port', async () => {
  const home = installedHome();
  const f = io(home);
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.strictEqual(f.spawned.length, 1);
  const {cmd, args} = f.spawned[0];
  assert.strictEqual(cmd, f.node);
  assert.strictEqual(args[0], path.join(home, 'app', 'node_modules', 'countinghouse', 'bin', 'countinghouse-stdio.js'));
  assert.ok(args.includes('--workerThread'));
  assert.strictEqual(valueOf(args, '--store'), 'local');
  assert.strictEqual(valueOf(args, '--storePath'), path.join(home, 'store'));
  assert.strictEqual(valueOf(args, '--moduleSandbox'), 'enforce');
  assert.strictEqual(valueOf(args, '--moduleDataPath'), path.join(home, 'module_data'));
  // Each start's own files, so concurrent starts never see each other's.
  assert.strictEqual(valueOf(args, '--remoteCredentials'), path.join(home, 'run', '4242', 'remote-credentials.json'));
  assert.strictEqual(valueOf(args, '--deviceConfigPath'), path.join(home, 'run', '4242', 'config'));
  assert.ok(!fs.existsSync(path.join(home, 'run', '4242')), 'removed when the runtime exits');
  assert.deepStrictEqual(args.filter((a, i) => args[i - 1] === '--loadModule'), [path.join(home, 'app', 'node_modules', ...SCENARIO.split('/'))]);
  // countinghouse-stdio.js adds --stdio=true itself.
  for (const absent of ['--authConfigPath', '--usageDir', '--port', '--stdio', '--debug']) assert.ok(!args.includes(absent), absent);
});

test('start returns the runtime\'s exit code', async () => {
  const f = io(installedHome(), {exit: 3});
  assert.strictEqual(await start({passThrough: []}, f), 3);
});

test('start passes the same per-user --storePath whatever the client or directory', async () => {
  const home = installedHome();
  const a = io(home); const b = io(home, {env: {COUNTINGHOUSE_GITHUB_TOKEN: 'other'}});
  a.cwd = '/one'; b.cwd = '/two';
  await start({passThrough: []}, a); await start({passThrough: []}, b);
  assert.strictEqual(valueOf(a.spawned[0].args, '--storePath'), valueOf(b.spawned[0].args, '--storePath'));
});

test('start refuses a pass-through --moduleSandbox other than audit or enforce, in either form, and starts nothing', async () => {
  const home = installedHome();
  for (const passThrough of [['--moduleSandbox', 'off'], ['--moduleSandbox=off'], ['--moduleSandbox', 'bogus'], ['--moduleSandbox']]) {
    const f = io(home);
    assert.strictEqual(await start({passThrough}, f), 2, passThrough.join(' '));
    assert.strictEqual(f.spawned.length, 0);
    assert.match(f.err, /--moduleSandbox/);
  }
  for (const passThrough of [['--moduleSandbox', 'audit'], ['--moduleSandbox=audit']]) {
    const f = io(home);
    assert.strictEqual(await start({passThrough}, f), 0, f.err);
    const args = f.spawned[0].args;
    assert.deepStrictEqual(args.filter((a) => a.startsWith('--moduleSandbox')).length, 1, 'one sandbox option, the passed one');
    assert.ok(args.includes('audit'));
  }
});

test('start passes other options through after its own', async () => {
  const f = io(installedHome());
  await start({passThrough: ['--logLevel', 'debug']}, f);
  assert.deepStrictEqual(f.spawned[0].args.slice(-2), ['--logLevel', 'debug']);
});

test('start gives the runtime remote credentials as the union of the loaded packs\' remotes', async () => {
  const f = io(installedHome());
  await start({passThrough: []}, f);
  assert.deepStrictEqual(f.spawned[0].remoteCredentials, {'https://api.githubcopilot.com': ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']});
});

test('start refuses a listed package that is missing from the app, and starts nothing', async () => {
  const home = installedHome();
  fs.rmSync(path.join(home, 'app', 'node_modules', '@countinghouse', 'ch-access-github'), {recursive: true});
  const f = io(home);
  assert.strictEqual(await start({passThrough: []}, f), 1);
  assert.strictEqual(f.spawned.length, 0);
  assert.match(f.err, /ch-access-github is not installed.*ch-local install/);
});

test('the runtime gets the credential start named: a blank or unresolved variable before it is removed from its environment', async () => {
  const f = io(installedHome(), {env: {COUNTINGHOUSE_GITHUB_TOKEN: '${GITHUB_TOKEN}', GITHUB_TOKEN: 'real', OTHER: 'kept'}});
  await start({passThrough: []}, f);
  assert.match(f.err, /with GITHUB_TOKEN/);
  const env = f.spawned[0].env;
  assert.ok(!('COUNTINGHOUSE_GITHUB_TOKEN' in env), 'the placeholder would be sent first');
  assert.strictEqual(env.GITHUB_TOKEN, 'real');
  assert.strictEqual(env.OTHER, 'kept');
});

test('start sweeps run directories left by starts that died, and keeps a live one\'s', async () => {
  const home = installedHome();
  for (const pid of ['7', '99999', 'junk']) fs.mkdirSync(path.join(home, 'run', pid), {recursive: true});
  await start({passThrough: []}, io(home));
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'run')).sort(), ['7', 'junk'], 'a dead pid goes; a live pid and a name ch-local did not make stay');
});

test('start removes its run directory when it fails after creating it', async () => {
  const home = installedHome();
  const f = io(home);
  f.exec = async () => { throw new Error('git exploded'); };
  await assert.rejects(start({passThrough: []}, f), /git exploded/);
  assert.ok(!fs.existsSync(path.join(home, 'run', '4242')));
});

test('start refuses the options it owns, in any form, and starts nothing', async () => {
  const home = installedHome();
  for (const passThrough of [['--storePath', '/tmp/x'], ['--store=redis'], ['--loadModule', '/some/dir'], ['--remoteCredentials', 'o.json'], ['--deviceConfigPath', 'd'],
    ['--moduleDataPath', 'm'], ['--authConfigPath', 'a.json'], ['--usageDir', 'u'], ['--port', '1'], ['--no-workerThread'], ['--debug'], ['--modulePath', 'p']]) {
    const f = io(home);
    assert.strictEqual(await start({passThrough}, f), 2, passThrough.join(' '));
    assert.strictEqual(f.spawned.length, 0);
    assert.ok(f.err.includes(passThrough[0].replace(/=.*/, '').replace('--no-', '--')), f.err);
  }
});

test('start refuses a declared remote whose origin is not allowed, naming the package and origin, and starts nothing', async () => {
  const home = installedHome({remotes: [{...GITHUB, url: 'https://collector.example/mcp/'}]});
  const f = io(home);
  assert.strictEqual(await start({passThrough: []}, f), 1);
  assert.strictEqual(f.spawned.length, 0);
  assert.match(f.err, /@countinghouse\/ch-access-github.*https:\/\/collector\.example/);
});

test('start refuses a declared variable the origin is not pinned to receive, naming the package, origin and variable', async () => {
  const home = installedHome({remotes: [{...GITHUB, credential: {...GITHUB.credential, fallbackEnv: 'AWS_SECRET_ACCESS_KEY'}}]});
  const f = io(home);
  assert.strictEqual(await start({passThrough: []}, f), 1);
  assert.strictEqual(f.spawned.length, 0);
  assert.match(f.err, /@countinghouse\/ch-access-github.*AWS_SECRET_ACCESS_KEY.*https:\/\/api\.githubcopilot\.com/);
});

test('start gives the runtime the defaultRepo device config from the origin remote, and removes it after', async () => {
  for (const origin of ['https://github.com/octo/widgets.git', 'git@github.com:octo/widgets.git', 'https://github.com/octo/widgets']) {
    const home = installedHome();
    const f = io(home, {origin});
    await start({passThrough: []}, f);
    // The runtime keys a device config by the package name (module-manager getModuleInfoFromPath).
    assert.deepStrictEqual(f.spawned[0].config, {'@countinghouse/ch-pack-ci-failure-triage.json': {defaultRepo: 'octo/widgets'}}, origin);
    assert.strictEqual(f.execs[0].cwd, '/work/widgets', 'read in the client\'s working directory');
  }
  const f = io(installedHome(), {origin: null});
  assert.strictEqual(await start({passThrough: []}, f), 0, 'no origin: the pack asks for repo instead');
  assert.deepStrictEqual(f.spawned[0].config, {});
});

test('repoFromRemote reads owner/name from GitHub remotes and nothing else', () => {
  assert.strictEqual(repoFromRemote('https://github.com/octo/widgets.git'), 'octo/widgets');
  assert.strictEqual(repoFromRemote('git@github.com:octo/widgets.git'), 'octo/widgets');
  assert.strictEqual(repoFromRemote('ssh://git@github.com/octo/widgets'), 'octo/widgets');
  assert.strictEqual(repoFromRemote('https://user@github.com/octo/widgets.git/'), 'octo/widgets');
  assert.strictEqual(repoFromRemote('ssh://git@github.com:22/octo/widgets.git'), 'octo/widgets');
  assert.strictEqual(repoFromRemote('https://GitHub.com/octo/widgets'), 'octo/widgets');
  assert.strictEqual(repoFromRemote('https://www.github.com/octo/widgets'), 'octo/widgets');
  assert.strictEqual(repoFromRemote('git://github.com/octo/widgets.git'), 'octo/widgets');
  assert.strictEqual(repoFromRemote('https://github.com.evil.example/octo/widgets'), null);
  assert.strictEqual(repoFromRemote('https://gitlab.com/octo/widgets.git'), null);
  assert.strictEqual(repoFromRemote('https://github.com/octo'), null);
  assert.strictEqual(repoFromRemote('not a url'), null);
});

test('start names the credential variable and never prints a value; with none present it loads nothing and says why', async () => {
  const home = installedHome();
  const f = io(home);
  await start({passThrough: []}, f);
  assert.match(f.err, /ci-failure-triage.*GITHUB_TOKEN/);
  assert.ok(!(f.out + f.err).includes('secret'));
  assert.strictEqual(f.out, '', 'stdout is the MCP channel: start writes nothing there');
  const none = io(home, {env: {}});
  assert.strictEqual(await start({passThrough: []}, none), 1);
  assert.strictEqual(none.spawned.length, 0);
  assert.match(none.err, /COUNTINGHOUSE_GITHUB_TOKEN or GITHUB_TOKEN/);
});

test('start with nothing installed says to install, and starts nothing', async () => {
  const f = io(tmp('ch-local-empty-'));
  assert.strictEqual(await start({passThrough: []}, f), 1);
  assert.strictEqual(f.spawned.length, 0);
  assert.match(f.err, /ch-local install/);
});

test('the CLI takes `start --stdio [options]` and nothing else', async () => {
  const home = installedHome();
  const f = io(home);
  assert.strictEqual(await main(['start', '--stdio', '--logLevel', 'debug'], f), 0, f.err);
  assert.deepStrictEqual(f.spawned[0].args.slice(-2), ['--logLevel', 'debug']);
  const g = io(home);
  assert.strictEqual(await main(['start'], g), 2);
  assert.strictEqual(g.spawned.length, 0);
  assert.match(g.err, /start --stdio/);
});
