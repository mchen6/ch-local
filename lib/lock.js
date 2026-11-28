'use strict';
// The home's lock (reviewer, 2026-11-12): install, add-pack, remove-pack and
// uninstall change packs.json and app/node_modules, so only one runs at a time.
// <home>/packs.lock is created exclusively and holds {pid, host, at}. A live
// holder, or one on another host, stops the command, naming it.
//
// A holder on this host whose PID is dead (a crash) is cleared, but only by
// one ch-local at a time: clearing takes <home>/packs.lock.break exclusively,
// then reads the lock again and removes it only if it is still that dead
// holder's. So a second ch-local that read the same dead holder earlier
// cannot remove the lock the first has just taken.
//
// "This host" is the host name plus, on Linux, the PID namespace: two
// containers sharing a host name do not see each other's PIDs, so neither
// takes the other's live lock for dead. With `started` (below), a holder
// whose PID was reused is gone, and the boot id tells this machine from
// another of the same name.
//
// The lock is never what creates the home: with no home there is nothing
// installed to guard.
//
// Packs in place (part 2; the review of ch-local #13): start takes the lock
// for one short section, reading the record and writing its run.json, which
// collection (held under this lock) reads; it waits for an install for as
// long as one takes, saying so every 10 s, and never tells anyone to remove
// the lock. A lock is created whole (its content written to a temporary file
// and linked into place), so it is never seen empty; an empty or unreadable
// one is never taken for stale. While held, its mtime is refreshed every
// HEARTBEAT_MS: a lock on any host whose heartbeat is STALE_MS old is a
// holder that is gone, and is cleared as a dead one is.
//
// Options a lock turns on (the stored credentials' lock, post-rel
// cred-race; packs.lock too since post-rel packs.lock protocol, with
// trustStarted and waitRemoteMs besides):
// - started: the holder records its process's start time, this boot's id and
//   this machine's id where they can be read (Linux), and a holder on this host whose
//   PID is alive with another start time is a reused PID: gone. Elsewhere
//   both are null and the heartbeat covers a reused PID. A zombie or dead
//   process (/proc state Z, X) is never taken for alive (#104's high, 1).
// - ageOtherHosts: false: a holder on another host is never taken for gone
//   by its heartbeat's age (another host's clock can be skewed); it is
//   named, with the file to remove if nothing runs there. By the ids a
//   holder recorded (placeOf; #104's high, 2, and the medium on it): the
//   same boot id, whatever the host name or PID namespace (a container on
//   a shared home), is this machine and its clock, aged by its heartbeat;
//   a different boot id with this machine id and host name, renewed last
//   before this kernel booted, is this machine before a reboot, gone; any other is another machine (a host name alone
//   never decides: two machines can share one). With no boot id on either
//   side, the host string decides, as before.
// - waitMs: wait at most that long for a holder, then say it is held. Its
//   heartbeat's age never cuts the wait short (the reviewer's high on
//   #102's round 1, 2 and 3): on this host an old heartbeat already makes
//   the holder gone (cleared; a stopped holder's lock with it, the limit
//   stated above, its write then refused by held), and a gone one whose
//   clearing another waiter (or a young .break) holds up is waited for; on
//   another host its mtime is that host's clock, which ageOtherHosts: false
//   distrusts, so an abandoned lock there is waited out to the cap, then
//   named with the file to remove. An unreadable lock is waited out too.
// - trustStarted (with started): a holder on this host whose PID is alive
//   with the start time it recorded is exactly that holder, so it is never
//   taken for gone by its heartbeat's age: an install whose synchronous
//   work (extracting, hashing) blocks its heartbeat past STALE_MS is never
//   stolen (packs.lock; the reviewer 11-20), and start waits for it as long
//   as it takes, unless /proc says it is stopped (state T: it won't finish
//   by itself; said with how to resume or end it). One that has stopped
//   renewing but isn't stopped (busy, or hung) is still waited for, said
//   with how to end it if it is hung. Where the start time can't be read it
//   changes nothing.
// - waitRemoteMs (with wait: true): a lock whose holder this host can't
//   judge (another host's, one that can't be read or has no pid) or an exact
//   holder here that is stopped is waited for while the lock changes, as
//   seen by this host's own clock (a new holder, or its mtime renewed), and
//   given up on once it has not changed for that long; then one more try,
//   and said held with the last look (start fails, never going on
//   unlocked). (the medium on post-rel packs.lock, 2-4; #104's high, 3-5)
// A limit: trustStarted protects a holder only from waiters that turn it on;
// an older ch-local (the defaults) still takes an hour-old heartbeat for
// gone. Mixed versions during an upgrade can still steal a blocked install.
// - missing: with no `dir`, its answer, never fn run unlocked.
// - doing: what the holder is doing, recorded for the held message.
// - heldMessage({holder, who, file, removable, stopped, quiet}): that line,
//   not the default.
// fn(release, held): held.check() throws (code LOCK_LOST) once the lock is
// no longer this holder's (cleared as stale, another holder in it), so a
// write made under it can be refused just before it lands. A limit: it is
// a check, then the write; a holder stopped in between (past STALE_MS, its
// lock taken meanwhile) still lands. A file lock in Node's core can't close
// that; it needs a holder stopped for minutes at that one instruction.
// A bounded wait (waitMs) says it is waiting at once, not after
// PROGRESS_MS, so a short wait is never silent.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function lockHost() {
  let ns = '';
  if (process.platform === 'linux') {
    try { ns = `#${fs.readlinkSync('/proc/self/ns/pid').replace(/^pid:/, 'pid:')}`; } catch (err) { ns = ''; }
  }
  return `${os.hostname()}${ns}`;
}

// a process's state letter (R running, S sleeping, T stopped, Z zombie, X
// dead, ...) and start time (clock ticks since boot, as a string), from one
// read of /proc/<pid>/stat, so both describe the same moment (the medium on
// #104's round 1, 7); nulls where it can't be read
function processStat(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return {state: null, started: null};
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // the fields after the command, which is in parentheses and may hold any
    // character: the state first, field 22 (starttime) the 20th
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return {state: rest[0] || null, started: /^\d+$/.test(rest[19] || '') ? rest[19] : null};
  } catch (err) { return {state: null, started: null}; }
}
const processStarted = (pid) => processStat(pid).started;
const processState = (pid) => processStat(pid).state;
// this boot of this machine's kernel (Linux): random per boot, the same in
// every container on it. null elsewhere.
let BOOT_ID;
function bootId() {
  if (BOOT_ID !== undefined) return BOOT_ID;
  try { BOOT_ID = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || null; } catch (err) { BOOT_ID = null; }
  return BOOT_ID;
}
// this installation's id (/etc/machine-id: kept across reboots), or null
let MACHINE_ID;
function machineId() {
  if (MACHINE_ID !== undefined) return MACHINE_ID;
  try { MACHINE_ID = fs.readFileSync('/etc/machine-id', 'utf8').trim() || null; } catch (err) { MACHINE_ID = null; }
  return MACHINE_ID;
}
// when this kernel booted (ms since the epoch: /proc/stat's btime), or null
let BOOT_TIME_MS;
function bootTimeMs() {
  if (BOOT_TIME_MS !== undefined) return BOOT_TIME_MS;
  try {
    const m = /^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
    BOOT_TIME_MS = m != null ? Number(m[1]) * 1000 : null;
  } catch (err) { BOOT_TIME_MS = null; }
  return BOOT_TIME_MS;
}
const hostNameOf = (h) => String(h).split('#')[0];
// Where a holder is (#104's high, 2; the medium on its round 1, 1, 2, 5),
// from the ids it recorded (`started`) and this side's:
// - 'here': this PID namespace of this boot (its PIDs are ours to judge);
// - 'machine': the same boot id, so this kernel, whatever its host name or
//   PID namespace (a container on a shared home): its clock is ours, so its
//   heartbeat's age counts, but its PIDs can't be read;
// - 'rebooted': another boot id, with this machine id and host name, and a
//   lock last renewed before this kernel booted: this machine before a
//   reboot, so the holder is gone. A host name alone is never enough (two
//   machines can share one: the medium, 1), nor a machine id with it (a
//   cloned VM keeps both, and a live clone renews its lock after our boot:
//   the reviewer's delta read of 87b28d4);
// - 'remote': anything else, never aged here.
// With no boot id on either side, as before: the host string decides.
// `mtimeMs`: the lock's last renewal (null: never 'rebooted').
function placeOf(holder, host, mtimeMs = null) {
  const boot = bootId();
  const theirs = typeof holder.boot === 'string' ? holder.boot : null;
  if (boot == null || theirs == null) return holder.host === host ? 'here' : 'remote';
  if (theirs === boot) return holder.host === host ? 'here' : 'machine';
  const mid = machineId();
  const booted = bootTimeMs();
  const before = booted != null && Number.isFinite(mtimeMs) && mtimeMs < booted;
  return before && mid != null && holder.machine === mid && hostNameOf(holder.host) === os.hostname() ? 'rebooted' : 'remote';
}
// where a holder is, as a person reads it (the high's 7; the medium, 9): the
// same machine in another PID namespace (either side may be the container);
// another machine by its host name, said as such when it is this one's
function hostLabel(holder) {
  const name = hostNameOf(holder.host);
  if (placeOf(holder, lockHost()) === 'machine') return 'another PID namespace on this machine (a container, or the host)';
  return name === os.hostname() ? `another machine named ${name}` : name;
}
// what to do about a lock this host can't judge: remove it if nothing runs
// where it was taken (one shared line: packs.lock's, credentials.lock's)
function removeHint(file, holder) {
  return `, or remove ${file} if nothing is running ${holder == null ? 'there' : `on ${hostLabel(holder)}`}`;
}

// a zombie (Z) or dead (X) process answers kill(pid, 0) but holds nothing
// (#104's high, 1)
const deadState = (state) => state === 'Z' || state === 'X';
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const readHolder = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return null; } };
const sameHolder = (a, b) => a != null && b != null && a.pid === b.pid && a.host === b.host && a.at === b.at;
const BREAK_STALE_MS = 10000;
const HEARTBEAT_MS = 15000;
const STALE_MS = 2 * 60 * 1000;
const PROGRESS_MS = 10000;

// On Windows a lock file another process is deleting (delete pending: a
// handle still open on it, as a holder's release meets a reader) refuses a
// new link or an exclusive create onto its name with EPERM (or EACCES) until
// that handle closes. Taking the lock then counts as busy, and is tried again
// on the wait's own clock for at most PENDING_WAIT_MS; a genuine permission
// error answers EPERM too, so the tries end at that deadline with the error
// itself (its code and the lock's path), never as a held lock and never
// forever (as countinghouse's json-file.js does). Elsewhere EPERM is an error
// at once, as before.
const PENDING_WAIT_MS = 10000;
const pendingRefusal = (err, platform) => platform === 'win32' && err != null && (err.code === 'EPERM' || err.code === 'EACCES');

// The lock created whole -> true; false when another holds it; or {pending:
// err} when its name is being deleted (Windows; pendingRefusal).
function create(file, mine, platform = process.platform) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mine) + '\n');
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    if (pendingRefusal(err, platform)) return {pending: err};
    throw err;
  } finally {
    fs.rmSync(tmp, {force: true});
  }
}
// The lock created whole -> true, or false when another holds it; anything
// else thrown, a delete-pending refusal included, as before: for a caller
// with its own loop (lib/settings.js withSettingsLock), whose wait does not
// read a pending name, so it keeps today's answer.
function createWhole(file, mine) {
  const made = create(file, mine);
  if (made === true || made === false) return made;
  throw made.pending;
}
const heartbeatAge = (file) => { try { return Date.now() - fs.statSync(file).mtimeMs; } catch (err) { return 0; } };

// Clears `file` if it is still `dead`'s; true when it was cleared. (A
// breaker whose name is being deleted, on Windows, is busy, as one that
// exists: pendingRefusal.)
function clearStale(file, dead, platform = process.platform) {
  const breaker = `${file}.break`;
  try {
    fs.writeFileSync(breaker, String(process.pid), {flag: 'wx'});
  } catch (err) {
    if (pendingRefusal(err, platform)) return false;
    if (err.code !== 'EEXIST') throw err;
    // A breaker left by a crash in the few lines below.
    try { if (Date.now() - fs.statSync(breaker).mtimeMs > BREAK_STALE_MS) fs.rmSync(breaker, {force: true}); } catch (e) { /* gone */ }
    return false;
  }
  try {
    if (!sameHolder(readHolder(file), dead)) return false;
    fs.rmSync(file, {force: true});
    return true;
  } finally {
    fs.rmSync(breaker, {force: true});
  }
}

// fn: an async function -> its exit code; or 1 when the lock is held.
// wait: true waits for the holder for as long as it takes, saying so every
// PROGRESS_MS (start: an install's npm ci can run for minutes).
// packs.lock on credentials.lock's options (post-rel packs.lock protocol,
// the reviewer 11-20): a reused PID is gone (started); another host's lock
// is never taken for gone by age (ageOtherHosts: false), waited for at most
// STALE_MS by start (waitRemoteMs; io.lockWaitMs, the tests'), then said
// with the file to remove; a live local holder with its recorded start time
// is never taken for gone by age (trustStarted: a long install isn't
// stolen). The hint to remove the file is said only where nothing here can
// tell whether its holder runs: another host's, or an unreadable lock.
// missing: what to do when the home isn't there (withLockFile's), else fn
// runs unlocked
async function withLock(where, io, fn, {wait = false, signal = null, missing = null} = {}) {
  const file = path.join(where.home, 'packs.lock');
  return withLockFile(file, where.home, io, fn, {wait, signal, missing,
    started: true, ageOtherHosts: false, trustStarted: true,
    waitRemoteMs: io != null && Number.isInteger(io.lockWaitMs) ? io.lockWaitMs : STALE_MS,
    heldMessage: ({holder, who, removable, stopped, quiet}) => (stopped
      ? `ch-local: another ch-local (${who}) holds this home's lock and is stopped (Ctrl-Z): resume it (fg, or kill -CONT ${holder.pid}) to let it finish, or end it (kill -9 ${holder.pid}), and try again`
      : quiet
        ? `ch-local: another ch-local (${who}) is changing this home but has not renewed its lock for over ${Math.round(STALE_MS / 60000)} minutes; try again when it is done, or if it is hung, end it (kill ${holder.pid}) and try again`
        : `ch-local: another ch-local (${who}) is changing this home; try again when it is done${removable ? removeHint(file, holder) : ''}`)});
}

// The same protocol for any lock file: `dir` must exist (with none there is
// nothing to guard, and fn runs unlocked). fn(release) may release the lock
// before it ends (ch-local daemon: once its runtime listens, while the
// runtime runs on); the release at the end is then skipped.
// what: how the waiting line names the holder's work.
// signal: an abort ends a wait, with 1 and fn never run
async function withLockFile(file, dir, io, fn, {wait = false, what = 'to finish changing this home', signal = null,
  started = false, ageOtherHosts = true, trustStarted = false, waitRemoteMs = null, waitMs = null, missing = null, doing = null, heldMessage = null} = {}) {
  const where = {home: dir};
  const host = lockHost();
  const mine = {pid: process.pid, host, at: new Date().toISOString()};
  if (started) {
    mine.started = processStarted(process.pid);
    mine.boot = bootId();
    mine.machine = machineId();
  }
  if (doing != null) mine.doing = doing;
  const unlocked = () => (typeof missing === 'function' ? missing() : fn(() => {}, null));
  // the clock the waits are measured on, and how a wait sleeps: a test may
  // give its own (io.lockNow, io.lockSleep), as it gives io.lockWaitMs, so a
  // wait is decided by what it observes, never by a timer's luck
  const now = typeof io.lockNow === 'function' ? io.lockNow : Date.now;
  const sleep = typeof io.lockSleep === 'function' ? io.lockSleep : (ms) => new Promise((r) => setTimeout(r, ms));
  // (the platform whose refusals are read: a test may give one, io.lockPlatform)
  const platform = typeof io.lockPlatform === 'string' ? io.lockPlatform : process.platform;
  const since = now();
  // a name being deleted (Windows): since when, on this clock, and the next step
  let pendingSince = null;
  let pendingStep = 25;
  // the lock this waiter is watching, and when (its own clock) it last saw
  // the lock change: a new holder, or its mtime moved
  let watched = null;
  let lastSaid = waitMs != null ? -Infinity : now();
  // the last look, for the line said when the wait gives up (#104's high, 5)
  let look = null;
  for (let attempt = 0; ; attempt++) {
    try {
      if (!fs.existsSync(where.home)) return unlocked();
      const made = create(file, mine, platform);
      if (made === true) break;
      if (made !== false) {
        // (its name being deleted: busy, tried again, backing off, until the
        // deadline; then the refusal itself, never a held lock)
        if (pendingSince == null) pendingSince = now();
        if (now() - pendingSince >= PENDING_WAIT_MS) throw made.pending;
        if (signal != null && signal.aborted) return 1;
        await sleep(pendingStep);
        pendingStep = Math.min(pendingStep * 2, 1000);
        continue;
      }
      pendingSince = null;
      pendingStep = 25;
      const holder = readHolder(file);
      // a holder with no usable pid is one this host can't judge: as an
      // unreadable lock (#104's high, 4)
      const pidOk = holder != null && Number.isInteger(holder.pid) && holder.pid > 0;
      // empty or unreadable: being written by an older ch-local, never stale
      let mtime = null;
      try { mtime = fs.statSync(file).mtimeMs; } catch (e) { mtime = null; }
      const place = pidOk ? (started ? placeOf(holder, host, mtime) : (holder.host === host ? 'here' : 'remote')) : null;
      const here = place === 'here';
      const sameMachine = place === 'machine';
      // (one read of /proc per look: the medium on post-rel packs.lock, 7,
      // and on #104's round 1, 7; a zombie or dead process holds nothing:
      // #104's high, 1)
      const stat = here ? processStat(holder.pid) : null;
      const aliveNow = here ? alive(holder.pid) && !deadState(stat.state) : null;
      const recorded = holder != null && typeof holder.started === 'string' ? holder.started : null;
      const reused = started && here && recorded != null && stat.started != null && stat.started !== recorded;
      // (exactly the holder that recorded it: alive, the same start time)
      const exact = trustStarted && started && here && recorded != null && aliveNow === true && stat.started === recorded;
      // stopped (T): an exact holder that will not finish by itself
      const stopped = exact && (stat.state === 'T' || stat.state === 't');
      const age = heartbeatAge(file);
      // not renewing: an exact holder busy or hung (never cleared; said with
      // what to do: the medium on #104's round 1, 4)
      const quiet = exact && !stopped && age > STALE_MS;
      // (the same machine in another PID namespace: aged by heartbeat, as
      // the reviewer's #104 high, 2, asks; its PIDs can't be read from here,
      // so a long install there is not protected as one here is: the limit)
      const aged = (ageOtherHosts || here || sameMachine) && !exact && age > STALE_MS;
      const gone = pidOk && ((here && aliveNow === false) || reused || place === 'rebooted' || aged);
      if (gone && clearStale(file, holder, platform)) continue;
      const bounded = waitMs != null && now() - since < waitMs;
      // an exact holder here is waited for as long as it takes (start can be
      // interrupted), unless it is stopped; one this host can't judge
      // (another host, unreadable, no pid) is watched, and given up on once
      // it hasn't changed for waitRemoteMs by this host's clock
      const judgeable = (here && !stopped) || sameMachine;
      // (two unreadable reads are the same lock: sameHolder is false for
      // nulls, which reset the watch each look and never gave up)
      const sameAsWatched = watched != null && ((watched.holder == null && holder == null) || sameHolder(watched.holder, holder));
      if (!sameAsWatched || watched.mtime !== mtime) watched = {holder, mtime, since: now()};
      const watchDone = wait && waitRemoteMs != null && !judgeable && now() - watched.since >= waitRemoteMs;
      const who = !pidOk ? `an unreadable lock ${file}` : `pid ${holder.pid}${here ? '' : ` on ${hostLabel(holder)}`}`;
      look = {holder: pidOk ? holder : null, who, removable: !here && !sameMachine, stopped, quiet};
      if ((wait && !watchDone) || bounded) {
        if (signal != null && signal.aborted) return 1;
        if (now() - lastSaid >= (io.lockProgressMs || PROGRESS_MS)) {
          lastSaid = now();
          // (a stopped or quiet holder said as such while waited for: the
          // medium on #104's round 1, 4 and 6)
          const why = stopped ? `; it is stopped (Ctrl-Z): resume it (fg, or kill -CONT ${holder.pid})`
            : quiet ? `; it has not renewed its lock for over ${Math.round(STALE_MS / 60000)} minutes: if it is hung, end it (kill ${holder.pid})` : '';
          io.stderr.write(`ch-local: waiting for another ch-local (${holder == null ? 'starting' : who}) ${what}${why}\n`);
        }
        await sleep(200);
        continue;
      }
      // (given up after a wait: one more try, then the last look's line;
      // the medium on #104's round 1, 8: never twice in a row unwaited)
      if ((wait || waitMs != null) && create(file, mine, platform) === true) break;
    } catch (err) {
      if (err.code === 'ENOENT') return unlocked();
      throw err;
    }
    {
      const {holder, who, removable, stopped, quiet} = look != null ? look : {holder: null, who: `an unreadable lock ${file}`, removable: true, stopped: false, quiet: false};
      if (typeof heldMessage === 'function') {
        io.stderr.write(`${heldMessage({holder, who, file, removable, stopped, quiet})}\n`);
        return 1;
      }
      io.stderr.write(`ch-local: another ch-local (${who}) is changing this home; try again when it is done, or remove ${file} if nothing is running\n`);
      return 1;
    }
  }
  // the heartbeat: a lock whose holder lives keeps a fresh mtime
  const beat = setInterval(() => { try { const t = new Date(); fs.utimesSync(file, t, t); } catch (err) { /* released */ } }, HEARTBEAT_MS);
  if (typeof beat.unref === 'function') beat.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(beat);
    if (sameHolder(readHolder(file), mine)) fs.rmSync(file, {force: true});
  };
  // (frozen: a holder can't swap its check for one that always passes;
  // the medium on #102 round 1, 4)
  const held = Object.freeze({
    file,
    check() {
      if (released || !sameHolder(readHolder(file), mine)) throw Object.assign(new Error(`${file} is no longer this ch-local's lock`), {code: 'LOCK_LOST'});
    },
  });
  try {
    return await fn(release, held);
  } finally {
    release();
  }
}

module.exports = {withLock, withLockFile, lockHost, processStarted, processState, bootId, machineId, bootTimeMs, placeOf, removeHint, hostLabel, createWhole, STALE_MS, HEARTBEAT_MS};
