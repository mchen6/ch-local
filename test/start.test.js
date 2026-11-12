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

// A working directory inside a repository whose .git/config names origin.
function repo(origin) {
  const top = tmp('ch-local-repo-');
  fs.mkdirSync(path.join(top, '.git'));
  fs.writeFileSync(path.join(top, '.git', 'config'), origin == null ? '[core]\n\tbare = false\n' : `[core]\n\tbare = false\n[remote "upstream"]\n\turl = https://github.com/other/thing.git\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  fs.mkdirSync(path.join(top, 'src', 'deep'), {recursive: true});
  return path.join(top, 'src', 'deep');
}

function io(home, {env = {GITHUB_TOKEN: 'secret'}, origin = 'https://github.com/octo/widgets.git', exit = 0, cwd} = {}) {
  const f = fakeIo({env: {...env, COUNTINGHOUSE_HOME: home}, homedir: '/nowhere'});
  f.pid = 4242;
  f.hostname = 'box-1';
  f.cwd = cwd !== undefined ? cwd : repo(origin);
  f.spawned = [];
  f.killed = [];
  f.exits = [];
  f.signal = null;
  f.trapSignals = (handler) => { f.signal = handler; return () => { f.signal = null; }; };
  f.exit = (code) => { f.exits.push(code); };
  f.alive = (pid) => pid === 4242 || pid === 7;
  void path;
  // What the runtime would see when it starts: its args, its environment, the
  // config directory's files (by relative path) and the remote credentials.
  f.spawn = (cmd, args, {env: childEnv} = {}) => {
    const dir = args[args.indexOf('--deviceConfigPath') + 1];
    const config = {};
    const walk = (d, rel) => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else config[r] = JSON.parse(fs.readFileSync(path.join(d, e.name), 'utf8')); } };
    if (fs.existsSync(dir)) walk(dir, '');
    const rc = args[args.indexOf('--remoteCredentials') + 1];
    f.spawned.push({cmd, args, env: childEnv, config, remoteCredentials: JSON.parse(fs.readFileSync(rc, 'utf8'))});
    // A real spawn is synchronous: signals arrive once start holds the child.
    return {kill: (sig) => f.killed.push(sig), exited: Promise.resolve().then(() => { if (f.duringRun) f.duringRun(); return exit; })};
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
  // Each start's own files, so concurrent starts never see each other's: <host>-<pid>-<random>.
  const runDir = path.dirname(valueOf(args, '--remoteCredentials'));
  assert.strictEqual(path.dirname(runDir), path.join(home, 'run'));
  assert.match(path.basename(runDir), /^box-1-4242-[0-9a-f]{8}$/);
  assert.strictEqual(valueOf(args, '--deviceConfigPath'), path.join(runDir, 'config'));
  assert.ok(!fs.existsSync(runDir), 'removed when the runtime exits');
  // Inside the home, never the runtime's default ~/countinghouse_modules.
  assert.strictEqual(valueOf(args, '--modulePath'), path.join(home, 'modules'));
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
    assert.ok(args.includes('audit') || args.includes('--moduleSandbox=audit'));
  }
});

test('start passes through only the options known safe: --moduleSandbox audit|enforce and --locale, after its own', async () => {
  const f = io(installedHome());
  assert.strictEqual(await start({passThrough: ['--locale', 'zh-CN']}, f), 0, f.err);
  assert.deepStrictEqual(f.spawned[0].args.slice(-2), ['--locale', 'zh-CN']);
  const g = io(installedHome());
  assert.strictEqual(await start({passThrough: ['--locale=en-US']}, g), 0, g.err);
  assert.deepStrictEqual(g.spawned[0].args.slice(-1), ['--locale=en-US']);
});

test('start gives the runtime remote credentials for the loaded packs\' remotes: the variable it chose for each origin', async () => {
  const f = io(installedHome());
  await start({passThrough: []}, f);
  assert.deepStrictEqual(f.spawned[0].remoteCredentials, {'https://api.githubcopilot.com': ['GITHUB_TOKEN']});
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
  assert.match(f.err, /sends GITHUB_TOKEN to/);
  const env = f.spawned[0].env;
  assert.ok(!('COUNTINGHOUSE_GITHUB_TOKEN' in env), 'the placeholder would be sent first');
  assert.strictEqual(env.GITHUB_TOKEN, 'real');
  assert.strictEqual(env.OTHER, 'kept');
  assert.deepStrictEqual(f.spawned[0].remoteCredentials, {'https://api.githubcopilot.com': ['GITHUB_TOKEN']});
});

test('one consented variable per origin: the chosen one alone is listed and passed, every other allowed one removed', async () => {
  const f = io(installedHome(), {env: {COUNTINGHOUSE_GITHUB_TOKEN: 'first', GITHUB_TOKEN: 'second'}});
  await start({passThrough: []}, f);
  assert.deepStrictEqual(f.spawned[0].remoteCredentials, {'https://api.githubcopilot.com': ['COUNTINGHOUSE_GITHUB_TOKEN']});
  assert.strictEqual(f.spawned[0].env.COUNTINGHOUSE_GITHUB_TOKEN, 'first');
  assert.ok(!('GITHUB_TOKEN' in f.spawned[0].env));
  assert.match(f.err, /COUNTINGHOUSE_GITHUB_TOKEN to https:\/\/api\.githubcopilot\.com/);
  assert.ok(!/ GITHUB_TOKEN to/.test(f.err));
});

test('start sweeps this host\'s run directories whose start died, and nothing else', async () => {
  const home = installedHome();
  for (const name of ['box-1-7-0000000a', 'box-1-99999-0000000b', 'other-host-99999-0000000c', 'junk', '99999']) fs.mkdirSync(path.join(home, 'run', name), {recursive: true});
  await start({passThrough: []}, io(home));
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'run')).sort(), ['99999', 'box-1-7-0000000a', 'junk', 'other-host-99999-0000000c'],
    'a dead pid of this host goes; a live one, another host\'s and names ch-local did not make stay');
});

test('start removes its run directory when it fails after creating it', async () => {
  const home = installedHome();
  const f = io(home);
  f.alive = () => { throw new Error('exploded'); };
  await assert.rejects(start({passThrough: []}, f), /exploded/);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'run')), []);
});

test('start refuses every pass-through option not known safe, naming it, and starts nothing', async () => {
  const home = installedHome();
  for (const passThrough of [['--authProvider', 'file'], ['--authoringTools'], ['--hardened=false'], ['--allowedOrigins', '*'], ['--logStream'], ['--redisUrl', 'x'], ['--locale', '../../x'], ['positional'],
    ['--storePath', '/tmp/x'], ['--store=redis'], ['--loadModule', '/some/dir'], ['--remoteCredentials', 'o.json'], ['--deviceConfigPath', 'd'],
    ['--moduleDataPath', 'm'], ['--authConfigPath', 'a.json'], ['--usageDir', 'u'], ['--port', '1'], ['--no-workerThread'], ['--debug'], ['--modulePath', 'p']]) {
    const f = io(home);
    assert.strictEqual(await start({passThrough}, f), 2, passThrough.join(' '));
    assert.strictEqual(f.spawned.length, 0);
    assert.ok(f.err.includes(passThrough[0].replace(/=.*/, '')), f.err);
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
    assert.deepStrictEqual(f.execs, [], 'no git process: the config is read');
  }
  const f = io(installedHome(), {origin: null});
  assert.strictEqual(await start({passThrough: []}, f), 0, 'no origin: the pack asks for repo instead');
  assert.deepStrictEqual(f.spawned[0].config, {});
});

test('the origin is read from the repository\'s config: a worktree\'s .git file and commondir, no repository, an unreadable cwd', async () => {
  // A worktree: .git is a file naming its gitdir, whose commondir holds the config.
  const main = tmp('ch-local-main-');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), {recursive: true});
  fs.writeFileSync(path.join(main, '.git', 'config'), '[remote "origin"]\n  url = "git@github.com:octo/from-worktree.git" ; a comment\n');
  fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  const wt = tmp('ch-local-wt-');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
  const a = io(installedHome(), {cwd: wt});
  await start({passThrough: []}, a);
  assert.deepStrictEqual(Object.values(a.spawned[0].config), [{defaultRepo: 'octo/from-worktree'}]);
  for (const cwd of [tmp('ch-local-norepo-'), null, '/does/not/exist']) {
    const b = io(installedHome(), {cwd});
    assert.strictEqual(await start({passThrough: []}, b), 0, b.err);
    assert.deepStrictEqual(b.spawned[0].config, {}, String(cwd));
  }
});

test('originUrl reads only [remote "origin"] url, and ignores other sections and remotes', () => {
  const {originUrl} = require('../lib/start');
  assert.strictEqual(originUrl('[remote "origin"]\n\turl = https://github.com/a/b\n'), 'https://github.com/a/b');
  assert.strictEqual(originUrl('[remote "upstream"]\n\turl = https://github.com/x/y\n[branch "main"]\n\tremote = origin\n'), null);
  assert.strictEqual(originUrl('# url = https://github.com/c/d\n[remote "origin"]\n\tfetch = x\n'), null);
  assert.strictEqual(originUrl('[Remote "origin"]\n\tURL = https://github.com/e/f\n'), 'https://github.com/e/f', 'section and key names are case-insensitive');
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
  for (const bad of ['https://github.com/../widgets', 'https://github.com/octo/..', 'https://github.com/octo/.', 'https://github.com/-octo/widgets', 'https://github.com/octo-/widgets',
    'https://github.com/oc--to/widgets', `https://github.com/${'o'.repeat(40)}/widgets`, `https://github.com/octo/${'w'.repeat(101)}`, 'https://github.com/oc_to/widgets', 'https://github.com/octo/wid gets']) {
    assert.strictEqual(repoFromRemote(bad), null, bad);
  }
  assert.strictEqual(repoFromRemote('https://github.com/o-c-t-o/w.i_d-gets'), 'o-c-t-o/w.i_d-gets');
  assert.strictEqual(repoFromRemote('https://github.com/octo/.github'), 'octo/.github');
});

test('start names the credential variable and never prints a value; with none present it loads nothing and says why', async () => {
  const home = installedHome();
  const f = io(home);
  await start({passThrough: []}, f);
  assert.match(f.err, /loading ci-failure-triage/);
  assert.match(f.err, /GITHUB_TOKEN to https:\/\/api\.githubcopilot\.com/);
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
  assert.strictEqual(await main(['start', '--stdio', '--locale', 'en-US'], f), 0, f.err);
  assert.deepStrictEqual(f.spawned[0].args.slice(-2), ['--locale', 'en-US']);
  const g = io(home);
  assert.strictEqual(await main(['start'], g), 2);
  assert.strictEqual(g.spawned.length, 0);
  assert.match(g.err, /start --stdio/);
});

test('a signal before the runtime starts removes the run directory and exits; nothing is spawned', async () => {
  const home = installedHome();
  const f = io(home);
  f.alive = () => { f.signal('SIGTERM'); return false; };
  const code = await start({passThrough: []}, f);
  assert.strictEqual(f.spawned.length, 0);
  assert.deepStrictEqual(f.exits, [143]);
  assert.strictEqual(code, 143);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, 'run')), []);
});

test('after the runtime starts, SIGINT, SIGTERM and SIGHUP are forwarded to it once each', async () => {
  const f = io(installedHome());
  f.duringRun = () => { for (const s of ['SIGINT', 'SIGINT', 'SIGTERM', 'SIGHUP', 'SIGTERM']) f.signal(s); };
  await start({passThrough: []}, f);
  assert.deepStrictEqual(f.killed, ['SIGINT', 'SIGTERM', 'SIGHUP']);
  assert.deepStrictEqual(f.exits, []);
  assert.strictEqual(f.signal, null, 'the handlers are removed when start returns');
});
