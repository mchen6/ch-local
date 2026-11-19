'use strict';
require('./tmp-dirs');   // its ch-* temporary directories removed at its end, under any runner
// lib/pipe-probe.js (the review of #39, F1): a daemon.json's pipe is probed
// in PowerShell at Identification level, its owner checked as the native
// shim checks it, then the PROVE. PowerShell is injected here; on Windows
// the real one runs against a fake runtime's pipe.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {probePipe, PROBE_SCRIPT} = require('../lib/pipe-probe');
const {newPipeName} = require('../lib/session-socket');
const {fakeRuntime, tmpHome, makeRunDir} = require('./daemon-fakes');

test('the script names no cmdlet, opens at Identification, and checks the owner as the shim does, before it writes a byte', () => {
  const code = PROBE_SCRIPT.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  assert.doesNotMatch(code, /\b[A-Z][a-z]+-[A-Z][A-Za-z]+\b/);
  assert.match(PROBE_SCRIPT, /TokenImpersonationLevel\]::Identification/);
  for (const sid of ['S-1-5-18', 'S-1-5-32-544']) assert.ok(PROBE_SCRIPT.includes(sid), sid);
  assert.ok(PROBE_SCRIPT.indexOf('GetOwner') < PROBE_SCRIPT.indexOf('$c.Write('), 'the owner before any write');
});

test('the pipe\'s short name in the environment, the secret on stdin and never in argv or env; only "ok" is a yes', async() => {
  const pipe = newPipeName();
  const secret = crypto.randomBytes(32);
  const seen = [];
  const ps = (answer) => (script, env, input) => { seen.push({script, env, input}); if (answer instanceof Error) throw answer; return answer; };
  assert.strictEqual(await probePipe(pipe, secret, 1500, {powershell: ps('ok\r\n')}), true);
  assert.deepStrictEqual(seen[0].env, {CH_PIPE: pipe.slice('\\\\.\\pipe\\'.length), CH_PROBE_MS: '1500'});
  assert.strictEqual(seen[0].input, secret.toString('hex'));
  assert.ok(!JSON.stringify(seen[0].env).includes(secret.toString('hex')));
  for (const answer of ['owner S-1-5-21-1-2-3-1002', 'wrong proof', 'not a prove', '', new Error('timed out')]) {
    assert.strictEqual(await probePipe(pipe, secret, 1500, {powershell: ps(answer)}), false, String(answer));
  }
});

test('anything but a pipe of the form, or a secret not of 32 bytes, is a no, and PowerShell never runs', async() => {
  let ran = false;
  const ps = () => { ran = true; return 'ok'; };
  for (const socket of ['\\\\.\\pipe\\other-0123456789abcdef0123456789abcdef', 'C:\\x\\sessions.sock', '/tmp/s', null]) {
    assert.strictEqual(await probePipe(socket, crypto.randomBytes(32), 1000, {powershell: ps}), false, String(socket));
  }
  assert.strictEqual(await probePipe(newPipeName(), crypto.randomBytes(31), 1000, {powershell: ps}), false);
  assert.strictEqual(ran, false);
});

test('on Windows: a pipe of this user\'s, proving the secret, is a yes; under another secret, a no', {skip: process.platform !== 'win32' && 'Windows only'}, async() => {
  const home = tmpHome();
  const runDir = makeRunDir(home);
  const pipe = newPipeName();
  const rt = await fakeRuntime(runDir, pipe);
  try {
    assert.strictEqual(await probePipe(pipe, rt.secret, 3000), true);
    assert.strictEqual(await probePipe(pipe, crypto.randomBytes(32), 3000), false);
    assert.strictEqual(await probePipe(newPipeName(), rt.secret, 500), false, 'nothing there');
  } finally {
    await rt.close();
    fs.rmSync(home, {recursive: true, force: true});
  }
});
