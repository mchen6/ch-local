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
// takes the other's live lock for dead. A holder whose PID was reused (it
// looks alive) is named, and the message says to remove the file.
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
// cred-race; packs.lock keeps the defaults until it is brought onto them):
// - started: the holder records its process's start time where it can be
//   read (Linux /proc/<pid>/stat), and a holder on this host whose PID is
//   alive with another start time is a reused PID: gone. Elsewhere it is
//   null and the heartbeat covers a reused PID.
// - ageOtherHosts: false: a holder on another host is never taken for gone
//   by its heartbeat's age (another host's clock can be skewed); it is
//   named, with the file to remove if nothing runs there.
// - waitMs: wait that long for a live holder, then say it is held.
// - missing: with no `dir`, its answer, never fn run unlocked.
// - doing: what the holder is doing, recorded for the held message.
// - heldMessage({holder, who, file, removable}): that line, not the default.
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

// a process's start time (clock ticks since boot, as a string), or null
// where it can't be read
function processStarted(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // the fields after the command, which is in parentheses and may hold any
    // character: field 22 (starttime) is the 20th after it
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return /^\d+$/.test(rest[19] || '') ? rest[19] : null;
  } catch (err) { return null; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const readHolder = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return null; } };
const sameHolder = (a, b) => a != null && b != null && a.pid === b.pid && a.host === b.host && a.at === b.at;
const BREAK_STALE_MS = 10000;
const HEARTBEAT_MS = 15000;
const STALE_MS = 2 * 60 * 1000;
const PROGRESS_MS = 10000;

// The lock created whole, or false when another holds it.
function create(file, mine) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(mine) + '\n');
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(tmp, {force: true});
  }
}
const heartbeatAge = (file) => { try { return Date.now() - fs.statSync(file).mtimeMs; } catch (err) { return 0; } };

// Clears `file` if it is still `dead`'s; true when it was cleared.
function clearStale(file, dead) {
  const breaker = `${file}.break`;
  try {
    fs.writeFileSync(breaker, String(process.pid), {flag: 'wx'});
  } catch (err) {
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
async function withLock(where, io, fn, {wait = false, signal = null} = {}) {
  return withLockFile(path.join(where.home, 'packs.lock'), where.home, io, fn, {wait, signal});
}

// The same protocol for any lock file: `dir` must exist (with none there is
// nothing to guard, and fn runs unlocked). fn(release) may release the lock
// before it ends (ch-local daemon: once its runtime listens, while the
// runtime runs on); the release at the end is then skipped.
// what: how the waiting line names the holder's work.
// signal: an abort ends a wait, with 1 and fn never run
async function withLockFile(file, dir, io, fn, {wait = false, what = 'to finish changing this home', signal = null,
  started = false, ageOtherHosts = true, waitMs = null, missing = null, doing = null, heldMessage = null} = {}) {
  const where = {home: dir};
  const host = lockHost();
  const mine = {pid: process.pid, host, at: new Date().toISOString()};
  if (started) mine.started = processStarted(process.pid);
  if (doing != null) mine.doing = doing;
  const unlocked = () => (typeof missing === 'function' ? missing() : fn(() => {}, null));
  const since = Date.now();
  let lastSaid = waitMs != null ? -Infinity : Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      if (!fs.existsSync(where.home)) return unlocked();
      if (create(file, mine)) break;
      const holder = readHolder(file);
      // empty or unreadable: being written by an older ch-local, never stale
      const here = holder != null && holder.host === host;
      const reused = () => {
        if (!started || !here || typeof holder.started !== 'string') return false;
        const now = processStarted(holder.pid);
        return now != null && now !== holder.started;
      };
      const gone = holder != null && Number.isInteger(holder.pid) &&
        ((here && !alive(holder.pid)) || reused() || ((ageOtherHosts || here) && heartbeatAge(file) > STALE_MS));
      if (gone && clearStale(file, holder)) continue;
      const bounded = waitMs != null && Date.now() - since < waitMs;
      if (wait || bounded) {
        if (signal != null && signal.aborted) return 1;
        if (Date.now() - lastSaid >= (io.lockProgressMs || PROGRESS_MS)) {
          lastSaid = Date.now();
          io.stderr.write(`ch-local: waiting for another ch-local (${holder == null ? 'starting' : `pid ${holder.pid}${holder.host !== host ? ` on ${holder.host}` : ''}`}) ${what}\n`);
        }
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
    } catch (err) {
      if (err.code === 'ENOENT') return unlocked();
      throw err;
    }
    {
      const holder = readHolder(file);
      const who = holder == null ? `an unreadable lock ${file}` : `pid ${holder.pid}${holder.host !== host ? ` on ${holder.host}` : ''}`;
      if (typeof heldMessage === 'function') {
        io.stderr.write(`${heldMessage({holder, who, file, removable: holder == null || holder.host !== host})}\n`);
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
  const held = {
    file,
    check() {
      if (released || !sameHolder(readHolder(file), mine)) throw Object.assign(new Error(`${file} is no longer this ch-local's lock`), {code: 'LOCK_LOST'});
    },
  };
  try {
    return await fn(release, held);
  } finally {
    release();
  }
}

module.exports = {withLock, withLockFile, lockHost, processStarted, createWhole: create, STALE_MS, HEARTBEAT_MS};
