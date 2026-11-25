'use strict';
require('./tmp-dirs');
// A-firstrun d1: the fixed "next" line (lib/next-steps.js) is the last line
// on stdout of `ch-local install` and of an `add-pack` that added the pack,
// after the auto-upgrade question; never after a refusal, an add-pack that
// found the pack there, or an upgrade (which installs through lib/install.js,
// not this command). The library calls are stubbed: this is the CLI's order.
const test = require('node:test');
const assert = require('node:assert');
const {fakeIo: rawIo, tmp} = require('./fake-io');
// (each with a home folder of its own: a command acting on a home checks it first)
const fakeIo = (o = {}) => rawIo({homedir: tmp('ch-next-'), ...o});

const READY = 'Next: add any credential still missing and connect your client; then ask it what countinghouse can do for you.';
const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = {id: p, filename: p, loaded: true, exports}; };

function cli({installCode = 0, addCode = 0, added = true} = {}) {
  stub('../lib/install', {...require('../lib/install'), install: async (args, io) => { io.stdout.write('installed the pack\n'); return installCode; }});
  stub('../lib/upgrade', {...require('../lib/upgrade'), offerAuto: async (io) => { io.stdout.write('automatic upgrades are off (no terminal to ask)\n'); }});
  stub('../lib/packs-command', {...require('../lib/packs-command'), addPack: async (args, io) => { io.stdout.write('added the pack\n'); if (args.report != null) args.report.added = added; return addCode; }});
  delete require.cache[require.resolve('../bin/ch-local')];
  return require('../bin/ch-local').main;
}
const lastLine = (out) => out.trimEnd().split('\n').pop();

test('install: the "next" line is the last on stdout, after the auto-upgrade question; a failed install prints none', async () => {
  const io = fakeIo({});
  assert.strictEqual(await cli()(['install', '--pack', 'ci-failure-triage'], io), 0, io.err);
  assert.strictEqual(lastLine(io.out), READY);
  assert.ok(io.out.indexOf('automatic upgrades are off') < io.out.indexOf(READY));
  const failed = fakeIo({});
  assert.strictEqual(await cli({installCode: 1})(['install', '--pack', 'ci-failure-triage'], failed), 1);
  assert.ok(!failed.out.includes(READY));
});

test('add-pack: the "next" line last when it added the pack; none when the pack was already there, or on a refusal', async () => {
  const io = fakeIo({});
  assert.strictEqual(await cli()(['add-pack', 'other'], io), 0);
  assert.strictEqual(lastLine(io.out), READY);
  const there = fakeIo({});
  assert.strictEqual(await cli({added: false})(['add-pack', 'other'], there), 0);
  assert.ok(!there.out.includes(READY));
  const refused = fakeIo({});
  assert.strictEqual(await cli({addCode: 2, added: false})(['add-pack', 'nope'], refused), 2);
  assert.ok(!refused.out.includes(READY));
});
