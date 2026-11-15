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
  w.lines = [['claude', '--resume', 'abc', '--model', 'opus', '--verbose', '--permission-mode', 'default', 'a prompt']];
  assert.strictEqual(clientConditions(w.args()).mayElicit, true);
  for (const flag of ['--some-new-flag', '--agents', '--print', '-p', '--dangerously-skip-permissions', '--plugin-url=https://x']) {
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
