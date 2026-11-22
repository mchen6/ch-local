'use strict';
// Fixtures for lib/client-conditions.js, one per place a hook (or a plugin)
// can come from, for its tests and for the automated re-test of each new
// Claude Code version (countinghouse part 3 P2: a new version gets a form
// only once every location here is shown, in that version, to be one it
// reads and one this scan finds; the re-test plants each in a real client).
//
// makeWorld() -> a temporary home, project and cwd, and the arguments
// clientConditions takes for them (w.args()). plant(location, w, event)
// puts an `event` hook (Elicitation or ElicitationResult) at `location`,
// changing w's files, env or command lines, and returns the reason the scan
// must give.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hookConfig = (event = 'Elicitation', matcher = '') => ({hooks: {[event]: [{matcher, hooks: [{type: 'command', command: 'echo accept'}]}]}});
const hookMarkdown = (event = 'Elicitation') => `---\nname: x\nhooks:\n  ${event}:\n    - hooks:\n        - type: command\n          command: echo accept\n---\nbody\n`;

function makeWorld(root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-cond-'))) {
  const home = path.join(root, 'home');
  const project = path.join(root, 'work', 'proj');
  const cwd = path.join(project, 'sub');
  const managed = path.join(root, 'managed', 'managed-settings.json');
  for (const d of [home, cwd, path.dirname(managed)]) fs.mkdirSync(d, {recursive: true});
  const w = {
    root, home, project, cwd, managed,
    env: {CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', CLAUDE_PROJECT_DIR: project},
    lines: [['claude']],
    write(file, value) {
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
      return file;
    },
    args(o = {}) {
      // stopAt: the world's own root, so the scan never walks into the real home above it
      return Object.assign({client: {name: 'claude-code', version: '2.1.323'}, home, cwd, env: w.env, managedFile: managed, parentCommandLines: () => w.lines, stopAt: root}, o);
    }
  };
  return w;
}

const userDir = (w) => path.join(w.home, '.claude');
const cacheVersion = (w, name = 'p') => path.join(userDir(w), 'plugins', 'cache', 'mkt', name, '1.0.0');
const pluginHooks = (dir, w, event) => w.write(path.join(dir, 'hooks', 'hooks.json'), hookConfig(event));
const client = (w, ...flags) => { w.lines = [['claude', ...flags]]; };

// location -> (w, event) => the reason
const PLANTS = {
  'user-settings': (w, e) => (w.write(path.join(userDir(w), 'settings.json'), hookConfig(e)), 'client hook present'),
  'user-settings-local': (w, e) => (w.write(path.join(userDir(w), 'settings.local.json'), hookConfig(e)), 'client hook present'),
  'remote-settings': (w, e) => (w.write(path.join(userDir(w), 'remote-settings.json'), hookConfig(e)), 'client hook present'),
  'config-dir-settings': (w, e) => {
    const config = path.join(w.root, 'cfg');
    w.env = {...w.env, CLAUDE_CONFIG_DIR: config};
    w.write(path.join(config, 'settings.json'), hookConfig(e));
    return 'client hook present';
  },
  'managed': (w, e) => (w.write(w.managed, hookConfig(e)), 'client hook present'),
  'managed-d': (w, e) => (w.write(path.join(path.dirname(w.managed), 'managed-settings.d', '10-x.json'), hookConfig(e)), 'client hook present'),
  'project-settings': (w, e) => (w.write(path.join(w.project, '.claude', 'settings.json'), hookConfig(e)), 'client hook present'),
  'project-local': (w, e) => (w.write(path.join(w.project, '.claude', 'settings.local.json'), hookConfig(e)), 'client hook present'),
  'ancestor-settings': (w, e) => (w.write(path.join(path.dirname(w.project), '.claude', 'settings.json'), hookConfig(e)), 'client hook present'),
  'project-enabled-plugins': (w) => (w.write(path.join(w.project, '.claude', 'settings.json'), {enabledPlugins: {'x@y': true}}), 'project plugin or marketplace'),
  'project-marketplace': (w) => (w.write(path.join(w.project, '.claude', 'settings.local.json'), {extraKnownMarketplaces: {m: {}}}), 'project plugin or marketplace'),
  'add-dir-settings': (w, e) => {
    const extra = path.join(w.root, 'extra');
    w.write(path.join(extra, '.claude', 'settings.json'), hookConfig(e));
    client(w, '--add-dir', extra);
    return 'client hook present';
  },
  'flag-settings-file': (w, e) => (client(w, '--settings', w.write(path.join(w.root, 'flag-settings.json'), hookConfig(e))), 'client hook present'),
  'flag-settings-inline': (w, e) => (client(w, `--settings=${JSON.stringify(hookConfig(e))}`), 'client hook present'),
  'flag-managed-settings': (w, e) => (client(w, '--managed-settings', JSON.stringify(hookConfig(e))), 'client hook present'),
  'wrapper-flag-settings': (w, e) => {
    w.lines = [['node', 'wrapper.js', '--settings', w.write(path.join(w.root, 'wrapped.json'), hookConfig(e))], ['claude']];
    return 'client hook present';
  },
  'skill-md': (w, e) => (w.write(path.join(w.project, '.claude', 'skills', 's', 'SKILL.md'), hookMarkdown(e)), 'client hook present'),
  'agent-md': (w, e) => (w.write(path.join(w.project, '.claude', 'agents', 'a.md'), hookMarkdown(e)), 'client hook present'),
  'command-md': (w, e) => (w.write(path.join(w.project, '.claude', 'commands', 'nested', 'c.md'), hookMarkdown(e)), 'client hook present'),
  'user-skill-md': (w, e) => (w.write(path.join(userDir(w), 'skills', 's', 'SKILL.md'), hookMarkdown(e)), 'client hook present'),
  'plugin-cache-hooks-json': (w, e) => (pluginHooks(cacheVersion(w), w, e), 'plugin hook present'),
  'plugin-cache-manifest-inline': (w, e) => (w.write(path.join(cacheVersion(w), '.claude-plugin', 'plugin.json'), {name: 'p', hooks: hookConfig(e).hooks}), 'plugin hook present'),
  'plugin-cache-manifest-file': (w, e) => {
    w.write(path.join(cacheVersion(w), '.claude-plugin', 'plugin.json'), {name: 'p', hooks: ['./more.json']});
    w.write(path.join(cacheVersion(w), 'more.json'), hookConfig(e));
    return 'plugin hook present';
  },
  'plugin-cache-skill-md': (w, e) => (w.write(path.join(cacheVersion(w), 'skills', 's', 'SKILL.md'), hookMarkdown(e)), 'plugin hook present'),
  'plugin-cache-symlinked': (w, e) => {
    const real = path.join(w.root, 'dev-plugin');
    pluginHooks(real, w, e);
    const p = path.dirname(cacheVersion(w));
    fs.mkdirSync(p, {recursive: true});
    fs.symlinkSync(real, path.join(p, '1.0.0'), 'dir');
    return 'plugin hook present';
  },
  'plugin-root-env': (w, e) => {
    const root = path.join(w.root, 'plugins-root');
    pluginHooks(path.join(root, 'cache', 'mkt', 'p', '1.0.0'), w, e);
    w.env = {...w.env, CLAUDE_CODE_PLUGIN_CACHE_DIR: root};
    return 'plugin hook present';
  },
  'plugin-dir': (w, e) => { const d = path.join(w.root, 'pdir'); pluginHooks(d, w, e); client(w, '--plugin-dir', d); return 'plugin hook present'; },
  'plugin-dir-child': (w, e) => { const d = path.join(w.root, 'pdirs'); pluginHooks(path.join(d, 'one'), w, e); client(w, `--plugin-dir=${d}`); return 'plugin hook present'; },
  'plugin-dir-no-mcp': (w, e) => { const d = path.join(w.root, 'pdir2'); pluginHooks(d, w, e); client(w, '--plugin-dir-no-mcp', d); return 'plugin hook present'; },
  'env-plugin-dirs': (w, e) => {
    const a = path.join(w.root, 'pa');
    const b = path.join(w.root, 'pb');
    fs.mkdirSync(a, {recursive: true});
    pluginHooks(b, w, e);
    w.env = {...w.env, CLAUDE_CODE_PLUGIN_DIRS: `${a}${path.delimiter}${b}`};
    return 'plugin hook present';
  },
  // the plugin route (2.1.326-2.1.330): a plugin's own process gets its
  // directory as CLAUDE_PLUGIN_ROOT, and its data directory
  'env-plugin-root': (w, e) => {
    const d = path.join(w.root, 'own-plugin');
    pluginHooks(d, w, e);
    const data = path.join(w.root, 'own-plugin-data');
    fs.mkdirSync(data, {recursive: true});
    w.env = {...w.env, CLAUDE_PLUGIN_ROOT: d, CLAUDE_PLUGIN_DATA: data};
    return 'plugin hook present';
  },
  'env-plugin-seed-dir': (w, e) => {
    const seed = path.join(w.root, 'seed');
    pluginHooks(path.join(seed, 'cache', 'mkt', 'p', '1.0.0'), w, e);
    w.env = {...w.env, CLAUDE_CODE_PLUGIN_SEED_DIR: seed};
    return 'plugin hook present';
  }
};

const LOCATIONS = Object.freeze(Object.keys(PLANTS));

function plant(location, w, event = 'Elicitation') {
  const fn = PLANTS[location];
  if (fn == null) throw new Error(`no such location: ${location}`);
  return fn(w, event);
}

module.exports = {LOCATIONS, plant, makeWorld, hookConfig, hookMarkdown};
