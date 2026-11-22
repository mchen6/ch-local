'use strict';
require('./tmp-dirs');
// lib/client-conditions.js (countinghouse part 3 P2, Task 4): before every
// dialog, may the client be asked? For Claude Code, only when nothing in
// its own configuration could answer the dialog for the user (any
// Elicitation or ElicitationResult hook, in any scope, whatever its matcher;
// a project plugin or marketplace; an installed plugin's hook; a --settings
// or --plugin-dir the client was started with), when it says it is an
// interactive CLI session, and when its project directory is known. Anything
// it cannot read is no.
const test = require('node:test');
// (Node 22.16's runner: see test/keep-alive.js)
require('./keep-alive');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {clientConditions} = require('../lib/client-conditions');

const CC = {name: 'claude-code', version: '2.1.323'};
const HOOK = (event, matcher = '') => ({hooks: {[event]: [{matcher, hooks: [{type: 'command', command: 'echo accept'}]}]}});

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cond-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'work', 'proj');
  const cwd = path.join(project, 'sub');
  const managed = path.join(root, 'managed', 'managed-settings.json');
  for (const d of [home, cwd, path.dirname(managed)]) fs.mkdirSync(d, {recursive: true});
  const env = {CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', CLAUDE_PROJECT_DIR: project};
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  // stopAt: this world's root, so the walk up never reaches the real home
  const ask = (o = {}) => clientConditions(Object.assign({client: CC, home, cwd, env, managedFile: managed, parentCommandLines: () => [['claude']], stopAt: root}, o));
  return {root, home, project, cwd, managed, env, write, ask};
}

test('nothing configured: yes', () => {
  const w = world();
  assert.deepStrictEqual(w.ask(), {mayElicit: true, why: null});
});

test('not an interactive CLI session, by its own word: no (a hint for honest unattended hosts)', () => {
  const w = world();
  for (const env of [{CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDECODE: '1'}, {CLAUDE_CODE_ENTRYPOINT: 'cli'}, {CLAUDECODE: '1'}, {}]) {
    assert.deepStrictEqual(w.ask({env: Object.assign({CLAUDE_PROJECT_DIR: w.project}, env)}), {mayElicit: false, why: 'not an interactive session'}, JSON.stringify(env));
  }
});

test('the project directory unset, relative or missing: no', () => {
  const w = world();
  for (const dir of [undefined, 'relative/proj', path.join(w.root, 'nowhere')]) {
    const env = Object.assign({}, w.env, {CLAUDE_PROJECT_DIR: dir});
    if (dir === undefined) delete env.CLAUDE_PROJECT_DIR;
    assert.deepStrictEqual(w.ask({env}), {mayElicit: false, why: 'project directory unknown'}, String(dir));
  }
});

test('any Elicitation or ElicitationResult hook, whatever its matcher, in any scope: no', () => {
  for (const matcher of ['', '*', 'github', 'countinghouse|x', '(bad', 'ch']) {
    for (const event of ['Elicitation', 'ElicitationResult']) {
      for (const where of ['user', 'project', 'local', 'ancestor', 'managed', 'managed.d']) {
        const w = world();
        const file = {
          user: path.join(w.home, '.claude', 'settings.json'),
          project: path.join(w.project, '.claude', 'settings.json'),
          local: path.join(w.project, '.claude', 'settings.local.json'),
          ancestor: path.join(path.dirname(w.project), '.claude', 'settings.json'),
          managed: w.managed,
          'managed.d': path.join(path.dirname(w.managed), 'managed-settings.d', '10-x.json')
        }[where];
        w.write(file, HOOK(event, matcher));
        assert.deepStrictEqual(w.ask(), {mayElicit: false, why: 'client hook present'}, `${event} ${JSON.stringify(matcher)} in ${where}`);
      }
    }
  }
});

test('other hooks are no reason', () => {
  const w = world();
  w.write(path.join(w.project, '.claude', 'settings.json'), HOOK('PreToolUse', 'Bash'));
  assert.strictEqual(w.ask().mayElicit, true);
});

test('CLAUDE_CONFIG_DIR: its settings are the user\'s, ~/.claude is not read', () => {
  const w = world();
  const config = path.join(w.root, 'cfg');
  w.write(path.join(config, 'settings.json'), HOOK('Elicitation'));
  assert.deepStrictEqual(w.ask({env: Object.assign({}, w.env, {CLAUDE_CONFIG_DIR: config})}), {mayElicit: false, why: 'client hook present'});
  const w2 = world();
  w2.write(path.join(w2.home, '.claude', 'settings.json'), HOOK('Elicitation'));
  assert.strictEqual(w2.ask({env: Object.assign({}, w2.env, {CLAUDE_CONFIG_DIR: path.join(w2.root, 'empty')})}).mayElicit, true);
});

test('a project or local settings file enabling a plugin or adding a marketplace: no; the user\'s own may', () => {
  for (const [file, key] of [['settings.json', 'enabledPlugins'], ['settings.local.json', 'enabledPlugins'], ['settings.json', 'extraKnownMarketplaces']]) {
    const w = world();
    w.write(path.join(w.project, '.claude', file), {[key]: {'x@y': true}});
    assert.deepStrictEqual(w.ask(), {mayElicit: false, why: 'project plugin or marketplace'}, `${file} ${key}`);
  }
  const w = world();
  w.write(path.join(w.home, '.claude', 'settings.json'), {enabledPlugins: {'x@y': true}});
  assert.strictEqual(w.ask().mayElicit, true, 'the user settings enabling a plugin is no reason by itself');
});

test('an installed plugin with an Elicitation hook, in hooks/hooks.json, plugin.json inline or a file it lists: no', () => {
  const cases = [
    (dir, w) => w.write(path.join(dir, 'hooks', 'hooks.json'), HOOK('ElicitationResult')),
    (dir, w) => w.write(path.join(dir, '.claude-plugin', 'plugin.json'), {name: 'p', hooks: HOOK('Elicitation').hooks}),
    (dir, w) => { w.write(path.join(dir, '.claude-plugin', 'plugin.json'), {name: 'p', hooks: './more.json'}); w.write(path.join(dir, 'more.json'), HOOK('Elicitation')); },
    (dir, w) => { w.write(path.join(dir, '.claude-plugin', 'plugin.json'), {name: 'p', hooks: ['./a.json']}); w.write(path.join(dir, 'a.json'), HOOK('Elicitation')); }
  ];
  for (const [i, make] of cases.entries()) {
    const w = world();
    make(path.join(w.home, '.claude', 'plugins', 'cache', 'mkt', 'p', '1.0.0'), w);
    assert.deepStrictEqual(w.ask(), {mayElicit: false, why: 'plugin hook present'}, `case ${i}`);
  }
  const w = world();
  // CLAUDE_CODE_PLUGIN_CACHE_DIR names the plugins root: its cache/ is read
  const pluginsRoot = path.join(w.root, 'plugins-root');
  w.write(path.join(pluginsRoot, 'cache', 'mkt', 'p', '1.0.0', 'hooks', 'hooks.json'), HOOK('Elicitation'));
  assert.strictEqual(w.ask({env: Object.assign({}, w.env, {CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginsRoot})}).why, 'plugin hook present', 'CLAUDE_CODE_PLUGIN_CACHE_DIR');
});

test('the client\'s own command line: --settings with a hook, or a --plugin-dir with one: no; unreadable: no', () => {
  const w = world();
  const s = path.join(w.root, 'flag-settings.json');
  w.write(s, HOOK('Elicitation'));
  assert.strictEqual(w.ask({parentCommandLines: () => [['claude', '--settings', s]]}).why, 'client hook present');
  assert.strictEqual(w.ask({parentCommandLines: () => [['claude', `--settings=${JSON.stringify(HOOK('Elicitation'))}`]]}).why, 'client hook present', 'inline JSON');
  const pd = path.join(w.root, 'pdir');
  w.write(path.join(pd, 'hooks', 'hooks.json'), HOOK('Elicitation'));
  assert.strictEqual(w.ask({parentCommandLines: () => [['node', 'launch.js'], ['claude', '--plugin-dir', pd]]}).why, 'plugin hook present', 'any ancestor');
  assert.deepStrictEqual(w.ask({parentCommandLines: () => null}), {mayElicit: false, why: 'client settings unreadable'});
});

test('a settings file that is not JSON, or too large: unreadable, no', () => {
  const w = world();
  w.write(path.join(w.project, '.claude', 'settings.local.json'), '{not json');
  assert.deepStrictEqual(w.ask(), {mayElicit: false, why: 'client settings unreadable'});
  const w2 = world();
  w2.write(path.join(w2.home, '.claude', 'settings.json'), JSON.stringify({x: 'y'.repeat(1024 * 1024 + 10)}));
  assert.strictEqual(w2.ask().why, 'client settings unreadable');
});

test('a client with no known conditions: no', () => {
  const w = world();
  assert.deepStrictEqual(w.ask({client: {name: 'other', version: '1.0.0'}}), {mayElicit: false, why: 'no conditions known'});
});

test('a project under the home: the user\'s own settings, met on the way up, are still the user\'s', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cond-'));
  const home = path.join(root, 'home');
  const project = path.join(home, 'src', 'proj');
  fs.mkdirSync(project, {recursive: true});
  fs.mkdirSync(path.join(home, '.claude'), {recursive: true});
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({enabledPlugins: {'x@y': true}}));
  const env = {CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', CLAUDE_PROJECT_DIR: project};
  assert.deepStrictEqual(clientConditions({client: CC, home, cwd: project, env, managedFile: path.join(root, 'none.json'), parentCommandLines: () => [['claude']], stopAt: root}), {mayElicit: true, why: null});
});

test('a --settings or --plugin-dir naming nothing readable: unreadable, no', () => {
  const w = world();
  assert.strictEqual(w.ask({parentCommandLines: () => [['claude', '--settings', path.join(w.root, 'gone.json')]]}).why, 'client settings unreadable');
  assert.strictEqual(w.ask({parentCommandLines: () => [['claude', `--plugin-dir=${path.join(w.root, 'gone')}`]]}).why, 'client settings unreadable');
});

test('the latch: a hook seen once holds for the whole start, though it is removed', () => {
  const {conditionsLatch} = require('../lib/client-conditions');
  const w = world();
  const file = path.join(w.project, '.claude', 'settings.json');
  w.write(file, HOOK('Elicitation'));
  const check = conditionsLatch();
  assert.strictEqual(check({client: CC, home: w.home, cwd: w.cwd, env: w.env, managedFile: w.managed, parentCommandLines: () => [['claude']], stopAt: w.root}).why, 'client hook present');
  fs.rmSync(file);
  assert.deepStrictEqual(check({client: CC, home: w.home, cwd: w.cwd, env: w.env, managedFile: w.managed, parentCommandLines: () => [['claude']], stopAt: w.root}), {mayElicit: false, why: 'client hook present'});
  assert.strictEqual(w.ask().mayElicit, true, 'a fresh scan, unlatched, says yes');
});

test('the real ancestry reader: this process\'s own command line, first', async () => {
  const {readAncestry} = require('../lib/client-conditions');
  const lines = await readAncestry(process.pid, 2);
  assert.ok(Array.isArray(lines) && lines.length >= 1, String(lines));
  assert.ok(lines[0].some((a) => /node/i.test(a)), JSON.stringify(lines[0]));
});

test('review: a symlinked marketplace, plugin or version directory is read', () => {
  const w = world();
  const real = path.join(w.root, 'dev-plugin');
  w.write(path.join(real, 'hooks', 'hooks.json'), HOOK('Elicitation'));
  const p = path.join(w.home, '.claude', 'plugins', 'cache', 'mkt', 'p');
  fs.mkdirSync(p, {recursive: true});
  fs.symlinkSync(real, path.join(p, '1.0.0'), 'dir');
  assert.strictEqual(w.ask().why, 'plugin hook present');
});

test('review: the user\'s own settings.local.json is read (the project is the home)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cond-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), {recursive: true});
  fs.writeFileSync(path.join(home, '.claude', 'settings.local.json'), JSON.stringify(HOOK('Elicitation')));
  const env = {CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', CLAUDE_PROJECT_DIR: home};
  assert.strictEqual(clientConditions({client: CC, home, cwd: home, env, managedFile: path.join(root, 'none.json'), parentCommandLines: () => [['claude']], stopAt: root}).why, 'client hook present');
});

test('review: a relative --settings or --plugin-dir is unreadable (the client\'s own directory is not known for certain)', () => {
  const w = world();
  w.write(path.join(w.cwd, 's.json'), {});
  fs.mkdirSync(path.join(w.cwd, 'p'), {recursive: true});
  assert.strictEqual(w.ask({parentCommandLines: () => [['claude', '--settings', 's.json']]}).why, 'client settings unreadable');
  assert.strictEqual(w.ask({parentCommandLines: () => [['claude', '--plugin-dir', './p']]}).why, 'client settings unreadable');
});

test('review: the client must be found among the ancestors; an empty command line on the way is unread', () => {
  const {clientLines} = require('../lib/client-conditions');
  assert.deepStrictEqual(clientLines([['node', 'x.js'], ['sh'], ['claude', '--resume', 'a']]), [['node', 'x.js'], ['sh'], ['claude', '--resume', 'a']]);
  assert.strictEqual(clientLines([['node', 'x.js'], ['bash']]), null);
  assert.strictEqual(clientLines([['node', 'x.js'], [], ['claude']]), null);
  assert.ok(clientLines([['C:\\Users\\u\\.local\\bin\\claude.exe']]));
  assert.ok(clientLines([['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', '--settings', '/s.json']]));
  assert.strictEqual(clientLines(null), null);
});

test('review: no cwd (removed), or anything unexpected, is unreadable, never a throw', () => {
  const w = world();
  assert.deepStrictEqual(w.ask({cwd: null}), {mayElicit: false, why: 'client settings unreadable'});
  assert.deepStrictEqual(w.ask({parentCommandLines: () => [[42]]}), {mayElicit: false, why: 'client settings unreadable'});
});

test('review: the service answers within its wait while the ancestry is still read, then from it, latching', async () => {
  const {conditionsService} = require('../lib/client-conditions');
  const w = world();
  let resolve;
  const svc = conditionsService({home: w.home, cwd: w.cwd, env: w.env, managedFile: w.managed, stopAt: w.root}, {ancestry: new Promise((r) => { resolve = r; }), waitMs: 30});
  assert.deepStrictEqual(await svc.check(CC), {mayElicit: false, why: 'client settings unreadable'});
  resolve([['claude']]);
  await svc.ready;
  assert.deepStrictEqual(await svc.check(CC), {mayElicit: true, why: null});
  const file = path.join(w.project, '.claude', 'settings.json');
  w.write(file, HOOK('Elicitation'));
  assert.strictEqual((await svc.check(CC)).why, 'client hook present');
  fs.rmSync(file);
  assert.strictEqual((await svc.check(CC)).why, 'client hook present', 'latched');
});

test('the real reader on this platform (Windows CI runs PowerShell here): read, never null by default; the client found or unreadable', async () => {
  const {readClientContext, clientLines, conditionsService} = require('../lib/client-conditions');
  const c = await readClientContext(process.pid, 3);
  assert.ok(Array.isArray(c.lines) && c.lines.length >= 1 && c.lines[0].some((a) => /node/i.test(a)), JSON.stringify(c));
  assert.strictEqual(typeof c.policyPresent, 'boolean');
  if (process.platform !== 'win32') assert.strictEqual(c.policyPresent, false);
  // the service reads from start's parent, 8 up, as production does
  const found = clientLines((await readClientContext(process.ppid)).lines);
  assert.ok(found === null || found.some((argv) => argv.slice(0, 2).some((a) => /claude/i.test(a))), JSON.stringify(found));
  // the service over the real reader: an answer, never a default yes
  const w = world();
  const svc = conditionsService({home: w.home, cwd: w.cwd, env: w.env, managedFile: w.managed, stopAt: w.root}, {waitMs: 60000});
  await svc.ready;
  const r = await svc.check(CC);
  if (found === null) assert.deepStrictEqual(r, {mayElicit: false, why: 'client settings unreadable'});
  else assert.strictEqual(typeof r.mayElicit, 'boolean', 'run under Claude Code: an answer from its real ancestry');
});

test('a managed source start cannot read (a Windows policy key): unreadable', () => {
  const w = world();
  assert.deepStrictEqual(w.ask({managedPresent: true}), {mayElicit: false, why: 'client settings unreadable'});
});

// the review of #62: a world's temp root may sit under a directory with its
// own .claude (TMPDIR under the developer's home): the walk stops at the
// world's root, so only the world's own fixtures are seen
test('a world under a directory whose .claude enables plugins sees only its own fixtures', () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cond-outer-'));
  try {
    fs.mkdirSync(path.join(outer, '.claude'));
    fs.writeFileSync(path.join(outer, '.claude', 'settings.json'), JSON.stringify({enabledPlugins: {'example@example-market': true}, ...HOOK('Elicitation')}));
    const root = fs.mkdtempSync(path.join(outer, 'ch-cond-'));
    const home = path.join(root, 'home');
    const project = path.join(root, 'work', 'proj');
    fs.mkdirSync(home, {recursive: true});
    fs.mkdirSync(project, {recursive: true});
    const env = {CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', CLAUDE_PROJECT_DIR: project};
    const args = {client: CC, home, cwd: project, env, managedFile: path.join(root, 'none.json'), parentCommandLines: () => [['claude']]};
    assert.deepStrictEqual(clientConditions({...args, stopAt: root}), {mayElicit: true, why: null});
    // and without the bound, the outer .claude is what a real walk would meet
    assert.strictEqual(clientConditions(args).mayElicit, false);
  } finally {
    fs.rmSync(outer, {recursive: true, force: true});
  }
});

// stopAt narrows a security scan (it stops the walk up), so it must be out
// of reach in use (the review of #62): it lives only in the scan's own
// definition, the conditions command's one io read and the fixture worlds,
// and no file that takes argv, env or settings names it at all
test('stopAt and conditionsStopAt are reachable only from tests: in lib/, bin/ and clients/ they appear only where they are defined and read', () => {
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), {withFileTypes: true})) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) walk(rel); else if (/\.(c?js|json)$/.test(e.name) || dir === 'bin') files.push(rel.split(path.sep).join('/'));
    }
  };
  for (const d of ['lib', 'bin', 'clients']) if (fs.existsSync(path.join(root, d))) walk(d);
  const naming = files.filter((f) => /\b(stopAt|conditionsStopAt)\b/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepStrictEqual(naming.sort(), ['lib/client-conditions-fixtures.js', 'lib/client-conditions.js', 'lib/conditions-command.js']);
  // the command's only mention is the one io read, never an argument or an option
  const command = fs.readFileSync(path.join(root, 'lib', 'conditions-command.js'), 'utf8').split('\n').filter((l) => /\b(stopAt|conditionsStopAt)\b/.test(l));
  assert.deepStrictEqual(command.map((l) => l.trim()), ['...(io.conditionsStopAt != null ? {stopAt: io.conditionsStopAt} : {})});']);
  // the fixture worlds bound only their own temp root
  const fixtures = fs.readFileSync(path.join(root, 'lib', 'client-conditions-fixtures.js'), 'utf8').split('\n').filter((l) => /\bstopAt\b/.test(l) && !/^\s*\/\//.test(l));
  assert.ok(fixtures.length === 1 && /stopAt: root\}/.test(fixtures[0]), fixtures.join('\n'));
});


// The plugin route (the walk's: the ch-packs plugin's `node
// ${CLAUDE_PLUGIN_ROOT}/bin/launch.js session`): Claude Code 2.1.326-2.1.330
// starts a plugin's stdio MCP server with CLAUDE_PLUGIN_ROOT (the plugin's
// directory) and CLAUDE_PLUGIN_DATA (its data directory) in its environment.
// ROOT is scanned as a plugin, on its real path, as a --plugin-dir is; DATA
// (and CLAUDE_PLUGIN_OPTION_*, user-config values a hook gets) are known and
// loaded from by nothing; any other CLAUDE_PLUGIN_* is still unreadable.
const pluginEnv = (w, {hook = false} = {}) => {
  const root = path.join(w.home, '.claude', 'plugins', 'cache', 'ch-packs', 'ch-packs', '0.1.0');
  w.write(path.join(root, '.claude-plugin', 'plugin.json'), {name: 'ch-packs'});
  if (hook) w.write(path.join(root, 'hooks', 'hooks.json'), HOOK('Elicitation'));
  const data = path.join(w.home, '.claude', 'plugins', 'data', 'ch-packs-ch-packs');
  fs.mkdirSync(data, {recursive: true});
  return {root, data, env: Object.assign({}, w.env, {CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_OPTION_REGION: 'eu'})};
};

test('the plugin route: CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA, with no hook anywhere: yes', () => {
  const w = world();
  const p = pluginEnv(w);
  assert.deepStrictEqual(w.ask({env: p.env}), {mayElicit: true, why: null});
});

test('the plugin route: an Elicitation hook in the plugin CLAUDE_PLUGIN_ROOT names: plugin hook present', () => {
  const w = world();
  const p = pluginEnv(w, {hook: true});
  assert.deepStrictEqual(w.ask({env: p.env}), {mayElicit: false, why: 'plugin hook present'});
});

test('the plugin route: a root outside the cache is scanned too, on its real path (a link to a plugin with a hook)', {skip: process.platform === 'win32' && 'symlinks need privilege'}, () => {
  const w = world();
  const outside = path.join(w.root, 'elsewhere', 'plugin');
  w.write(path.join(outside, 'hooks', 'hooks.json'), HOOK('ElicitationResult'));
  const link = path.join(w.root, 'link-to-plugin');
  fs.symlinkSync(outside, link, 'dir');
  const env = Object.assign({}, w.env, {CLAUDE_PLUGIN_ROOT: link});
  assert.deepStrictEqual(w.ask({env}), {mayElicit: false, why: 'plugin hook present'});
});

test('the plugin route: a root relative, missing or not a directory; DATA relative; another CLAUDE_PLUGIN_*: unreadable', () => {
  const w = world();
  const p = pluginEnv(w);
  const file = path.join(w.root, 'a-file');
  w.write(file, 'x');
  for (const extra of [{CLAUDE_PLUGIN_ROOT: 'relative/plugin'}, {CLAUDE_PLUGIN_ROOT: path.join(w.root, 'nowhere')}, {CLAUDE_PLUGIN_ROOT: file},
    {CLAUDE_PLUGIN_DATA: 'relative/data'}, {CLAUDE_PLUGIN_SOURCES: p.root}, {Claude_Plugin_Root: p.root}]) {
    assert.deepStrictEqual(w.ask({env: Object.assign({}, p.env, extra)}), {mayElicit: false, why: 'client settings unreadable'}, JSON.stringify(extra));
  }
});

test('the plugin route never masks another source: a cached plugin\'s hook, or a settings hook, still says no', () => {
  const w = world();
  const p = pluginEnv(w);
  w.write(path.join(w.home, '.claude', 'plugins', 'cache', 'other', 'tool', '1.0.0', 'hooks', 'hooks.json'), HOOK('Elicitation'));
  assert.deepStrictEqual(w.ask({env: p.env}), {mayElicit: false, why: 'plugin hook present'});
  const v = world();
  const q = pluginEnv(v);
  v.write(path.join(v.home, '.claude', 'settings.json'), HOOK('Elicitation'));
  assert.deepStrictEqual(v.ask({env: q.env}), {mayElicit: false, why: 'client hook present'});
});

test('a settings env block naming CLAUDE_PLUGIN_ROOT or CLAUDE_PLUGIN_DATA is still unreadable', () => {
  const w = world();
  w.write(path.join(w.project, '.claude', 'settings.json'), {env: {CLAUDE_PLUGIN_DATA: '/x'}});
  assert.deepStrictEqual(w.ask(), {mayElicit: false, why: 'client settings unreadable'});
});
