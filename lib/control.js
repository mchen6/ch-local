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

// child: {send(msg), onMessage(fn)}. -> {request(msg) -> Promise<reply>}
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
  child.onMessage((m) => {
    if (m != null && m.type === 'ready' && m.id === undefined) { clearTimeout(readyTimer); isReady(); return; }
    const w = (m != null) ? waiting.get(m.id) : null;
    if (w == null) return;
    waiting.delete(m.id);
    clearTimeout(w.timer);
    w.resolve(m);
  });
  const once = (msg) => new Promise((resolve) => {
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
// start's. -> {tell(text), attach(control), told}
function teller(say) {
  const buffered = [];
  const told = new Set();
  let control = null;
  // never a rejection left unhandled (that ends start on Node 15 and later):
  // a request that rejects is said, like one the runtime did not take
  const notTold = (text, code) => say(`the client was not told: ${text} (${code || 'failed'})`);
  const send = (text) => {
    let p;
    try { p = Promise.resolve(control.request({type: 'notice', module: null, text})); } catch (e) { p = Promise.reject(e); }
    p.then((r) => { if (r == null || r.ok !== true) notTold(text, r && r.code); }, (e) => notTold(text, e && e.code));
  };
  return {
    told,
    tell(text) {
      say(text);
      told.add(text);
      if (control != null) send(text); else buffered.push(text);
    },
    attach(c) {
      control = c;
      buffered.splice(0).forEach(send);
    }
  };
}

module.exports = {controlClient, teller, TIMEOUT_MS, READY_MS};
