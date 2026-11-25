'use strict';
// How a change to the user's own modules ended in the runtimes that run now
// (R-add-module-says-early): add-module and remove-module print their line
// once every live start has applied the change, and say the worst of how it
// ended. Read from each start's run.json (lib/in-place.js writes it):
//   ownSeen: {<name>: {addedAt, state, code?, kind?}}   own.json as the applier
//     last applied it, whole: written after the loads and unloads were
//     answered. state: loaded; kept (availability keeps it out, kind says
//     why, and so does status); refused (the runtime refused the load, with
//     its code); waits (wanted, and may be loading: one of the start's own
//     plan, or a load not answered); restart (wanted, and not loaded in place:
//     its next restart loads it). addedAt is the entry's own, so the same code
//     added again is told from before. null until a first apply ends; absent
//     from an older ch-local's start, which tells nothing.
//   ownAt: {at, ino}   the own.json that was, so a removal is told from the
//     own.json before it, which may hold the same names (stampOf).
//   loaded: what that runtime holds; shared: whether it is the shared one.
// run.json is a file: every field is checked before it is used, and a code is
// printed only in the runtime's own form.
const fs = require('node:fs');
const {liveRuns} = require('./gc');
const {hostTag} = require('./run-liveness');

const WAIT_MS = 40000;   // the control request's 30 s, the watcher's 2 s, a margin
const POLL_MS = 200;
const SAY_MS = 2000;
const WAITING = `Waiting for the running runtime to apply it (up to ${WAIT_MS / 1000} s)…`;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const TREE = /^[0-9a-f]{64}$/;
const RUN_DIR = /^(.+)-([0-9]{1,10})-[0-9a-f]{8}$/;   // start's: host, pid
const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const own = (o, k) => (isObject(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const codeOf = (x) => (typeof x === 'string' && CODE.test(x) ? x : null);

// worst first: what several runtimes together are said to have done
const ADD_ORDER = ['refused', 'kept', 'restart', 'late', 'loaded'];
const REMOVE_ORDER = ['still', 'late', 'removed'];

// own.json as it is now: {at, ino}, strings (bigints as JSON has them), zeros
// with none; null when it can't be told
function stampOf(where) {
  // (a few times, with a pause: Windows refuses one while the file is being replaced)
  for (let i = 0; i < 5; i++) {
    if (i > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    try {
      const st = fs.statSync(where.ownRecord, {bigint: true});
      return {at: String(st.mtimeNs), ino: String(st.ino)};
    } catch (err) {
      if (err.code === 'ENOENT') return {at: '0', ino: '0'};
    }
  }
  return null;
}
const DIGITS = /^[0-9]{1,30}$/;
const isStamp = (s) => isObject(s) && typeof s.at === 'string' && typeof s.ino === 'string' && DIGITS.test(s.at) && DIGITS.test(s.ino);
// whether seen is the own.json of `mine`, or a later one
const sinceThen = (seen, mine) => isStamp(seen) && isStamp(mine) && (BigInt(seen.at) > BigInt(mine.at) || (seen.at === mine.at && seen.ino === mine.ino));

// one start's run.json -> {state (of the order), code?}, or null: not yet
function addOutcome(run, {name, tree, addedAt}) {
  if (!Object.prototype.hasOwnProperty.call(run, 'ownSeen')) return {state: 'late'};
  const e = own(run.ownSeen, name);
  if (!isObject(e) || e.addedAt !== addedAt) return null;
  if (e.state === 'loaded') return [].concat(own(run.loaded, name)).includes(tree) ? {state: 'loaded'} : null;
  if (e.state === 'refused' && codeOf(e.code) != null) return {state: 'refused', code: e.code};
  if (e.state === 'kept') return {state: 'kept'};
  if (e.state === 'restart') return {state: 'restart', shared: run.shared === true};
  return e.state === 'refused' || e.state === 'waits' ? {state: 'late'} : null;
}
// (an own module's version in loaded is its tree; a pack's module of the same
// name is not the one removed)
function removeOutcome(run, {name, stamp, tree, addedAt}) {
  if (!Object.prototype.hasOwnProperty.call(run, 'ownSeen')) return {state: 'late'};
  if (!isObject(run.ownSeen) || !sinceThen(run.ownAt, stamp)) return null;
  const still = {state: 'still', shared: run.shared === true};
  const loaded = [].concat(own(run.loaded, name));
  const e = own(run.ownSeen, name);
  if (e === undefined) return loaded.some((v) => TREE.test(String(v))) ? still : {state: 'removed'};
  // (the entry removed itself: an own.json before this, whatever its time says)
  if (isObject(e) && e.addedAt === addedAt) return null;
  // (added again since: overtaken, but the removed code may still be served;
  // not where what was added again is that code, of the start's own plan)
  return isObject(e) && e.state !== 'loaded' && e.state !== 'waits' && loaded.includes(tree) ? still : {state: 'removed'};
}

// Waits for the starts live on this machine now, by their processes: one whose
// process ends drops out; one whose process goes on (the daemon's, between a
// runtime and the next) is judged as it starts again; a process that starts
// meanwhile reads the new own.json, and is not waited for, unless all the
// others have ended (a daemon's hand-over). A run that can't
// be read is a live start's while its process lives, else nothing.
// io.appliedWaitMs, appliedPollMs, appliedSayMs: a test's.
// -> {state: 'none'} (no runtime runs) or the worst outcome
async function applied(where, io, outcomeOf, order, change) {
  if (typeof io.alive !== 'function') throw new Error('applied: io.alive is required');
  const ms = (v, or) => (Number.isInteger(v) && v >= 0 ? v : or);
  const bound = ms(io.appliedWaitMs, WAIT_MS);
  const sayAfter = ms(io.appliedSayMs, SAY_MS);
  const began = performance.now();
  const here = hostTag(io.hostname);
  const pidOf = (r) => (Number.isInteger(r.pid) ? r.pid : r.childPid);
  let waitedFor = null;
  let said = false;
  for (;;) {
    let runs = null;
    const unread = new Set();
    try {
      runs = liveRuns(where, {alive: io.alive, hostname: io.hostname, sameMachine: true, unreadable: (n) => {
        const m = RUN_DIR.exec(n);
        if (m != null && m[1] === here && io.alive(Number(m[2]))) unread.add(Number(m[2]));
      }});
    } catch (err) { runs = null; }   // (the run directory can't be listed: read again)
    const past = performance.now() - began >= bound;
    if (runs == null && past) return {state: 'late'};
    if (runs != null) {
      if (waitedFor == null) waitedFor = new Set([...runs.map(pidOf), ...unread]);
      const judged = () => {
        const out = [];
        for (const pid of waitedFor) {
          const its = runs.filter((r) => pidOf(r) === pid);
          if (its.length === 0 && !io.alive(pid)) continue;
          for (const o of its.length > 0 ? its.map((r) => outcomeOf(r, change)) : [null]) out.push(o || (past ? {state: 'late'} : null));
        }
        return out;
      };
      let outcomes = judged();
      // (none of them left, but others run: the daemon handed over)
      const others = [...runs.map(pidOf), ...unread];
      if (outcomes.length === 0 && others.length > 0) {
        waitedFor = new Set(others);
        outcomes = judged();
      }
      if (outcomes.length === 0) return {state: 'none'};
      if (!outcomes.includes(null)) return outcomes.sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || Number(b.shared === true) - Number(a.shared === true))[0];
    }
    if (!said && performance.now() - began >= sayAfter) {
      said = true;
      io.stdout.write(`${WAITING}\n`);
    }
    await new Promise((r) => setTimeout(r, ms(io.appliedPollMs, POLL_MS)));
  }
}
const addApplied = (where, io, change) => applied(where, io, addOutcome, ADD_ORDER, change);
const removeApplied = (where, io, change) => applied(where, io, removeOutcome, REMOVE_ORDER, change);

// what status says of this entry (its addedAt) from a live start's run.json,
// as add-module's line: the code its runtime refused it with, or that the
// start keeps it out for its own sandbox (the rest of what keeps one out,
// status reads itself) -> {code} | {sandbox: true} | null
function notLoadedIn(run, name, entry) {
  const o = own(run.ownSeen, name);
  if (!isObject(o) || o.addedAt !== entry.addedAt) return null;
  if (o.state === 'refused' && codeOf(o.code) != null) return {code: o.code};
  return o.state === 'kept' && o.kind === 'sandbox' ? {sandbox: true} : null;
}

module.exports = {addApplied, removeApplied, notLoadedIn, stampOf, WAIT_MS};
