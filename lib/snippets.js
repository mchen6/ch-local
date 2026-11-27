'use strict';
// Each client's config entry for the installed launcher (spec §3). Pure: the
// node and launcher paths come in, the text goes out. No entry sets a
// credential, and none forwards one: a credential is a module's own, in the
// store, never a client's environment (#413 section 6.9; L5a).
// One entry serves every installed pack (reviewer, 2026-11-12).
const SERVER = 'countinghouse';
// start loads every installed pack, so an entry names none.
const CLIENTS = ['claude-code', 'cursor', 'vscode', 'codex', 'claude-desktop'];

// The entry runs the home's launcher's `session`, which decides at each
// session start between the shared runtime (the native shim, countinghouse
// #236) and this session's own (lib/session.js): one decision, in the home's
// code, so an entry never names a shim that was set aside (#120).
const commandOf = ({node, launcher, home}) => ({command: node, args: [launcher, 'session', '--home', home]});
const json = (obj) => JSON.stringify(obj, null, 2) + '\n';
// A TOML basic string: JSON's escapes are TOML's.
const toml = (s) => JSON.stringify(s);
// A shell word: bare when it is plainly safe; else double-quoted, which bash,
// zsh, cmd.exe and PowerShell all read (the line has no $ of its own); a word
// holding " $ ` or ! is single-quoted, the POSIX way.
const word = (s) => {
  if (/^[A-Za-z0-9_./:=%+-]+$/.test(s)) return s;
  if (!/["$`!]/.test(s)) return `"${s}"`;
  return `'${s.replace(/'/g, `'\\''`)}'`;
};

const RENDER = {
  // https://code.claude.com/docs/en/mcp: `claude mcp add [options] <name> -- <command> [args...]`.
  'claude-code': (w) => {
    const {command, args} = commandOf(w);
    return ['claude mcp add --scope user', SERVER, '--', ...[command, ...args].map(word)].join(' ') + '\n';
  },
  // https://cursor.com/docs/context/mcp. No `type` (Cursor's docs show entries without it).
  cursor: (w) => json({mcpServers: {[SERVER]: commandOf(w)}}),
  // ~/.copilot/mcp-config.json, the portable format.
  vscode: (w) => json({mcpServers: {[SERVER]: {type: 'stdio', ...commandOf(w)}}}),
  // https://learn.chatgpt.com/docs/extend/mcp?surface=cli (no env_vars: no
  // variable of Codex's own environment is forwarded). Codex's own waits:
  // startup_timeout_sec (its default 10) covers a cold first start on a busy
  // machine, whose first tools/list answers once the packs are loaded;
  // tool_timeout_sec (its default 60) is above countinghouse's longest
  // requestTimeout, 120 s, so the runtime's own limit ends a call first
  // (Codex's clock starts before the call reaches the runtime).
  codex: (w) => [
    `[mcp_servers.${SERVER}]`,
    `command = ${toml(commandOf(w).command)}`,
    `args = [${commandOf(w).args.map(toml).join(', ')}]`,
    'startup_timeout_sec = 90',
    'tool_timeout_sec = 130'
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

// {node, launcher, home} -> {text, note?}: text is the entry to paste
// (empty when there is none), note says why there is none. home: the
// absolute home the session is given. Throws on an unknown client.
function snippet(client, {node, launcher, home}) {
  if (!Object.prototype.hasOwnProperty.call(RENDER, client)) {
    throw new Error(`unknown client "${client}"; one of: ${CLIENTS.join(', ')}`);
  }
  const text = RENDER[client]({node, launcher, home});
  return NOTES[client] != null ? {text, note: NOTES[client]} : {text};
}

module.exports = {snippet, CLIENTS, SERVER};
