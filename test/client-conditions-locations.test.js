'use strict';
// Every place a hook or plugin can come from (lib/client-conditions-fixtures.js
// LOCATIONS, also the automated re-test's list), planted one at a time, with
// both events: the scan finds each. And what the scan does not know is no:
// an unknown client flag, an unknown CLAUDE_CODE_* source variable, an env
// block naming one, --plugin-url, the zip and cowork plugin variables.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {clientConditions} = require('../lib/client-conditions');
const {LOCATIONS, plant, makeWorld} = require('../lib/client-conditions-fixtures');

test('nothing planted: yes (each world starts clean)', () => {
  assert.deepStrictEqual(clientConditions(makeWorld().args()), {mayElicit: true, why: null});
});

for (const location of LOCATIONS) {
  for (const event of ['Elicitation', 'ElicitationResult']) {
    test(`${location} (${event}): found`, () => {
      const w = makeWorld();
      const why = plant(location, w, event);
      assert.deepStrictEqual(clientConditions(w.args()), {mayElicit: false, why});
    });
  }
}

const no = (w) => assert.deepStrictEqual(clientConditions(w.args()), {mayElicit: false, why: 'client settings unreadable'});

test('a client flag not known safe: no; the known ones: yes', () => {
  const w = makeWorld();
  w.lines = [['claude', '--resume', 'abc', '--model', 'opus', '--verbose', 'a prompt']];
  assert.strictEqual(clientConditions(w.args()).mayElicit, true);
  for (const flag of ['--some-new-flag', '--agents', '--print', '-p', '--dangerously-skip-permissions', '--plugin-url=https://x', '--permission-mode']) {
    w.lines = [['claude', flag]];
    no(w);
  }
  // an npm install's command line: the flags after the package's script
  w.lines = [['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', '--new-thing']];
  no(w);
  w.lines = [['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', '--continue']];
  assert.strictEqual(clientConditions(w.args()).mayElicit, true);
});

test('a CLAUDE_CODE_* variable naming a source the scan does not handle: no; the zip and cowork plugin variables: no', () => {
  for (const k of ['CLAUDE_CODE_PLUGIN_NEW_THING', 'CLAUDE_CODE_EXTRA_SETTINGS', 'CLAUDE_CODE_HOOKS_DIR', 'CLAUDE_CODE_MANAGED_X', 'CLAUDE_CODE_POLICY_FILE', 'CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE', 'CLAUDE_CODE_USE_COWORK_PLUGINS']) {
    const w = makeWorld();
    w.env = {...w.env, [k]: '1'};
    no(w);
  }
  const w = makeWorld();
  w.env = {...w.env, CLAUDE_CODE_SSE_PORT: '1234', CLAUDE_CODE_PLUGIN_SEED_DIR: ''};
  assert.strictEqual(clientConditions(w.args()).mayElicit, true, 'other variables, and an empty one, are no reason');
});

test('a scanned settings file\'s env block naming a source: no', () => {
  for (const k of ['CLAUDE_CODE_PLUGIN_DIRS', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_COWORK_PLUGINS']) {
    const w = makeWorld();
    w.write(path.join(w.project, '.claude', 'settings.json'), {env: {[k]: '/x'}});
    no(w);
  }
  const w = makeWorld();
  w.write(path.join(w.project, '.claude', 'settings.json'), {env: {FOO: 'bar'}});
  assert.strictEqual(clientConditions(w.args()).mayElicit, true);
});

test('relative or missing given dirs, and a relative CLAUDE_CONFIG_DIR: no', () => {
  for (const lines of [[['claude', '--add-dir', 'rel']], [['claude', '--plugin-dir-no-mcp', path.join('/', 'nowhere', 'x')]], [['claude', '--settings']]]) {
    const w = makeWorld();
    w.lines = lines;
    no(w);
  }
  const w = makeWorld();
  w.env = {...w.env, CLAUDE_CONFIG_DIR: 'cfg'};
  no(w);
});

test('the user\'s config dir met on the way up is the user\'s, whatever its case on Windows and macOS', () => {
  const w = makeWorld();
  // a project under the home whose .claude the user's own settings enable plugins in
  w.env = {...w.env, CLAUDE_PROJECT_DIR: w.home};
  w.write(path.join(w.home, '.claude', 'settings.json'), {enabledPlugins: {'x@y': true}});
  assert.strictEqual(clientConditions(w.args({cwd: w.home})).mayElicit, true);
  const upper = w.home.replace(/home$/, 'HOME');
  assert.strictEqual(clientConditions(w.args({cwd: w.home, platform: 'darwin', home: upper})).mayElicit, true, 'darwin: compared case-insensitively');
});

test('#22 re-check: what could spell a hook without the plain word is unreadable', () => {
  const fs = require('node:fs');
  const md = (w, text) => w.write(path.join(w.project, '.claude', 'agents', 'a.md'), text);
  let w = makeWorld();
  md(w, '---\nname: x\nhooks:\n  "Elicit\\x61tion":\n    - hooks: []\n---\n');
  no(w);
  w = makeWorld();
  const file = path.join(w.project, '.claude', 'commands', 'c.md');
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('---\nhooks:\n  Elicitation: []\n---\n', 'utf16le')]));
  no(w);
  w = makeWorld();
  md(w, 'plain\u0000text');
  no(w);
  // past the depth limit: unreadable, never skipped
  w = makeWorld();
  w.write(path.join(w.project, '.claude', 'agents', ...'abcdefghij'.split(''), 'deep.md'), 'nothing here');
  no(w);
  // a backslash outside the front matter is no reason
  w = makeWorld();
  md(w, '---\nname: x\n---\nC:\\path in the body\n');
  assert.strictEqual(clientConditions(w.args()).mayElicit, true);
});

test('#22 re-check: a plugin\'s whole tree is read for *.md (its custom command, agent and skill paths)', () => {
  const w = makeWorld();
  w.write(path.join(w.home, '.claude', 'plugins', 'cache', 'mkt', 'p', '1.0.0', 'my-commands', 'nested', 'go.md'), '---\nhooks:\n  ElicitationResult: []\n---\n');
  assert.deepStrictEqual(clientConditions(w.args()), {mayElicit: false, why: 'plugin hook present'});
});

test('#22 re-check: --add-dir takes every following non-flag token; a later one with a hook counts', () => {
  const {hookConfig} = require('../lib/client-conditions-fixtures');
  const w = makeWorld();
  const a = path.join(w.root, 'a');
  const b = path.join(w.root, 'b');
  require('node:fs').mkdirSync(a, {recursive: true});
  w.write(path.join(b, '.claude', 'settings.json'), hookConfig());
  w.lines = [['claude', '--add-dir', a, b]];
  assert.strictEqual(clientConditions(w.args()).why, 'client hook present');
});

test('#22 re-check: CLAUDE_CODE_PLUGIN_SEED_DIR is a list', () => {
  const {hookConfig} = require('../lib/client-conditions-fixtures');
  const w = makeWorld();
  const s1 = path.join(w.root, 's1');
  const s2 = path.join(w.root, 's2');
  require('node:fs').mkdirSync(s1, {recursive: true});
  w.write(path.join(s2, 'p', 'hooks', 'hooks.json'), hookConfig());
  w.env = {...w.env, CLAUDE_CODE_PLUGIN_SEED_DIR: `${s1}${path.delimiter}${s2}`};
  assert.strictEqual(clientConditions(w.args()).why, 'plugin hook present');
});

test('#22 re-check: a "--" never ends the scan (a prompt split on whitespace)', () => {
  const {hookConfig} = require('../lib/client-conditions-fixtures');
  const w = makeWorld();
  const s = w.write(path.join(w.root, 's.json'), hookConfig());
  w.lines = [['claude', 'fix', '--', 'this', '--settings', s]];
  assert.strictEqual(clientConditions(w.args()).why, 'client hook present');
});

test('#22 re-check: any mention in remote-settings.json counts', () => {
  const w = makeWorld();
  w.write(path.join(w.home, '.claude', 'remote-settings.json'), {policies: [{on: 'ElicitationResult', run: 'x'}]});
  assert.strictEqual(clientConditions(w.args()).why, 'client hook present');
});

test('#22 re-check: environment names in any case; CLAUDE_ with SKILL, MARKETPLACE, MODS or CONFIG_DIR', () => {
  for (const k of ['CLAUDE_DEV_MODS_DIR', 'CLAUDE_AI_PLUGINS_SCOPE', 'CLAUDE_CODE_MARKETPLACE_URL', 'CLAUDE_CODE_SYNC_SKILLS', 'CLAUDE_CODE_HOST_SKILL_CATALOG',
    'CLAUDE_CODE_HOST_OWNED_CONFIG_DIR', 'CLAUDE_TEST_USER_SETTINGS', 'claude_code_plugin_new', 'Claude_Config_Dir']) {
    const w = makeWorld();
    w.env = {...w.env, [k]: '/x'};
    no(w);
  }
  const w = makeWorld();
  w.env = {...w.env, CLAUDE_CODE_SESSION_ID: 'a', CLAUDE_CODE_SESSION_ATTENDED: '1', CLAUDE_PID: '1', CLAUDE_EFFORT: 'x', CLAUDE_CODE_MESSAGING_SOCKET: '/s', CLAUDE_CODE_EXECPATH: '/e'};
  assert.strictEqual(clientConditions(w.args()).mayElicit, true, 'what a real session passes down');
  const w2 = makeWorld();
  w2.write(path.join(w2.project, '.claude', 'settings.json'), {env: {claude_code_marketplace_url: 'x'}});
  no(w2);
});

test('#22 re-check: the unknown-flag rule wherever the client token sits', () => {
  const w = makeWorld();
  w.lines = [['node', '--max-old-space-size=4096', '/opt/@anthropic-ai/claude-code/cli.js', '--new-flag']];
  no(w);
  w.lines = [['node', '--max-old-space-size=4096', '/opt/@anthropic-ai/claude-code/cli.js', '--continue']];
  assert.strictEqual(clientConditions(w.args()).mayElicit, true, 'a flag before the client token is the launcher\'s');
});

test('#22 re-check 2: front matter as broadly as any parser takes it: an opening with trailing white space, a closing mid-line', () => {
  for (const text of ['--- \nhooks:\n  "Elicit\\x61tion": []\n---\n', '---\t\nhooks:\n  "Elicit\\x61tion": []\n---\n',
    '---\nhooks:\n  "Elicit\\x61tion": [] ---\nbody\n', '﻿\n  ---\nhooks:\n  "Elicit\\x61tion": []\n', '---\nhooks: "\\u0045licitation"']) {
    const w = makeWorld();
    w.write(path.join(w.project, '.claude', 'agents', 'a.md'), text);
    no(w);
  }
});
