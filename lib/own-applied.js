'use strict';
// How a change to the user's own modules ended in the runtimes that run now
// (R-add-module-says-early): add-module and remove-module print their line
// once every live start has applied the change, and say the worst of how it
// ended. Read from each start's run.json (lib/in-place.js writes it):
//   ownSeen: {<name>: {addedAt, state, code?}}   own.json as the applier last
//     applied it, whole: written after the loads and unloads were answered.
//     state: loaded; kept (availability keeps it out: status says why);
//     refused (the runtime refused the load, with its code); waits (wanted,
//     and not loaded in place: the next restart loads it). addedAt is the
//     entry's own, so the same code added again is told from before.
//     null until a first apply ends; absent from an older ch-local's start,
//     which tells nothing.
//   loaded: what that runtime holds; shared: whether it is the shared one.
// run.json is a file: every field is checked before it is used, and a code is
// printed only in the runtime's own form.
const {liveRuns} = require('./gc');

const WAIT_MS = 40000;   // the control request's 30 s, the watcher's 2 s, a margin
const POLL_MS = 200;
const SAY_MS = 2000;
const WAITING = `Waiting for the running runtime to apply it (up to ${WAIT_MS / 1000} s)…`;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const own = (o, k) => (isObject(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const codeOf = (x) => (typeof x === 'string' && CODE.test(x) ? x : null);

// worst first: what several runtimes together are said to have done
const ADD_ORDER = ['refused', 'kept', 'late', 'loaded'];
const REMOVE_ORDER = ['still', 'late', 'removed'];

// one start's run.json -> {state (of the order), code?}, or null: not yet
function addOutcome(run, {name, tree, addedAt}) {
  if (!Object.prototype.hasOwnProperty.call(run, 'ownSeen')) return {state: 'late'};
  const e = own(run.ownSeen, name);
  if (!isObject(e) || e.addedAt !== addedAt) return null;
  if (e.state === 'loaded') return [].concat(own(run.loaded, name)).includes(tree) ? {state: 'loaded'} : null;
  if (e.state === 'refused' && codeOf(e.code) != null) return {state: 'refused', code: e.code};
  if (e.state === 'refused' || e.state === 'kept') return {state: 'kept'};
  return e.state === 'waits' ? {state: 'late'} : null;
}
function removeOutcome(run, {name}) {
  if (!Object.prototype.hasOwnProperty.call(run, 'ownSeen')) return {state: 'late'};
  if (!isObject(run.ownSeen) || own(run.ownSeen, name) !== undefined) return null;
  return own(run.loaded, name) === undefined ? {state: 'removed'} : {state: 'still', shared: run.shared === true};
}

// Waits for the starts live on this machine now (one that ends drops out; one
// that starts meanwhile reads the new own.json, and is not waited for).
// io.appliedWaitMs, appliedPollMs, appliedSayMs: a test's.
// -> {state: 'none'} (no runtime runs) or the worst outcome
async function applied(where, io, outcomeOf, order, change) {
  const ms = (v, or) => (Number.isInteger(v) && v >= 0 ? v : or);
  const bound = ms(io.appliedWaitMs, WAIT_MS);
  const sayAfter = ms(io.appliedSayMs, SAY_MS);
  const began = performance.now();
  const keyOf = (r) => `${r.host}:${r.pid}:${r.startedAt}`;
  let waitedFor = null;
  let said = false;
  for (;;) {
    let runs = null;
    // (one that can't be read could be a live start's: read again)
    try { runs = liveRuns(where, {alive: io.alive, hostname: io.hostname, sameMachine: true}); } catch (err) { runs = null; }
    const past = performance.now() - began >= bound;
    if (runs == null && past) return {state: 'late'};
    if (runs != null) {
      if (waitedFor == null) waitedFor = new Set(runs.map(keyOf));
      const outcomes = runs.filter((r) => waitedFor.has(keyOf(r))).map((r) => outcomeOf(r, change) || (past ? {state: 'late'} : null));
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

// the code a live start's runtime refused this entry (its addedAt) with, or
// null: status says the same as add-module's line
function refusedCode(run, name, entry) {
  const o = own(run.ownSeen, name);
  return isObject(o) && o.state === 'refused' && o.addedAt === entry.addedAt ? codeOf(o.code) : null;
}

module.exports = {addApplied, removeApplied, refusedCode, WAIT_MS};
