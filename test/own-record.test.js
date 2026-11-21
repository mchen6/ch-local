'use strict';
require('./tmp-dirs');
// B-own-add: <home>/own.json, the user's own modules (lib/own-record.js;
// the own-modules design §2.1). Versioned and stable: what is written is
// read back as written; anything else is refused, never taken for "none".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const own = require('../lib/own-record');
const {layout} = require('../lib/home');
const {tmp} = require('./fake-io');

const where = () => layout({COUNTINGHOUSE_HOME: tmp('ch-ownrec-')});
const entry = (over = {}) => Object.assign({tree: 'a'.repeat(64), version: '1.0.0', friendlyName: 'my-tool', addedAt: '2026-11-21T10:00:00.000Z',
  from: '/home/u/my-tool', calls: ['ch-access-github/githubService.listRuns']}, over);

test('none: null; written and read back as written', () => {
  const w = where();
  assert.strictEqual(own.readOwnRecord(w), null);
  own.writeOwnRecord(w, {v: 1, modules: {'my-tool': entry(), '@me/other': entry({friendlyName: 'other', calls: []})}});
  const r = own.readOwnRecord(w);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), {v: 1, modules: {'my-tool': entry(), '@me/other': entry({friendlyName: 'other', calls: []})}});
  assert.strictEqual(Object.getPrototypeOf(r.modules), null, 'a map with no prototype');
});

test('a record that is there and malformed is refused, never "none"', () => {
  const w = where();
  const bad = [
    '{', JSON.stringify({v: 2, modules: {}}), JSON.stringify({v: 1, modules: {}, extra: 1}),
    JSON.stringify({v: 1, modules: {'Not A Name': entry()}}),
    JSON.stringify({v: 1, modules: {'@countinghouse/ch-x': entry()}}),
    JSON.stringify({v: 1, modules: {'my-tool': entry({tree: 'short'})}}),
    JSON.stringify({v: 1, modules: {'my-tool': entry({from: 'relative/path'})}}),
    JSON.stringify({v: 1, modules: {'my-tool': entry({addedAt: 'yesterday'})}}),
    JSON.stringify({v: 1, modules: {'my-tool': Object.assign(entry(), {reach: ['https://api.github.com']})}}),
    JSON.stringify({v: 1, modules: {'my-tool': entry({calls: ['not an address']})}}),
    JSON.stringify({v: 1, modules: {'my-tool': Object.assign(entry(), {token: 'x'})}})
  ];
  for (const text of bad) {
    fs.writeFileSync(w.ownRecord, text);
    assert.throws(() => own.readOwnRecord(w), (e) => e.code === 'OWN_RECORD_FORMAT', text.slice(0, 80));
  }
});

test('the writer refuses a record it would refuse to read', () => {
  const w = where();
  assert.throws(() => own.writeOwnRecord(w, {v: 1, modules: {'my-tool': entry({tree: 'x'})}}), /refused to write/);
  assert.strictEqual(fs.existsSync(w.ownRecord), false);
});
