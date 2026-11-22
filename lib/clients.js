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
const {chLocal} = require('./command-line');

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

// Appends the TOML table, or rewrites the one it wrote; records the separator it added.
function addToml(file, block, recorded) {
  const text = readText(file) || '';
  if (TABLE.test(text)) {
    if (recorded !== undefined && recorded.kind === 'toml' && text.includes(recorded.block)) {
      writeAtomic(file, text.replace(recorded.block, block));
      return {ok: true, record: {kind: 'toml', block, separator: recorded.separator}};
    }
    return text.includes(block) ? BY_HAND : {ok: false, why: `${file} already has a [mcp_servers.${SERVER}] table; ch-local leaves it alone`};
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
  if (!fs.existsSync(where.launcher)) { io.stderr.write(`ch-local: not installed yet: run ${chLocal(where, 'install --pack ci-failure-triage')} first\n`); return 1; }
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
  const exact = e.separator + e.block;
  if (e.separator !== '' && text.includes(exact)) { writeAtomic(e.file, text.replace(exact, '')); return `${e.file}: removed [mcp_servers.${e.key}]`; }
  if (text.includes(e.block)) { writeAtomic(e.file, text.replace(e.block, '')); return `${e.file}: removed [mcp_servers.${e.key}]`; }
  return `${e.file}: the [mcp_servers.${e.key}] table was changed since ch-local wrote it; left in place`;
}

module.exports = {add, removeEntry, readRecord, FILES};
