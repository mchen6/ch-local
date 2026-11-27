'use strict';
require('./tmp-dirs');
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

// The install-yourself line for each platform: the routes the install pages
// give (docs/install, "Before you start"), never "whatever is current".
// Homebrew's node@24 is keg-only, so `brew install node@24` alone leaves
// `node -v` where it was: the PATH line `brew info node@24` prints is part of
// the route. winget has no per-major id for 24 (only exact versions), so
// Windows takes the .msi from latest-v24.x.
const LINES = {
  darwin: 'brew install node@24, then put it on your PATH as brew info node@24 says (Homebrew keeps it off the PATH): echo \'export PATH="$(brew --prefix node@24)/bin:$PATH"\' >> ~/.zshrc, and open a new terminal; or the macOS installer (.pkg) from https://nodejs.org/dist/latest-v24.x/',
  win32: 'the Windows installer (.msi, x64) from https://nodejs.org/dist/latest-v24.x/, then open a new terminal',
  linux: 'your distribution\'s package if node -v then prints v24.x; otherwise https://nodejs.org/en/download: choose v24 and Linux, and it shows the commands to run',
  other: 'https://nodejs.org/en/download: choose v24 and your system, and it shows the commands to run'
};
for (const platform of ['darwin', 'win32', 'linux', 'freebsd']) {
  test(`below the floor on ${platform}: the install-yourself line is the install pages' route, never "whatever is current"`, async () => {
    const io = fakeIo({answers: ['no'], version: 'v20.11.0'});
    io.platform = platform;
    assert.strictEqual(await offerNode(io), 'install-yourself');
    const line = io.err.split('\n').find((l) => l.startsWith('  1. install Node 24 yourself: '));
    assert.strictEqual(line, '  1. install Node 24 yourself: ' + (LINES[platform] || LINES.other));
    assert.ok(!/winget install OpenJS\.NodeJS\.LTS/.test(io.err) && !/brew install node(?!@)/.test(io.err), io.err);
  });
}
