'use strict';
// ch-local restart (A5, the final pass): the shared runtime takes what is
// stored now, its sessions asked to resume. A client's restart only attaches
// again to the same running runtime, which stops 10 minutes after its last
// session; so a change that "applies at the next start" needs the runtime
// itself restarted. Through the daemon's requests (lib/daemon-requests.js
// requestRestart: a changed ch-local handed over to, else drained and
// started again with its session table), never a signal. A restart reads
// exactly what any daemon start reads: what is stored, the ceiling's bounds
// applied as at any start.
// Said only as seen:
// - restarted: daemon.json's runtimeStarted changed from the baseline read
//   under start.lock right after the request, AND its socket proves the
//   secret;
// - failed: daemon.json gone and a failed.json there;
// - stopped: daemon.json gone, no failed.json, and no successor within the
//   bound;
// - never "goes on as before" while daemon.json names no socket (it is
//   still restarting).
const fs = require('node:fs');
const path = require('node:path');
const {layout} = require('./home');
const {chLocal} = require('./command-line');

// how long the command watches for the restart: a drain, a runtime's start,
// an old runtime's stop, and 20 s
const restartBoundMs = () => { const d = require('./daemon'); return d.drainBoundMs() + d.READY_MS + d.STOP_MS + 20000; };
// after a stop, how long a successor is waited for: its runtime's start, a
// stop, and 10 s for its own boot and its wait on start.lock. A fresh daemon's
// cold start ends within COLD_READY_MS of its process start, inside READY_MS
// and those 10 s
const successorWaitMs = () => { const d = require('./daemon'); return d.READY_MS + d.STOP_MS + 10000; };

// io.restartWaitMs: a test's bound. -> 0 restarted (or asked of a daemon
// that can't show it, or stopped) | 1 not (said)
async function restart(_, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const fail = (s) => io.stderr.write(`ch-local restart: ${s}\n`);
  const where = layout(io.env, io.homedir);
  if (!fs.existsSync(where.home)) { fail(`nothing is installed: ${where.home} does not exist`); return 1; }
  const d = require('./daemon');
  const runDir = path.join(where.home, 'run', 'daemon');
  const opts = {platform: io.platform, probePipe: io.probePipe || null, ...(typeof io.alive === 'function' ? {alive: io.alive} : {})};
  const before = await d.daemonServing(where.home, opts);
  if (!before.serving) {
    say('no shared runtime runs here: restart your client, whose own runtime takes the change at its start');
    return 1;
  }
  if (before.by !== 'socket' && before.by !== 'pid') {
    fail(`whether the shared runtime runs can't be told (${path.join(runDir, 'daemon.json')} can't be read); nothing changed`);
    return 1;
  }
  // (a settings file a start refuses would fail every restart, the shared
  // mode then off: refused now, nothing asked -- the reviewer's high, M1)
  const settings = require('./settings').readSettings(where);
  if (settings.error != null) {
    fail(`${settings.error}: a restart would not start; fix it first (\`${chLocal(where, 'settings reset')}\` resets every setting); nothing changed`);
    return 1;
  }
  const bound = Number.isInteger(io.restartWaitMs) ? io.restartWaitMs : restartBoundMs();
  // (a private read only when daemon.json's stat changed: on Windows each is
  // a blocking PowerShell run, and this waits up to minutes -- the
  // closing pass, L3. A read that gave nothing is never kept)
  const file = path.join(runDir, 'daemon.json');
  let lastKey = null;
  let lastJson = null;
  const read = () => {
    let st;
    try { st = fs.lstatSync(file); } catch (e) { lastKey = null; return null; }
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    if (key === lastKey) return lastJson;
    lastJson = d.readDaemonJson(runDir);
    lastKey = lastJson == null ? null : key;
    return lastJson;
  };
  // (the baseline read under start.lock, right after the request: a restart
  // already under way is not taken for this one -- M2)
  let was;
  const asked = await require('./daemon-requests').requestRestart(where.home, {io, platform: io.platform, signal: AbortSignal.timeout(bound),
    underLock: () => { const j = read(); was = j == null ? undefined : (j.runtimeStarted || null); }});
  if (!asked) {
    fail(`the restart could not be asked for (${runDir} is not this user's private folder, its requests file could not be written, or another start held it past ${bound / 1000} s); nothing changed`);
    return 1;
  }
  // (a baseline that can't be known is never taken for a change: asked for,
  // and said as what it is -- M2, N2)
  if (was === null) {
    say('the restart is asked for; whether the shared runtime has restarted can\'t be seen here (it was started by an earlier ch-local). It restarts once its calls finish, its sessions asked to resume');
    return 0;
  }
  if (was === undefined && !fs.existsSync(path.join(runDir, 'daemon.json'))) {
    // (gone between the check and the request: an idle stop -- the medium
    // on #147's last round, 7)
    say('the shared runtime stopped before the restart was asked for; the next session starts it, with what is stored');
    return 0;
  }
  if (was === undefined) {
    say(`the restart is asked for; whether the shared runtime has restarted can't be seen here (${path.join(runDir, 'daemon.json')} couldn't be read just now). It restarts once its calls finish, its sessions asked to resume`);
    return 0;
  }
  // (the time to watch starts now, the request written: the lock's wait
  // never eats it -- R1. A successor after "gone" is waited for only as long
  // as a daemon takes to start -- N1)
  const until = Date.now() + bound;
  // (with a margin for the successor's own boot and its wait on start.lock:
  // the medium on #147's last round, 6)
  const successorMs = Number.isInteger(io.successorWaitMs) ? io.successorWaitMs : successorWaitMs();
  let goneUntil = null;
  for (;;) {
    const now = read();
    if (now == null && !fs.existsSync(path.join(runDir, 'daemon.json'))) {
      const failed = readFailed(runDir);
      if (failed != null) {
        fail(`the shared runtime could not start again (${failed}), so the sessions run their own runtimes for now; ${path.join(runDir, 'failed.json')} records it`);
        return 1;
      }
      if (goneUntil == null) {
        goneUntil = Date.now() + successorMs;
        say(`the shared runtime stopped; waiting up to ${successorMs / 1000} s for its successor`);
      }
      if (Date.now() >= Math.min(goneUntil, until)) {
        say('the shared runtime stopped and has not started again; the next session starts it, with what is stored');
        return 0;
      }
    } else if (now != null && now.runtimeStarted != null && now.runtimeStarted !== was) {
      const after = await d.daemonServing(where.home, opts);
      if (after.serving && after.by === 'socket') { say('the shared runtime restarted; its sessions are asked to resume'); return 0; }
    }
    if (Date.now() >= until) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const last = read();
  if (last != null && last.socket == null) {
    fail(`the shared runtime is still restarting after ${bound / 1000} s (${path.join(runDir, 'daemon.json')} names no socket yet); it serves again once its runtime listens`);
    return 1;
  }
  // (a daemon gone without removing daemon.json -- killed -- serves no
  // request: said, exit 1 -- the medium on #147's last round, 5)
  const still = await d.daemonServing(where.home, opts);
  if (!still.serving) {
    fail('the shared runtime\'s daemon has gone without restarting it; the next session starts it, with what is stored');
    return 1;
  }
  // (asked, written, and not yet seen: never "run it again", the request
  // stands -- R1)
  say(`the restart is asked for and hasn't happened yet after ${bound / 1000} s; it will once its calls finish`);
  return 0;
}

// failed.json's reason, if this run directory holds one -> text | null
function readFailed(runDir) {
  // (by the shim's own rule, lib/failed-json.js: a file a session ignores --
  // stale, from the future, of another shape -- is none, so "gave up" is
  // said only while a session would act on it -- the medium on the closing
  // pass, 1; restart's own use was the same gap)
  const reason = require('./failed-json').read(runDir);
  const words = {'restarts-exhausted': 'it failed 5 times in 10 minutes', 'never-listened': 'it never listened'};
  return reason == null ? null : words[reason];
}

module.exports = {restart, readFailed, restartBoundMs, successorWaitMs};
