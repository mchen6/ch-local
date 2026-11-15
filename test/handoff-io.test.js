'use strict';
// lib/handoff-io.js (C3b): the re-exec handoff's two ends, with real
// processes. spawnDaemon starts `<node> <home>/bin/ch-local.js <args>` in its
// own group, cwd the home, with the allowlist's environment and the bytes on
// its fd 3; readHandoff reads fd 3 whole, within a size and a time bound.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnDaemon, readHandoff} = require('../lib/handoff-io');

const LIB = path.join(__dirname, '..', 'lib', 'handoff-io.js');
const wait = async(file, ms = 10000) => {
  const until = Date.now() + ms;
  while (!fs.existsSync(file) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
};

test('spawnDaemon hands the bytes over fd 3, never argv or env, from the home, with only the allowlist', {skip: process.platform === 'win32'}, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ho-')));
  try {
    fs.mkdirSync(path.join(home, 'bin'));
    const out = path.join(home, 'out.json');
    // a stand-in launcher: reads its handoff and says what it saw
    fs.writeFileSync(path.join(home, 'bin', 'ch-local.js'), `require(${JSON.stringify(LIB)}).readHandoff().then((b) => {
      require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env).sort(), bytes: b == null ? null : b.toString('hex')}));
    });`);
    const bytes = Buffer.from('00000003abc', 'utf8');
    assert.strictEqual(spawnDaemon(home, ['daemon', '--home', home, '--handoff'], {handoff: bytes, env: {PATH: process.env.PATH, HOME: home, NODE_OPTIONS: '--require /nonexistent.js', SECRET_THING: 'x'}}), true);
    await wait(out);
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepStrictEqual(seen.argv, ['daemon', '--home', home, '--handoff']);
    assert.strictEqual(seen.cwd, home);
    assert.strictEqual(seen.bytes, bytes.toString('hex'), 'the bytes, whole, on fd 3');
    assert.ok(!seen.env.includes('NODE_OPTIONS') && !seen.env.includes('SECRET_THING'), `only the allowlist: ${seen.env}`);
  } finally {
    fs.rmSync(home, {recursive: true, force: true});
  }
});

test('readHandoff: nothing on fd 3 (no pipe) is null; more than the bound is null', {skip: process.platform === 'win32'}, async () => {
  assert.strictEqual(await readHandoff(987, {ms: 300}), null, 'a closed descriptor');
  const big = require('node:child_process').spawn(process.execPath, ['-e', `require(${JSON.stringify(LIB)}).readHandoff(3, {max: 10, ms: 2000}).then((b) => process.stdout.write(b === null ? 'null' : 'bytes'))`], {stdio: ['ignore', 'pipe', 'inherit', 'pipe']});
  let said = '';
  big.stdout.on('data', (d) => { said += d; });
  big.stdio[3].end(Buffer.alloc(100, 1));
  await new Promise((res) => big.on('exit', res));
  assert.strictEqual(said, 'null', 'over its bound');
});

// the review of #39: readHandoff resolves once its stream, and the fd, has
// closed, not before the asynchronous close
test('readHandoff: by the time it resolves, its fd is closed', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ch-ho-')));
  try {
    const file = path.join(dir, 'handoff');
    fs.writeFileSync(file, 'abc');
    for (const max of [1024, 2]) {
      const fd = fs.openSync(file, 'r');
      const got = await readHandoff(fd, {max});
      assert.strictEqual(got == null ? null : got.toString(), max === 1024 ? 'abc' : null);
      assert.throws(() => fs.fstatSync(fd), (e) => e.code === 'EBADF', `fd closed (max ${max})`);
    }
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
