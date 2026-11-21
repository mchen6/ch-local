#!/usr/bin/env node
'use strict';
// ch-local: the countinghouse packs' launcher.
//
//   ch-local install --pack <name> --from <dir>   the pack's pinned tarballs into <home>/app
//   ch-local install [--from <dir>]               reinstalls what this home lists, at this
//                                                 ch-local's own release: never adds a pack,
//                                                 never moves to another release
//   ch-local snippet <client>                     the client's config entry, on stdout alone
//   ch-local add <client>                         writes that entry, and records it
//   ch-local uninstall [--keep-data]              takes back what install and add wrote
//   ch-local upgrade [--check | --auto on|off]    installed and available versions; asks once (--check: never)
//   ch-local session [--home <abs>]               what a client runs: the shared runtime through the shim, or its own
//   ch-local start --stdio [options]              this session's own runtime with the installed packs
//   ch-local add-pack <name> --from <dir>         another pack beside the installed ones
//   ch-local remove-pack <name>                   a pack, and the parts no other pack calls
//   ch-local add-module <dir>                     your own module, asked in your own terminal
//   ch-local remove-module <name>                 one of your own modules; its data and key kept
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
       ch-local install [--from <directory of tarballs>]
                reinstalls what this home lists, at this ch-local's own release:
                it never adds a pack, and never moves to another release
       ch-local add-pack <name> --from <directory of tarballs>
       ch-local remove-pack <name>
       ch-local add-module <directory of your own module>
       ch-local remove-module <name>
       ch-local status
       ch-local rollback [--yes]
       ch-local add <cursor|vscode|codex>
       ch-local uninstall [--keep-data]
       ch-local upgrade [--check | --auto on|off]
       ch-local settings [get | set <name> <value> | reset]
       ch-local settings modules [<module>]
       ch-local settings set <module>.<setting> [<value>]
       ch-local settings reset <module>[.<setting>]
       ch-local credentials [list | add <module> [--to <origin>] | remove <module>]
       ch-local session [--home <absolute home>]
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

// argv -> {command, ...its arguments} | null (a usage error). The command
// line's syntax alone, the one place it is decided: main dispatches on what
// this returns, and the hints' pin (test/command-line.test.js) parses every
// printed command with it. Checks that read the disk (an absolute --home, a
// directory) stay with the command.
const ON_HOME = new Set(['add-pack', 'remove-pack', 'add-module', 'remove-module', 'rollback', 'status', 'add', 'credentials', 'uninstall', 'settings', 'upgrade']);
function parseCommand(argv) {
  const [command, ...rest] = argv;
  const one = () => rest.length === 1 && !rest[0].startsWith('--');
  switch (command) {
    case 'snippet': return rest.length === 1 ? {command, client: rest[0]} : null;
    case 'install': {
      const a = parse(rest, {values: ['--pack', '--from', '--unreleased-pins']});
      if (a == null || a.positional.length > 0) return null;
      // (no --pack: reinstall what the record lists; install says why
      // --unreleased-pins needs one, the medium on the install hints, 6)
      return {command, pack: a.values['--pack'], from: a.values['--from'], unreleasedPins: a.values['--unreleased-pins']};
    }
    case 'add-pack': {
      const a = parse(rest, {values: ['--from', '--unreleased-pins']});
      return a == null || a.positional.length !== 1 ? null : {command, pack: a.positional[0], from: a.values['--from'], unreleasedPins: a.values['--unreleased-pins']};
    }
    case 'remove-pack': return one() ? {command, pack: rest[0]} : null;
    case 'add-module': return one() ? {command, dir: rest[0]} : null;
    case 'remove-module': return one() ? {command, name: rest[0]} : null;
    case 'rollback': {
      const a = parse(rest, {flags: ['--yes']});
      return a == null || a.positional.length > 0 ? null : {command, yes: a.flags['--yes'] === true};
    }
    case 'status': return rest.length === 0 ? {command} : null;
    case 'add': return rest.length === 1 ? {command, client: rest[0]} : null;
    case 'credentials': {
      const a = parse(rest, {values: ['--to']});
      if (a == null) return null;
      const [action = 'list', name, ...more] = a.positional;
      if (more.length > 0 || (action === 'list' && (name !== undefined || a.values['--to'] !== undefined))) return null;
      if ((action === 'add' || action === 'remove') && name === undefined) return null;
      if (action === 'remove' && a.values['--to'] !== undefined) return null;
      return {command, action, name, to: a.values['--to'] || null};
    }
    case 'uninstall': {
      const a = parse(rest, {flags: ['--keep-data']});
      return a == null || a.positional.length > 0 ? null : {command, keepData: a.flags['--keep-data'] === true};
    }
    case 'conditions': {
      const a = parse(rest, {values: ['--for', '--home']});
      return a == null || a.positional.length > 0 || a.values['--for'] === undefined || a.values['--home'] === undefined ? null : {command, pid: a.values['--for'], home: a.values['--home']};
    }
    case 'daemon': {
      // --handoff: started by a daemon re-execing onto a new ch-local (C3b),
      // with the session table on fd 3, never in argv or env
      const a = parse(rest, {values: ['--home'], flags: ['--handoff']});
      return a == null || a.positional.length > 0 || a.values['--home'] === undefined ? null : {command, home: a.values['--home'], handoff: a.flags['--handoff'] === true};
    }
    case 'session': {
      // (--home: the entry clients add writes, so a client's
      // COUNTINGHOUSE_HOME can't pick another home; the plugin's has none,
      // and takes the home rule, as its launch.js found this launcher by)
      const a = parse(rest, {values: ['--home']});
      // (once at most: a second --home is refused, never the last one taken)
      if (a == null || a.positional.length > 0 || rest.filter((x) => x === '--home').length > 1) return null;
      return {command, home: a.values['--home']};
    }
    // (start's own options are read with the disk checks they need, below)
    case 'start': return rest[0] === '--stdio' ? {command, rest} : null;
    case 'settings': {
      if (rest.length === 0 || (rest.length === 1 && rest[0] === 'get')) return {command, action: 'get'};
      if ((rest.length === 3 || rest.length === 2) && rest[0] === 'set') return {command, action: 'set', name: rest[1], value: rest[2]};
      if ((rest.length === 1 || rest.length === 2) && rest[0] === 'reset') return {command, action: 'reset', name: rest[1]};
      if ((rest.length === 1 || rest.length === 2) && rest[0] === 'modules') return {command, action: 'modules', name: rest[1]};
      return null;
    }
    case 'upgrade': {
      const a = parse(rest, {values: ['--auto'], flags: ['--apply-auto', '--check']});
      if (a == null || a.positional.length > 0) return null;
      // (--check is read-only: never with another mode; the medium on the
      // easy upgrades, 1)
      if (a.flags['--check'] && (a.values['--auto'] !== undefined || a.flags['--apply-auto'])) return null;
      if (a.flags['--apply-auto'] && a.values['--auto'] !== undefined) return null;
      return {command, auto: a.values['--auto'], check: a.flags['--check'] === true, applyAuto: a.flags['--apply-auto'] === true};
    }
    default: return null;
  }
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
  const {text, note} = snippet(client, {node: io.node, launcher: launcherPath(io.env, io.homedir), home: h});
  io.stdout.write(text);
  if (note != null) {
    io.stderr.write(note);
  } else {
    io.stderr.write(`ch-local: the entry runs the Node at ${io.node}.\n`);
    const where = require('../lib/home').layout(io.env, io.homedir);
    io.stderr.write(`ch-local: an nvm or system Node upgrade changes this path; run \`${require('../lib/command-line').chLocal(where, `snippet ${client}`, io.platform)}\` again to reprint the entry.\n`);
  }
  return 0;
}

async function main(argv, io) {
  if (!check(io.version).ok) {
    io.stderr.write(`ch-local: needs Node 22.16 or later; this is ${io.version}\n`);
    await offerNode(io);
    return 1;
  }
  const usage = () => { io.stderr.write(USAGE); return 2; };
  const p = parseCommand(argv);
  if (p == null) return usage();
  const {command} = p;
  try {
    // every command that acts on a home refuses one another user could
    // change, here, before any of it runs (the reviewer's Fable high on
    // #126, F5). install, session, start, daemon and conditions make their
    // own check, with their own words; snippet acts on none.
    // (the background check, upgrade --apply-auto, says its own paused line:
    // the medium on #126's round 2)
    if (ON_HOME.has(command) && !(command === 'upgrade' && p.applyAuto)) {
      const {layout, openHomeLine} = require('../lib/home');
      const open = openHomeLine(layout(io.env, io.homedir).home);
      if (open != null) {
        io.stderr.write(`ch-local: ${open}; nothing was changed\n`);
        // (uninstall: the client entries it would remove are named from
        // ch-local's own list of the files `add` writes, never from the home's
        // record of them: the reviewer on #126's round 2, (6))
        if (command === 'uninstall') {
          const {FILES} = require('../lib/clients');
          const files = Object.values(FILES).map((f) => f(io.homedir(), io.env));
          io.stderr.write(`ch-local: the client entries \`add\` writes are not removed from a home that can't be trusted: remove the "countinghouse" server from each of these by hand, if it is there: ${files.join(', ')}; or move the home aside, install again, and uninstall then. (add writes no file for Claude Code or Claude Desktop: the Claude Code plugin is removed with Claude Code's own /plugin)\n`);
        }
        return 2;
      }
    }
    if (command === 'snippet') return snippetCommand(p.client, io);
    if (command === 'install') {
      const code = await require('../lib/install').install({pack: p.pack, from: p.from, unreleasedPins: p.unreleasedPins}, io);
      // asked once whether to turn automatic upgrades on (off with no
      // terminal), and the last line, what to do next (A-firstrun d1): a
      // first install's, never a reinstall's (the medium on the install
      // hints, 10). A reinstall at a terminal still asks for a credential
      // a module is missing, as every install does; with none, it names
      // the command instead.
      if (code === 0 && p.pack !== undefined) await require('../lib/upgrade').offerAuto(io);
      if (code === 0 && p.pack !== undefined) io.stdout.write(`${require('../lib/next-steps').READY_LINE}\n`);
      return code;
    }
    if (command === 'add-pack') {
      const report = {added: false};
      const code = await require('../lib/packs-command').addPack({pack: p.pack, from: p.from, unreleasedPins: p.unreleasedPins, report}, io);
      // the last line, when it added the pack: what to do next (A-firstrun d1)
      if (code === 0 && report.added) io.stdout.write(`${require('../lib/next-steps').READY_LINE}\n`);
      return code;
    }
    if (command === 'remove-pack') return await require('../lib/packs-command').removePack({pack: p.pack}, io);
    if (command === 'add-module') return await require('../lib/own-command').addModule({dir: p.dir}, io);
    if (command === 'remove-module') return await require('../lib/own-command').removeModule({name: p.name}, io);
    if (command === 'rollback') return await require('../lib/rollback').rollback({yes: p.yes}, io);
    if (command === 'status') return await require('../lib/packs-command').status({}, io);
    if (command === 'add') return await require('../lib/clients').add(p.client, io);
    if (command === 'credentials') return await require('../lib/credentials-command').credentials({action: p.action, name: p.name, to: p.to}, io);
    if (command === 'uninstall') return await require('../lib/uninstall').uninstall({keepData: p.keepData}, io);
    if (command === 'conditions') {
      const {isFullPath} = require('../lib/home');
      if (!isFullPath(p.home)) { io.stderr.write('ch-local conditions: --home must be an absolute path\n'); return 2; }
      return await require('../lib/conditions-command').conditions({pid: p.pid, home: p.home}, io);
    }
    if (command === 'daemon') {
      const {isFullPath} = require('../lib/home');
      if (!isFullPath(p.home)) { io.stderr.write('ch-local daemon: --home must be an absolute path\n'); return 2; }
      const handoff = p.handoff ? await io.readHandoff() : null;
      return await require('../lib/daemon').daemon({home: p.home, handoff}, io);
    }
    if (command === 'session') {
      let home = null;
      if (p.home !== undefined) {
        const v = p.home;
        const {isFullPath} = require('../lib/home');
        if (!isFullPath(v)) { io.stderr.write('ch-local session: --home must be an absolute path\n'); return 2; }
        const fs = require('node:fs');
        let st = null;
        try { st = fs.statSync(v); } catch (err) { st = null; }
        if (st == null || !st.isDirectory()) { io.stderr.write(`ch-local session: --home ${v} is not a directory\n`); return 2; }
        // (whose it is, and how open, is the session's choice to judge: a
        // home the shared runtime's daemon would refuse runs the session's
        // own runtime, said -- never a session that ends here)
        home = fs.realpathSync(v);
      }
      return await require('../lib/session').session({home}, io);
    }
    if (command === 'start') {
      const rest = p.rest;
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
          // cut and cleaned at the source (lib/clean-text.js)
          else ownRuntime.why = require('../lib/clean-text').cleanText(v, 200);
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
    if (command === 'settings') return await require('../lib/settings-command').settings({action: p.action, name: p.name, value: p.value}, io);
    if (command === 'upgrade') {
      // start's background check runs this, in a child with the allowlisted
      // environment (lib/auto-upgrade.js); it re-checks everything itself
      if (p.applyAuto) {
        const r = await require('../lib/auto-apply').autoApply({io});
        if (r.line != null) io.stdout.write(`${r.line}\n`);
        return 0;
      }
      return await require('../lib/upgrade').upgrade({auto: p.auto, check: p.check}, io);
    }
  } catch (err) {
    if (err.code === 'HOME_RELATIVE') { io.stderr.write(`ch-local: ${err.message}\n`); return 2; }
    throw err;
  }
  return usage();
}

// The real io: this process, its terminal, npm through child processes, fetch.
function realIo() {
  // stdout, stderr and interactive are read only when used: `session` runs
  // the shim in this process's place, and Node opening a stdio pipe makes
  // it O_NONBLOCK for the shim too (lib/session.js)
  return {
    get stdout() { return process.stdout; },
    get stderr() { return process.stderr; },
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
    get interactive() { return Boolean(process.stdin.isTTY); },
    // A terminal both ways (credentials add: the prompt seen, the typing not)
    get terminal() { return Boolean(process.stdin.isTTY && process.stderr.isTTY); },
    // (a terminal on standard input alone: credentials add refuses it)
    get stdinIsTTY() { return Boolean(process.stdin.isTTY); },
    // (add-module's lines are seen: standard output a terminal too)
    get stdoutTTY() { return Boolean(process.stdout.isTTY); },
    readHidden: (prompt) => require('../lib/hidden-input').readHidden(prompt),
    // standard input, read whole up to max bytes (credentials add --to: a
    // key piped in); more than max is cut there, and the caller refuses it
    // at most `max` bytes, until the input ends or closes; an open pipe
    // that sends nothing for timeoutMs is a TIMEOUT, never a wait forever
    // (the Reviewer's high review of L5a, 4). The wait restarts with each
    // piece that arrives: a slow producer (a password manager's prompt) is
    // not cut off while it is sending.
    readStdin: (max, {timeoutMs = 60000} = {}) => new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let done = false;
      let timer = null;
      const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          process.stdin.destroy();
          finish(reject, Object.assign(new Error(`standard input sent nothing for ${timeoutMs / 1000} s`), {code: 'TIMEOUT'}));
        }, timeoutMs);
      };
      arm();
      const text = () => Buffer.concat(chunks).subarray(0, max).toString('utf8');
      // past max, no more waiting for an end that may never come (`yes |`):
      // refused as too long at once (the Reviewer's round 3, 7)
      process.stdin.on('data', (c) => {
        if (done) return;
        chunks.push(c);
        size += c.length;
        if (size > max) {
          process.stdin.destroy();
          finish(reject, Object.assign(new Error(`standard input held more than ${max} bytes`), {code: 'TOO_LONG'}));
          return;
        }
        arm();
      });
      process.stdin.on('end', () => finish(resolve, text()));
      process.stdin.on('close', () => finish(resolve, text()));
      process.stdin.on('error', (e) => finish(reject, e));
    }),
    // Read when used: a directory removed under a shell makes process.cwd()
    // throw, and only start needs it (null: git runs wherever it is).
    get cwd() { try { return process.cwd(); } catch (err) { return null; } },
    alive: require('../lib/run-liveness').processAlive,
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
      const child = require('child_process').spawn(cmd, args, {stdio: control ? ['inherit', 'inherit', 'inherit', 'ipc'] : 'inherit', env, detached, windowsHide: true});
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

module.exports = {main, run, parseCommand};
