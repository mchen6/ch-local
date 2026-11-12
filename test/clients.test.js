'use strict';
// ch-local add <client> writes the client's entry and records what it wrote;
// uninstall removes exactly that.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {add} = require('../lib/clients');
const {uninstall} = require('../lib/uninstall');
const {snippet} = require('../lib/snippets');
const {fakeIo, tmp} = require('./fake-io');

// A user home with ~/.countinghouse installed (bin/ch-local.js present).
function setup() {
  const user = tmp('ch-user-');
  const home = path.join(user, '.countinghouse');
  fs.mkdirSync(path.join(home, 'bin'), {recursive: true});
  fs.writeFileSync(path.join(home, 'bin', 'ch-local.js'), '');
  fs.writeFileSync(path.join(home, 'installed.json'), JSON.stringify({pack: 'ci-failure-triage', credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']}));
  return {user, home, done: () => fs.rmSync(user, {recursive: true, force: true})};
}
const io = (s, answers = []) => fakeIo({env: {}, homedir: s.user, answers});
const entryFor = (s, client) => snippet(client, {node: '/usr/local/bin/node', launcher: path.join(s.home, 'bin', 'ch-local.js')}).text;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('add records what it wrote and uninstall removes exactly that', async () => {
  const s = setup();
  try {
    const file = path.join(s.user, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({mcpServers: {other: {command: 'other-server'}}}, null, 2));
    const a = io(s);
    assert.strictEqual(await add('cursor', a), 0, a.err);
    const written = readJson(file).mcpServers;
    assert.deepStrictEqual(written.other, {command: 'other-server'});
    assert.deepStrictEqual(written['ci-failure-triage'], JSON.parse(entryFor(s, 'cursor')).mcpServers['ci-failure-triage']);
    const record = readJson(path.join(s.home, 'installed-clients.json'));
    assert.deepStrictEqual(record.entries.map((e) => [e.client, e.file, e.key]), [['cursor', file, 'ci-failure-triage']]);
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0, u.err);
    assert.deepStrictEqual(readJson(file).mcpServers, {other: {command: 'other-server'}});
  } finally {
    s.done();
  }
});

test('add writes the VS Code portable file and a Codex table, and uninstall takes back exactly those', async () => {
  const s = setup();
  try {
    const toml = path.join(s.user, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(toml), {recursive: true});
    const before = 'model = "o4"\n\n[mcp_servers.other]\ncommand = "other"\n';
    fs.writeFileSync(toml, before);
    assert.strictEqual(await add('vscode', io(s)), 0);
    assert.strictEqual(await add('codex', io(s)), 0);
    const vs = path.join(s.user, '.copilot', 'mcp-config.json');
    assert.deepStrictEqual(readJson(vs).mcpServers['ci-failure-triage'], JSON.parse(entryFor(s, 'vscode')).mcpServers['ci-failure-triage']);
    assert.ok(fs.readFileSync(toml, 'utf8').startsWith(before));
    assert.ok(fs.readFileSync(toml, 'utf8').includes(entryFor(s, 'codex')));
    assert.strictEqual(await uninstall({}, io(s, ['yes'])), 0);
    assert.strictEqual(fs.readFileSync(toml, 'utf8'), before);
    assert.deepStrictEqual(readJson(vs).mcpServers, {});
  } finally {
    s.done();
  }
});

test('add never replaces an entry it did not write', async () => {
  const s = setup();
  try {
    const file = path.join(s.user, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({mcpServers: {'ci-failure-triage': {command: 'mine'}}}));
    const a = io(s);
    assert.strictEqual(await add('cursor', a), 1);
    assert.match(a.err, /already has a "ci-failure-triage" entry; ch-local leaves it alone/);
    assert.deepStrictEqual(readJson(file).mcpServers['ci-failure-triage'], {command: 'mine'});
  } finally {
    s.done();
  }
});

test('uninstall leaves an entry the user has changed since, and says so', async () => {
  const s = setup();
  try {
    assert.strictEqual(await add('cursor', io(s)), 0);
    const file = path.join(s.user, '.cursor', 'mcp.json');
    const changed = readJson(file);
    changed.mcpServers['ci-failure-triage'].args.push('--extra');
    fs.writeFileSync(file, JSON.stringify(changed));
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0);
    assert.match(u.out + u.err, /changed since ch-local wrote it; left in place/);
    assert.ok(readJson(file).mcpServers['ci-failure-triage']);
  } finally {
    s.done();
  }
});

test('a config file that is not JSON is never rewritten', async () => {
  const s = setup();
  try {
    const file = path.join(s.user, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, '{ // a comment\n}');
    const a = io(s);
    assert.strictEqual(await add('cursor', a), 1);
    assert.match(a.err, /is not plain JSON; add the entry by hand/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ // a comment\n}');
  } finally {
    s.done();
  }
});

test('add needs an install, and sends Claude Code and Desktop elsewhere', async () => {
  const s = setup();
  try {
    fs.rmSync(path.join(s.home, 'bin', 'ch-local.js'));
    const a = io(s);
    assert.strictEqual(await add('cursor', a), 1);
    assert.match(a.err, /not installed yet: run ch-local install --pack ci-failure-triage first/);
    const c = io(s);
    assert.strictEqual(await add('claude-code', c), 2);
    assert.match(c.err, /claude plugin marketplace add mchen6\/ch-local/);
    assert.match(c.err, /ch-local snippet claude-code/);
    const d = io(s);
    assert.strictEqual(await add('claude-desktop', d), 2);
    assert.match(d.err, /\.mcpb bundle/);
  } finally {
    s.done();
  }
});
