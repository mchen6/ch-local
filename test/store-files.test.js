'use strict';
require('./tmp-dirs');
// lib/store-files.js: the runtime's store files in the home (countinghouse
// --store local --storePath <home>/store) as status sees them, read only: a
// file that is there and does not parse as a JSON object is corrupt (as
// countinghouse's store reads it), and status says so in one line, naming
// the file and what to do. A missing or good file, or one that can't be read
// for another reason, says nothing here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {tmp} = require('./fake-io');
const {storeLines} = require('../lib/store-files');

const LINE = {
  'used-nonces.json': (f) => `store: used-nonces.json is corrupt: when a tool asks you a question during a call, your answer is refused, until a runtime that had it open before it became corrupt replaces it; if none does, move it away (${f})`,
  'kv.json': (f) => `store: kv.json is corrupt: the modules' stored data can't be read or changed, and an uninstall that would remove it is refused, until a runtime that had it open before it became corrupt replaces it; if none does, move it away (${f}), and what the modules stored starts empty`
};

test('metering.json is not said, corrupt or not: ch-local\'s start never meters, so the runtime never reads it', () => {
  const dir = tmp('ch-store-');
  fs.writeFileSync(path.join(dir, 'metering.json'), '{not json');
  assert.deepStrictEqual(storeLines(dir, '8.0.0'), []);
});

test('only for the runtime these lines describe: a home recorded on countinghouse 8.0.0 or later; an older or unknown one says nothing here', () => {
  const dir = tmp('ch-store-');
  fs.writeFileSync(path.join(dir, 'kv.json'), '{not json');
  assert.strictEqual(storeLines(dir, '8.0.0').length, 1);
  assert.strictEqual(storeLines(dir, '8.1.0').length, 1);
  for (const v of ['7.1.2', '8.0.0-rc.1', undefined, null, 'x']) assert.deepStrictEqual(storeLines(dir, v), [], String(v));
});

test('no store, or good and missing files: nothing to say', () => {
  const dir = tmp('ch-store-');
  assert.deepStrictEqual(storeLines(path.join(dir, 'none'), '8.0.0'), []);
  fs.writeFileSync(path.join(dir, 'used-nonces.json'), '{"a": 1}');
  fs.writeFileSync(path.join(dir, 'kv.json'), '{}');
  assert.deepStrictEqual(storeLines(dir, '8.0.0'), []);
});

test('each store file that does not parse as a JSON object: its own line, naming it and what to do, in the files\' order', () => {
  for (const bad of ['{not json', '[]', 'null', '42', '"x"', '']) {
    const dir = tmp('ch-store-');
    for (const name of Object.keys(LINE)) fs.writeFileSync(path.join(dir, name), bad);
    assert.deepStrictEqual(storeLines(dir, '8.0.0'), Object.entries(LINE).map(([name, line]) => line(path.join(dir, name))), JSON.stringify(bad));
  }
  const dir = tmp('ch-store-');
  fs.writeFileSync(path.join(dir, 'used-nonces.json'), '{"n": 1');
  fs.writeFileSync(path.join(dir, 'kv.json'), '{}');
  assert.deepStrictEqual(storeLines(dir, '8.0.0'), [LINE['used-nonces.json'](path.join(dir, 'used-nonces.json'))]);
  // (a kept copy of a corrupt file, <file>.corrupt-..., is not a store file)
  fs.writeFileSync(path.join(dir, 'kv.json.corrupt-1-2-3'), '{bad');
  assert.strictEqual(storeLines(dir, '8.0.0').length, 1);
});

test('a store file that is a folder is not said corrupt here', () => {
  const dir = tmp('ch-store-');
  fs.mkdirSync(path.join(dir, 'kv.json'));
  assert.deepStrictEqual(storeLines(dir, '8.0.0'), []);
});

test('a store file that cannot be read (its mode) is not said corrupt here', (t) => {
  const dir = tmp('ch-store-');
  const file = path.join(dir, 'kv.json');
  fs.writeFileSync(file, '{bad');
  fs.chmodSync(file, 0o000);
  try {
    let readable = true;
    try { fs.readFileSync(file); } catch (e) { readable = false; }
    if (readable) return t.skip('this user reads a mode-0 file (root, or Windows)');
    assert.deepStrictEqual(storeLines(dir, '8.0.0'), []);
  } finally {
    fs.chmodSync(file, 0o600);
  }
});
