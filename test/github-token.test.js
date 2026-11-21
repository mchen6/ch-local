'use strict';
require('./tmp-dirs');
// lib/github-token.js: the gh token a start gives its runtime. The reviewer's
// Fable high on #126, F1: on Windows the search for a program looks in the
// current folder first, so gh is never run from the home (a gh.exe planted
// there would run as the user); and a home another user could change gets no
// token at all.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {ghToken} = require('../lib/github-token');
const {tmp} = require('./fake-io');

const TOKEN = ['gh', 'o', '_', 'x'.repeat(30)].join('');
const fakeExec = (seen) => async (cmd, args, opts) => { seen.push({cmd, args, cwd: opts && opts.cwd}); return {status: 0, stdout: `${TOKEN}\n`}; };

test('Windows: gh runs from the Windows system folder, never the home', async () => {
  const home = tmp('ch-ghtoken-');
  const seen = [];
  const r = await ghToken({env: {SystemRoot: 'C:\\Windows'}, platform: 'win32', exec: fakeExec(seen)}, home);
  assert.strictEqual(r.token, TOKEN);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].cwd, 'C:\\Windows\\System32');
});

test('a home another user could change gets no gh token, and gh is not run', {skip: process.platform === 'win32' && 'POSIX modes'}, async () => {
  const home = tmp('ch-ghtoken-');
  fs.chmodSync(home, 0o777);
  try {
    const seen = [];
    const r = await ghToken({env: {}, platform: process.platform, exec: fakeExec(seen)}, home);
    assert.strictEqual(r.token, undefined);
    assert.match(String(r.why), /so another user could change what runs from it/);
    assert.strictEqual(seen.length, 0, 'gh not run');
  } finally {
    fs.chmodSync(home, 0o700);
  }
});

// the medium on #126's round 2: a Windows folder that can't be found is a
// reason, never a throw (start, status and credentials add await this)
test('Windows: a system folder that can\'t be named is said, never thrown', async () => {
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = '\\\\server\\share';
  try {
    const r = await ghToken({env: {}, platform: 'win32', exec: async () => assert.fail('gh not run')}, tmp('ch-ghtoken-'));
    assert.strictEqual(r.token, undefined);
    // (on Windows the home's own check comes first, and its ACL read can't
    // start either: refused there, said; elsewhere the home passes and the
    // system folder is the step that refuses. Either way: a reason, gh never
    // run, nothing thrown)
    assert.match(String(r.why), process.platform === 'win32' ? /could not be found|ACL could not be read/ : /could not be found/);
  } finally {
    if (saved === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = saved;
  }
});
