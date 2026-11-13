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
// installed to guard. start only reads, and takes no lock.
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

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const readHolder = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { return null; } };
const sameHolder = (a, b) => a != null && b != null && a.pid === b.pid && a.host === b.host && a.at === b.at;
const BREAK_STALE_MS = 10000;

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
async function withLock(where, io, fn) {
  const file = path.join(where.home, 'packs.lock');
  const host = lockHost();
  const mine = {pid: process.pid, host, at: new Date().toISOString()};
  for (let attempt = 0; ; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(mine) + '\n', {flag: 'wx'});
      break;
    } catch (err) {
      if (err.code === 'ENOENT') return fn();
      if (err.code !== 'EEXIST') throw err;
      const holder = readHolder(file);
      const dead = holder != null && holder.host === host && Number.isInteger(holder.pid) && !alive(holder.pid);
      if (dead && attempt === 0 && clearStale(file, holder)) continue;
      const who = holder == null ? `an unreadable lock ${file}` : `pid ${holder.pid}${holder.host !== host ? ` on ${holder.host}` : ''}`;
      io.stderr.write(`ch-local: another ch-local (${who}) is changing this home; try again when it is done, or remove ${file} if nothing is running\n`);
      return 1;
    }
  }
  try {
    return await fn();
  } finally {
    if (sameHolder(readHolder(file), mine)) fs.rmSync(file, {force: true});
  }
}

module.exports = {withLock, lockHost};
