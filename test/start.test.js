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

// A home with ci-failure-triage installed: packs.json and the app's packages.
function installedHome({remotes = [GITHUB], unreleased = false, other = false} = {}) {
  const home = tmp('ch-local-start-');
  const pkgs = {[SCENARIO]: {role: 'scenario'}, '@countinghouse/ch-access-github': {role: 'part', remotes}, countinghouse: null, ...(other ? {'@countinghouse/ch-pack-other': {role: 'scenario'}} : {})};
  for (const [name, countinghouse] of Object.entries(pkgs)) {
    const at = path.join(home, 'app', 'node_modules', ...name.split('/'));
    fs.mkdirSync(at, {recursive: true});
    fs.writeFileSync(path.join(at, 'package.json'), JSON.stringify({name, version: '1.0.0', ...(countinghouse ? {countinghouse} : {})}));
  }
  fs.writeFileSync(path.join(home, 'packs.json'), JSON.stringify({runtime: {versions: {countinghouse: '1.0.0'}}, unreleased, packs: {
    'ci-failure-triage': {packages: {[SCENARIO]: '1.0.0', '@countinghouse/ch-access-github': '1.0.0'}, credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']},
    ...(other ? {other: {packages: {'@countinghouse/ch-pack-other': '1.0.0'}, credentials: ['OTHER_TOKEN']}} : {})}}));
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

// platform: this host's unless a test asks for another (the sandbox option
// differs on win32, as the settings' default does: countinghouse#195).
function io(home, {env = {GITHUB_TOKEN: 'secret'}, origin = 'https://github.com/octo/widgets.git', exit = 0, cwd, platform = process.platform} = {}) {
  const f = fakeIo({env: {...env, COUNTINGHOUSE_HOME: home}, homedir: '/nowhere'});
  f.platform = platform;
  f.pid = 4242;
  f.hostname = 'box-1';
  f.cwd = cwd !== undefined ? cwd : repo(origin);
  f.spawned = [];
  f.killed = [];
  f.exits = [];
  f.signal = null;
  f.trapSignals = (handler, signals) => { f.signal = handler; f.trapped = signals; return () => { f.signal = null; }; };
  f.exit = (code) => { f.exits.push(code); };
  f.alive = (pid) => pid === 4242 || pid === 7;
  void path;
  // What the runtime would see when it starts: its args, its environment, the
  // config directory's files (by relative path) and the remote credentials.
  f.spawn = (cmd, args, {env: childEnv, detached} = {}) => {
    f.detached = detached;
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

// the shared runtime (session mode) is POSIX-only until C4c, the Windows daemon
const POSIX_ONLY = process.platform === 'win32' && 'shared runtime is POSIX-only until C4c';
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
  assert.strictEqual(valueOf(args, '--moduleSandbox'), process.platform === 'win32' ? 'audit' : 'enforce');
  assert.strictEqual(args.filter((a) => a.startsWith('--moduleSandbox')).length, 1, 'one sandbox option');
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
    assert.deepStrictEqual(f.execs.filter((e) => e.cmd === 'git'), [], 'no git process: the config is read');
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
  // why: gh gave no token and the environment has none (gh auth login, or the plaintext fallback)
  assert.match(none.err, /run `gh auth login`, or for headless or CI use set COUNTINGHOUSE_GITHUB_TOKEN/);
  assert.match(none.err, /not loading ci-failure-triage: it needs the GitHub token/);
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

test('start loads every installed pack whose credential is set, one --loadModule each', async () => {
  const home = installedHome({other: true});
  const both = io(home, {env: {GITHUB_TOKEN: 'a', OTHER_TOKEN: 'b'}});
  assert.strictEqual(await start({passThrough: []}, both), 0, both.err);
  const args = both.spawned[0].args;
  assert.deepStrictEqual(args.filter((a, i) => args[i - 1] === '--loadModule').map((d) => path.relative(path.join(home, 'app', 'node_modules'), d)),
    [path.join('@countinghouse', 'ch-pack-ci-failure-triage'), path.join('@countinghouse', 'ch-pack-other')]);
  const one = io(home, {env: {GITHUB_TOKEN: 'a'}});
  await start({passThrough: []}, one);
  assert.strictEqual(one.spawned[0].args.filter((a) => a === '--loadModule').length, 1);
  assert.match(one.err, /not loading other: set OTHER_TOKEN/);
});

test('every start of an unreleased install says so in one stderr line', async () => {
  const f = io(installedHome({unreleased: true}));
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.strictEqual(f.err.split('\n').filter((l) => /unreleased/.test(l)).length, 1);
  const g = io(installedHome());
  await start({passThrough: []}, g);
  assert.ok(!/unreleased/.test(g.err));
});

test('the CLI takes add-pack, remove-pack, status and install --unreleased-pins', async () => {
  const home = tmp('ch-local-cli-');
  const run = async (argv) => { const f = io(home); return {code: await main(argv, f), f}; };
  let r = await run(['add-pack', 'nope', '--from', '/x']);
  assert.strictEqual(r.code, 2); assert.match(r.f.err, /"nope" is not in this ch-local release's allowlist/);
  r = await run(['remove-pack', 'nope']);
  assert.strictEqual(r.code, 1); assert.match(r.f.err, /"nope" is not installed/);
  r = await run(['status']);
  assert.strictEqual(r.code, 1); assert.match(r.f.out, /nothing is installed/);
  r = await run(['install', '--pack', 'ci-failure-triage', '--from', '/x', '--unreleased-pins', path.join(home, 'missing.json')]);
  assert.strictEqual(r.code, 2); assert.match(r.f.err, /--unreleased-pins is for development: set CH_LOCAL_DEV=1/);
  for (const bad of [['add-pack'], ['remove-pack'], ['status', 'x'], ['add-pack', 'a', 'b']]) assert.strictEqual((await run(bad)).code, 2, bad.join(' '));
});

// The GitHub token from `gh auth token` (Matt, 2026-11-13): read at start,
// held in memory, given to the runtime in its environment only; a plaintext
// environment value is the fallback for headless and CI use. No token value
// is ever written to a file or said. Values are made here, never literals.
const crypto = require('node:crypto');
const madeToken = () => `t${crypto.randomBytes(12).toString('hex')}`;
const ghAnswers = (answer) => async (cmd, args) => (cmd === 'gh' ? answer : {status: 0, stdout: '', stderr: ''});
// Every file under dir, as text.
const filesUnder = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(fs.readFileSync(p, 'utf8')); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};
// a session runtime's environment is the allowlist only (no GITHUB_TOKEN):
// its token comes from gh, here logged in
const ghLoggedIn = (f) => { f.exec = async(cmd) => (cmd === 'gh' ? {status: 0, stdout: 'gho_exampleexampleexample\n'} : {status: 0, stdout: ''}); return f; };
const withExec = (f, exec) => { f.exec = async (cmd, args, opts) => { f.execs.push({cmd, args, opts}); return exec(cmd, args, opts); }; return f; };

test('start asks gh for the GitHub token and gives it to the runtime in its environment only, never in a file or a line', async () => {
  const home = installedHome();
  const token = madeToken();
  const plain = madeToken();
  const f = withExec(io(home, {env: {GITHUB_TOKEN: plain, GH_TOKEN: plain}}), ghAnswers({status: 0, stdout: `${token}\n`, stderr: ''}));
  let during = [];
  f.duringRun = () => { during = filesUnder(home); };
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  const gh = f.execs.filter((e) => e.cmd === 'gh');
  assert.deepStrictEqual(gh.map((e) => e.args), [['auth', 'token', '--hostname', 'github.com']]);
  // gh would answer these before its own login: it runs without them, and is killed past its timeout
  for (const v of ['GH_TOKEN', 'GITHUB_TOKEN']) assert.strictEqual(gh[0].opts.env[v], undefined, v);
  assert.ok(gh[0].opts.timeout > 0);
  const {env, remoteCredentials, config} = f.spawned[0];
  assert.strictEqual(env.COUNTINGHOUSE_GITHUB_TOKEN, token);
  assert.strictEqual(env.GITHUB_TOKEN, undefined, 'the plaintext fallback is not passed when gh gave a token');
  assert.deepStrictEqual(Object.values(remoteCredentials), [['COUNTINGHOUSE_GITHUB_TOKEN']]);
  assert.match(f.err, /GitHub token from `gh auth token`, held in memory/);
  for (const text of [f.err, f.out, JSON.stringify(config), JSON.stringify(remoteCredentials), ...during, ...filesUnder(home)]) {
    assert.ok(!text.includes(token) && !text.includes(plain), 'no token value is written or said');
  }
});

test('gh not installed and no token in the environment: nothing starts, and the message names gh auth login and the plaintext fallback', async () => {
  const f = withExec(io(installedHome(), {env: {}}), ghAnswers({status: null, stdout: '', stderr: 'spawn gh ENOENT'}));
  assert.strictEqual(await start({passThrough: []}, f), 1);
  assert.strictEqual(f.spawned.length, 0);
  assert.match(f.err, /gh, the GitHub CLI, was not found or did not answer/);
  assert.match(f.err, /`gh auth login`/);
  assert.match(f.err, /plaintext in that client's config/);
});

test('gh not logged in: a plain message naming gh auth login, and gh\'s own output is never repeated', async () => {
  const leaked = madeToken();
  const f = withExec(io(installedHome(), {env: {}}), ghAnswers({status: 1, stdout: '', stderr: `no oauth token found for github.com ${leaked}`}));
  assert.strictEqual(await start({passThrough: []}, f), 1);
  assert.match(f.err, /gh is not logged in to github\.com: run `gh auth login`/);
  assert.ok(!f.err.includes(leaked) && !f.err.includes('no oauth token'), f.err);
});

test('an explicit COUNTINGHOUSE_GITHUB_TOKEN is the user\'s choice (often narrower than gh\'s): used as is, gh not asked, named as plaintext', async () => {
  const plain = madeToken();
  const f = withExec(io(installedHome(), {env: {COUNTINGHOUSE_GITHUB_TOKEN: plain}}), ghAnswers({status: 0, stdout: `${madeToken()}\n`, stderr: ''}));
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.strictEqual(f.spawned[0].env.COUNTINGHOUSE_GITHUB_TOKEN, plain);
  assert.deepStrictEqual(f.execs.filter((e) => e.cmd === 'gh'), []);
  assert.match(f.err, /using COUNTINGHOUSE_GITHUB_TOKEN from the environment; if a client's config sets it, it is stored there in plaintext/);
  assert.ok(!f.err.includes(plain));
});

test('the environment fallback: with gh unavailable, GITHUB_TOKEN from the client\'s environment is used and named as plaintext', async () => {
  const plain = madeToken();
  for (const answer of [{status: null, stdout: '', stderr: ''}, {status: 1, stdout: '', stderr: ''}, {status: 0, stdout: 'not a token value\n', stderr: ''}]) {
    const f = withExec(io(installedHome(), {env: {GITHUB_TOKEN: plain}}), ghAnswers(answer));
    assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
    assert.strictEqual(f.spawned[0].env.GITHUB_TOKEN, plain);
    assert.match(f.err, /using GITHUB_TOKEN from the environment; if a client's config sets it, it is stored there in plaintext/);
    assert.ok(!f.err.includes(plain));
  }
});

test('a pack that takes only GITHUB_TOKEN gets gh\'s token too, and with none it says it needs the GitHub token, once', async () => {
  const home = installedHome();
  const packsJson = path.join(home, 'packs.json');
  const record = JSON.parse(fs.readFileSync(packsJson, 'utf8'));
  record.packs['ci-failure-triage'].credentials = ['GITHUB_TOKEN'];
  fs.writeFileSync(packsJson, JSON.stringify(record));
  const token = madeToken();
  const f = withExec(io(home, {env: {}}), ghAnswers({status: 0, stdout: `${token}\n`, stderr: ''}));
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.ok(Object.values(f.spawned[0].env).includes(token));
  const g = withExec(io(home, {env: {}}), ghAnswers({status: 1, stdout: '', stderr: ''}));
  assert.strictEqual(await start({passThrough: []}, g), 1);
  assert.match(g.err, /not loading ci-failure-triage: it needs the GitHub token \(above\)/);
  assert.doesNotMatch(g.err, /set GITHUB_TOKEN in the environment your client starts from/);
});

// The review of ch-local #13's re-check.
test('a settings file that is not valid stops start, saying why and how to fix it; nothing is spawned', async () => {
  const home = installedHome();
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh', maxOutputBytes: 1}}));
  const f = io(home);
  assert.notStrictEqual(await start({passThrough: []}, f), 0);
  assert.match(f.err, /maxOutputBytes = 1, which is not allowed: not starting; fix it \(`ch-local settings reset` replaces every setting with its default, asking first if that loosens one\)/);
  assert.deepStrictEqual(f.spawned, []);
});

test('a setting this ch-local does not know is ignored with a warning, and start runs', async () => {
  const home = installedHome();
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {fromTheFuture: 3, locale: 'zh'}}));
  const f = io(home);
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.match(f.err, /does not know, ignored: fromTheFuture/);
  assert.strictEqual(valueOf(f.spawned[0].args, '--locale'), 'zh-CN', 'the runtime\'s locale');
});

test('start waits for an install for as long as it takes, saying so, and never says to remove the lock', async () => {
  const {lockHost} = require('../lib/lock');
  const home = installedHome();
  const lock = path.join(home, 'packs.lock');
  fs.writeFileSync(lock, JSON.stringify({pid: process.pid, host: lockHost(), at: new Date().toISOString()}));
  const f = io(home);
  f.lockProgressMs = 100;
  setTimeout(() => fs.rmSync(lock), 450);
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.match(f.err, /waiting for another ch-local \(pid \d+\) to finish changing this home/);
  assert.doesNotMatch(f.err, /remove/);
  assert.strictEqual(f.spawned.length, 1);
});

test('the requestTimeout setting, in milliseconds, reaches the runtime in seconds', async () => {
  const home = installedHome();
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {requestTimeout: 12500}}));
  const f = io(home);
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.strictEqual(valueOf(f.spawned[0].args, '--requestTimeout'), '12', 'rounded down: never looser than asked');
});

test('start gives the runtime the settings file countinghouse_settings changes', async () => {
  const home = installedHome();
  const f = io(home);
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.strictEqual(valueOf(f.spawned[0].args, '--settingsFile'), path.join(home, 'settings.json'));
});

test('the locale setting reaches the runtime as its own locale: en-US or zh-CN', async () => {
  for (const [stored, passed] of [['zh', 'zh-CN'], ['en', 'en-US']]) {
    const home = installedHome();
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {locale: stored}}));
    const f = io(home);
    assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
    assert.strictEqual(valueOf(f.spawned[0].args, '--locale'), passed);
  }
});

// On Windows enforce needs a countinghouse with #195 (lib/sandbox-support.js:
// its lib/fs-broker/virtual-drive.js). With an older one start keeps #17's
// behaviour: audit, said, and an explicit enforce refused before anything
// starts. With one that has it, Windows is like every platform.
const withWindowsEnforce = (home) => {
  const f = path.join(home, 'app', 'node_modules', 'countinghouse', 'lib', 'fs-broker', 'virtual-drive.js');
  fs.mkdirSync(path.dirname(f), {recursive: true});
  fs.writeFileSync(f, 'module.exports = {};\n');
};
const sandboxOf = (args) => args.filter((a, i, all) => a === '--moduleSandbox' || all[i - 1] === '--moduleSandbox');

test('on Windows with a runtime older than countinghouse#195: audit, said; an explicit enforce refused, starting nothing', async () => {
  const home = installedHome();
  const f = io(home, {platform: 'win32'});
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.deepStrictEqual(sandboxOf(f.spawned[0].args), ['--moduleSandbox', 'audit']);
  assert.match(f.err, /the installed countinghouse cannot run --moduleSandbox enforce on Windows \(it is older than countinghouse#195\): running audit; `ch-local upgrade` installs one that can/);
  for (const passThrough of [['--moduleSandbox', 'enforce'], ['--moduleSandbox=enforce']]) {
    const g = io(home, {platform: 'win32'});
    assert.notStrictEqual(await start({passThrough}, g), 0);
    assert.strictEqual(g.spawned.length, 0, 'nothing started');
    assert.match(g.err, /--moduleSandbox enforce needs a countinghouse that runs it on Windows .*issues\/195\), and the installed one is older: run `ch-local upgrade`, or use --moduleSandbox audit until then\./);
  }
  const off = io(home, {platform: 'win32'});
  assert.notStrictEqual(await start({passThrough: ['--moduleSandbox', 'off']}, off), 0);
  assert.match(off.err, /with the installed countinghouse a pack runs under audit on Windows/);
  // a stored enforce is read, and audit runs
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {moduleSandbox: 'enforce'}}));
  const w = io(home, {platform: 'win32'});
  assert.strictEqual(await start({passThrough: []}, w), 0, w.err);
  assert.deepStrictEqual(sandboxOf(w.spawned[0].args), ['--moduleSandbox', 'audit']);
});

test('on Windows with a runtime that has countinghouse#195: enforce by default, an explicit enforce passed, a stored audit honoured', async () => {
  const home = installedHome();
  withWindowsEnforce(home);
  const f = io(home, {platform: 'win32'});
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.deepStrictEqual(sandboxOf(f.spawned[0].args), ['--moduleSandbox', 'enforce']);
  assert.doesNotMatch(f.err, /cannot run --moduleSandbox enforce/);
  const g = io(home, {platform: 'win32'});
  assert.strictEqual(await start({passThrough: ['--moduleSandbox', 'enforce']}, g), 0, g.err);
  assert.deepStrictEqual(sandboxOf(g.spawned[0].args), ['--moduleSandbox', 'enforce'], 'once, as passed');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {moduleSandbox: 'audit'}}));
  const h = io(home, {platform: 'win32'});
  assert.strictEqual(await start({passThrough: []}, h), 0, h.err);
  assert.deepStrictEqual(sandboxOf(h.spawned[0].args), ['--moduleSandbox', 'audit']);
});

test('a stored moduleSandbox audit reaches the runtime once', async () => {
  const home = installedHome();
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {moduleSandbox: 'audit'}}));
  const f = io(home, {platform: 'linux'});
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.deepStrictEqual(sandboxOf(f.spawned[0].args), ['--moduleSandbox', 'audit']);
});

// C4b: ch-local daemon's runtime, start in session mode (countinghouse #236)
test('start in session mode: framework.js on --sessionSocket, never --stdio, and the same profile otherwise', {skip: POSIX_ONLY}, async () => {
  const home = installedHome();
  const f = io(home);
  const socket = path.join(home, 'run', 'daemon', 'sessions.sock');
  assert.strictEqual(await start({passThrough: [], session: {socket, home}}, ghLoggedIn(f)), 0, f.err);
  const {args} = f.spawned[0];
  assert.strictEqual(args[0], path.join(home, 'app', 'node_modules', 'countinghouse', 'framework.js'));
  assert.strictEqual(valueOf(args, '--sessionSocket'), socket);
  assert.ok(!args.includes('--stdio') && !args.some((a) => /countinghouse-stdio/.test(a)), 'no stdio');
  assert.strictEqual(valueOf(args, '--store'), 'local');
  assert.strictEqual(valueOf(args, '--controlChannel'), 'ipc');
  assert.strictEqual(valueOf(args, '--storePath'), path.join(home, 'store'));
});

test('start in session mode refuses a path it would pass that resolves outside the home, and starts nothing', {skip: process.platform === 'win32'}, async () => {
  const home = installedHome();
  const outside = tmp('ch-local-outside-');
  // the app's countinghouse is a link out of the home
  const at = path.join(home, 'app', 'node_modules', 'countinghouse');
  fs.renameSync(at, path.join(outside, 'countinghouse'));
  fs.symlinkSync(path.join(outside, 'countinghouse'), at);
  const f = io(home);
  const code = await start({passThrough: [], session: {socket: path.join(home, 'run', 'daemon', 'sessions.sock'), home}}, ghLoggedIn(f));
  assert.notStrictEqual(code, 0);
  assert.strictEqual(f.spawned.length, 0);
  assert.match(f.err, /outside the home/);
});

// C4b's review: the session runtime's home, signals, group and environment
test('start in session mode takes its home from session.home, not the environment, which holds only the allowlist', {skip: POSIX_ONLY}, async () => {
  const home = installedHome();
  const f = io(home, {env: {PATH: '/usr/bin', HOME: '/home/dev', NODE_OPTIONS: '--require /tmp/x.js', GITHUB_TOKEN: 'example-shell-token'}});
  delete f.env.COUNTINGHOUSE_HOME;   // the shim's cleared environment never carries it
  f.exec = async(cmd) => (cmd === 'gh' ? {status: 0, stdout: 'gho_exampleexampleexample\n'} : {status: 0, stdout: ''});
  const socket = path.join(home, 'run', 'daemon', 'sessions.sock');
  assert.strictEqual(await start({passThrough: [], session: {socket, home}}, f), 0, f.err);
  const {args, env} = f.spawned[0];
  assert.strictEqual(valueOf(args, '--storePath'), path.join(home, 'store'), 'the home named, not ~/.countinghouse');
  assert.strictEqual(args[0], path.join(home, 'app', 'node_modules', 'countinghouse', 'framework.js'));
  // the runtime's environment: the allowlist, and the one token start adds
  assert.deepStrictEqual(Object.keys(env).sort(), ['COUNTINGHOUSE_GITHUB_TOKEN', 'HOME', 'PATH']);
  assert.strictEqual(env.COUNTINGHOUSE_GITHUB_TOKEN, 'gho_exampleexampleexample');
});

test('start in session mode traps only SIGINT and SIGTERM, and runs the runtime in its own process group', {skip: POSIX_ONLY}, async () => {
  const home = installedHome();
  const f = io(home);
  assert.strictEqual(await start({passThrough: [], session: {socket: path.join(home, 'run', 'daemon', 'sessions.sock'), home}}, ghLoggedIn(f)), 0, f.err);
  assert.deepStrictEqual(f.trapped, ['SIGINT', 'SIGTERM']);
  assert.strictEqual(f.detached, true);
  const g = io(installedHome());
  await start({passThrough: []}, g);
  assert.strictEqual(g.trapped, undefined, 'a stdio start traps as before');
  assert.notStrictEqual(g.detached, true);
});

test('start in session mode: an aborted signal kills the runtime, and the start ends', {skip: POSIX_ONLY}, async () => {
  const home = installedHome();
  const f = io(home);
  let finish = null;
  f.spawn = (cmd, args) => { f.spawned.push({cmd, args}); return {kill: (sig) => { f.killed.push(sig); finish(143); }, exited: new Promise((r) => { finish = r; })}; };
  const ac = new AbortController();
  const done = start({passThrough: [], session: {socket: path.join(home, 'run', 'daemon', 'sessions.sock'), home, signal: ac.signal}}, ghLoggedIn(f));
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  assert.strictEqual(await done, 143);
  assert.deepStrictEqual(f.killed, ['SIGTERM']);
});

test('start in session mode passes on the runtime\'s listening message', {skip: POSIX_ONLY}, async () => {
  const home = installedHome();
  const f = io(home);
  let deliver = null;
  f.spawn = (cmd, args) => { f.spawned.push({cmd, args}); return {kill: () => {}, exited: new Promise(() => {}), send: () => {}, onMessage: (fn) => { deliver = fn; }}; };
  const heard = [];
  const socket = path.join(home, 'run', 'daemon', 'sessions.sock');
  start({passThrough: [], session: {socket, home, onListening: (m) => heard.push(m)}}, ghLoggedIn(f));
  for (let i = 0; i < 50 && deliver == null; i++) await new Promise((r) => setTimeout(r, 10));
  deliver({type: 'listening', socket});
  deliver({type: 'listening', socket, id: 3});   // with an id it is a reply, not this
  assert.deepStrictEqual(heard, [{type: 'listening', socket}]);
});

// the shim's own-runtime hand-over (the review of ch-local #29):
// `start --stdio --own-runtime --home <abs> <pass-through>`
test('start --home names the home, over COUNTINGHOUSE_HOME; --own-runtime is taken; both before the pass-through', async () => {
  const {main} = require('../bin/ch-local');
  const home = installedHome();
  const other = installedHome();
  const f = io(other);   // COUNTINGHOUSE_HOME names another home
  assert.strictEqual(await main(['start', '--stdio', '--own-runtime', '--home', home, '--locale', 'en'], f), 0, f.err);
  const {args} = f.spawned[0];
  // --home is taken by its real path (macOS: /var is a link to /private/var)
  assert.strictEqual(valueOf(args, '--storePath'), path.join(fs.realpathSync(home), 'store'), 'the --home given, not COUNTINGHOUSE_HOME');
  assert.ok(!args.includes('--own-runtime') && !args.includes('--home'), 'neither reaches the runtime');
  assert.ok(args.includes('--locale'), 'the pass-through still does');
});

test('start --home must be absolute and an existing directory, and is refused with exit 2 otherwise', async () => {
  const {main} = require('../bin/ch-local');
  const home = installedHome();
  for (const bad of [['--home'], ['--home', 'relative/home'], ['--home', path.join(home, 'missing')]]) {
    const f = io(home);
    assert.strictEqual(await main(['start', '--stdio', ...bad], f), 2, `${bad.join(' ')}: ${f.err}`);
    assert.strictEqual(f.spawned.length, 0);
  }
});

// the review of #32 (c7c6923): a runtime that ignores SIGTERM, and an abort
// before the spawn
test('start in session mode: a runtime that ignores SIGTERM gets SIGKILL after the bound', {skip: POSIX_ONLY}, async () => {
  const home = installedHome();
  const f = ghLoggedIn(io(home));
  f.sessionKillMs = 200;
  let finish = null;
  f.spawn = (cmd, args) => { f.spawned.push({cmd, args}); return {kill: (sig) => { f.killed.push(sig); if (sig === 'SIGKILL') finish(137); }, exited: new Promise((r) => { finish = r; })}; };
  const ac = new AbortController();
  const done = start({passThrough: [], session: {socket: path.join(home, 'run', 'daemon', 'sessions.sock'), home, signal: ac.signal}}, f);
  await new Promise((r) => setTimeout(r, 50));
  ac.abort();
  assert.strictEqual(await done, 137);
  assert.deepStrictEqual(f.killed, ['SIGTERM', 'SIGKILL']);
});

test('start in session mode: an abort while it waits for the home\'s lock ends the wait, with nothing spawned', {skip: POSIX_ONLY}, async () => {
  const home = installedHome();
  const f = ghLoggedIn(io(home));
  // a live holder on this host: the wait would go on
  const {lockHost} = require('../lib/lock');
  fs.writeFileSync(path.join(home, 'packs.lock'), JSON.stringify({pid: process.pid, host: lockHost(), at: new Date().toISOString()}) + '\n');
  const ac = new AbortController();
  const done = start({passThrough: [], session: {socket: path.join(home, 'run', 'daemon', 'sessions.sock'), home, signal: ac.signal}}, f);
  await new Promise((r) => setTimeout(r, 300));
  ac.abort();
  const code = await Promise.race([done, new Promise((r) => setTimeout(() => r('still waiting'), 3000))]);
  assert.notStrictEqual(code, 'still waiting');
  assert.notStrictEqual(code, 0);
  assert.strictEqual(f.spawned.length, 0);
});

test('start --home must be owned by this user and not group- or world-writable', {skip: process.platform === 'win32'}, async () => {
  const {main} = require('../bin/ch-local');
  const home = installedHome();
  fs.chmodSync(home, 0o777);
  const f = io(home);
  assert.strictEqual(await main(['start', '--stdio', '--own-runtime', '--home', home], f), 2, f.err);
  assert.match(f.err, /writable/);
  assert.strictEqual(f.spawned.length, 0);
});

test('start\'s own runtime (--home) is given only paths under the home, as session mode is', {skip: process.platform === 'win32'}, async () => {
  const {main} = require('../bin/ch-local');
  const home = installedHome();
  const outside = tmp('ch-local-outside-');
  const at = path.join(home, 'app', 'node_modules', 'countinghouse');
  fs.renameSync(at, path.join(outside, 'countinghouse'));
  fs.symlinkSync(path.join(outside, 'countinghouse'), at);
  const f = io(home);
  assert.notStrictEqual(await main(['start', '--stdio', '--own-runtime', '--home', home], f), 0);
  assert.strictEqual(f.spawned.length, 0);
  assert.match(f.err, /outside the home/);
});

// C3a: the daemon's table and requests, through start's session mode
test('start in session mode sends the daemon\'s restore first, passes the table\'s tells on, and hands the daemon a request sender', {skip: POSIX_ONLY}, async () => {
  const home = installedHome();
  const f = ghLoggedIn(io(home));
  const sent = [];
  let deliver = null;
  f.spawn = (cmd, args) => {
    f.spawned.push({cmd, args});
    return {kill: () => {}, exited: new Promise(() => {}), send: (m) => { sent.push(m); if (m.type === 'restore' || m.type === 'idle-stop') deliver({id: m.id, ok: true}); }, onMessage: (fn) => { deliver = fn; }};
  };
  const told = [];
  let request = null;
  const table = {type: 'restore', sessions: [], declines: []};
  start({passThrough: [], session: {socket: path.join(home, 'run', 'daemon', 'sessions.sock'), home, restore: () => table, onTold: (m) => told.push(m), onControl: (fn) => { request = fn; }}}, f);
  for (let i = 0; i < 100 && deliver == null; i++) await new Promise((r) => setTimeout(r, 10));
  deliver({type: 'ready'});
  for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(sent[0].type, 'restore', 'the restore is the first request');
  assert.deepStrictEqual(Object.assign({}, sent[0], {id: undefined}), Object.assign({}, table, {id: undefined}));
  for (const m of [{type: 'session-resume', session: 'a'.repeat(32), hash: 'f'.repeat(64)}, {type: 'session-state', session: 'a'.repeat(32), state: {}}, {type: 'session-gone', session: 'a'.repeat(32)}, {type: 'decline', kind: 'pack', at: 1}, {type: 'idle'}, {type: 'busy'}]) deliver(m);
  assert.deepStrictEqual(told.map((m) => m.type), ['session-resume', 'session-state', 'session-gone', 'decline', 'idle', 'busy']);
  assert.strictEqual(typeof request, 'function');
  const answer = await request({type: 'idle-stop'});
  assert.strictEqual(answer.ok, true);
});
