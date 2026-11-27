'use strict';
require('./tmp-dirs');
// scripts/client-plugin-check.js: the checks of windows-client.yml, on
// `claude plugin list --json`'s shape (as Claude Code 2.1.332 printed it, with
// no login, 2026-11-27: an entry per plugin, ours with mcpServers) and the
// acceptance report's timings.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {tmp} = require('./fake-io');
const {listed, absent, timed, main} = require('../scripts/client-plugin-check');

const ID = 'ch-packs@ch-packs';
const BUILTIN = {id: 'cc-plugin-privacy@builtin', version: 'unknown', scope: 'user', enabled: true};
const OURS = {id: ID, version: '0.2.0', scope: 'user', enabled: true, mcpServers: {countinghouse: {command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/launch.js', 'session']}}};
const list = (...e) => JSON.stringify(e);

test('listed: once, enabled, with its countinghouse server; anything else is not', () => {
  assert.deepStrictEqual(listed(list(OURS, BUILTIN), ID), {ok: true, line: `${ID}: listed, enabled, with its countinghouse server (version 0.2.0)`});
  const {version, ...noVersion} = OURS;
  assert.deepStrictEqual(listed(list(noVersion), ID), {ok: true, line: `${ID}: listed, enabled, with its countinghouse server`}, version);
  assert.strictEqual(listed(list(BUILTIN), ID).ok, false);
  assert.strictEqual(listed(list(OURS, OURS), ID).ok, false);
  assert.strictEqual(listed(list({...OURS, enabled: false}), ID).ok, false);
  assert.strictEqual(listed(list({...OURS, mcpServers: {}}), ID).ok, false);
  assert.throws(() => listed('{"id": 1}', ID), /did not answer a list/);
});

test('absent: only when no entry has the id', () => {
  assert.deepStrictEqual(absent(list(BUILTIN), ID), {ok: true, line: `${ID}: not listed`});
  assert.deepStrictEqual(absent(list(BUILTIN, {...OURS, enabled: false}), ID), {ok: false, line: `${ID}: still listed`});
});

test('timed: the plugin steps plus install to first result, the build not counted; under 5 minutes or not', () => {
  const report = {ok: true, timings: {built: 50000, installed: 57000, firstResult: 74000}};
  const r = timed(report, 30000);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.timing, {pluginMs: 30000, installToFirstResultMs: 24000, firstCommandToFirstResultMs: 54000, limitMs: 300000});
  assert.strictEqual(r.line, 'first command to first result: 54.0 s (the plugin steps 30.0 s, then install to first result 24.0 s); under 5 minutes');
  const slow = timed(report, 276000);
  assert.strictEqual(slow.ok, false);
  assert.match(slow.line, /300\.0 s .*NOT under 5 minutes$/);
  assert.strictEqual(timed({ok: false, timings: report.timings}, 1).ok, false);
  assert.strictEqual(timed({ok: true, timings: {built: 1}}, 1).ok, false);
  assert.strictEqual(timed(report, -1).ok, false);
});

test('main: exit 0 when it holds, 1 when not, 2 on a usage or read error; the timing file written', () => {
  const dir = tmp('ch-cpc-');
  const f = (name, text) => { const p = path.join(dir, name); fs.writeFileSync(p, text); return p; };
  const io = () => { const o = {out: '', err: ''}; o.stdout = {write: (s) => { o.out += s; }}; o.stderr = {write: (s) => { o.err += s; }}; return o; };
  let o = io();
  assert.strictEqual(main(['listed', f('a.json', list(OURS)), ID], o), 0);
  assert.strictEqual(o.out, `${ID}: listed, enabled, with its countinghouse server (version 0.2.0)\n`);
  assert.strictEqual(main(['absent', f('b.json', list(OURS)), ID], io()), 1);
  assert.strictEqual(main(['absent', f('c.json', 'not json'), ID], io()), 2);
  assert.strictEqual(main(['listed', path.join(dir, 'none.json'), ID], io()), 2);
  assert.strictEqual(main(['other', f('d.json', '[]'), ID], io()), 2);
  assert.strictEqual(main(['listed', f('e.json', '[]')], io()), 2);
  const rep = f('r.json', JSON.stringify({ok: true, timings: {built: 1000, firstResult: 3000}}));
  assert.strictEqual(main(['timed', rep, '12x'], io()), 2);
  const out = path.join(dir, 'timing.json');
  o = io();
  assert.strictEqual(main(['timed', rep, '500', out], o), 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, 'utf8')), {pluginMs: 500, installToFirstResultMs: 2000, firstCommandToFirstResultMs: 2500, limitMs: 300000});
});
