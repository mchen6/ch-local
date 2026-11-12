'use strict';
// Each client's config entry for the installed launcher (spec §3). Pure: the
// node and launcher paths come in, the text goes out. No entry sets a
// credential: a stdio child inherits its client's environment, so an env entry
// could only reduce what it sees (reviewer, 2026-11-11). Only Codex, which does
// not forward the environment by default, names the variables to pass.
const SERVER = 'ci-failure-triage';
const PACK = 'ci-failure-triage';
const CREDENTIALS = ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN'];
const CLIENTS = ['claude-code', 'cursor', 'vscode', 'codex', 'claude-desktop'];

const argsOf = (launcher) => [launcher, 'start', '--pack', PACK, '--stdio'];
const json = (obj) => JSON.stringify(obj, null, 2) + '\n';
// A TOML basic string: JSON's escapes are TOML's.
const toml = (s) => JSON.stringify(s);
// A shell word: bare when it is plainly safe, else single-quoted.
const word = (s) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

const RENDER = {
  // https://code.claude.com/docs/en/mcp: `claude mcp add [options] <name> -- <command> [args...]`.
  'claude-code': ({node, launcher}) => [
    'claude mcp add --scope user', SERVER,
    '--', ...[node, ...argsOf(launcher)].map(word)
  ].join(' ') + '\n',
  // https://cursor.com/docs/context/mcp. No `type` (Cursor's docs show entries without it).
  cursor: ({node, launcher}) => json({mcpServers: {[SERVER]: {command: node, args: argsOf(launcher)}}}),
  // ~/.copilot/mcp-config.json, the portable format.
  vscode: ({node, launcher}) => json({mcpServers: {[SERVER]: {type: 'stdio', command: node, args: argsOf(launcher)}}}),
  // https://learn.chatgpt.com/docs/extend/mcp?surface=cli: env_vars whitelists variables
  // forwarded from Codex's own environment.
  codex: ({node, launcher}) => [
    `[mcp_servers.${SERVER}]`,
    `command = ${toml(node)}`,
    `args = [${argsOf(launcher).map(toml).join(', ')}]`,
    `env_vars = [${CREDENTIALS.map(toml).join(', ')}]`
  ].join('\n') + '\n',
  'claude-desktop': () => ''
};

// What a client gets instead of an entry, on stderr.
const NOTES = {
  'claude-desktop': [
    'Claude Desktop has no config entry to paste.',
    'Desktop does not see your shell\'s environment, and a GitHub token is never written to a config file,',
    'so the route for Desktop is the .mcpb bundle, which keeps the token in the OS keychain.',
    'The bundle is not built yet.'
  ].join('\n') + '\n'
};

// {node, launcher} -> {text, note?}: text is the entry to paste (empty when
// there is none), note says why there is none. Throws on an unknown client.
function snippet(client, {node, launcher}) {
  if (!Object.prototype.hasOwnProperty.call(RENDER, client)) {
    throw new Error(`unknown client "${client}"; one of: ${CLIENTS.join(', ')}`);
  }
  const text = RENDER[client]({node, launcher});
  return NOTES[client] != null ? {text, note: NOTES[client]} : {text};
}

module.exports = {snippet, CLIENTS, SERVER, PACK};
