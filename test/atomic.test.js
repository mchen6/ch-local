'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {writeAtomic, createExclusive} = require('../lib/atomic');
const {tmp} = require('./fake-io');

test('writeAtomic writes and replaces a file, leaving no temporary file', () => {
  const dir = tmp('ch-atomic-');
  try {
    const f = path.join(dir, 'sub', 'a.json');
    writeAtomic(f, 'one');
    writeAtomic(f, 'two');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'two');
    assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['a.json']);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

test('two launchers do not clobber auth.json: the second exclusive create is refused', () => {
  const dir = tmp('ch-atomic-');
  try {
    const f = path.join(dir, 'auth.json');
    assert.strictEqual(createExclusive(f, 'first'), true);
    assert.strictEqual(createExclusive(f, 'second'), false);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), 'first');
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
