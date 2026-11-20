'use strict';
// ch-local dev-server (A-ownuse; Matt's "build my own tool", Option A,
// DECISIONS 2026-11-20): a local countinghouse development server for the
// user's own tools, which the plugin's countinghouse-module skill builds with
// the authoring tools (validate, load, call). It runs the home's own installed
// runtime, in the foreground, in the user's own terminal; nothing new in the
// runtime and nothing in the pack install:
//   - 127.0.0.1 only, on a fixed port (default 7531), so Claude Code's entry
//     for it stays valid;
//   - --authoringTools, behind an admin key: 32 random bytes, made once into
//     <home>/dev-auth/admin-key (0600, or an owner-only DACL on Windows) and
//     kept, or made anew with --new-key (Matt, 11-20: a stable key, rotated
//     on demand), never printed: the lines it prints for Claude Code read it
//     in the shell, printed when the key is new;
//   - --store local under <home>/dev/store; the user's modules kept in
//     <home>/dev/modules, loaded by the authoring tools;
//   - the same short environment the packs' runtime starts from
//     (lib/shim-config.js runtimeEnv): no client credential, no proxy.
// No pack is loaded there and no credential slot is passed. uninstall removes
// dev-auth/ (a secret) always and dev/ (the user's own code) unless
// --keep-data.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {layout, UNSAFE_IN_COMMAND} = require('./home');
const {checkDir} = require('./credential-store');
const {writePrivate} = require('./private-write');
const {runtimeEnv} = require('./shim-config');

const DEFAULT_PORT = 7531;
const KEY_FILE = 'admin-key';

// whether 127.0.0.1:port can be listened on now
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen({port, host: '127.0.0.1', exclusive: true}, () => s.close(() => resolve(true)));
});

// A path the printed lines may quote: on POSIX inside double quotes (the
// runtime's rule, lib/home.js UNSAFE_IN_COMMAND); in PowerShell inside
// single quotes, where ' and the typographic quotes end it. Else null.
function quotable(file, platform) {
  if (platform === 'win32') return /['‘-‟\u0000-\u001f\u007f]/.test(file) ? null : file;
  return UNSAFE_IN_COMMAND.test(file) ? null : file;
}

// The lines said before the server starts (the fixed text business checked:
// ch-business tech/plans/2026-11-20-a-firstrun-ownuse-plan.md, Fixed text 5,
// and its stable-key revision, 11-20). fresh: the key was just made, so
// Claude Code's entry is added (again); else the entry from before works.
function linesFor({port, keyFile, modules, platform, fresh, launcher}) {
  const url = `http://127.0.0.1:${port}/mcp`;
  const read = platform === 'win32' ? `$(Get-Content '${keyFile}')` : `$(cat "${keyFile}")`;
  const add = fresh ? [
    `Its key is new: add it to Claude Code, in another terminal${platform === 'win32' ? ' (PowerShell)' : ''}:`,
    '  claude mcp remove --scope user countinghouse-dev',
    `  claude mcp add --scope user --transport http countinghouse-dev ${url} --header "X-CH-Key: ${read}"`
  ] : [
    `Claude Code's countinghouse-dev entry from before still works. To make a new key: node "${launcher}" dev-server --new-key`
  ];
  return [
    `countinghouse development server: ${url} (stop it with Ctrl-C)`,
    ...add,
    `Keep your tools' modules in ${modules}, and load them again after each start. They run here only: not inside your installed packs, not upgraded with them, and not published or shared.`
  ];
}

// The kept key, if it is one this command made and still private: a regular
// file, never a link, this user's alone on POSIX (dev-auth/ itself is
// checked as the credential store's, an owner-only DACL on Windows), 64 hex
// characters -> the key, null when there is none, or throws the problem
function keptKey(keyFile, platform) {
  let st;
  try { st = fs.lstatSync(keyFile); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error(`${keyFile} could not be read (${e.code || e.message})`); }
  if (!st.isFile()) throw new Error(`${keyFile} is not a file this command made: start with --new-key to replace it`);
  if (platform !== 'win32') {
    if ((st.mode & 0o077) !== 0) throw new Error(`${keyFile} is open to others: start with --new-key to replace it`);
    if (typeof process.geteuid === 'function' && st.uid !== process.geteuid()) throw new Error(`${keyFile} is not this user's: start with --new-key to replace it`);
  }
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`${keyFile} is not a key this command made: start with --new-key to replace it`);
  return key;
}

async function devServer({port = DEFAULT_PORT, newKey = false}, io) {
  const say = (s) => io.stdout.write(`${s}\n`);
  const fail = (s, code = 1) => { io.stderr.write(`ch-local dev-server: ${s}\n`); return code; };
  const platform = io.platform || process.platform;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('--port takes a port number, 1 to 65535', 2);
  const where = layout(io.env, io.homedir);
  const runtimeBin = path.join(where.app, 'node_modules', 'countinghouse', 'bin', 'countinghouse');
  if (!fs.existsSync(runtimeBin)) return fail(`countinghouse is not installed in ${where.home}: install a pack first (ch-local install)`);
  const authDir = path.join(where.home, 'dev-auth');
  const keyFile = path.join(authDir, KEY_FILE);
  // (a path the printed lines would break on is refused, never printed: the
  // A-ownuse medium, 3)
  if (quotable(keyFile, platform) == null) return fail(`${where.home} holds a character a shell would read in the lines printed for Claude Code: set COUNTINGHOUSE_HOME to a plain path`, 2);
  if (!await (io.portFree || portFree)(port)) return fail(`port ${port} on 127.0.0.1 is in use: choose another with --port <n>`, 2);

  // dev-auth/, a secret: a directory of this user's alone, never a link (the
  // credential store's own check; the A-ownuse medium, 5)
  try { checkDir(authDir, {platform, create: true}); } catch (e) { return fail(e.message); }
  // the key: kept from before, or made now (the first start, or --new-key);
  // never printed
  let key = null;
  if (!newKey) { try { key = keptKey(keyFile, platform); } catch (e) { return fail(e.message); } }
  const fresh = key == null;
  if (fresh) {
    key = crypto.randomBytes(32).toString('hex');
    writePrivate(authDir, KEY_FILE, key);
  }
  writePrivate(authDir, 'auth.json', `${JSON.stringify({[key]: {userName: 'dev', devices: ['*'], admin: true}})}\n`);
  // the user's own code and the server's store: dev/, data
  const dev = path.join(where.home, 'dev');
  const modules = path.join(dev, 'modules');
  const store = path.join(dev, 'store');
  for (const d of [dev, modules, store]) fs.mkdirSync(d, {recursive: true});

  for (const line of linesFor({port, keyFile, modules, platform, fresh, launcher: where.launcher})) say(line);
  // (no --modulePath: a start without --moduleRegistry loads nothing from it,
  // and the authoring tools load from any path: the A-ownuse medium, 2)
  const args = [runtimeBin,
    '--bindAddr', '127.0.0.1', '--port', String(port),
    '--store', 'local', '--storePath', store,
    '--authProvider', 'file', '--authConfigPath', path.join(authDir, 'auth.json'),
    '--authoringTools', '--workerThread'];
  const child = io.spawn(io.node, args, {env: runtimeEnv(io.env, platform)});
  // each signal passed on once; Ctrl-C at a terminal already reached the
  // runtime through the terminal's process group, so it is not sent again
  // (the A-ownuse medium, 6)
  const atTerminal = io.stdinIsTTY != null ? io.stdinIsTTY : process.stdin.isTTY === true;
  const forwarded = new Set();
  const untrap = io.trapSignals((signal) => {
    if (forwarded.has(signal) || (signal === 'SIGINT' && atTerminal)) return;
    forwarded.add(signal);
    try { child.kill(signal); } catch (e) { /* gone */ }
  });
  try {
    return await child.exited;
  } finally {
    untrap();
  }
}

module.exports = {devServer, linesFor, quotable, DEFAULT_PORT};
