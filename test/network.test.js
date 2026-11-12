'use strict';
// No command other than install and upgrade makes a network call (spec §2):
// every lib file loads with the network stubbed to throw, and only
// lib/registry.js may name a network module or fetch.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {main} = require('../bin/ch-local');
const {fakeIo, tmp} = require('./fake-io');

const LIB = path.join(__dirname, '..', 'lib');

test('only lib/registry.js names a network module or fetch', () => {
  for (const f of fs.readdirSync(LIB)) {
    const src = fs.readFileSync(path.join(LIB, f), 'utf8');
    const net = /require\(['"](node:)?(http|https|net|tls|dns|http2|dgram)['"]\)|\bfetch\(/.test(src);
    assert.strictEqual(net, f === 'registry.js', f);
  }
});

test('snippet, add and uninstall run with the network stubbed to throw', async () => {
  const user = tmp('ch-user-');
  const saved = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network call'); };
  try {
    const home = path.join(user, '.countinghouse');
    fs.mkdirSync(path.join(home, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(home, 'bin', 'ch-local.js'), '');
    const run = async (argv, answers) => { const io = fakeIo({env: {}, homedir: user, answers}); const code = await main(argv, io); return {code, io}; };
    for (const [argv, answers] of [[['snippet', 'cursor']], [['add', 'cursor']], [['uninstall'], ['yes']]]) {
      const {code, io} = await run(argv, answers);
      assert.strictEqual(code, 0, `${argv.join(' ')}: ${io.err}`);
      assert.deepStrictEqual(io.fetches, [], argv.join(' '));
    }
  } finally {
    globalThis.fetch = saved;
    fs.rmSync(user, {recursive: true, force: true});
  }
});
