'use strict';
// Each client's config entry for the installed launcher (spec §3). Pure: the
// node and launcher paths come in, the text goes out. No entry sets a
// credential: a stdio child inherits its client's environment, so an env entry
// could only reduce what it sees (reviewer, 2026-11-11). Only Codex, which does
// not forward the environment by default, names the variables to pass.
// One entry serves every installed pack (reviewer, 2026-11-12).
const SERVER = 'countinghouse';
// start loads every installed pack, so an entry names none, and Codex is
// given every pack's variables, once each.
const CREDENTIALS = [...new Set(Object.values(require('./allowlist').ALLOWLIST.packs).flatMap((p) => p.credentials))];
const CLIENTS = ['claude-code', 'cursor', 'vscode', 'codex', 'claude-desktop'];

// The entry runs the native shim with its home where there is one (the
// shared runtime, countinghouse #236), else the per-session runtime.
const argsOf = (launcher) => [launcher, 'start', '--stdio'];
const commandOf = ({node, launcher, shim, home}) => (shim != null ? {command: shim, args: ['--home', home]} : {command: node, args: argsOf(launcher)});
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
  // https://learn.chatgpt.com/docs/extend/mcp?surface=cli: env_vars whitelists variables
  // forwarded from Codex's own environment.
  codex: (w) => [
    `[mcp_servers.${SERVER}]`,
    `command = ${toml(commandOf(w).command)}`,
    `args = [${commandOf(w).args.map(toml).join(', ')}]`,
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

// {node, launcher, shim?, home?} -> {text, note?}: text is the entry to
// paste (empty when there is none), note says why there is none. shim: the
// native shim's path (with home, the absolute home it is given), or none for
// the per-session runtime. Throws on an unknown client.
function snippet(client, {node, launcher, shim = null, home = null}) {
  if (!Object.prototype.hasOwnProperty.call(RENDER, client)) {
    throw new Error(`unknown client "${client}"; one of: ${CLIENTS.join(', ')}`);
  }
  const text = RENDER[client]({node, launcher, shim, home});
  return NOTES[client] != null ? {text, note: NOTES[client]} : {text};
}

module.exports = {snippet, CLIENTS, SERVER};
