#!/usr/bin/env node
'use strict';
// ch-local: the countinghouse packs' launcher.
//
//   ch-local install --pack <name> --from <dir>   the pack's pinned tarballs into <home>/app
//   ch-local snippet <client>                     the client's config entry, on stdout alone
//   ch-local add <client>                         writes that entry, and records it
//   ch-local uninstall [--keep-data]              takes back what install and add wrote
//   ch-local upgrade [--auto on|off]              installed and available versions; asks once
//   ch-local start --stdio [options]              what a client runs: the runtime with the installed packs
//
// The Node floor is checked before anything else is loaded, with plain
// require names, so a Node far below it still gets a plain answer.
const os = require('os');
const {check, offerNode} = require('../lib/node-check');

const CLIENT_LIST = 'claude-code|cursor|vscode|codex|claude-desktop';
const USAGE = `usage: ch-local snippet <${CLIENT_LIST}>
       ch-local install --pack <name> --from <directory of tarballs>
       ch-local add <cursor|vscode|codex>
       ch-local uninstall [--keep-data]
       ch-local upgrade [--auto on|off]
       ch-local start --stdio [countinghouse options]
`;

// argv -> {flags, values, positional} | null when something is not understood.
function parse(argv, {flags = [], values = []}) {
  const out = {flags: {}, values: {}, positional: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.includes(a)) out.flags[a] = true;
    else if (values.includes(a) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.values[a] = argv[++i];
    else if (!a.startsWith('--')) out.positional.push(a);
    else return null;
  }
  return out;
}

function snippetCommand(client, io) {
  const {snippet, CLIENTS} = require('../lib/snippets');
  const {launcherPath} = require('../lib/home');
  if (!CLIENTS.includes(client)) {
    if (client !== undefined) io.stderr.write(`ch-local: unknown client "${client}"\n`);
    io.stderr.write(USAGE);
    return 2;
  }
  const {text, note} = snippet(client, {node: io.node, launcher: launcherPath(io.env, io.homedir)});
  io.stdout.write(text);
  if (note != null) {
    io.stderr.write(note);
  } else {
    io.stderr.write(`ch-local: the entry runs the Node at ${io.node}.\n`);
    io.stderr.write(`ch-local: an nvm or system Node upgrade changes this path; run \`ch-local snippet ${client}\` again to reprint the entry.\n`);
  }
  return 0;
}

async function main(argv, io) {
  if (!check(io.version).ok) {
    io.stderr.write(`ch-local: needs Node 22.16 or later; this is ${io.version}\n`);
    await offerNode(io);
    return 1;
  }
  const [command, ...rest] = argv;
  const usage = () => { io.stderr.write(USAGE); return 2; };
  try {
    if (command === 'snippet') {
      if (rest.length !== 1) return usage();
      return snippetCommand(rest[0], io);
    }
    if (command === 'install') {
      const a = parse(rest, {values: ['--pack', '--from']});
      if (a == null || a.positional.length > 0 || a.values['--pack'] === undefined) return usage();
      return await require('../lib/install').install({pack: a.values['--pack'], from: a.values['--from']}, io);
    }
    if (command === 'add') {
      if (rest.length !== 1) return usage();
      return await require('../lib/clients').add(rest[0], io);
    }
    if (command === 'uninstall') {
      const a = parse(rest, {flags: ['--keep-data']});
      if (a == null || a.positional.length > 0) return usage();
      return await require('../lib/uninstall').uninstall({keepData: a.flags['--keep-data'] === true}, io);
    }
    if (command === 'start') {
      if (rest[0] !== '--stdio') return usage();
      return await require('../lib/start').start({passThrough: rest.slice(1)}, io);
    }
    if (command === 'upgrade') {
      const a = parse(rest, {values: ['--auto']});
      if (a == null || a.positional.length > 0) return usage();
      return await require('../lib/upgrade').upgrade({auto: a.values['--auto']}, io);
    }
  } catch (err) {
    if (err.code === 'HOME_RELATIVE') { io.stderr.write(`ch-local: ${err.message}\n`); return 2; }
    throw err;
  }
  return usage();
}

// The real io: this process, its terminal, npm through child processes, fetch.
function realIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    node: process.execPath,
    version: process.version,
    platform: process.platform,
    homedir: os.homedir,
    ask: (question) => new Promise((resolve) => {
      const rl = require('readline').createInterface({input: process.stdin, output: process.stderr});
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
      rl.on('close', () => resolve(''));
    }),
    exec: (cmd, args, {cwd}) => new Promise((resolve) => {
      const child = require('child_process').spawn(cmd, args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => resolve({status: null, stdout, stderr: stderr + String(err.message)}));
      child.on('close', (status) => resolve({status, stdout, stderr}));
    }),
    fetch: (url, options) => globalThis.fetch(url, options),
    pid: process.pid,
    // Read when used: a directory removed under a shell makes process.cwd()
    // throw, and only start needs it (null: git runs wherever it is).
    get cwd() { try { return process.cwd(); } catch (err) { return null; } },
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } },
    // The runtime, on this process's own stdin, stdout and stderr: the client's
    // MCP channel goes straight through. -> its exit code. A terminal's Ctrl-C
    // reaches the runtime itself (one process group), so SIGINT only keeps
    // this process waiting; SIGTERM and SIGHUP, which a client sends to this
    // process alone, are passed on, and the finally in start still runs.
    spawn: (cmd, args, {env} = {}) => new Promise((resolve) => {
      const child = require('child_process').spawn(cmd, args, {stdio: 'inherit', env});
      process.on('SIGINT', () => {});
      for (const signal of ['SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
      child.on('error', (err) => { process.stderr.write(`ch-local: could not start the runtime (${err.code || err.message})\n`); resolve(1); });
      child.on('exit', (code, signal) => resolve(code != null ? code : (signal != null ? 1 : 0)));
    })
  };
}

function run() {
  main(process.argv.slice(2), realIo()).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`ch-local: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  });
}

if (require.main === module) run();

module.exports = {main, run};
