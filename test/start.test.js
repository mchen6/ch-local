'use strict';
require('./tmp-dirs');
const {unhomed} = require('./unhomed');

// ch-local start --stdio (plan Task 11; reviewer, 2026-11-12): the
// single-identity profile of LM1 with every installed pack whose credential is
// present, the one per-user store, the sandbox never off, the remote
// credentials as the union of the loaded packs' remotes, and no device config
// (the scenario's defaultRepo is its own setting: #413 rev 3, P1 and P3).
const test = require('node:test');
// (Node 22.16's runner: see test/keep-alive.js)
require('./keep-alive');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo, tmp} = require('./fake-io');
const {start, repoFromRemote, readOrigin} = require('../lib/start');
const {main} = require('../bin/ch-local');
const {storeModule, writeHome, setPackCredentials} = require('./store-helpers');
const credentialStore = require('../lib/credential-store');
const ACCESS = '@countinghouse/ch-access-github';
const VAR = 'COUNTINGHOUSE_GITHUB_TOKEN';
const GH_ORIGIN = 'https://api.githubcopilot.com';
// the value a test home's binding holds (no real token's shape)
const STORED = 'test-stored-value-1';
const OTHER = '@countinghouse/ch-pack-other';
const OTHER_ORIGIN = 'https://api.other.example';
const OTHER_REMOTE = {name: 'other', url: `${OTHER_ORIGIN}/mcp/`, credential: 'OTHER_TOKEN'};
const bindOther = (home, value = 'test-stored-value-2') => credentialStore.bind(home, OTHER, 'OTHER_TOKEN', {origin: OTHER_ORIGIN, source: 'stored', value}, {held: require('./store-helpers').FIXTURE_HELD});
const bindGh = (home) => credentialStore.bind(home, ACCESS, VAR, {origin: GH_ORIGIN, source: 'gh'}, {held: require('./store-helpers').FIXTURE_HELD});

const GITHUB = {name: 'github', transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/',
  credential: {env: 'COUNTINGHOUSE_GITHUB_TOKEN', fallbackEnv: 'GITHUB_TOKEN', header: 'Authorization', scheme: 'Bearer'}};
const SCENARIO = '@countinghouse/ch-pack-ci-failure-triage';

// A home with ci-failure-triage installed: its modules in the module store,
// modules.json, and the runtime in the app.
// bound: the value stored for ch-access-github's credential, to its
// declared origin (null: none stored); boundTo: another origin to bind it to
function installedHome({remotes = [GITHUB], unreleased = false, other = false, bound = STORED, boundTo = GH_ORIGIN} = {}) {
  const home = tmp('ch-local-start-');
  const app = path.join(home, 'app', 'node_modules', 'countinghouse');
  fs.mkdirSync(app, {recursive: true});
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({name: 'countinghouse', version: '1.0.0'}));
  storeModule(home, SCENARIO, '1.0.0', {countinghouse: {role: 'scenario', calls: ['ch-access-github/githubService.listRuns']}});
  storeModule(home, '@countinghouse/ch-access-github', '1.0.0', {countinghouse: {role: 'part', remotes}});
  if (other) storeModule(home, '@countinghouse/ch-pack-other', '1.0.0', {countinghouse: {role: 'scenario', remotes: [OTHER_REMOTE]}});
  writeHome(home, {
    'ci-failure-triage': {[SCENARIO]: '1.0.0', '@countinghouse/ch-access-github': '1.0.0'},
    ...(other ? {other: {'@countinghouse/ch-pack-other': '1.0.0'}} : {})
  }, {unreleased, credentials: {'ci-failure-triage': ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN'], ...(other ? {other: ['OTHER_TOKEN']} : {})}});
  // a credential is the module's own, bound in the store (#413 section 6.3)
  if (bound != null) credentialStore.bind(home, ACCESS, VAR, {origin: boundTo, source: 'stored', value: bound}, {held: require('./store-helpers').FIXTURE_HELD});
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
  // (Windows simulated on another OS: the home's DACL as a private one, since
  // there is no PowerShell here to read it; on Windows the real one is read)
  if (platform === 'win32' && process.platform !== 'win32') {
    const ME = 'S-1-5-21-1-2-3-1001';
    f.winAcl = {fileAcl: () => ({user: ME, owner: ME, otherAces: false, rules: [{sid: ME, rights: 2032127, type: 'Allow', inheritOnly: false}]})};
  }
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
  f.spawn = (cmd, args, {env: childEnv, detached, output = null} = {}) => {
    f.detached = detached;
    f.output = output;
    const dir = args[args.indexOf('--deviceConfigPath') + 1];
    const config = {};
    const walk = (d, rel) => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else config[r] = JSON.parse(fs.readFileSync(path.join(d, e.name), 'utf8')); } };
    if (fs.existsSync(dir)) walk(dir, '');
    const rc = args[args.indexOf('--remoteCredentials') + 1];
    // the held-back file, as the runtime would read it, and its mode
    // (A-firstrun d1)
    const hb = args.includes('--heldBackFile') ? args[args.indexOf('--heldBackFile') + 1] : null;
    const heldBack = hb != null ? {path: hb, doc: JSON.parse(fs.readFileSync(hb, 'utf8')), mode: fs.lstatSync(hb).mode & 0o777, file: fs.lstatSync(hb).isFile()} : null;
    f.spawned.push({cmd, args, env: childEnv, config, remoteCredentials: JSON.parse(fs.readFileSync(rc, 'utf8')), heldBack});
    // A real spawn is synchronous: signals arrive once start holds the child.
    return {kill: (sig) => f.killed.push(sig), exited: Promise.resolve().then(() => { if (f.duringRun) f.duringRun(); return exit; })};
  };
  return f;
}

// the shared runtime (session mode) is POSIX-only until C4c, the Windows daemon
// the session runtime's environment allowlist is POSIX's here (Windows has
// its own keys: lib/shim-config.js)
const POSIX_ENV = process.platform === 'win32' && 'the POSIX environment allowlist';
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
  // from the module store (#413 section 9.8): the scenario by --loadModule,
  // each part by --partDir, under --modulesRoot
  assert.deepStrictEqual(args.filter((a, i) => args[i - 1] === '--loadModule'), [path.join(home, 'module-store', ...SCENARIO.split('/'), '1.0.0')]);
  assert.deepStrictEqual(args.filter((a, i) => args[i - 1] === '--partDir'), [path.join(home, 'module-store', '@countinghouse', 'ch-access-github', '1.0.0')]);
  // (and the user's own modules' copies: B-own-add)
  assert.deepStrictEqual(args.filter((a, i) => args[i - 1] === '--modulesRoot'), [path.join(home, 'module-store'), path.join(home, 'own')]);
  assert.ok(!args.includes('--packsRoot'));
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

// #413 section 6.4 (L5a): each usable binding gets a slot; the runtime's
// --remoteCredentials is version 2, per module, origin and variable
test('start gives the runtime its version 2 remote credentials: the module, its origin and variable, and the slot holding the stored value', async () => {
  const f = io(installedHome());
  await start({passThrough: []}, f);
  assert.deepStrictEqual(f.spawned[0].remoteCredentials, {version: 2, modules: {[ACCESS]: {[GH_ORIGIN]: {[VAR]: 'COUNTINGHOUSE_CREDENTIAL_1'}}}});
  assert.strictEqual(f.spawned[0].env.COUNTINGHOUSE_CREDENTIAL_1, STORED);
  assert.match(f.err, /sends COUNTINGHOUSE_GITHUB_TOKEN to https:\/\/api\.githubcopilot\.com for ch-access-github/);
  assert.ok(!f.err.includes(STORED), 'never a value');
});

// #83's high review, 5: one pack with a module missing from the store is
// not loaded, and said; the healthy packs still load
test('a pack with a module missing from the module store is not loaded, and said; the others load', async () => {
  const home = installedHome({other: true});
  fs.rmSync(path.join(home, 'module-store', '@countinghouse', 'ch-access-github', '1.0.0'), {recursive: true});
  bindOther(home);
  const f = io(home);
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  const loaded = f.spawned[0].args.filter((a, i, all) => all[i - 1] === '--loadModule');
  assert.deepStrictEqual(loaded.map((d) => path.basename(path.dirname(d))), ['ch-pack-other']);
  assert.match(f.err, /not loading ch-pack-ci-failure-triage: it calls ch-access-github, which is missing from the module store; run `(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local install` again/);
});

// a planted slot name in the client's environment is never read as a key,
// and a credential in the client's environment is never one (section 6.9)
test('every inherited COUNTINGHOUSE_CREDENTIAL_* is removed before the slots; a client\'s own token variables are no credential', async () => {
  const f = io(installedHome(), {env: {COUNTINGHOUSE_CREDENTIAL_1: 'planted-one', COUNTINGHOUSE_CREDENTIAL_7: 'planted-seven', GITHUB_TOKEN: 'from-the-client'}});
  await start({passThrough: []}, f);
  const env = f.spawned[0].env;
  assert.strictEqual(env.COUNTINGHOUSE_CREDENTIAL_1, STORED);
  assert.ok(!('COUNTINGHOUSE_CREDENTIAL_7' in env), 'a planted slot name is gone');
  const named = Object.values(f.spawned[0].remoteCredentials.modules).flatMap((o) => Object.values(o).flatMap((v) => Object.keys(v)));
  assert.deepStrictEqual(named, [VAR], 'only the module\'s own declared variable, never a client variable');
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

// section 6.6: a binding is used only for the origin it was entered for; a
// module that now declares another gets no key and is not loaded
test('a module whose declared origin is not the one its key was stored for gets no key and is not loaded, and is told why', async () => {
  const home = installedHome({remotes: [{...GITHUB, url: 'https://collector.example/mcp/'}]});
  const f = io(home);
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.deepStrictEqual(f.spawned[0].remoteCredentials, {version: 2, modules: {}});
  assert.ok(!('COUNTINGHOUSE_CREDENTIAL_1' in f.spawned[0].env));
  assert.match(f.err, /not loading ch-pack-ci-failure-triage: it calls ch-access-github, which sends its credential somewhere new: run `(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local credentials add ch-access-github` again/);
});


// #413 rev 3 (after P1 and P3): the scenario reads defaultRepo as its own
// setting, so start writes no device config; --deviceConfigPath still names
// the start's own empty directory, so the runtime never reads one from
// anywhere else (section 9.8).
test('start writes no device config, whatever the origin remote', async () => {
  for (const origin of ['https://github.com/octo/widgets.git', null]) {
    const f = io(installedHome(), {origin});
    assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
    assert.deepStrictEqual(f.spawned[0].config, {}, String(origin));
  }
});

test('the origin is read from the repository\'s config: a worktree\'s .git file and commondir, no repository, an unreadable cwd', () => {
  // A worktree: .git is a file naming its gitdir, whose commondir holds the config.
  const main = tmp('ch-local-main-');
  fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), {recursive: true});
  fs.writeFileSync(path.join(main, '.git', 'config'), '[remote "origin"]\n  url = "git@github.com:octo/from-worktree.git" ; a comment\n');
  fs.writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  const wt = tmp('ch-local-wt-');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
  assert.strictEqual(repoFromRemote(readOrigin(wt)), 'octo/from-worktree');
  for (const cwd of [tmp('ch-local-norepo-'), null, '/does/not/exist']) assert.strictEqual(repoFromRemote(readOrigin(cwd)), null, String(cwd));
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

test('start names the credential and never prints a value; with none stored it loads nothing that needs one, and says how to add it', async () => {
  const home = installedHome();
  const f = io(home);
  await start({passThrough: []}, f);
  assert.match(f.err, /loading ch-pack-ci-failure-triage/);
  assert.match(f.err, /sends COUNTINGHOUSE_GITHUB_TOKEN to https:\/\/api\.githubcopilot\.com for ch-access-github/);
  assert.ok(!(f.out + f.err).includes(STORED));
  assert.strictEqual(f.out, '', 'stdout is the MCP channel: start writes nothing there');
  // none stored: a token in the client's environment is no credential (section 6.9)
  const none = io(installedHome({bound: null}), {env: {GITHUB_TOKEN: 'from-the-client', COUNTINGHOUSE_GITHUB_TOKEN: 'from-the-client'}});
  assert.strictEqual(await start({passThrough: []}, none), 0, none.err);
  assert.strictEqual(none.spawned.length, 1);
  assert.ok(!none.spawned[0].args.includes('--loadModule'), 'the runtime starts with no module');
  assert.match(none.err, /not loading ch-pack-ci-failure-triage: it calls ch-access-github, which needs a credential: run `(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local credentials add ch-access-github`/);
});

// A-firstrun d1 (countinghouse #490): what start held back reaches the
// runtime's overview, by name and reason class, in a private file in its run
// directory; the launcher only where the home has one
test('start passes the runtime what it held back: the pack calls a module with no credential, by name and reason, never a value', async () => {
  const none = io(installedHome({bound: null}), {env: {GITHUB_TOKEN: 'from-the-client'}});
  assert.strictEqual(await start({passThrough: []}, none), 0, none.err);
  const hb = none.spawned[0].heldBack;
  assert.ok(hb != null, 'the flag is passed');
  assert.ok(hb.path.startsWith(path.join(none.env.COUNTINGHOUSE_HOME, 'run')) && path.basename(hb.path) === 'held-back.json', hb.path);
  assert.deepStrictEqual(hb.doc.modules, [{name: '@countinghouse/ch-pack-ci-failure-triage', reason: 'calls', root: 'credential', via: '@countinghouse/ch-access-github'}]);
  assert.deepStrictEqual(Object.keys(hb.doc).sort(), hb.doc.launcher != null ? ['launcher', 'modules', 'v'] : ['modules', 'v']);
  if (hb.doc.launcher != null) assert.strictEqual(hb.doc.launcher, fs.realpathSync.native(path.join(none.env.COUNTINGHOUSE_HOME, 'bin', 'ch-local.js')));
  assert.ok(hb.file, 'a regular file');
  if (process.platform !== 'win32') assert.strictEqual(hb.mode, 0o600);
  assert.ok(!JSON.stringify(hb.doc).includes('from-the-client') && !JSON.stringify(hb.doc).includes('GITHUB_TOKEN'));
  // everything loaded: nothing held back
  const all = io(installedHome());
  assert.strictEqual(await start({passThrough: []}, all), 0, all.err);
  assert.deepStrictEqual(all.spawned[0].heldBack.doc.modules, []);
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

test('start loads every installed module whose credential is stored, one --loadModule each; one without says how to add it', async () => {
  const home = installedHome({other: true});
  bindOther(home);
  const both = io(home);
  assert.strictEqual(await start({passThrough: []}, both), 0, both.err);
  const args = both.spawned[0].args;
  assert.deepStrictEqual(args.filter((a, i) => args[i - 1] === '--loadModule').map((d) => path.relative(path.join(home, 'module-store'), path.dirname(d))),
    [path.join('@countinghouse', 'ch-pack-ci-failure-triage'), path.join('@countinghouse', 'ch-pack-other')]);
  assert.deepStrictEqual(Object.keys(both.spawned[0].remoteCredentials.modules).sort(), [ACCESS, OTHER]);
  const one = io(installedHome({other: true}));
  await start({passThrough: []}, one);
  assert.strictEqual(one.spawned[0].args.filter((a) => a === '--loadModule').length, 1);
  assert.match(one.err, /not loading ch-pack-other: it needs a credential \(OTHER_TOKEN, sent to https:\/\/api\.other\.example\): run `(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local credentials add ch-pack-other`/);
});

// By module (#413 section 5.2; L2a): a top-level module two packs record is
// loaded once, with one --partDir for each part of its closure; run.json
// begins with nothing stopped.
test('a top-level module two packs record is loaded once; each part of its closure gets one --partDir; run.json starts with nothing stopped', async () => {
  const home = installedHome();
  const {editHome} = require('./store-helpers');
  editHome(home, (r) => ({...r, packs: {...r.packs, twin: {from: {release: '1.0.0'}, modules: {...r.packs['ci-failure-triage'].modules}}}}));
  const {setPackCredentials} = require('./store-helpers');
  setPackCredentials(home, {'ci-failure-triage': ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN'], twin: ['GITHUB_TOKEN']});
  let run = null;
  const f = io(home, {env: {GITHUB_TOKEN: 'a'}});
  // this start's own ch-local (this record names none, so it is no other's)
  const self = '7.7.7';
  f.selfVersion = self;
  const spawn = f.spawn;
  f.spawn = (...a) => {
    const runs = path.join(home, 'run');
    for (const d of fs.readdirSync(runs)) { try { run = JSON.parse(fs.readFileSync(path.join(runs, d, 'run.json'), 'utf8')); } catch (e) { /* the daemon's */ } }
    return spawn(...a);
  };
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  const args = f.spawned[0].args;
  const named = (flag) => args.filter((a, i) => args[i - 1] === flag).map((d) => path.relative(path.join(home, 'module-store'), path.dirname(d)));
  assert.deepStrictEqual(named('--loadModule'), [path.join('@countinghouse', 'ch-pack-ci-failure-triage')]);
  assert.deepStrictEqual(named('--partDir'), [path.join('@countinghouse', 'ch-access-github')]);
  assert.strictEqual(f.err.split('\n').filter((l) => /^ch-local: loading /.test(l)).length, 1);
  assert.deepStrictEqual(run.stopped, {});
  // its own ch-local, for status to name a client still on another one (L1b-1)
  assert.strictEqual(run.chLocal, '7.7.7');
});

// the high review of L2a, 3: a start older than the record (a daemon or
// binary from before an upgrade) judges it by none of its own pins
test('a start the home was upgraded under is started by the record, not by its own pins', async () => {
  const home = installedHome();
  const {editHome} = require('./store-helpers');
  // the home's ch-local (its record's) is 9.9.9, this process 0.1.0: stale
  editHome(home, (r) => ({...r, release: {version: '9.9.9', security: null}, runtime: {versions: {...r.runtime.versions, '@countinghouse/ch-local': '9.9.9'}}}));
  const f = io(home);
  f.selfVersion = '0.1.0';
  // this start's own pins name none of the record's versions
  const {ALLOWLIST} = require('../lib/allowlist');
  f.release = {...ALLOWLIST, packs: {'ci-failure-triage': {packages: [SCENARIO, '@countinghouse/ch-access-github'], credentials: ['GITHUB_TOKEN']}}, pins: {}};
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  const args = f.spawned[0].args;
  assert.strictEqual(args.filter((a) => a === '--loadModule').length, 1, f.err);
  assert.ok(!/this release pins/.test(f.err), f.err);
  // (a running runtime takes it at a restart: the client's, or the shared one's: A5)
  assert.match(f.err, /ch-local in this home is now 9\.9\.9 \(upgraded\); restart your client to use it/);
});

// the medium review of the high round, 1: a record older than this
// ch-local (an upgrade not yet installed) is judged by this release's pins
test('a record of another release under the home\'s own ch-local is judged by this release\'s pins', async () => {
  const home = installedHome();
  const {editHome} = require('./store-helpers');
  editHome(home, (r) => ({...r, release: {version: '0.0.1', security: null}}));
  const f = io(home);
  const {ALLOWLIST} = require('../lib/allowlist');
  f.release = {...ALLOWLIST, packs: {'ci-failure-triage': {packages: [SCENARIO, '@countinghouse/ch-access-github'], credentials: ['GITHUB_TOKEN']}}, pins: {}};
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.strictEqual(f.spawned[0].args.filter((a) => a === '--loadModule').length, 0, f.err);
  assert.match(f.err, /this release pins no version of it; run `(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local install` again/);
  // (this process is not the home's own ch-local: its own launcher, the home
  // named: on POSIX as the variable before the command, on Windows in words
  // beside it)
  assert.match(f.err, process.platform === 'win32'
    ? /this home's record is not this ch-local's release; run `node "[^"]+" install --pack ci-failure-triage` \(with COUNTINGHOUSE_HOME set to "[^"]+"\) to bring the home to /
    : /this home's record is not this ch-local's release; run `(?:COUNTINGHOUSE_HOME="[^"]+" )?node "[^"]+" install --pack ci-failure-triage` to bring the home to /);
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

// Acceptance (reviewer, 2026-11-12): start passes --remoteOriginMap only under
// CH_LOCAL_DEV=1, from CH_LOCAL_REMOTE_MAP, never from a client's options. The
// runtime's own gate, COUNTINGHOUSE_ACCEPTANCE=1, is the caller's to set:
// start passes the environment through and never sets it.
// An acceptance run's own token, generated per run (scripts/acceptance.js).
const ACCEPTANCE_TOKEN = 'chacc_' + 'a'.repeat(48);

test('CH_LOCAL_REMOTE_MAP under CH_LOCAL_DEV=1 becomes --remoteOriginMap: an allowed origin to a loopback http target', async () => {
  const f = io(installedHome(), {env: {GITHUB_TOKEN: ACCEPTANCE_TOKEN, CH_LOCAL_DEV: '1', CH_LOCAL_REMOTE_MAP: 'https://api.githubcopilot.com=http://127.0.0.1:9745'}});
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  const args = f.spawned[0].args;
  assert.strictEqual(valueOf(args, '--remoteOriginMap'), 'https://api.githubcopilot.com=http://127.0.0.1:9745');
  assert.match(f.err, /acceptance: https:\/\/api\.githubcopilot\.com is sent to http:\/\/127\.0\.0\.1:9745/);
  assert.strictEqual(f.spawned[0].env.COUNTINGHOUSE_ACCEPTANCE, undefined, 'start never sets the runtime\'s own gate');
  const g = io(installedHome(), {env: {GITHUB_TOKEN: 'a'}});
  await start({passThrough: []}, g);
  assert.ok(!g.spawned[0].args.includes('--remoteOriginMap'), 'nothing without it');
});

test('CH_LOCAL_REMOTE_MAP is refused without CH_LOCAL_DEV=1, for an origin the launcher does not allow, or a target that is not loopback http', async () => {
  for (const [env, why] of [
    [{CH_LOCAL_REMOTE_MAP: 'https://api.githubcopilot.com=http://127.0.0.1:9'}, /CH_LOCAL_REMOTE_MAP needs CH_LOCAL_DEV=1/],
    [{CH_LOCAL_DEV: '1', CH_LOCAL_REMOTE_MAP: 'https://collector.example=http://127.0.0.1:9'}, /not an origin this launcher allows/],
    [{CH_LOCAL_DEV: '1', CH_LOCAL_REMOTE_MAP: 'https://api.githubcopilot.com=http://10.0.0.1:9'}, /http:\/\/127\.0\.0\.1:<port> or http:\/\/\[::1\]:<port>/],
    [{CH_LOCAL_DEV: '1', CH_LOCAL_REMOTE_MAP: 'nonsense'}, /CH_LOCAL_REMOTE_MAP/]
  ]) {
    const f = io(installedHome(), {env: {GITHUB_TOKEN: 'a', ...env}});
    assert.strictEqual(await start({passThrough: []}, f), 2, JSON.stringify(env));
    assert.match(f.err, why);
    assert.strictEqual(f.spawned.length, 0);
  }
  const p = io(installedHome(), {env: {GITHUB_TOKEN: 'a', CH_LOCAL_DEV: '1'}});
  assert.strictEqual(await start({passThrough: ['--remoteOriginMap', 'https://api.githubcopilot.com=http://127.0.0.1:9']}, p), 2, 'never from a client\'s options');
});

// The gates are environment variables, which a client's config can set too
// (review of the acceptance branch): under a map, only an acceptance run's own
// generated token is sent, so a real one never reaches whatever listens there.
test('under CH_LOCAL_REMOTE_MAP only an acceptance token gets a slot: another stored value is not given, and its module not loaded', async () => {
  const mapEnv = {CH_LOCAL_DEV: '1', COUNTINGHOUSE_ACCEPTANCE: '1', CH_LOCAL_REMOTE_MAP: 'https://api.githubcopilot.com=http://127.0.0.1:9745'};
  const f = io(installedHome(), {env: mapEnv});
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.ok(!('COUNTINGHOUSE_CREDENTIAL_1' in f.spawned[0].env), 'never a real key past the map');
  assert.match(f.err, /under an acceptance run's origin map only an acceptance token is given/);
  assert.ok(!f.err.includes(STORED), 'the value is never printed');
  const acc = io(installedHome({bound: 'chacc_test_value_1'}), {env: mapEnv});
  assert.strictEqual(await start({passThrough: []}, acc), 0, acc.err);
  assert.strictEqual(acc.spawned[0].env.COUNTINGHOUSE_CREDENTIAL_1, 'chacc_test_value_1');
});

// The GitHub token from `gh auth token` (maintainer's decision, 2026-11-13):
// read at start, held in memory, given to the runtime in its environment
// only; a plaintext
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

test('a binding whose source is gh: start asks gh once, gives its token in the slot only, never in a file or a line', async () => {
  const home = installedHome({bound: null});
  bindGh(home);
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
  assert.strictEqual(env.COUNTINGHOUSE_CREDENTIAL_1, token);
  assert.deepStrictEqual(remoteCredentials, {version: 2, modules: {[ACCESS]: {[GH_ORIGIN]: {[VAR]: 'COUNTINGHOUSE_CREDENTIAL_1'}}}});
  assert.match(f.err, /sends COUNTINGHOUSE_GITHUB_TOKEN to https:\/\/api\.githubcopilot\.com for ch-access-github \(your gh login's token, held in memory\)/);
  for (const text of [f.err, f.out, JSON.stringify(config), JSON.stringify(remoteCredentials), ...during, ...filesUnder(home)]) {
    assert.ok(!text.includes(token) && !text.includes(plain), 'no token value is written or said');
  }
  // a stored binding: gh is not asked at all
  const stored = withExec(io(installedHome()), ghAnswers({status: 0, stdout: `${madeToken()}\n`, stderr: ''}));
  await start({passThrough: []}, stored);
  assert.deepStrictEqual(stored.execs.filter((e) => e.cmd === 'gh'), []);
});

test('a gh binding with gh not installed: its module is not loaded, and the message names credentials add, whole within a notice (#147, M3)', async () => {
  const home = installedHome({bound: null});
  bindGh(home);
  const f = withExec(io(home, {env: {}}), ghAnswers({status: null, stdout: '', stderr: 'spawn gh ENOENT'}));
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.ok(!f.spawned[0].args.includes('--loadModule'), 'the runtime starts with no module');
  assert.match(f.err, /not loading ch-pack-ci-failure-triage: it calls ch-access-github, which has no gh token: run `(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local credentials add ch-access-github`/);
});

test('a gh binding with gh not logged in: gh\'s own output is never repeated', async () => {
  const leaked = madeToken();
  const home = installedHome({bound: null});
  bindGh(home);
  const f = withExec(io(home, {env: {}}), ghAnswers({status: 1, stdout: '', stderr: `no oauth token found for github.com ${leaked}`}));
  assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  assert.match(f.err, /has no gh token: run `/);
  assert.ok(!f.err.includes(leaked) && !f.err.includes('no oauth token'), f.err);
});




// The review of ch-local #13's re-check.
test('a settings file that is not valid stops start, saying why and how to fix it; nothing is spawned', async () => {
  const home = installedHome();
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {locale: 'zh', maxOutputBytes: 1}}));
  const f = io(home);
  assert.notStrictEqual(await start({passThrough: []}, f), 0);
  assert.match(f.err, /maxOutputBytes = 1, which is not allowed: not starting; fix it \(`(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local settings reset` replaces every setting with its default, asking first if that loosens one\)/);
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
  // (the lock goes once start says it waits, never on a clock: on Windows the
  // home's ACL read before it can take seconds; a bound so a wait never said
  // fails, never hangs)
  const write = f.stderr.write.bind(f.stderr);
  const bound = setTimeout(() => fs.rmSync(lock, {force: true}), 60000);
  f.stderr.write = (x) => { const r = write(x); if (/waiting for another ch-local/.test(String(x))) setTimeout(() => fs.rmSync(lock, {force: true}), 50); return r; };
  try {
    assert.strictEqual(await start({passThrough: []}, f), 0, f.err);
  } finally {
    clearTimeout(bound);
  }
  assert.match(f.err, /waiting for another ch-local \(pid \d+\) to finish changing this home/);
  assert.doesNotMatch(f.err, /remove/);
  assert.strictEqual(f.spawned.length, 1);
});

// post-rel packs.lock protocol (its medium, 1 and 2): another host's lock
// that stops changing is given up on at start's cap, and the start fails,
// spawning nothing, never going on without the lock; one still renewed (its
// mtime changing, by this host's clock) is waited for
test('start against another host\'s abandoned lock fails at its cap, spawning nothing; one still being renewed is waited for', async () => {
  const home = installedHome();
  const lock = path.join(home, 'packs.lock');
  fs.writeFileSync(lock, JSON.stringify({pid: 1, host: 'elsewhere', at: 'x'}));
  const f = Object.assign(io(home), {lockWaitMs: 300});
  assert.notStrictEqual(await start({passThrough: []}, f), 0);
  assert.match(f.err, /if nothing is running on elsewhere/);
  assert.match(f.err, /the home's lock could not be taken; nothing was started/);
  assert.strictEqual(f.spawned.length, 0);
  assert.ok(!fs.existsSync(path.join(home, 'run')) || fs.readdirSync(path.join(home, 'run')).every((n) => !n.includes(String(f.pid))), 'no run directory');
  // renewed every 200 ms for 3 s against a 1.5 s cap, then released: waited
  // for, and started (wide margins for a loaded CI runner: #104's high)
  const g = Object.assign(io(home), {lockWaitMs: 1500});
  const renew = setInterval(() => { const t = new Date(); try { fs.utimesSync(lock, t, t); } catch (e) { /* gone */ } }, 200);
  setTimeout(() => { clearInterval(renew); fs.rmSync(lock, {force: true}); }, 3000);
  assert.strictEqual(await start({passThrough: []}, g), 0, g.err);
  assert.strictEqual(g.spawned.length, 1);
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
  windowsLine(f.err);
  for (const passThrough of [['--moduleSandbox', 'enforce'], ['--moduleSandbox=enforce']]) {
    const g = io(home, {platform: 'win32'});
    assert.notStrictEqual(await start({passThrough}, g), 0);
    assert.strictEqual(g.spawned.length, 0, 'nothing started');
    assert.match(g.err, /--moduleSandbox enforce needs a countinghouse that runs it on Windows .*issues\/195\), and the installed one is older: run `(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local upgrade`, or use --moduleSandbox audit until then\./);
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

// The maintainer's decision: under audit, countinghouse refuses a pack's
// file writes outside its own area; reads are allowed and logged. A process,
// a thread or native code a pack starts is reported, not stopped: only
// enforce confines it. Start says so, once, whenever the runtime runs under
// audit.
// the Windows line, as sent: its upgrade command whole at the end; its words
// whole unless the test's home is long enough to fit it to the cut ("…")
// (at a home so long the command alone takes the cut, only the command is
// sent: the 1.1 row on fitNotice's tail)
const windowsLine = (err) => {
  const line = err.split('\n').find((l) => /^ch-local: (this countinghouse is |`)/.test(l) && /upgrade` installs one that can$/.test(l));
  assert.ok(line != null, err);
  if (!/…/.test(line) && !/^ch-local: `/.test(line)) assert.ok(line.startsWith('ch-local: this countinghouse is older than countinghouse#195: it cannot enforce the sandbox on Windows, so it runs audit; '), line);
};
const AUDIT_TEXT = /^ch-local: under audit, countinghouse logs what a pack reads and refuses its file writes outside its own area; it does not stop a module that starts a process, a thread or native code: enforce refuses those$/gm;
test('audit, passed, stored or forced on Windows, says what it watches and that it refuses writes outside the pack\'s area, once', async () => {
  const count = (f) => (f.err.match(AUDIT_TEXT) || []).length;
  const home = installedHome();
  const passed = io(home, {platform: 'linux'});
  assert.strictEqual(await start({passThrough: ['--moduleSandbox', 'audit']}, passed), 0, passed.err);
  assert.strictEqual(count(passed), 1, passed.err);
  // (one notice, within the runtime's 200-character cut: the final pass, L2)
  assert.ok(require('./notice-length').atRealisticHome(passed.err.match(AUDIT_TEXT)[0].replace(/^ch-local: /, '')) <= 200);
  const enforce = io(home, {platform: 'linux'});
  assert.strictEqual(await start({passThrough: []}, enforce), 0, enforce.err);
  assert.strictEqual(count(enforce), 0, 'never under enforce');
  const windows = io(home, {platform: 'win32'});
  assert.strictEqual(await start({passThrough: []}, windows), 0, windows.err);
  assert.strictEqual(count(windows), 1, `in WINDOWS_AUDIT, and not twice: ${windows.err}`);
  // (whole at a typical home's launcher; this test's home, with no launcher,
  // names the npx form with its home, so the explanation is cut before it)
  windowsLine(windows.err);
  // (at a user's home: the npx form's home as long as a typical one)
  // (one fitted to the cut, "…" before its command, measured as sent)
  const atHome = (l) => { const t = l.replace(/^ch-local: /, ''); return /…/.test(t) ? [...t].length : require('./notice-length').atRealisticHome(t.replace(/COUNTINGHOUSE_HOME="[^"]*"/g, 'COUNTINGHOUSE_HOME="/home/alexandra/.countinghouse"')); };
  for (const l of windows.err.split('\n').filter((x) => /countinghouse#195|under audit/.test(x))) assert.ok(atHome(l) <= 200, `${atHome(l)}: ${l}`);
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({version: 1, values: {moduleSandbox: 'audit'}}));
  const stored = io(home, {platform: 'linux'});
  assert.strictEqual(await start({passThrough: []}, stored), 0, stored.err);
  assert.strictEqual(count(stored), 1, stored.err);
});

// C4b: ch-local daemon's runtime, start in session mode (countinghouse #236)
test('start in session mode: framework.js on --sessionSocket, never --stdio, and the same profile otherwise', async () => {
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

// C-daemon-log: a shared runtime's stdout and stderr go to the daemon's
// log; a client's own runtime keeps the client's
test('C-daemon-log: start in session mode hands the runtime\'s output to the daemon\'s log; a client\'s start never does', async () => {
  const home = installedHome();
  const runDir = path.join(home, 'run', 'daemon');
  const log = {forward() {}, write() { return true; }};
  const f = io(home);
  f.runtimeOutput = log;
  assert.strictEqual(await start({passThrough: [], session: {socket: path.join(runDir, 'sessions.sock'), sessionDir: runDir, home}}, ghLoggedIn(f)), 0, f.err);
  assert.strictEqual(f.output, log, 'the shared runtime\'s output: the log');
  const g = io(home);
  g.runtimeOutput = log;
  assert.strictEqual(await start({passThrough: []}, ghLoggedIn(g)), 0, g.err);
  assert.strictEqual(g.output, null, 'a client\'s own runtime: its client\'s stdio');
});

// C-daemon-log: what ch-local itself writes to the shared runtime's log
// never carries a stored credential: it reaches the runtime in its slot, and
// the log has every line start wrote (the runtime's own lines name keys by
// fingerprint only: countinghouse test/auth/29-no-keys-in-logs.js)
test('C-daemon-log: a stored credential reaches the shared runtime in its slot, and never the log', async () => {
  const home = installedHome();
  const runDir = path.join(home, 'run', 'daemon');
  fs.mkdirSync(runDir, {recursive: true, mode: 0o700});
  const log = require('../lib/runtime-log').openRuntimeLog(runDir, process.platform === 'win32'
    ? {platform: 'win32', acl: {createPrivate: (f, d) => fs.writeFileSync(f, d), fileAcl: () => ({}), privateProblem: () => null}} : {});
  const f = io(home);
  f.runtimeOutput = log;
  const plain = f.stderr;
  f.stderr = {write: (t) => { plain.write(t); log.write(t); return true; }};
  assert.strictEqual(await start({passThrough: [], session: {socket: path.join(runDir, 'sessions.sock'), sessionDir: runDir, home}}, ghLoggedIn(f)), 0, f.err);
  log.write('ch-local daemon: the end of the run');
  await log.close();
  assert.strictEqual(f.spawned[0].env.COUNTINGHOUSE_CREDENTIAL_1, STORED, 'it reached the runtime');
  const text = fs.readFileSync(log.file, 'utf8');
  assert.match(text, /the end of the run/, 'the log was written');
  assert.ok(!text.includes(STORED), 'never in the log');
  assert.ok(!f.err.includes(STORED));
});

// C4c: --sessionDir, and the one socket that may be outside the home
test('start in session mode passes --sessionDir, the daemon\'s run directory, after --sessionSocket', async () => {
  const home = installedHome();
  const f = io(home);
  const runDir = path.join(home, 'run', 'daemon');
  const socket = path.join(runDir, 'sessions.sock');
  assert.strictEqual(await start({passThrough: [], session: {socket, sessionDir: runDir, home}}, ghLoggedIn(f)), 0, f.err);
  assert.strictEqual(valueOf(f.spawned[0].args, '--sessionSocket'), socket);
  assert.strictEqual(valueOf(f.spawned[0].args, '--sessionDir'), runDir);
});

test('start in session mode: a --sessionDir outside the home is refused; so is a socket outside it, but for the daemon\'s own long-home fallback', {skip: process.platform === 'win32' && 'POSIX socket paths'}, async () => {
  const home = installedHome();
  const outside = tmp('ch-local-outside-');
  const refused = async(session) => {
    const f = io(home);
    const code = await start({passThrough: [], session: Object.assign({home}, session)}, ghLoggedIn(f));
    return {code, f};
  };
  const runDir = path.join(home, 'run', 'daemon');
  let r = await refused({socket: path.join(runDir, 'sessions.sock'), sessionDir: outside});
  assert.notStrictEqual(r.code, 0);
  assert.match(r.f.err, /--sessionDir .* resolves outside the home/);
  r = await refused({socket: path.join(outside, 'sessions.sock'), sessionDir: runDir});
  assert.notStrictEqual(r.code, 0);
  assert.match(r.f.err, /--sessionSocket .* resolves outside the home/);
  // the fallback the daemon picks from this same environment's TMPDIR
  const f = io(home);
  f.env.TMPDIR = outside;
  const fallback = require('../lib/session-socket').fallbackSocket({env: f.env});
  assert.strictEqual(await start({passThrough: [], session: {socket: fallback, sessionDir: runDir, home}}, ghLoggedIn(f)), 0, f.err);
  assert.strictEqual(valueOf(f.spawned[0].args, '--sessionSocket'), fallback);
});

test('start in session mode on Windows: a pipe of the daemon\'s form is the socket, and nothing else outside the home', {skip: process.platform !== 'win32' && 'Windows only'}, async () => {
  const home = installedHome();
  const runDir = path.join(home, 'run', 'daemon');
  const pipe = require('../lib/session-socket').newPipeName();
  const f = io(home);
  assert.strictEqual(await start({passThrough: [], session: {socket: pipe, sessionDir: runDir, home}}, ghLoggedIn(f)), 0, f.err);
  assert.strictEqual(valueOf(f.spawned[0].args, '--sessionSocket'), pipe);
  const g = io(home);
  assert.notStrictEqual(await start({passThrough: [], session: {socket: '\\\\.\\pipe\\other', sessionDir: runDir, home}}, ghLoggedIn(g)), 0);
  assert.match(g.err, /--sessionSocket .* resolves outside the home/);
});

// C4b's review: the session runtime's home, signals, group and environment
test('start in session mode takes its home from session.home, not the environment, which holds only the allowlist', {skip: POSIX_ENV}, async () => {
  const home = installedHome();
  const f = io(home, {env: {PATH: '/usr/bin', HOME: '/home/dev', NODE_OPTIONS: '--require /tmp/x.js', GITHUB_TOKEN: 'example-shell-token'}});
  delete f.env.COUNTINGHOUSE_HOME;   // the shim's cleared environment never carries it
  f.exec = async(cmd) => (cmd === 'gh' ? {status: 0, stdout: 'gho_exampleexampleexample\n'} : {status: 0, stdout: ''});
  const socket = path.join(home, 'run', 'daemon', 'sessions.sock');
  assert.strictEqual(await start({passThrough: [], session: {socket, home}}, f), 0, f.err);
  const {args, env} = f.spawned[0];
  assert.strictEqual(valueOf(args, '--storePath'), path.join(home, 'store'), 'the home named, not ~/.countinghouse');
  assert.strictEqual(args[0], path.join(home, 'app', 'node_modules', 'countinghouse', 'framework.js'));
  // the runtime's environment: the allowlist, and the stored key's slot
  assert.deepStrictEqual(Object.keys(env).sort(), ['COUNTINGHOUSE_CREDENTIAL_1', 'HOME', 'PATH']);
  assert.strictEqual(env.COUNTINGHOUSE_CREDENTIAL_1, STORED);
});

test('start in session mode traps only SIGINT and SIGTERM, and runs the runtime in its own process group', async () => {
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

test('start in session mode: an aborted signal kills the runtime, and the start ends', async () => {
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

test('start in session mode passes on the runtime\'s listening message', async () => {
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

// what a start tells the client (notices over the control channel, which the
// runtime adds to the first result), with a runtime that answers every request
async function toldBy(argv, f) {
  const {main} = require('../bin/ch-local');
  const sent = [];
  let deliver = null;
  let end = null;
  f.spawn = (cmd, args) => {
    f.spawned.push({cmd, args});
    return {kill: () => {}, exited: new Promise((r) => { end = r; }), onMessage: (fn) => { deliver = fn; setImmediate(() => fn({type: 'ready'})); },
      send: (m) => { sent.push(m); if (deliver != null) deliver({id: m.id, ok: true}); }};
  };
  const done = main(argv, f);
  for (let i = 0; i < 200 && (end == null || !sent.some((m) => m.type === 'notice')); i++) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  if (end != null) end(0);
  assert.strictEqual(await done, 0, f.err);
  return sent.filter((m) => m.type === 'notice').map((m) => m.text);
}

// #236 section 5: a session the shim runs per-session says why, in its first
// result's notice; a credential is named, never its value
test('start --own-runtime tells why the session runs its own runtime: token, credential (per pack and variable), conditions-failed (with its why), or none given', async () => {
  const value = `example-${require('node:crypto').randomBytes(6).toString('hex')}`;
  const cases = [
    [['--own-runtime-reason', 'token'], /^this session chooses a GitHub token the shared runtime doesn't hold, so it runs its own runtime$/],
    // (no longer produced by this ch-local, still read from an older shim)
    [['--own-runtime-reason', 'credential'], /^a pack credential in this session's environment isn't the shared runtime's, so it runs its own runtime$/],
    [['--own-runtime-reason', 'conditions-failed', '--own-runtime-why', 'the conditions check timed out after 10 s\u202e\n\u2028'], /^the client checks could not run \(the conditions check timed out after 10 s   \), so this session runs its own runtime$/],
    [['--own-runtime-reason', 'conditions-failed', '--own-runtime-why', 'gh\u00ad hid\u{e0041}\u{e0042}den\ufff9 text'], /^the client checks could not run \(gh  hid  den  text\), so this session runs its own runtime$/],
    [['--own-runtime-reason', 'later-reason'], /^this session can't share the runtime \(later-reason\), so it runs its own$/],
    [['--own-runtime-reason', 'Bad Reason!'], /^this session can't share the runtime, so it runs its own$/]
  ];
  for (const [extra, want] of cases) {
    const home = installedHome({other: true});
    const f = io(home, {env: {GITHUB_TOKEN: 'example-shell-token', OTHER_TOKEN: value}});
    const told = await toldBy(['start', '--stdio', '--own-runtime', ...extra, '--home', home], f);
    assert.ok(told.some((t) => want.test(t)), `${extra.join(' ')}: ${told.join(' | ')}`);
    assert.ok(!told.some((t) => t.includes(value)) && !f.err.includes(value), 'never the value');
    const {args} = f.spawned[0];
    assert.ok(!args.some((a) => /own-runtime/.test(a)), 'none of it reaches the runtime');
  }
});

test('start --own-runtime with no reason (an older shim, or the startup and failed.json fallbacks) tells nothing of sharing', async () => {
  const home = installedHome({other: true});
  const told = await toldBy(['start', '--stdio', '--own-runtime', '--home', home], io(home, {env: {GITHUB_TOKEN: 'example-shell-token', OTHER_TOKEN: 'example-other'}}));
  assert.ok(!told.some((t) => /share the runtime|runs its own runtime/.test(t)), told.join(' | '));
});

test('--own-runtime-reason and --own-runtime-why only after --own-runtime, and never take an option as their value', async () => {
  const {main} = require('../bin/ch-local');
  const home = installedHome();
  for (const bad of [['--own-runtime-reason', 'token', '--home', home], ['--own-runtime', '--own-runtime-why', '--home', home], ['--own-runtime', '--own-runtime-reason']]) {
    const f = io(home);
    assert.strictEqual(await main(['start', '--stdio', ...bad], f), 2, `${bad.join(' ')}: ${f.err}`);
    assert.strictEqual(f.spawned.length, 0);
  }
});

// A8 (the final pass): the automatic upgrade check's lines went to start's
// stderr only, which in shared mode is the daemon's, so no client heard that
// an upgrade was applied, paused or failed. They are notices.
test('A8: what the automatic upgrade check says reaches the client as a notice, not stderr alone', async (t) => {
  t.mock.method(require('../lib/auto-upgrade'), 'autoCheck', async ({say}) => { say('upgraded ch-local 0.1.0 -> 0.1.1; a test line'); return {checked: true}; });
  const home = installedHome({other: true});
  const told = await toldBy(['start', '--stdio', '--home', home], io(home, {env: {GITHUB_TOKEN: 'example-shell-token', OTHER_TOKEN: 'example-other'}}));
  assert.ok(told.includes('upgraded ch-local 0.1.0 -> 0.1.1; a test line'), told.join(' | '));
});

test('A8: an upgrade line that comes after start ended is said on stderr alone, never as a notice no client gets', async (t) => {
  let late = null;
  t.mock.method(require('../lib/auto-upgrade'), 'autoCheck', ({say, signal}) => new Promise((r) => { late = () => { say('a late line'); r({checked: true}); }; signal.addEventListener('abort', () => setImmediate(late)); }));
  const home = installedHome({other: true});
  const f = io(home, {env: {GITHUB_TOKEN: 'example-shell-token', OTHER_TOKEN: 'example-other'}});
  const told = await toldBy(['start', '--stdio', '--home', home], f);
  for (let i = 0; i < 100 && !/a late line/.test(f.err); i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(f.err, /^ch-local: a late line$/m);
  assert.ok(!told.includes('a late line'));
  assert.doesNotMatch(f.err, /the client was not told: a late line/);
});

test('start without --own-runtime tells no such notice', async () => {
  const home = installedHome({other: true});
  const told = await toldBy(['start', '--stdio', '--home', home], io(home, {env: {GITHUB_TOKEN: 'example-shell-token', OTHER_TOKEN: 'example-other'}}));
  assert.ok(!told.some((t) => /runs its own runtime|so it runs its own/.test(t)), told.join(' | '));
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
test('start in session mode: a runtime that ignores SIGTERM gets SIGKILL after the bound', async () => {
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

test('start in session mode: an abort while it waits for the home\'s lock ends the wait, with nothing spawned', async () => {
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
test('start in session mode sends the daemon\'s restore first, passes the table\'s tells on, and hands the daemon a request sender', async () => {
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

// #54's diagnosis: with gh not logged in and no token, the daemon's shared
// runtime ended before it listened, and every client got only "no answer".
// Now it starts with no pack (ch-local's own tools), its restore first as
// ever, and the sessions are told which pack is not loaded and why.
test('start in session mode with no pack loadable: the shared runtime starts with no pack, and tells why', {skip: process.platform === 'win32' && 'a socket path: Windows names a pipe'}, async () => {
  const home = installedHome({bound: null});
  const f = withExec(io(home, {env: {}}), ghAnswers({status: 1, stdout: '', stderr: ''}));
  const sent = [];
  let deliver = null;
  let end = null;
  f.spawn = (cmd, args) => {
    f.spawned.push({cmd, args});
    return {kill: () => {}, exited: new Promise((r) => { end = r; }), onMessage: (fn) => { deliver = fn; },
      send: (m) => { sent.push(m); if (deliver != null) deliver({id: m.id, ok: true}); }};
  };
  const done = start({passThrough: [], session: {socket: path.join(home, 'run', 'daemon', 'sessions.sock'), home, restore: () => ({type: 'restore', sessions: [], declines: [], reset: []})}}, f);
  for (let i = 0; i < 100 && deliver == null; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(deliver != null, `the shared runtime was spawned: ${f.err}`);
  assert.ok(!f.spawned[0].args.includes('--loadModule'), 'with no pack');
  deliver({type: 'ready'});
  for (let i = 0; i < 100 && !sent.some((m) => m.type === 'notice' && /no pack is loaded/.test(m.text)); i++) await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(sent[0].type, 'restore', 'the restore is still the first request');
  const told = sent.filter((m) => m.type === 'notice').map((m) => m.text);
  assert.ok(told.some((t) => /^not loading ch-pack-ci-failure-triage: it calls ch-access-github, which needs a credential: run `(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local credentials add ch-access-github`/.test(t)), told.join(' | '));
  assert.ok(told.some((t) => /no module is loaded this start/.test(t)), told.join(' | '));
  end(0);
  await done;
});

test('start in session mode says how to add a missing credential, never to set a variable in a client\'s environment', {skip: process.platform === 'win32' && 'a socket path: Windows names a pipe'}, async () => {
  const home = installedHome({other: true});
  const f = io(home, {env: {}});
  const sent = [];
  let deliver = null;
  let end = null;
  f.spawn = (cmd, args) => {
    f.spawned.push({cmd, args});
    return {kill: () => {}, exited: new Promise((r) => { end = r; }), onMessage: (fn) => { deliver = fn; },
      send: (m) => { sent.push(m); if (deliver != null) deliver({id: m.id, ok: true}); }};
  };
  const done = start({passThrough: [], session: {socket: path.join(home, 'run', 'daemon', 'sessions.sock'), home, restore: () => ({type: 'restore', sessions: [], declines: [], reset: []})}}, f);
  for (let i = 0; i < 100 && deliver == null; i++) await new Promise((r) => setTimeout(r, 10));
  deliver({type: 'ready'});
  for (let i = 0; i < 100 && !sent.some((m) => m.type === 'notice' && /not loading ch-pack-other/.test(m.text)); i++) await new Promise((r) => setTimeout(r, 10));
  const told = sent.filter((m) => m.type === 'notice').map((m) => m.text);
  assert.ok(told.some((t) => unhomed(t) === 'not loading ch-pack-other: it needs a credential (OTHER_TOKEN, sent to https://api.other.example): run `npx @countinghouse\/ch-local credentials add ch-pack-other`'), told.join(' | '));
  assert.ok(!told.some((t) => /environment/.test(t)), told.join(' | '));
  end(0);
  await done;
});

test('start in session mode: a runtime that ends during its restore never reports a refusal; only an explicit one does (the review of #34)', async () => {
  const runWith = async(answer) => {
    const home = installedHome();
    const f = ghLoggedIn(io(home));
    let deliver = null;
    let end = null;
    f.spawn = (cmd, args) => {
      f.spawned.push({cmd, args});
      return {kill: () => {}, exited: new Promise((r) => { end = r; }), onMessage: (fn) => { deliver = fn; },
        send: (m) => { if (m.type === 'restore') setTimeout(() => answer(m, deliver, end), 10); }};
    };
    let refused = 0;
    const done = start({passThrough: [], session: {socket: path.join(home, 'run', 'daemon', 'sessions.sock'), home, restore: () => ({type: 'restore', sessions: [], declines: []}), onRestoreRefused: () => { refused += 1; }}}, f);
    for (let i = 0; i < 100 && deliver == null; i++) await new Promise((r) => setTimeout(r, 10));
    deliver({type: 'ready'});
    await new Promise((r) => setTimeout(r, 200));
    if (end != null) end(0);
    await done;
    await new Promise((r) => setTimeout(r, 50));
    return refused;
  };
  assert.strictEqual(await runWith((m, deliver, end) => end(1)), 0, 'a crash mid-restore is no refusal');
  assert.strictEqual(await runWith((m, deliver) => deliver({id: m.id, ok: false, code: 'CONTROL_NO_ANSWER'})), 0, 'nor is no answer');
  assert.strictEqual(await runWith((m, deliver) => deliver({id: m.id, ok: false, code: 'CONTROL_BAD_RESTORE'})), 1, 'an explicit refusal is');
  assert.strictEqual(await runWith((m, deliver) => deliver({id: m.id, ok: false, code: 'CONTROL_RESTORE_DONE'})), 1);
});

// the Reviewer's high review of L5a, 1: a runtime of its own starts from an
// allowlist, never the client's whole environment
test('a runtime of its own gets an allowlisted environment: no client credential of any name, whatever the modules declare', {skip: process.platform === 'win32' && 'the POSIX allowlist'}, async () => {
  const f = io(installedHome(), {env: {PATH: '/usr/bin', HOME: '/home/dev', LANG: 'en_US.UTF-8', LC_ALL: 'C', TZ: 'UTC', TMPDIR: '/tmp',
    NODE_EXTRA_CA_CERTS: '/etc/ca.pem', COUNTINGHOUSE_ACCEPTANCE: '1',
    OPENAI_API_KEY: 'client-1', ANTHROPIC_API_KEY: 'client-2', GITHUB_TOKEN: 'client-3', GH_TOKEN: 'client-4', AWS_SECRET_ACCESS_KEY: 'client-5', SOME_OTHER: 'client-6', NODE_OPTIONS: '--require /tmp/x.js'}});
  await start({passThrough: []}, f);
  const {env} = f.spawned[0];
  assert.deepStrictEqual(Object.keys(env).sort(), ['COUNTINGHOUSE_ACCEPTANCE', 'COUNTINGHOUSE_CREDENTIAL_1', 'HOME', 'LANG', 'LC_ALL', 'NODE_EXTRA_CA_CERTS', 'PATH', 'TMPDIR', 'TZ']);
  assert.ok(!Object.values(env).some((v) => /^client-/.test(v)));
});

// the Reviewer's high review of L5a, 6: the "sends" line only for what loads
test('start says where a key goes only for a module it loads this start', async () => {
  const home = installedHome({other: true});
  bindOther(home);
  assert.strictEqual(await main(['settings', 'set', 'enabled.@countinghouse/ch-pack-other', 'off'], Object.assign(io(home), {stdout: {write: () => {}}})), 0);
  const f = io(home);
  await start({passThrough: []}, f);
  assert.match(f.err, /sends COUNTINGHOUSE_GITHUB_TOKEN to https:\/\/api\.githubcopilot\.com for ch-access-github/);
  assert.ok(!/sends OTHER_TOKEN/.test(f.err), f.err);
  assert.ok('COUNTINGHOUSE_CREDENTIAL_2' in f.spawned[0].env, 'its slot is still given, for a later turn-on');
});

// #413 section 10: a token a client's configuration still sets is not read,
// said once
test('a COUNTINGHOUSE_GITHUB_TOKEN in the client\'s environment is said to be no longer read, once, and never used', async () => {
  const f = io(installedHome({bound: null}), {env: {COUNTINGHOUSE_GITHUB_TOKEN: 'from-the-client'}});
  await start({passThrough: []}, f);
  assert.strictEqual(unhomed(f.err).split('COUNTINGHOUSE_GITHUB_TOKEN in this client\'s environment is no longer read: run `npx @countinghouse\/ch-local credentials add ch-access-github`').length - 1, 1, f.err);
  assert.ok(!Object.values(f.spawned[0].env).includes('from-the-client'));
  assert.ok(!f.err.includes('from-the-client'));
});

// a proxy variable never reaches the runtime: countinghouse makes no call
// through a proxy, so one would only be readable by a module that declares it
test('start passes no proxy variable to a runtime of its own', {skip: process.platform === 'win32' && 'the POSIX allowlist'}, async () => {
  const f = io(installedHome(), {env: {PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy.example:3128', no_proxy: 'localhost'}});
  await start({passThrough: []}, f);
  assert.ok(!Object.keys(f.spawned[0].env).some((k) => /_proxy$/i.test(k)), JSON.stringify(Object.keys(f.spawned[0].env)));
});

// the reviewer on #124's round 20ab08e: "run install --pack <pack> to bring
// the home to <ours>" is run by the ch-local whose release is <ours>, the one
// that said it: from outside the home (a global ch-local over an older home),
// its own launcher, with the home named; from the home's own app, the home's
test('a record of another release: the install line names the ch-local that said it, never the home\'s launcher when that is another', async () => {
  const home = installedHome();
  const {editHome} = require('./store-helpers');
  // (the home's app is ch-local 0.5.0; its record's release, another)
  editHome(home, (r) => ({...r, release: {version: '0.0.1', security: null}, runtime: {...r.runtime, versions: {...r.runtime.versions, '@countinghouse/ch-local': '0.5.0'}}}));
  const {ALLOWLIST} = require('../lib/allowlist');
  const release = {...ALLOWLIST, packs: {'ci-failure-triage': {packages: [SCENARIO, '@countinghouse/ch-access-github'], credentials: ['GITHUB_TOKEN']}}, pins: {}};
  const self = fs.realpathSync.native(path.join(__dirname, '..', 'bin', 'ch-local.js'));
  const outside = io(home);
  outside.release = release;
  assert.strictEqual(await start({passThrough: []}, outside), 0, outside.err);
  // (the home named: on POSIX as the variable before the command, on Windows
  // in words beside it, quoted as every printed folder is)
  const {folderArg} = require('../lib/command-line');
  const want = process.platform === 'win32'
    ? `run \`node "${self}" install --pack ci-failure-triage\` (with COUNTINGHOUSE_HOME set to ${folderArg(home, 'win32')}) to bring the home to ${ALLOWLIST.release.version}`
    : `run \`COUNTINGHOUSE_HOME="${home}" node "${self}" install --pack ci-failure-triage\` to bring the home to ${ALLOWLIST.release.version}`;
  assert.ok(outside.err.includes(want), outside.err);
  // from the home's own app (its ch-local is the one the record's runtime names)
  const inside = Object.assign(io(home), {selfVersion: '0.5.0'});
  inside.release = release;
  assert.strictEqual(await start({passThrough: []}, inside), 0, inside.err);
  assert.match(inside.err, /this home's record is not this ch-local's release; run `(?:node "[^"]+" |(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local )install --pack ci-failure-triage` to bring the home to /);
  assert.ok(!inside.err.includes(self), 'the home\'s own launcher, not this one');
});

// the reviewer's pre-work high (A-home-check, 3): start, with no --home as
// with one, runs nothing from a home another user could change: its app is
// loaded and every stored key given to it
test('start runs nothing from a home another user could change: exit 2, with the fix', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const home = installedHome();
  fs.chmodSync(home, 0o777);
  try {
    const f = io(home);
    assert.strictEqual(await start({passThrough: []}, f), 2, f.err);
    assert.strictEqual(f.spawned.length, 0, 'no runtime spawned');
    assert.match(f.err, /is group- or world-writable \(mode 0777\), so another user could change what runs from it; it may already have been changed: move it aside \(`mv "[^"]+" "[^"]+\.suspect"`\) and install again; nothing was started/);
  } finally {
    fs.chmodSync(home, 0o700);
  }
});
