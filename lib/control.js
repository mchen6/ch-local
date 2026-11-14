'use strict';
// start's side of the runtime's control channel (packs in place, part 2, plan
// Task B3; countinghouse's lib/control-channel.js): requests sent one at a
// time over the child's IPC fd, each answered by its id. A runtime that does
// not take control requests (one older than the channel) never answers: each
// request then fails at its timeout, and start says a restart is needed.
const TIMEOUT_MS = 30000;

// child: {send(msg), onMessage(fn)}. -> {request(msg) -> Promise<reply>}
function controlClient(child, {timeoutMs} = {}) {
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) timeoutMs = TIMEOUT_MS;
  let next = 1;
  let chain = Promise.resolve();
  const waiting = new Map();
  child.onMessage((m) => {
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

module.exports = {controlClient, TIMEOUT_MS};
