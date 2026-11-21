'use strict';
require('./tmp-dirs');
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

// the reviewer's pre-work high (A-home-check, 5): a file writeAtomic makes is
// the user's alone whatever the umask (the launcher among them: under 0002 it
// was 0664); a file that exists keeps its own mode
test('writeAtomic: a new file is 0600 whatever the umask; an existing one keeps its mode', {skip: process.platform === 'win32' && 'POSIX modes'}, () => {
  const dir = tmp('ch-atomic-');
  const was = process.umask(0o002);
  try {
    const f = path.join(dir, 'new.js');
    writeAtomic(f, 'x');
    assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    const g = path.join(dir, 'kept.json');
    fs.writeFileSync(g, 'y');
    fs.chmodSync(g, 0o644);
    writeAtomic(g, 'z');
    assert.strictEqual(fs.statSync(g).mode & 0o777, 0o644, 'kept');
    const e = path.join(dir, 'excl.json');
    assert.strictEqual(createExclusive(e, '{}'), true);
    assert.strictEqual(fs.statSync(e).mode & 0o777, 0o600);
  } finally {
    process.umask(was);
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
