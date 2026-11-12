'use strict';
// The credential a launcher uses: the first named variable with a real value.
// No client entry sets one; the guard against '' and an unresolved ${...}
// placeholder is a defence against a hand-written entry.
const test = require('node:test');
const assert = require('node:assert');
const {pickCredential} = require('../lib/credential');

const NAMES = ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN'];

test('the first variable with a value wins, by name', () => {
  assert.deepStrictEqual(pickCredential({COUNTINGHOUSE_GITHUB_TOKEN: 'a', GITHUB_TOKEN: 'b'}, NAMES), {name: 'COUNTINGHOUSE_GITHUB_TOKEN', value: 'a'});
  assert.deepStrictEqual(pickCredential({GITHUB_TOKEN: 'b'}, NAMES), {name: 'GITHUB_TOKEN', value: 'b'});
});

test('an empty or unresolved value counts as missing, so the fallback is reached', () => {
  for (const empty of ['', '   ', '${env:COUNTINGHOUSE_GITHUB_TOKEN}', '${COUNTINGHOUSE_GITHUB_TOKEN:-}', '${COUNTINGHOUSE_GITHUB_TOKEN}']) {
    assert.deepStrictEqual(pickCredential({COUNTINGHOUSE_GITHUB_TOKEN: empty, GITHUB_TOKEN: 'b'}, NAMES), {name: 'GITHUB_TOKEN', value: 'b'}, JSON.stringify(empty));
  }
  assert.strictEqual(pickCredential({COUNTINGHOUSE_GITHUB_TOKEN: '', GITHUB_TOKEN: ''}, NAMES), null);
  assert.strictEqual(pickCredential({}, NAMES), null);
});
