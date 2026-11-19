'use strict';
// start's side of the runtime's control channel (packs in place, part 2, plan
// Task B3; countinghouse's lib/control-channel.js): requests sent one at a
// time over the child's IPC fd, each answered by its id. A runtime that does
// not take control requests (one older than the channel) never answers: each
// request then fails at its timeout, and start says a restart is needed.
const TIMEOUT_MS = 30000;
// The runtime says {type: 'ready'} once it listens (countinghouse #210): a
// request sent before that was lost. Requests wait for it, and at most this
// long for an older runtime that never says it.
const READY_MS = 10000;

// child: {send(msg), onMessage(fn)}. -> {request(msg) -> Promise<reply>,
// onRequest(type, async (msg) -> fields)}
//
// The runtime asks start too (countinghouse part 3 P2, Task 4: may-elicit):
// {id: 'r<n>', type, ...}, answered {id, ok: true, ...fields} or {id, ok:
// false, code}, with no type (the runtime routes a reply by that).
function controlClient(child, {timeoutMs, readyMs} = {}) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) timeoutMs = TIMEOUT_MS;
  if (!(Number.isFinite(readyMs) && readyMs >= 0)) readyMs = READY_MS;
  let next = 1;
  let isReady = null;
  const ready = new Promise((resolve) => { isReady = resolve; });
  const readyTimer = setTimeout(() => isReady(), readyMs);
  if (typeof readyTimer.unref === 'function') readyTimer.unref();
  let chain = ready;
  const waiting = new Map();
  const handlers = new Map();
  const tellers = new Map();
  const answer = (m) => { try { child.send(m); } catch (err) { /* the runtime has gone */ } };
  child.onMessage((m) => {
    if (m != null && m.type === 'ready' && m.id === undefined) { clearTimeout(readyTimer); isReady(); return; }
    // an unasked message, {type, ...} with no id (a session runtime's
    // 'listening', countinghouse C3): to its teller, if one is set
    if (m != null && m.id === undefined && typeof m.type === 'string') {
      const fn = tellers.get(m.type);
      if (fn != null) { try { fn(m); } catch (err) { /* the teller's own */ } }
      return;
    }
    if (m != null && typeof m.id === 'string' && /^r\d+$/.test(m.id) && typeof m.type === 'string') {
      const handler = handlers.get(m.type);
      if (handler == null) { answer({id: m.id, ok: false, code: 'CONTROL_UNKNOWN'}); return; }
      Promise.resolve().then(() => handler(m)).then(
        (fields) => answer({...fields, id: m.id, ok: true}),
        (err) => answer({id: m.id, ok: false, code: (err != null && typeof err.code === 'string') ? err.code : 'CONTROL_FAILED'}));
      return;
    }
    const w = (m != null) ? waiting.get(m.id) : null;
    if (w == null) return;
    waiting.delete(m.id);
    clearTimeout(w.timer);
    w.resolve(m);
  });
  let closed = false;
  const once = (msg) => new Promise((resolve) => {
    if (closed) return resolve({ok: false, code: 'CONTROL_GONE', message: 'the runtime has ended'});
    const id = next++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      resolve({id, ok: false, code: 'CONTROL_NO_ANSWER', message: `the runtime did not answer within ${timeoutMs} ms`});
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    waiting.set(id, {resolve, timer});
    try {
      child.send({...msg, id});
    } catch (err) {
      waiting.delete(id);
      clearTimeout(timer);
      resolve({id, ok: false, code: 'CONTROL_SEND_FAILED', message: err.message});
    }
  });
  return {
    onRequest: (type, fn) => { handlers.set(type, fn); },
    onTold: (type, fn) => { tellers.set(type, fn); },
    // the runtime has ended: every pending request is settled now,
    // CONTROL_GONE, never left to its timeout, and later ones answer the same
    close: () => {
      closed = true;
      clearTimeout(readyTimer);
      isReady();
      for (const [id, w] of waiting) { clearTimeout(w.timer); w.resolve({id, ok: false, code: 'CONTROL_GONE', message: 'the runtime has ended'}); }
      waiting.clear();
    },
    request: (msg) => {
      const p = chain.then(() => once(msg));
      chain = p.catch(() => {});
      return p;
    }
  };
}

// Never silent (countinghouse part 3, section 5): a text said on stderr and
// told to the client as a notice (the next result of any tool, and
// notifications/message). Buffered until the control channel is attached,
// then sent; one the runtime did not take is said on stderr, so nothing is
// lost unsaid. told: every text so far, so the applier repeats none of
// start's. A notice goes to every open session (countinghouse M5a: no
// session has a view of its own); it names the module it is about, or null
// (the module form's notice: {type: 'notice', module, text}).
// -> {tell(text, {module}?), attach(control), told}
function teller(say) {
  const buffered = [];
  const told = new Set();
  let control = null;
  // never a rejection left unhandled (that ends start on Node 15 and later):
  // a request that rejects is said, like one the runtime did not take
  const notTold = (text, code) => say(`the client was not told: ${text} (${code || 'failed'})`);
  const send = ({text, module}) => {
    let p;
    try { p = Promise.resolve(control.request({type: 'notice', module, text})); } catch (e) { p = Promise.reject(e); }
    p.then((r) => { if (r == null || r.ok !== true) notTold(text, r && r.code); }, (e) => notTold(text, e && e.code));
  };
  return {
    told,
    tell(text, {module = null} = {}) {
      say(text);
      told.add(text);
      if (control != null) send({text, module}); else buffered.push({text, module});
    },
    attach(c) {
      control = c;
      buffered.splice(0).forEach(send);
    }
  };
}

module.exports = {controlClient, teller, TIMEOUT_MS, READY_MS};
