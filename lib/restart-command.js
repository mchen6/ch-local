'use strict';
// ch-local restart (A5, the final pass): the shared runtime takes what is
// stored and confirmed now, its sessions resuming. A client's restart only
// attaches again to the same running runtime, which stops 10 minutes after
// its last session; so a change that "applies at the next start" needs the
// runtime itself restarted. Through the daemon's requests (lib/daemon-
// requests.js requestRestart: drained, then started again with its session
// table), never a signal. It applies only what is stored and confirmed: a
// loosening never confirmed at a terminal stays unapplied, as at any start.
// A restart is said only once seen: daemon.json's runtimeStarted changed AND
// the socket it names proves the secret (lib/daemon.js daemonServing).
const fs = require('node:fs');
const path = require('node:path');
const {layout} = require('./home');
const {chLocal} = require('./command-line');

// io.restartWaitMs: a test's bound. -> 0 restarted | 1 not (said)
async function restart(_, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const fail = (s) => io.stderr.write(`ch-local restart: ${s}\n`);
  const where = layout(io.env, io.homedir);
  if (!fs.existsSync(where.home)) { fail(`nothing is installed: ${where.home} does not exist`); return 1; }
  const d = require('./daemon');
  const opts = {platform: io.platform, probePipe: io.probePipe || null, ...(typeof io.alive === 'function' ? {alive: io.alive} : {})};
  const before = await d.daemonServing(where.home, opts);
  if (!before.serving) {
    say('no shared runtime runs here: restart your client, whose own runtime takes the change at its start');
    return 1;
  }
  // (a daemon.json that can't be read, or a check that couldn't be made: no
  // restart asked for of a daemon this can't judge -- the medium on A5, 1)
  if (before.by !== 'socket' && before.by !== 'pid') {
    fail(`whether the shared runtime runs can't be told (${path.join(where.home, 'run', 'daemon', 'daemon.json')} can't be read); nothing changed`);
    return 1;
  }
  // (a live daemon that answers no handshake now -- draining, or between a
  // crash and its restart -- is asked too: its poll takes the request once
  // it is free, and the wait below covers its drain: the medium, 1)
  const startedOf = () => { const j = d.readDaemonJson(path.join(where.home, 'run', 'daemon')); return j == null ? undefined : (j.runtimeStarted || null); };
  const was = startedOf();
  if (!(await require('./daemon-requests').requestRestart(where.home, {io, platform: io.platform}))) {
    fail(`the restart could not be asked for (${path.join(where.home, 'run', 'daemon')} is not this user's private folder, or its requests file could not be written); nothing changed`);
    return 1;
  }
  // (a daemon of an earlier ch-local writes no runtimeStarted, so its restart
  // can't be seen: asked for, and said as such, never as done -- the medium, 2)
  if (was === null) {
    say('the restart is asked for; this shared runtime was started by an earlier ch-local, so whether it has restarted can\'t be seen here. It restarts once its calls finish, its sessions resuming');
    return 0;
  }
  // (the daemon's drain, then its runtime's ready wait and an abandon's
  // stop, and 20 s)
  const bound = Number.isInteger(io.restartWaitMs) ? io.restartWaitMs : d.DRAIN_MS + d.READY_MS + d.STOP_MS + 20000;
  const until = Date.now() + bound;
  for (;;) {
    const now = startedOf();
    // (gone: it stopped instead -- an idle stop under way took the request --
    // and the next session starts it again with what is stored: the medium, 4)
    if (now === undefined && !fs.existsSync(path.join(where.home, 'run', 'daemon', 'daemon.json'))) {
      say('the shared runtime stopped instead (it was idle); the next session starts it again, with what is stored');
      return 0;
    }
    if (now != null && now !== was) {
      const after = await d.daemonServing(where.home, opts);
      if (after.serving && after.by === 'socket') { say('the shared runtime restarted; its sessions resume'); return 0; }
    }
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  fail(`the shared runtime did not restart within ${bound / 1000} s; its sessions go on as before. Run \`${chLocal(where, 'restart')}\` again in a minute`);
  return 1;
}

module.exports = {restart};
