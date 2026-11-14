'use strict';
// lib/control.js: start's side of the runtime's control channel. Requests
// wait for the runtime's {type: 'ready'} (countinghouse #210), at most a
// while for an older runtime that never says it; the teller says a text on
// stderr and tells it to the client, buffered until the channel is there,
// and says on stderr a notice the runtime did not take.
const test = require('node:test');
const assert = require('node:assert');
const {controlClient, teller} = require('../lib/control');

// a runtime that answers each request ok, and says ready when asked to
function fakeRuntime() {
  let listener = null;
  const sent = [];
  return {
    sent,
    ready: () => listener({type: 'ready'}),
    child: {send: (m) => { sent.push(m); setImmediate(() => listener({id: m.id, ok: m.type !== 'refuse', code: m.type === 'refuse' ? 'CONTROL_UNKNOWN' : undefined})); }, onMessage: (fn) => { listener = fn; }}
  };
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('a request waits for the runtime to say ready; then it goes, in order', async () => {
  const rt = fakeRuntime();
  const c = controlClient(rt.child, {readyMs: 5000});
  const first = c.request({type: 'notice', text: 'a'});
  const second = c.request({type: 'set', name: 'locale'});
  await tick();
  assert.deepStrictEqual(rt.sent, [], 'nothing before ready');
  rt.ready();
  assert.strictEqual((await first).ok, true);
  assert.strictEqual((await second).ok, true);
  assert.deepStrictEqual(rt.sent.map((m) => m.type), ['notice', 'set']);
});

test('an older runtime that never says ready: requests go after readyMs', async () => {
  const rt = fakeRuntime();
  const c = controlClient(rt.child, {readyMs: 50});
  const t = Date.now();
  assert.strictEqual((await c.request({type: 'notice', text: 'a'})).ok, true);
  assert.ok(Date.now() - t >= 40, 'waited for readyMs');
});

test('the teller: said at once, told once the channel is attached, and a notice not taken is said', async () => {
  const said = [];
  const n = teller((s) => said.push(s));
  n.tell('before');
  assert.deepStrictEqual(said, ['before']);
  assert.ok(n.told.has('before'));
  const rt = fakeRuntime();
  const c = controlClient(rt.child, {readyMs: 0});
  n.attach(c);
  n.tell('after');
  await tick(50);
  assert.deepStrictEqual(rt.sent.filter((m) => m.type === 'notice').map((m) => [m.module, m.text]), [[null, 'before'], [null, 'after']]);
  // the runtime refuses it (an older one without notices): said on stderr
  const refusing = teller((s) => said.push(s));
  refusing.attach({request: async () => ({ok: false, code: 'CONTROL_UNKNOWN'})});
  refusing.tell('lost?');
  await tick();
  assert.ok(said.includes('the client was not told: lost? (CONTROL_UNKNOWN)'), said.join('\n'));
});

test('the teller: a control whose request rejects, or throws, is said on stderr; nothing is left unhandled', async () => {
  const said = [];
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const rejecting = teller((s) => said.push(s));
    rejecting.attach({request: () => Promise.reject(Object.assign(new Error('gone'), {code: 'ERR_IPC_CHANNEL_CLOSED'}))});
    rejecting.tell('one');
    const throwing = teller((s) => said.push(s));
    throwing.attach({request: () => { throw Object.assign(new Error('no'), {code: 'EPIPE'}); }});
    throwing.tell('two');
    await tick(50);
    assert.ok(said.includes('the client was not told: one (ERR_IPC_CHANNEL_CLOSED)'), said.join('\n'));
    assert.ok(said.includes('the client was not told: two (EPIPE)'), said.join('\n'));
    assert.deepStrictEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
