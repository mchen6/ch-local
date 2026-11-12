'use strict';
// ch-local snippet <client>: the exact config entry per client (spec §3),
// against one golden file per client.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {snippet, CLIENTS} = require('../lib/snippets');

const GOLDEN = path.join(__dirname, 'fixtures', 'snippets');
const POSIX = {node: '/usr/local/bin/node', launcher: '/home/dev/.countinghouse/bin/ch-local.js'};
const golden = (client) => fs.readFileSync(path.join(GOLDEN, `${client}.txt`), 'utf8').replace(/\r\n/g, '\n');

test('snippets match the fixtures per client', () => {
  assert.deepStrictEqual(CLIENTS, ['claude-code', 'cursor', 'vscode', 'codex', 'claude-desktop']);
  for (const client of CLIENTS) {
    const s = snippet(client, POSIX);
    assert.strictEqual(client === 'claude-desktop' ? s.note : s.text, golden(client), client);
  }
});

test('JSON snippets parse and name the pinned node and the launcher', () => {
  const cursor = JSON.parse(snippet('cursor', POSIX).text).mcpServers['countinghouse'];
  assert.deepStrictEqual(cursor.command, POSIX.node);
  assert.deepStrictEqual(cursor.args, [POSIX.launcher, 'start', '--stdio']);
  assert.ok(!('type' in cursor), 'Cursor\'s entry has no type');
  const vscode = JSON.parse(snippet('vscode', POSIX).text).mcpServers['countinghouse'];
  assert.strictEqual(vscode.type, 'stdio');
  assert.ok(!('env' in vscode), 'VS Code inherits the environment: no env block');
});

test('Windows paths are escaped for JSON and TOML', () => {
  const win = {node: 'C:\\Program Files\\nodejs\\node.exe', launcher: 'C:\\Users\\dev\\.countinghouse\\bin\\ch-local.js'};
  assert.strictEqual(JSON.parse(snippet('cursor', win).text).mcpServers['countinghouse'].command, win.node);
  const toml = snippet('codex', win).text;
  assert.ok(toml.includes('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"'), toml);
  assert.ok(toml.includes('"C:\\\\Users\\\\dev\\\\.countinghouse\\\\bin\\\\ch-local.js"'), toml);
  const line = snippet('claude-code', win).text;
  // Double quotes: cmd.exe and PowerShell read them, and the line has no $ to expand.
  assert.ok(line.includes('"C:\\Program Files\\nodejs\\node.exe"'), line);
  assert.ok(line.includes('"C:\\Users\\dev\\.countinghouse\\bin\\ch-local.js"'), line);
});

// Reviewer, PR #36: a stdio child inherits the client's environment, so an
// env entry could only reduce what it sees. Only Codex, which does not forward
// by default, names the variables.
test('only Codex names the credential variables; no entry sets one', () => {
  for (const client of ['claude-code', 'cursor', 'vscode']) {
    const {text} = snippet(client, POSIX);
    assert.ok(!/TOKEN|--env|"env"/.test(text), client);
  }
  assert.match(snippet('codex', POSIX).text, /^env_vars = \["COUNTINGHOUSE_GITHUB_TOKEN", "GITHUB_TOKEN"\]$/m);
});

test('no snippet carries a token', () => {
  for (const client of CLIENTS) {
    const {text, note} = snippet(client, POSIX);
    assert.ok(!/ghp_|github_pat_/.test(text + (note || '')), client);
  }
});

// From /code-review medium on ch-local#1.
test('the add line quotes what a shell would split or read as syntax', () => {
  const line = (node) => snippet('claude-code', {node, launcher: '/h/.countinghouse/bin/ch-local.js'}).text;
  assert.ok(line('/opt/a,b/node').includes('"/opt/a,b/node"'), 'a comma is an array in PowerShell');
  assert.ok(line('/opt/@x/node').includes('"/opt/@x/node"'));
  assert.ok(line("/home/o'brien/node").includes('"/home/o\'brien/node"'), 'an apostrophe goes inside double quotes');
  assert.ok(line('/home/a$b/node').includes("'/home/a$b/node'"), 'a $ needs single quotes on POSIX');
});

test('Claude Desktop gets a note, not an entry', () => {
  const {text, note} = snippet('claude-desktop', POSIX);
  assert.strictEqual(text, '', 'nothing to paste');
  assert.strictEqual(note, golden('claude-desktop'));
  const prose = note;
  assert.match(prose, /does not see your shell's environment/);
  assert.match(prose, /never written to a config file/);
  assert.match(prose, /keychain/);
  assert.ok(!prose.includes(POSIX.node));
});

test('an unknown client is refused', () => {
  assert.throws(() => snippet('emacs', POSIX), /unknown client "emacs"; one of: claude-code, cursor, vscode, codex, claude-desktop/);
});
