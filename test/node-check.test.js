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

// The install-yourself route for each platform: the routes the install pages
// give (docs/install/README.md, "Before you start", as they land), never "whatever is current", in
// business's words. Homebrew's node@24 is keg-only, so `brew install node@24`
// alone leaves `node -v` where it was: the PATH line `brew info node@24`
// prints is part of the route. winget has no per-major id for 24, so Windows
// takes the .msi from latest-v24.x. Each command and address stands on its
// own indented line with nothing after it, so a copy of it is whole.
const BLOCKS = {
  darwin: [
    '  1. install Node 24 yourself: the macOS installer (.pkg) from',
    '       https://nodejs.org/dist/latest-v24.x/',
    '     or Homebrew:',
    '       brew install node@24',
    '     then add the PATH line that brew info node@24 prints to your shell\'s',
    '     startup file (~/.zshrc for zsh, the default; ~/.bash_profile for bash),',
    '     and open a new terminal'
  ],
  win32: [
    '  1. install Node 24 yourself: the Windows installer (.msi, x64) from',
    '       https://nodejs.org/dist/latest-v24.x/',
    '     then open a new terminal'
  ],
  linux: [
    '  1. install Node 24 yourself: your distribution\'s package if node -v',
    '     then prints v24.x; otherwise',
    '       https://nodejs.org/en/download',
    '     choose v24 and Linux, and it shows the commands to run'
  ],
  other: [
    '  1. install Node 24 yourself: your system\'s package manager or ports,',
    '     for Node 24'
  ]
};
// (a platform named like an Object.prototype member gets the other systems' route)
for (const platform of ['darwin', 'win32', 'linux', 'freebsd', 'constructor', '__proto__']) {
  test(`below the floor on ${platform}: the install-yourself route is the install pages' own, each command on a line of its own`, async () => {
    const io = fakeIo({answers: ['no'], version: 'v20.11.0'});
    io.platform = platform;
    assert.strictEqual(await offerNode(io), 'install-yourself');
    const lines = io.err.split('\n');
    const from = lines.findIndex((l) => l.startsWith('  1. install Node 24 yourself: '));
    const to = lines.findIndex((l) => l.startsWith('  2. '));
    assert.deepStrictEqual(lines.slice(from, to), Object.prototype.hasOwnProperty.call(BLOCKS, platform) ? BLOCKS[platform] : BLOCKS.other);
    // (each line of the route fits an 80-column terminal)
    for (const l of lines.slice(from, to)) assert.ok(l.length <= 80, `${l.length}: ${l}`);
    // (a command or an address alone on its line: nothing after it)
    for (const l of lines.slice(from, to).filter((x) => x.startsWith('       '))) assert.match(l, /^ {7}(brew install node@24|https:\/\/\S*[^\s,;:.])$/);
    assert.ok(!/winget install OpenJS\.NodeJS\.LTS/.test(io.err) && !/brew install node(?!@24)/.test(io.err), io.err);
  });
}
