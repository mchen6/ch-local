'use strict';
// ch-local add <client>: writes the client's entry for the installed launcher
// and records exactly what it wrote in <home>/installed-clients.json, so that
// uninstall can take back exactly that and nothing else.
const fs = require('node:fs');
const {isDeepStrictEqual: same} = require('node:util');
const path = require('node:path');
const {snippet, SERVER} = require('./snippets');
const {layout} = require('./home');
const {writeAtomic} = require('./atomic');
const {chLocal, hintCommand} = require('./command-line');

const absolute = (v) => (typeof v === 'string' && path.isAbsolute(v) ? v : null);
// The file each client reads, under the user's home directory.
const FILES = {
  cursor: (home) => path.join(home, '.cursor', 'mcp.json'),
  // (Copilot reads $COPILOT_HOME/mcp-config.json when that is set)
  // (a client's home variable only when absolute: a relative one would name
  // a file under whatever directory add runs in)
  vscode: (home, env) => path.join(absolute(env.COPILOT_HOME) || path.join(home, '.copilot'), 'mcp-config.json'),
  codex: (home, env) => path.join(absolute(env.CODEX_HOME) || path.join(home, '.codex'), 'config.toml')
};
// (where: the home's layout, for the command's launcher form:
// lib/command-line.js)
const elsewhere = (where) => ({
  'claude-code': `Claude Code: use the plugin (claude plugin marketplace add mchen6/ch-local, then claude plugin install ch-packs@ch-packs), or run the line \`${chLocal(where, 'snippet claude-code')}\` prints`,
  'claude-desktop': `Claude Desktop: its route is the .mcpb bundle, which is not built yet (\`${chLocal(where, 'snippet claude-desktop')}\` says why)`
});

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
// Any TOML spelling of the table's header: bare, double- or single-quoted key, spaces.
const TABLE = new RegExp(`^[ \\t]*\\[[ \\t]*mcp_servers[ \\t]*\\.[ \\t]*(?:"${SERVER}"|'${SERVER}'|${SERVER})[ \\t]*\\][ \\t]*(?:#.*)?$`, 'm');
const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);

function readRecord(where) {
  const text = readText(where.clients);
  return text == null ? {entries: []} : JSON.parse(text);
}
function writeRecord(where, record) {
  writeAtomic(where.clients, JSON.stringify(record, null, 2) + '\n');
}

// The outcome of an add: {ok: true, record} when ch-local wrote (or rewrote its
// own) entry, {ok: true, record: null} when an identical entry was written by
// hand (never adopted, so uninstall leaves it), {ok: false, why} otherwise.
const BY_HAND = {ok: true, record: null};

// `recorded`: what ch-local wrote to this file last time, or undefined.
function addJson(file, entry, recorded, where, client) {
  const text = readText(file);
  let config = {};
  if (text != null && text.trim() !== '') {
    try { config = JSON.parse(text); } catch { return {ok: false, why: `${file} is not plain JSON; add the entry by hand (${chLocal(where, `snippet ${client}`)} prints it)`}; }
  }
  if (!isObject(config) || (config.mcpServers !== undefined && !isObject(config.mcpServers))) {
    return {ok: false, why: `${file} does not hold an object of servers ("mcpServers"); add the entry by hand (${chLocal(where, `snippet ${client}`)} prints it)`};
  }
  if (config.mcpServers === undefined) config.mcpServers = {};
  const existing = config.mcpServers[SERVER];
  const ours = recorded !== undefined && recorded.kind === 'json' && same(existing, recorded.entry);
  if (existing !== undefined && !ours) {
    return same(existing, entry) ? BY_HAND : {ok: false, why: `${file} already has a "${SERVER}" entry; ch-local leaves it alone`};
  }
  config.mcpServers[SERVER] = entry;
  writeAtomic(file, JSON.stringify(config, null, 2) + '\n');
  return {ok: true, record: {kind: 'json', entry}};
}

// Codex's table is ch-local's to rewrite or take back only while the whole
// of it, from its header to the next table, is still what ch-local wrote (its
// line endings and the blank lines after it aside). Any change of the user's
// (a wait set another way, a line added, a table of its own under it) leaves
// it to them, whole: nothing of theirs is merged with ch-local's lines, so no
// key is ever written twice (Codex refuses such a file) and no line of theirs
// is left to join another table.
// (a header: a line that is only [name] or [[name]], and a comment; a quoted
// part of a name may hold any character, a bracket too)
const HEADER = /^[ \t]*\[\[?(?:"[^"\n]*"|'[^'\n]*'|[^[\]\n"'])+\]\]?[ \t]*(?:#.*)?\r?$/m;
// (a table under this server's own, anywhere in the file: [mcp_servers.countinghouse.<name>])
const UNDER = new RegExp(`^[ \\t]*\\[\\[?[ \\t]*mcp_servers[ \\t]*\\.[ \\t]*(?:"${SERVER}"|'${SERVER}'|${SERVER})[ \\t]*\\.`, 'm');
// -> {at, body, end, under} for the table in text: body is its text with the
// blank and comment lines after it left out, end where the next table begins;
// under: the file holds a table under this server's; or null
function codexTable(text) {
  const m = TABLE.exec(text);
  if (m == null) return null;
  const nl = text.indexOf('\n', m.index);
  const from = nl < 0 ? text.length : nl + 1;
  const next = HEADER.exec(text.slice(from));
  const end = next == null ? text.length : from + next.index;
  const own = text.slice(m.index, end);
  const lines = own.split('\n');
  while (lines.length > 1 && /^[ \t]*(?:#.*)?\r?$/.test(lines[lines.length - 1])) lines.pop();
  return {at: m.index, body: lines.join('\n').replace(/\r$/, ''), end, under: UNDER.test(text)};
}
const sameTable = (t, block) => typeof block === 'string' && !t.under && t.body.replace(/\r\n/g, '\n') === block.replace(/\n+$/, '');

// Appends the TOML table, or rewrites the one it wrote; records the separator it added.
function addToml(file, block, recorded) {
  const text = readText(file) || '';
  const t = codexTable(text);
  if (t != null) {
    if (recorded !== undefined && recorded.kind === 'toml' && sameTable(t, recorded.block)) {
      // (sliced, not String.replace, whose $& and $' a path may hold; the
      // blank lines after the table kept as they were)
      const after = text.slice(t.at + t.body.length);
      const crlf = t.body.includes('\r\n');
      const lines = block.replace(/\n+$/, '');
      writeAtomic(file, text.slice(0, t.at) + (crlf ? lines.replace(/\n/g, '\r\n') : lines) + (after === '' ? (crlf ? '\r\n' : '\n') : after));
      return {ok: true, record: {kind: 'toml', block, separator: recorded.separator}};
    }
    // (an identical table written by hand, from this ch-local's snippet or an
    // earlier one's: its three lines alone)
    return sameTable(t, block) || sameTable(t, block.split('\n').slice(0, 3).join('\n')) ? BY_HAND
      : {ok: false, why: `${file} already has a [mcp_servers.${SERVER}] table; ch-local leaves it alone`};
  }
  const separator = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  writeAtomic(file, text + separator + block);
  return {ok: true, record: {kind: 'toml', block, separator}};
}

async function add(client, io) {
  const where = layout(io.env, io.homedir);
  const other = elsewhere(where);
  if (other[client] != null) { io.stderr.write(`ch-local: ${other[client]}\n`); return 2; }
  if (FILES[client] == null) { io.stderr.write(`ch-local: unknown client "${client}"; one of: ${Object.keys(FILES).join(', ')}\n`); return 2; }
  // (the npx form before an install: the home in words on Windows, as
  // every pre-install hint -- the closing pass on release 1, L3)
  if (!fs.existsSync(where.launcher)) { io.stderr.write(`ch-local: not installed yet: run ${hintCommand(where, 'install --pack ci-failure-triage', io.platform)} first\n`); return 1; }
  const file = FILES[client](io.homedir(), io.env);
  // the native shim where this platform has one (and its shim.json, kept
  // current), else the per-session runtime, said
  const {shim, note} = require('./shim-binary').shimFor({home: where.home, locate: io.locateShim ?? undefined});
  if (shim != null) require('./shim-config').writeShimJson(where.home, {node: io.node, env: io.env, platform: io.platform});
  if (note != null) io.stderr.write(note);
  const {text} = snippet(client, {node: io.node, launcher: where.launcher, home: where.home});
  const record = readRecord(where);
  const recorded = record.entries.find((e) => e.client === client && e.file === file);
  const r = client === 'codex' ? addToml(file, text, recorded) : addJson(file, JSON.parse(text).mcpServers[SERVER], recorded, where, client);
  if (!r.ok) { io.stderr.write(`ch-local: ${r.why}\n`); return 1; }
  if (r.record == null) { io.stdout.write(`"${SERVER}" is already there in ${file}; written by hand, so ch-local does not record it\n`); return 0; }
  record.entries = record.entries.filter((e) => e !== recorded);
  record.entries.push({client, file, key: SERVER, ...r.record, at: new Date().toISOString()});
  writeRecord(where, record);
  io.stdout.write(`added "${SERVER}" to ${file}\n`);
  return 0;
}

// Takes back one recorded entry -> a line saying what happened.
function removeEntry(e) {
  const text = readText(e.file);
  if (text == null) return `${e.file}: gone already`;
  if (e.kind === 'json') {
    let config;
    try { config = JSON.parse(text); } catch { return `${e.file}: no longer plain JSON; left in place`; }
    const servers = config.mcpServers || {};
    if (servers[e.key] === undefined) return `${e.file}: no "${e.key}" entry any more`;
    if (!same(servers[e.key], e.entry)) return `${e.file}: the "${e.key}" entry was changed since ch-local wrote it; left in place`;
    delete servers[e.key];
    writeAtomic(e.file, JSON.stringify(config, null, 2) + '\n');
    return `${e.file}: removed "${e.key}"`;
  }
  const t = codexTable(text);
  if (t == null || !sameTable(t, e.block)) return `${e.file}: the [mcp_servers.${e.key}] table was changed since ch-local wrote it; left in place`;
  // (its last line's own line end goes with it; the separator ch-local added
  // before it too, unless taking it would join two lines)
  let to = t.at + t.body.length;
  if (text.startsWith('\r\n', to)) to += 2; else if (text.startsWith('\n', to)) to += 1;
  // (the separator as it stands, its line ends turned to CRLF by an editor or not)
  const recordedSep = typeof e.separator === 'string' ? e.separator : '';
  const sep = [recordedSep.replace(/\n/g, '\r\n'), recordedSep].find((x) => x !== '' && text.slice(t.at - x.length, t.at) === x) || '';
  const before = text.slice(0, t.at - sep.length);
  // (a file that had no last line end gets none back; else the line before keeps its own)
  const drop = sep !== '' && (before === '' || before.endsWith('\n') || (to === text.length && recordedSep === '\n\n'));
  writeAtomic(e.file, (drop ? before : text.slice(0, t.at)) + text.slice(to));
  return `${e.file}: removed [mcp_servers.${e.key}]`;
}

module.exports = {add, removeEntry, readRecord, FILES};
