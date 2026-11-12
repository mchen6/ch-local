'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {check, offerNode, FLOOR} = require('../lib/node-check');
const {main} = require('../bin/ch-local');
const {fakeIo} = require('./fake-io');

test('check compares against the 22.16 floor', () => {
  assert.strictEqual(FLOOR, '22.16.0');
  assert.deepStrictEqual(check('v22.15.1'), {ok: false, floor: '22.16.0'});
  assert.deepStrictEqual(check('v22.16.0'), {ok: true, floor: '22.16.0'});
  assert.deepStrictEqual(check('v24.21.0'), {ok: true, floor: '22.16.0'});
});

test('below the floor two paths are offered; a no means install it yourself', async () => {
  const io = fakeIo({answers: ['no'], version: 'v20.11.0'});
  assert.strictEqual(await offerNode(io), 'install-yourself');
  assert.match(io.err, /Node 24/);
  assert.match(io.err, /install Node 24 yourself/i);
  assert.match(io.err, /let ch-local fetch/i);
  assert.deepStrictEqual(io.fetches, []);
});

test('a yes to the fetch is refused for now, and nothing is downloaded', async () => {
  const io = fakeIo({answers: ['yes'], version: 'v20.11.0'});
  assert.strictEqual(await offerNode(io), 'abort');
  assert.match(io.err, /cannot fetch Node yet/);
  assert.deepStrictEqual(io.fetches, []);
});

test('every command stops below the floor before doing anything', async () => {
  const io = fakeIo({answers: ['no'], version: 'v20.11.0'});
  assert.strictEqual(await main(['install', '--pack', 'ci-failure-triage', '--from', '/nowhere'], io), 1);
  assert.deepStrictEqual(io.execs, []);
  assert.match(io.err, /needs Node 22\.16 or later; this is v20\.11\.0/);
});

test('node-check loads on an old Node: no node: requires, no newer syntax it needs', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'node-check.js'), 'utf8');
  assert.ok(!/require\(/.test(src), 'requires nothing');
  const bin = fs.readFileSync(path.join(__dirname, '..', 'bin', 'ch-local.js'), 'utf8');
  assert.ok(bin.indexOf("require('../lib/node-check')") < bin.indexOf("require('../lib/install')"), 'the floor module loads first');
});
