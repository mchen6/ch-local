'use strict';
require('./tmp-dirs');
// ch-local add <client> writes the client's entry and records what it wrote;
// uninstall removes exactly that.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {add} = require('../lib/clients');
const {uninstall} = require('../lib/uninstall');
const {snippet} = require('../lib/snippets');
const {fakeIo, tmp, FAKE_NODE} = require('./fake-io');

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
const entryFor = (s, client) => snippet(client, {node: FAKE_NODE, launcher: path.join(s.home, 'bin', 'ch-local.js'), home: s.home}).text;
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
    assert.deepStrictEqual(written['countinghouse'], JSON.parse(entryFor(s, 'cursor')).mcpServers['countinghouse']);
    const record = readJson(path.join(s.home, 'installed-clients.json'));
    assert.deepStrictEqual(record.entries.map((e) => [e.client, e.file, e.key]), [['cursor', file, 'countinghouse']]);
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
    assert.deepStrictEqual(readJson(vs).mcpServers['countinghouse'], JSON.parse(entryFor(s, 'vscode')).mcpServers['countinghouse']);
    assert.ok(fs.readFileSync(toml, 'utf8').startsWith(before));
    assert.ok(fs.readFileSync(toml, 'utf8').includes(entryFor(s, 'codex')));
    // (Codex's own waits: a first start that loads the packs on a busy
    // machine, and a call as long as countinghouse's longest request timeout)
    assert.match(fs.readFileSync(toml, 'utf8'), /^\[mcp_servers\.countinghouse\]\ncommand = .*\nargs = .*\nstartup_timeout_sec = 90\ntool_timeout_sec = 130\n/m);
    assert.strictEqual(await uninstall({}, io(s, ['yes'])), 0);
    assert.strictEqual(fs.readFileSync(toml, 'utf8'), before);
    assert.deepStrictEqual(readJson(vs).mcpServers, {});
  } finally {
    s.done();
  }
});

// From /code-review medium on #2.
test('add refreshes an entry it wrote itself, after a Node upgrade moved the path', async () => {
  const s = setup();
  try {
    assert.strictEqual(await add('cursor', io(s)), 0);
    const later = fakeIo({env: {}, homedir: s.user});
    later.node = '/opt/node-26/bin/node';
    assert.strictEqual(await add('cursor', later), 0, later.err);
    const file = path.join(s.user, '.cursor', 'mcp.json');
    assert.strictEqual(readJson(file).mcpServers['countinghouse'].command, '/opt/node-26/bin/node');
    const record = readJson(path.join(s.home, 'installed-clients.json'));
    assert.strictEqual(record.entries.length, 1);
    assert.strictEqual(record.entries[0].entry.command, '/opt/node-26/bin/node');
    const toml = fakeIo({env: {}, homedir: s.user});
    assert.strictEqual(await add('codex', toml), 0);
    toml.node = '/opt/node-26/bin/node';
    assert.strictEqual(await add('codex', toml), 0, toml.err);
    const text = fs.readFileSync(path.join(s.user, '.codex', 'config.toml'), 'utf8');
    assert.strictEqual(text.split('[mcp_servers.countinghouse]').length, 2, 'one table');
    assert.ok(text.includes('command = "/opt/node-26/bin/node"'));
  } finally {
    s.done();
  }
});

// (the medium, three rounds: ch-local's Codex table is its own to rewrite or
// take back only while the whole of it is what ch-local wrote; a table the
// user changed is theirs, whole, so no key is ever written twice, no line of
// theirs joins another table, and no table is left without its command)
const codexFile = (s) => path.join(s.user, '.codex', 'config.toml');
const coreOf = (s) => entryFor(s, 'codex').split('\n').slice(0, 3).join('\n') + '\n';

test('a Codex table the user changed is left whole, by add and by uninstall, with the messages as before', async () => {
  for (const change of [
    (x) => x.replace('startup_timeout_sec = 90', 'startup_timeout_sec = 300'),   // a wait edited in place
    (x) => `${x}env = { X = "1" }\n`,   // a line added
    (x) => `${x}tools = [\n  ["a"],\n  ["b"]\n]\n`,   // a multi-line array, a line of it beginning with [
    (x) => `${x}\n[mcp_servers.countinghouse.env]\nX = "1"\n`   // a table of its own under it
  ]) {
    const s = setup();
    try {
      const file = codexFile(s);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      const other = '[mcp_servers.other]\ncommand = "other"\n';
      fs.writeFileSync(file, other);
      assert.strictEqual(await add('codex', io(s)), 0);
      fs.writeFileSync(file, change(fs.readFileSync(file, 'utf8')));
      const changed = fs.readFileSync(file, 'utf8');
      const again = fakeIo({env: {}, homedir: s.user});
      again.node = '/opt/node-26/bin/node';
      assert.strictEqual(await add('codex', again), 1, changed);
      assert.match(again.err, /already has a \[mcp_servers\.countinghouse\] table; ch-local leaves it alone/);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), changed, 'add leaves it whole');
      const u = io(s, ['yes']);
      assert.strictEqual(await uninstall({}, u), 0);
      assert.match(u.out + u.err, /the \[mcp_servers\.countinghouse\] table was changed since ch-local wrote it; left in place/);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), changed, 'uninstall leaves it whole');
    } finally {
      s.done();
    }
  }
});

test('a Codex table still ch-local\'s after an editor changed its line ends or its last line end is still recognised', async () => {
  for (const [name, edit] of [['CRLF', (x) => x.replace(/\n/g, '\r\n')], ['no final newline', (x) => x.replace(/\n$/, '')], ['blank lines after', (x) => `${x}\n\n`]]) {
    const s = setup();
    try {
      const file = codexFile(s);
      assert.strictEqual(await add('codex', io(s)), 0);
      fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')));
      const again = fakeIo({env: {}, homedir: s.user});
      again.node = '/opt/node-26/bin/node';
      assert.strictEqual(await add('codex', again), 0, `${name}: ${again.err}`);
      assert.ok(fs.readFileSync(file, 'utf8').includes('command = "/opt/node-26/bin/node"'), name);
      assert.strictEqual(fs.readFileSync(file, 'utf8').split('[mcp_servers.countinghouse]').length, 2, `${name}: one table`);
      assert.strictEqual(await uninstall({}, io(s, ['yes'])), 0);
      assert.ok(!fs.readFileSync(file, 'utf8').includes('mcp_servers'), `${name}: taken back`);
    } finally {
      s.done();
    }
  }
});

test('an entry an earlier ch-local added (its three lines) gets the waits when added again', async () => {
  const s = setup();
  try {
    const file = codexFile(s);
    assert.strictEqual(await add('codex', io(s)), 0);
    // (as an earlier ch-local left it: its three lines, recorded as its block)
    fs.writeFileSync(file, coreOf(s));
    const where = path.join(s.home, 'installed-clients.json');
    const rec = readJson(where);
    rec.entries = rec.entries.map((e) => ({...e, block: coreOf(s)}));
    fs.writeFileSync(where, JSON.stringify(rec));
    assert.strictEqual(await add('codex', io(s)), 0);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), entryFor(s, 'codex'));
    assert.strictEqual(await uninstall({}, io(s, ['yes'])), 0);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '');
  } finally {
    s.done();
  }
});

test('an earlier snippet pasted by hand counts as written by hand, as before', async () => {
  const s = setup();
  try {
    const file = codexFile(s);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, coreOf(s));
    const a = io(s);
    assert.strictEqual(await add('codex', a), 0, a.err);
    assert.match(a.out, /already there .* written by hand/);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), coreOf(s));
  } finally {
    s.done();
  }
});

test('uninstall never joins two lines where the blank line before ch-local\'s table is gone', async () => {
  const s = setup();
  try {
    const file = codexFile(s);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, '[a]\nx = 1\n');
    assert.strictEqual(await add('codex', io(s)), 0);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('x = 1\n\n', 'x = 1\n') + '[b]\ny = 2\n');
    assert.strictEqual(await uninstall({}, io(s, ['yes'])), 0);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '[a]\nx = 1\n[b]\ny = 2\n');
  } finally {
    s.done();
  }
});

// (the medium's last round: the exact match's edges, each first seen to fail)
test('exact-match edges: a CRLF file, a sub-table elsewhere, a comment after the table, a quoted bracket in a header, a broken record', async () => {
  const removed = async (setupFile, check, record) => {
    const s = setup();
    try {
      const file = codexFile(s);
      fs.mkdirSync(path.dirname(file), {recursive: true});
      fs.writeFileSync(file, 'a = 1\n');
      assert.strictEqual(await add('codex', io(s)), 0);
      fs.writeFileSync(file, setupFile(fs.readFileSync(file, 'utf8')));
      if (record != null) {
        const where = path.join(s.home, 'installed-clients.json');
        const rec = readJson(where);
        rec.entries = rec.entries.map(record);
        fs.writeFileSync(where, JSON.stringify(rec));
      }
      const u = io(s, ['yes']);
      assert.strictEqual(await uninstall({}, u), 0, u.err);
      check(fs.readFileSync(file, 'utf8'), u.out + u.err);
    } finally {
      s.done();
    }
  };
  // a CRLF file: the separator goes whole, no lone CR is left
  await removed((x) => x.replace(/\n/g, '\r\n'), (x) => assert.strictEqual(x, 'a = 1\r\n'));
  // a table of its own under it, anywhere in the file: left whole
  await removed((x) => `${x}\n[x]\ny = 1\n\n[mcp_servers.countinghouse.env]\nX = "1"\n`, (x, said) => { assert.match(x, /^\[mcp_servers\.countinghouse\]$/m); assert.match(said, /left in place/); });
  // a comment before the next table is not part of ch-local's
  await removed((x) => `${x}\n# my other servers\n[mcp_servers.other]\ncommand = "o"\n`, (x) => assert.strictEqual(x, 'a = 1\n\n# my other servers\n[mcp_servers.other]\ncommand = "o"\n'));
  // a header with a bracket inside a quoted key ends ch-local's table
  await removed((x) => `${x}[projects."/home/u/repo[old]"]\ntrust_level = "trusted"\n`, (x) => assert.strictEqual(x, 'a = 1\n[projects."/home/u/repo[old]"]\ntrust_level = "trusted"\n'));
  // the blank line before it gone, the table last: the line before keeps its line end
  await removed((x) => x.replace('a = 1\n\n', 'a = 1\n'), (x) => assert.strictEqual(x, 'a = 1\n'));
  // a record with no block: changed, left in place, and the uninstall goes on
  await removed((x) => x, (x, said) => { assert.match(x, /mcp_servers\.countinghouse/); assert.match(said, /left in place/); }, (e) => ({...e, block: undefined}));
});

test('add rewrites ch-local\'s table in a CRLF file with CRLF line ends', async () => {
  const s = setup();
  try {
    const file = codexFile(s);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, 'a = 1\r\n');
    assert.strictEqual(await add('codex', io(s)), 0);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
    const again = fakeIo({env: {}, homedir: s.user});
    again.node = '/opt/node-26/bin/node';
    assert.strictEqual(await add('codex', again), 0, again.err);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('command = "/opt/node-26/bin/node"\r\n'), JSON.stringify(text));
    assert.ok(!/[^\r]\n/.test(text), `no bare LF: ${JSON.stringify(text)}`);
  } finally {
    s.done();
  }
});

test('an entry the user pasted is never adopted, so uninstall cannot take it', async () => {
  const s = setup();
  try {
    const file = path.join(s.user, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, entryFor(s, 'cursor'));
    const a = io(s);
    assert.strictEqual(await add('cursor', a), 0);
    assert.match(a.out, /already there in .*mcp\.json; written by hand, so ch-local does not record it/);
    assert.ok(!fs.existsSync(path.join(s.home, 'installed-clients.json')) || readJson(path.join(s.home, 'installed-clients.json')).entries.length === 0);
    assert.strictEqual(await uninstall({}, io(s, ['yes'])), 0);
    assert.ok(readJson(file).mcpServers['countinghouse'], 'the pasted entry stays');
  } finally {
    s.done();
  }
});

test('an equivalent TOML table header is recognised, never duplicated', async () => {
  const s = setup();
  try {
    const toml = path.join(s.user, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(toml), {recursive: true});
    for (const header of ['[mcp_servers."countinghouse"]', '[ mcp_servers.countinghouse ]', "[mcp_servers.'countinghouse']"]) {
      fs.writeFileSync(toml, `${header}\ncommand = "mine"\n`);
      const a = io(s);
      assert.strictEqual(await add('codex', a), 1, header);
      assert.match(a.err, /already has a \[mcp_servers\.countinghouse\] table/);
      assert.strictEqual(fs.readFileSync(toml, 'utf8'), `${header}\ncommand = "mine"\n`);
    }
  } finally {
    s.done();
  }
});

test('a config file that is not an object of servers is never rewritten', async () => {
  const s = setup();
  try {
    const file = path.join(s.user, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    for (const body of ['null', '[]', '{"mcpServers": []}', '{"mcpServers": "x"}']) {
      fs.writeFileSync(file, body);
      const a = io(s);
      assert.strictEqual(await add('cursor', a), 1, body);
      assert.match(a.err, /add the entry by hand/, body);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), body);
    }
  } finally {
    s.done();
  }
});

test('a rewritten config keeps its permissions and its symlink', {skip: process.platform === 'win32' ? 'POSIX modes and symlinks' : false}, async () => {
  const s = setup();
  try {
    const real = path.join(s.user, 'dotfiles', 'config.toml');
    fs.mkdirSync(path.dirname(real), {recursive: true});
    fs.writeFileSync(real, 'model = "o4"\n', {mode: 0o600});
    fs.chmodSync(real, 0o600);
    fs.mkdirSync(path.join(s.user, '.codex'));
    fs.symlinkSync(real, path.join(s.user, '.codex', 'config.toml'));
    assert.strictEqual(await add('codex', io(s)), 0);
    assert.ok(fs.lstatSync(path.join(s.user, '.codex', 'config.toml')).isSymbolicLink(), 'still a link');
    assert.ok(fs.readFileSync(real, 'utf8').includes('[mcp_servers.countinghouse]'), 'the target was written');
    assert.strictEqual(fs.statSync(real).mode & 0o777, 0o600);
  } finally {
    s.done();
  }
});

test('add never replaces an entry it did not write', async () => {
  const s = setup();
  try {
    const file = path.join(s.user, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify({mcpServers: {'countinghouse': {command: 'mine'}}}));
    const a = io(s);
    assert.strictEqual(await add('cursor', a), 1);
    assert.match(a.err, /already has a "countinghouse" entry; ch-local leaves it alone/);
    assert.deepStrictEqual(readJson(file).mcpServers['countinghouse'], {command: 'mine'});
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
    changed.mcpServers['countinghouse'].args.push('--extra');
    fs.writeFileSync(file, JSON.stringify(changed));
    const u = io(s, ['yes']);
    assert.strictEqual(await uninstall({}, u), 0);
    assert.match(u.out + u.err, /changed since ch-local wrote it; left in place/);
    assert.ok(readJson(file).mcpServers['countinghouse']);
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
    assert.match(a.err, /not installed yet: run `(?:COUNTINGHOUSE_HOME="[^"]+" )?npx @countinghouse\/ch-local install --pack ci-failure-triage`(?: \(with COUNTINGHOUSE_HOME set to [^)]+\))? first/);
    // (on Windows, a home not the default: named in words after the
    // command, or the install goes to the default home -- the closing
    // pass on release 1, L3)
    const w = Object.assign(io(s), {platform: 'win32'});
    assert.strictEqual(await add('cursor', w), 1);
    assert.match(w.err, /not installed yet: run `npx @countinghouse\/ch-local install --pack ci-failure-triage` \(with COUNTINGHOUSE_HOME set to [^)]+\) first/);
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

// (the medium on the docs PR: Copilot reads $COPILOT_HOME/mcp-config.json
// when that is set, and add writes it there, as it honours CODEX_HOME)
test('add vscode writes under $COPILOT_HOME when it is set', async () => {
  const s = setup();
  try {
    const copilotHome = path.join(s.user, 'elsewhere-copilot');
    const f = fakeIo({env: {COPILOT_HOME: copilotHome}, homedir: s.user});
    assert.strictEqual(await add('vscode', f), 0, f.err);
    assert.ok(fs.existsSync(path.join(copilotHome, 'mcp-config.json')));
    assert.ok(!fs.existsSync(path.join(s.user, '.copilot', 'mcp-config.json')));
  } finally {
    s.done();
  }
});
