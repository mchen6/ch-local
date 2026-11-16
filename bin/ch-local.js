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
//   ch-local add-pack <name> --from <dir>         another pack beside the installed ones
//   ch-local remove-pack <name>                   a pack, and the parts no other pack calls
//   ch-local status                               the installed packs, their tools and missing credentials
//   ch-local rollback [--yes]                     back to the release the last install replaced
//
// The Node floor is checked before anything else is loaded, with plain
// require names, so a Node far below it still gets a plain answer.
const os = require('os');
const {check, offerNode} = require('../lib/node-check');

const CLIENT_LIST = 'claude-code|cursor|vscode|codex|claude-desktop';
const USAGE = `usage: ch-local snippet <${CLIENT_LIST}>
       ch-local install --pack <name> --from <directory of tarballs>
       ch-local add-pack <name> --from <directory of tarballs>
       ch-local remove-pack <name>
       ch-local status
       ch-local rollback [--yes]
       ch-local add <cursor|vscode|codex>
       ch-local uninstall [--keep-data]
       ch-local upgrade [--auto on|off]
       ch-local settings [get | set <name> <value> | reset]
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
  const {home} = require('../lib/home');
  const h = home(io.env, io.homedir);
  const found = require('../lib/shim-binary').shimFor({home: h, locate: io.locateShim ?? undefined});
  if (found.note != null) io.stderr.write(found.note);
  const {text, note} = snippet(client, {node: io.node, launcher: launcherPath(io.env, io.homedir), shim: found.shim, home: h});
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
      const a = parse(rest, {values: ['--pack', '--from', '--unreleased-pins']});
      if (a == null || a.positional.length > 0 || a.values['--pack'] === undefined) return usage();
      const code = await require('../lib/install').install({pack: a.values['--pack'], from: a.values['--from'], unreleasedPins: a.values['--unreleased-pins']}, io);
      // asked once whether to turn automatic upgrades on (off with no terminal)
      if (code === 0) await require('../lib/upgrade').offerAuto(io);
      return code;
    }
    if (command === 'add-pack') {
      const a = parse(rest, {values: ['--from', '--unreleased-pins']});
      if (a == null || a.positional.length !== 1) return usage();
      return await require('../lib/packs-command').addPack({pack: a.positional[0], from: a.values['--from'], unreleasedPins: a.values['--unreleased-pins']}, io);
    }
    if (command === 'remove-pack') {
      if (rest.length !== 1 || rest[0].startsWith('--')) return usage();
      return await require('../lib/packs-command').removePack({pack: rest[0]}, io);
    }
    if (command === 'rollback') {
      const a = parse(rest, {flags: ['--yes']});
      if (a == null || a.positional.length > 0) return usage();
      return await require('../lib/rollback').rollback({yes: a.flags['--yes'] === true}, io);
    }
    if (command === 'status') {
      if (rest.length !== 0) return usage();
      return await require('../lib/packs-command').status({}, io);
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
    if (command === 'conditions') {
      const a = parse(rest, {values: ['--for', '--home']});
      if (a == null || a.positional.length > 0 || a.values['--for'] === undefined || a.values['--home'] === undefined) return usage();
      const {isFullPath} = require('../lib/home');
      if (!isFullPath(a.values['--home'])) { io.stderr.write('ch-local conditions: --home must be an absolute path\n'); return 2; }
      return await require('../lib/conditions-command').conditions({pid: a.values['--for'], home: a.values['--home']}, io);
    }
    if (command === 'daemon') {
      // --handoff: started by a daemon re-execing onto a new ch-local (C3b),
      // with the session table on fd 3, never in argv or env
      const a = parse(rest, {values: ['--home'], flags: ['--handoff']});
      if (a == null || a.positional.length > 0 || a.values['--home'] === undefined) return usage();
      const {isFullPath} = require('../lib/home');
      if (!isFullPath(a.values['--home'])) { io.stderr.write('ch-local daemon: --home must be an absolute path\n'); return 2; }
      const handoff = a.flags['--handoff'] === true ? await io.readHandoff() : null;
      return await require('../lib/daemon').daemon({home: a.values['--home'], handoff}, io);
    }
    if (command === 'start') {
      if (rest[0] !== '--stdio') return usage();
      // ch-local's own options, before any pass-through runtime flag: the
      // native shim's hand-over is `start --stdio --own-runtime --home <abs>`
      // (#236 section 5), so a client's COUNTINGHOUSE_HOME can't pick the home
      let i = 1;
      let home = null;
      // the shim's hand-over says why the session can't share
      // (--own-runtime-reason, a short token: token, credential,
      // conditions-failed; --own-runtime-why: the conditions check's own
      // words), told to the client in its first result's notice (#236
      // section 5). An older shim sends neither: then only that it runs its own.
      let ownRuntime = null;
      for (;;) {
        if (rest[i] === '--own-runtime') { i += 1; ownRuntime = ownRuntime || {}; continue; }
        if (rest[i] === '--own-runtime-reason' || rest[i] === '--own-runtime-why') {
          const v = rest[i + 1];
          // only on the shim's hand-over, after --own-runtime, and never an option as its value
          if (ownRuntime == null || typeof v !== 'string' || v.startsWith('--')) { io.stderr.write(`ch-local start: ${rest[i]} needs --own-runtime before it and a value\n`); return 2; }
          if (rest[i] === '--own-runtime-reason') ownRuntime.reason = /^[a-z][a-z-]{0,31}$/.test(v) ? v : 'unknown';
          // cut and cleaned at the source: no control, line-separator, bidi or
          // zero-width characters, and cut by code point (never half a pair)
          else ownRuntime.why = Array.from(v.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ')).slice(0, 200).join('');
          i += 2;
          continue;
        }
        if (rest[i] === '--home') {
          const v = rest[i + 1];
          const {isFullPath} = require('../lib/home');
          if (typeof v !== 'string' || !isFullPath(v)) { io.stderr.write('ch-local start: --home must be an absolute path\n'); return 2; }
          let st = null;
          const fs = require('node:fs');
          try { st = fs.statSync(v); } catch (err) { st = null; }
          if (st == null || !st.isDirectory()) { io.stderr.write(`ch-local start: --home ${v} is not a directory\n`); return 2; }
          home = fs.realpathSync(v);
          const owned = require('../lib/home').homeOwnershipProblem(home);
          if (owned != null) { io.stderr.write(`ch-local start: --home ${v}: ${owned}\n`); return 2; }
          i += 2;
          continue;
        }
        break;
      }
      return await require('../lib/start').start({passThrough: rest.slice(i), home, ownRuntime}, io);
    }
    if (command === 'settings') {
      if (rest.length === 0 || (rest.length === 1 && rest[0] === 'get')) return await require('../lib/settings-command').settings({action: 'get'}, io);
      if (rest.length === 3 && rest[0] === 'set') return await require('../lib/settings-command').settings({action: 'set', name: rest[1], value: rest[2]}, io);
      if (rest.length === 1 && rest[0] === 'reset') return await require('../lib/settings-command').settings({action: 'reset'}, io);
      return usage();
    }
    if (command === 'upgrade') {
      const a = parse(rest, {values: ['--auto'], flags: ['--apply-auto']});
      if (a == null || a.positional.length > 0) return usage();
      // start's background check runs this, in a child with the allowlisted
      // environment (lib/auto-upgrade.js); it re-checks everything itself
      if (a.flags['--apply-auto']) {
        if (a.values['--auto'] !== undefined) return usage();
        const r = await require('../lib/auto-apply').autoApply({io});
        if (r.line != null) io.stdout.write(`${r.line}\n`);
        return 0;
      }
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
      // Resolved before close(): close() fires the 'close' listener at once,
      // which would answer '' first (test/cli.test.js).
      rl.question(question, (answer) => { resolve(answer); rl.close(); });
      rl.on('close', () => resolve(''));
    }),
    // env: the child's whole environment (default: this process's); timeout:
    // ms after which the child is killed (it then answers status null).
    exec: (cmd, args, {cwd, env, timeout} = {}) => new Promise((resolve) => {
      const child = require('child_process').spawn(cmd, args, {cwd, env, timeout, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe']});
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => resolve({status: null, stdout, stderr: stderr + String(err.message)}));
      child.on('close', (status) => resolve({status, stdout, stderr}));
    }),
    fetch: (url, options) => globalThis.fetch(url, options),
    pid: process.pid,
    // A terminal to ask on: rollback over a security fix asks, or needs --yes.
    interactive: Boolean(process.stdin.isTTY),
    // Read when used: a directory removed under a shell makes process.cwd()
    // throw, and only start needs it (null: git runs wherever it is).
    get cwd() { try { return process.cwd(); } catch (err) { return null; } },
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } },
    hostname: os.hostname(),
    exit: (code) => process.exit(code),
    // a signal this process takes and does nothing with (ch-local daemon:
    // SIGHUP, so it outlives the shim's parent ending)
    ignoreSignal: (name) => process.on(name, () => {}),
    // ch-local daemon's re-exec (C3b): the new daemon, with the table on its
    // fd 3; and that fd's bytes, read by the daemon started so
    spawnDaemon: (args, {handoff}) => require('../lib/handoff-io').spawnDaemon(args[2], args, {handoff, env: process.env}),
    readHandoff: () => require('../lib/handoff-io').readHandoff(3),
    // SIGINT, SIGTERM and SIGHUP (or the signals named) go to handler(name)
    // until the returned function is called; start decides what each means.
    trapSignals: (handler, signals = ['SIGINT', 'SIGTERM', 'SIGHUP']) => {
      const on = Object.fromEntries(signals.map((s) => [s, () => handler(s)]));
      for (const [s, fn] of Object.entries(on)) process.on(s, fn);
      return () => { for (const [s, fn] of Object.entries(on)) process.removeListener(s, fn); };
    },
    // The runtime, on this process's own stdin, stdout and stderr: the client's
    // MCP channel goes straight through. -> {kill(signal), exited: Promise<exit code>}.
    // control: an IPC fd for the runtime's control channel (packs in place)
    // detached: in its own process group (a session runtime: a terminal's
    // hang-up never reaches it)
    spawn: (cmd, args, {env, control = false, detached = false} = {}) => {
      const child = require('child_process').spawn(cmd, args, {stdio: control ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', env, detached});
      const exited = new Promise((resolve) => {
        child.on('error', (err) => { process.stderr.write(`ch-local: could not start the runtime (${err.code || err.message})\n`); resolve(1); });
        child.on('exit', (code, signal) => resolve(code != null ? code : (signal != null ? 1 : 0)));
      });
      return {kill: (signal) => { try { child.kill(signal); } catch (err) { /* already gone */ } }, exited, pid: child.pid,
        ...(control ? {send: (m) => child.send(m), onMessage: (fn) => child.on('message', fn)} : {})};
    }
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
