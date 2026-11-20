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
//     <home>/dev-auth/admin-key (0600, or an owner-only DACL on Windows), never
//     printed: the line it prints for Claude Code reads it in the shell;
//   - --store local under <home>/dev/store, the user's modules in
//     <home>/dev/modules;
//   - the same short environment the packs' runtime starts from
//     (lib/shim-config.js runtimeEnv): no client credential, no proxy.
// No pack is loaded there and no credential slot is passed. uninstall removes
// dev-auth/ (a secret) always and dev/ (the user's own code) unless
// --keep-data.
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {layout} = require('./home');
const {writePrivate} = require('./private-write');
const {runtimeEnv} = require('./shim-config');

const DEFAULT_PORT = 7531;
const KEY_FILE = 'admin-key';

// a directory only this user may enter (0700; on Windows an owner-only ACL)
function privateDir(dir, platform) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  if (platform === 'win32') require('./win-acl').makePrivateDirs([dir], [dir]);
  else fs.chmodSync(dir, 0o700);
}

// whether 127.0.0.1:port can be listened on now
const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen({port, host: '127.0.0.1', exclusive: true}, () => s.close(() => resolve(true)));
});

// The lines said before the server starts (the fixed text business checked:
// ch-business tech/plans/2026-11-20-a-firstrun-ownuse-plan.md, Fixed text 5)
function linesFor({port, keyFile, modules, platform}) {
  const url = `http://127.0.0.1:${port}/mcp`;
  const read = platform === 'win32' ? `$(Get-Content '${keyFile}')` : `$(cat "${keyFile}")`;
  return [
    `countinghouse development server: ${url} (stop it with Ctrl-C)`,
    'Add it to Claude Code once, in another terminal:',
    `  claude mcp add --scope user --transport http countinghouse-dev ${url} --header "X-CH-Key: ${read}"`,
    `Its tools load modules from ${modules}. They run here only: not inside your installed packs, not upgraded with them, and not published or shared.`
  ];
}

async function devServer({port = DEFAULT_PORT}, io) {
  const say = (s) => io.stdout.write(`${s}\n`);
  const fail = (s, code = 1) => { io.stderr.write(`ch-local dev-server: ${s}\n`); return code; };
  const platform = io.platform || process.platform;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('--port takes a port number, 1 to 65535', 2);
  const where = layout(io.env, io.homedir);
  const runtimeBin = path.join(where.app, 'node_modules', 'countinghouse', 'bin', 'countinghouse');
  if (!fs.existsSync(runtimeBin)) return fail(`countinghouse is not installed in ${where.home}: install a pack first (ch-local install)`);
  if (!await (io.portFree || portFree)(port)) return fail(`port ${port} on 127.0.0.1 is in use: choose another with --port <n>`, 2);

  // the key and its auth config: dev-auth/, a secret
  const authDir = path.join(where.home, 'dev-auth');
  privateDir(authDir, platform);
  const keyFile = path.join(authDir, KEY_FILE);
  if (!fs.existsSync(keyFile)) writePrivate(authDir, KEY_FILE, crypto.randomBytes(32).toString('hex'));
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(key)) return fail(`${keyFile} is not a key this command made: remove it to make a new one`);
  writePrivate(authDir, 'auth.json', `${JSON.stringify({[key]: {userName: 'dev', devices: ['*'], admin: true}})}\n`);
  // the user's own code and the server's store: dev/, data
  const dev = path.join(where.home, 'dev');
  const modules = path.join(dev, 'modules');
  const store = path.join(dev, 'store');
  for (const d of [dev, modules, store]) fs.mkdirSync(d, {recursive: true});

  for (const line of linesFor({port, keyFile, modules, platform})) say(line);
  const args = [runtimeBin,
    '--bindAddr', '127.0.0.1', '--port', String(port),
    '--store', 'local', '--storePath', store,
    '--authProvider', 'file', '--authConfigPath', path.join(authDir, 'auth.json'),
    '--authoringTools', '--workerThread',
    '--modulePath', modules];
  const child = io.spawn(io.node, args, {env: runtimeEnv(io.env, platform)});
  // Ctrl-C (and a stop) end the server, once
  const untrap = io.trapSignals((signal) => { try { child.kill(signal); } catch (e) { /* gone */ } });
  try {
    return await child.exited;
  } finally {
    untrap();
  }
}

module.exports = {devServer, linesFor, DEFAULT_PORT};
