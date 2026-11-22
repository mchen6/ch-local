'use strict';
require('./tmp-dirs');
// lib/failed-json.js: failed.json read by the shim's own rule (shim/src/failed.rs,
// its vectors in shim/tests/vectors/contract-2.json failedJson): exactly
// {v, at, exit, signal, reason}, at most 512 bytes, fresh within 10 minutes
// back and 1 minute ahead. status and restart say "gave up" only when a
// session would act on it (the medium on the closing pass, 1)
const test = require('node:test');
const assert = require('node:assert');
const {parse} = require('../lib/failed-json');

const V = require('../shim/tests/vectors/contract-2.json').failedJson;
const NOW = 1794391200000;
const bytesOf = (c) => {
  const at = NOW + c.atOffsetMs;
  if (typeof c.text === 'string') return Buffer.from(c.text.replace('<at>', String(at)));
  return Buffer.from(JSON.stringify({...c.value, at}));
};

test('the shim\'s failedJson vectors: every accepted file is read with its reason; every ignored one is none', () => {
  assert.strictEqual(V.freshPastMs, 600000);
  assert.strictEqual(V.freshFutureMs, 60000);
  for (const c of V.accepted) assert.strictEqual(parse(bytesOf(c), NOW), (c.value && c.value.reason) || JSON.parse(bytesOf(c).toString()).reason, c.why);
  for (const c of V.ignored) assert.strictEqual(parse(bytesOf(c), NOW), null, c.why);
});

test('a duplicate key, an extra one, or a file past 512 bytes is none', () => {
  const ok = {v: 1, at: NOW, exit: 1, signal: null, reason: 'never-listened'};
  assert.strictEqual(parse(Buffer.from(JSON.stringify(ok)), NOW), 'never-listened');
  assert.strictEqual(parse(Buffer.from(`{"v":1,"v":1,"at":${NOW},"exit":1,"signal":null,"reason":"never-listened"}`), NOW), null, 'a key twice');
  assert.strictEqual(parse(Buffer.from(JSON.stringify({...ok, extra: 1})), NOW), null, 'a key extra');
  assert.strictEqual(parse(Buffer.concat([Buffer.from(JSON.stringify(ok)), Buffer.alloc(600, 0x20)]), NOW), null, 'past 512 bytes');
});
