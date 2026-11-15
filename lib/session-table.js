'use strict';
// ch-local daemon's session table (countinghouse's shared-runtime design,
// #236, section 6, "Where session state lives"). It is in memory only and
// never on disk. The runtime tells the daemon each session's resume hash and
// state, and the daemon hands the whole table back to a restarted runtime
// ('restore', before it listens).
//
// From the runtime, over the control channel, with no id:
//   {type: 'session-resume', session, hash}   SHA-256 of its newest resume token
//   {type: 'session-state', session, state}   B2's snapshot after each change
//   {type: 'session-gone', session}           it ended: its row goes
//   {type: 'decline', kind, at}               a declined form, kept 30 minutes
// To a new runtime:
//   {type: 'restore', sessions: [{session, resume, state}], declines: [{kind, at}]}
//
// The runtime refuses a whole restore over one bad row
// (countinghouse lib/session-transport/restore.js). So the table keeps only
// what that check accepts, by the same rules:
// - a session id is 32 lowercase hex, and a hash is 64;
// - a state is B2's exact shape (#252 rev 2);
// - a decline's kind is one of three, its `at` a past epoch ms;
// - at most MAX_ROWS sessions and MAX_DECLINES declines.
// A told message that fails is refused. A refused state drops that session's
// whole row, so a restart never restores it looser than it was. Only a
// session with a resume hash is restored: without one, nothing resumes it.
const MAX_ROWS = 256;
const MAX_DECLINES = 1024;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_OVERRIDES = 64;
const DECLINE_KEEP_MS = 30 * 60 * 1000;
const SESSION_ID = /^[0-9a-f]{32}$/;
const RESUME = /^[0-9a-f]{64}$/;
const KINDS = ['maxOutputBytes', 'requestTimeout', 'pack'];
const CAPS = ['maxOutputBytes', 'requestTimeout'];
const PACK = /^pack\.[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,64})?$/;
// a session's state before B2 has told one: the runtime's fresh one
const EMPTY_STATE = Object.freeze({overrides: Object.freeze([]), locks: Object.freeze([]), formsLeft: 3});

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const keysAre = (o, keys) => { const k = Object.keys(o).sort(); return k.length === keys.length && k.every((x, i) => x === keys[i]); };
const posInt = (v) => Number.isSafeInteger(v) && v > 0;

function overrideOk(o) {
  if (!isObject(o) || !keysAre(o, ['loosening', 'name', 'over', 'value', 'version']) || typeof o.loosening !== 'boolean') return false;
  if (CAPS.includes(o.name)) return posInt(o.value) && o.version === null && (o.loosening ? posInt(o.over) : o.over === null);
  if (typeof o.name === 'string' && PACK.test(o.name)) return typeof o.value === 'boolean' && o.over === null && typeof o.version === 'string' && VERSION.test(o.version);
  return false;
}

function stateOk(st) {
  if (!isObject(st) || !keysAre(st, ['formsLeft', 'locks', 'overrides'])) return false;
  if (!Array.isArray(st.overrides) || st.overrides.length > MAX_OVERRIDES || !st.overrides.every(overrideOk)) return false;
  if (new Set(st.overrides.map((o) => o.name)).size !== st.overrides.length) return false;
  if (!Array.isArray(st.locks) || !st.locks.every((k) => KINDS.includes(k)) || new Set(st.locks).size !== st.locks.length) return false;
  if (!Number.isInteger(st.formsLeft) || st.formsLeft < 0 || st.formsLeft > 3) return false;
  try { return Buffer.byteLength(JSON.stringify(st)) <= MAX_STATE_BYTES; } catch (e) { return false; }
}

function createSessionTable({now = () => Date.now(), warn = () => {}} = {}) {
  const rows = new Map();       // session id -> {resume, state}
  let declines = [];            // {kind, at}, oldest first
  const prune = () => { const cut = now() - DECLINE_KEEP_MS; declines = declines.filter((d) => d.at >= cut); };
  const row = (id) => {
    if (rows.has(id)) return rows.get(id);
    if (rows.size >= MAX_ROWS) { warn(`the session table is full (${MAX_ROWS}); a new session is not kept`); return null; }
    const r = {resume: null, state: null};
    rows.set(id, r);
    return r;
  };
  const idOk = (m) => typeof m.session === 'string' && SESSION_ID.test(m.session);
  return {
    // one message from the runtime -> whether the table took it
    told(m) {
      if (m == null || typeof m.type !== 'string') return false;
      if (m.type === 'session-resume') {
        if (!idOk(m) || !keysAre(m, ['hash', 'session', 'type']) || typeof m.hash !== 'string' || !RESUME.test(m.hash)) return false;
        const r = row(m.session);
        if (r == null) return false;
        r.resume = m.hash;
        return true;
      }
      if (m.type === 'session-state') {
        if (!idOk(m)) return false;
        if (!stateOk(m.state)) {
          // the whole row goes: restored with no state, its tightenings and
          // locks would be lost on a resume that carries no replay. Without
          // it the resume is refused, and the shim replays only-tighter.
          rows.delete(m.session);
          warn('a session\'s state is not one the runtime would restore; its row is dropped');
          return false;
        }
        const r = row(m.session);
        if (r == null) return false;
        r.state = m.state;
        return true;
      }
      if (m.type === 'session-gone') return idOk(m) && rows.delete(m.session);
      if (m.type === 'decline') {
        if (!keysAre(m, ['at', 'kind', 'type']) || !KINDS.includes(m.kind)) return false;
        if (!Number.isSafeInteger(m.at) || m.at < 0 || m.at > now() + 60000) return false;
        declines.push({kind: m.kind, at: m.at});
        prune();
        if (declines.length > MAX_DECLINES) declines = declines.slice(-MAX_DECLINES);
        return true;
      }
      return false;
    },
    // the 'restore' a new runtime is handed (empty from a fresh daemon)
    restore() {
      prune();
      const sessions = [];
      for (const [session, r] of rows) {
        if (r.resume != null) sessions.push({session, resume: r.resume, state: r.state != null ? r.state : EMPTY_STATE});
      }
      return {type: 'restore', sessions, declines: declines.slice()};
    },
    // a handoff from the daemon this one replaced (C3b): each row and decline
    // goes through the same checks as a told one (a bad state drops its whole
    // row) -> how many sessions were kept
    seed(t) {
      if (t == null || !Array.isArray(t.sessions) || !Array.isArray(t.declines)) return 0;
      let kept = 0;
      for (const r of t.sessions) {
        if (r == null || typeof r !== 'object') continue;
        if (!this.told({type: 'session-resume', session: r.session, hash: r.resume})) continue;
        if (r.state != null && !this.told({type: 'session-state', session: r.session, state: r.state})) continue;
        kept += 1;
      }
      for (const d of t.declines) if (d != null && typeof d === 'object') this.told({type: 'decline', kind: d.kind, at: d.at});
      return kept;
    },
    // a restore the runtime refused: its rows would be stale forever, never
    // told gone, so the table starts over
    clear() { rows.clear(); declines = []; },
    size: () => rows.size
  };
}

module.exports = {createSessionTable, MAX_ROWS, MAX_DECLINES, MAX_STATE_BYTES, DECLINE_KEEP_MS, EMPTY_STATE};
