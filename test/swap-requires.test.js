'use strict';
require('./tmp-dirs');
// Code running from <home>/app while that tree is replaced never loads the
// other release's file (lib/swap-preload.js): before each swap -- install's,
// rollback's, an interrupted rollback's finish -- and at the daemon's start,
// preloadForSwap() loads this release's whole lib and every JSON file lib
// requires, so any later require, however lazy or deep, is this release's
// copy. Pinned here: it loads them all (in a fresh process), the JSON list
// covers every JSON file lib names, and the call comes before each swap.
// The class C-upgrade-path's test found (rollback calling the older
// release's upgrade.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {JSON_FILES} = require('../lib/swap-preload');

const LIB = path.join(__dirname, '..', 'lib');
// (a file's source without its comments: a comment never stands in for a call)
const code = (file) => fs.readFileSync(path.join(LIB, `${file}.js`), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('preloadForSwap loads every module of lib and every JSON file lib requires, and nothing more happens (a fresh process)', () => {
  // (loaded in a process that never loaded them -- an install, a rollback,
  // the daemon -- each module's top level runs: none may add a listener, a
  // timer or other handle, change the environment or add a global)
  const script = `
    const EVENTS = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection', 'warning', 'beforeExit'];
    const state = () => ({resources: process.getActiveResourcesInfo().slice().sort(), listeners: EVENTS.map((e) => process.listenerCount(e)),
      env: JSON.stringify(process.env), globals: Object.getOwnPropertyNames(globalThis).sort()});
    const before = state();
    require(${JSON.stringify(path.join(LIB, 'swap-preload.js'))}).preloadForSwap();
    // (read before process.stdout is touched: its first use opens a pipe)
    const after = state();
    process.stdout.write(JSON.stringify({loaded: Object.keys(require.cache), before, after}));
  `;
  const r = spawnSync(process.execPath, ['-e', script], {encoding: 'utf8', timeout: 60000});
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual(out.after, out.before, 'the preload leaves no listener, timer, handle, environment change or global');
  const loaded = new Set(out.loaded);
  const modules = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).map((f) => path.join(LIB, f));
  assert.deepStrictEqual(modules.filter((m) => !loaded.has(m)), [], 'every lib module loaded');
  for (const j of JSON_FILES) assert.ok(loaded.has(path.resolve(LIB, j)), `${j} loaded`);
});

test('the JSON list names every JSON file a lib module requires', () => {
  const named = new Set();
  for (const f of fs.readdirSync(LIB).filter((n) => n.endsWith('.js'))) {
    for (const m of fs.readFileSync(path.join(LIB, f), 'utf8').matchAll(/require\(['"`]((?:\.\.?\/)[^'"`]+\.json)['"`]\)/g)) named.add(m[1]);
  }
  assert.deepStrictEqual([...named].filter((j) => !JSON_FILES.includes(j)).sort(), [], 'add it to JSON_FILES in lib/swap-preload.js');
});

test('the preload comes before each swap: install\'s, rollback\'s, an interrupted rollback\'s, and before the daemon runs', () => {
  const before = (file, scope, swapText) => {
    const src = code(file);
    const from = scope == null ? 0 : src.indexOf(scope);
    assert.ok(from !== -1, `${file}: ${scope}`);
    const call = src.indexOf('preloadForSwap()', from);
    const swap = src.indexOf(swapText, from);
    assert.ok(call !== -1 && swap !== -1 && call < swap, `${file}${scope != null ? ` (${scope})` : ''}: preloadForSwap() before ${swapText}`);
  };
  before('install', null, 'fs.renameSync(build, where.app)');
  before('rollback', 'function finish(', 'fs.renameSync(');
  before('rollback', 'async function rollback(', 'const moved = swap(');
  before('daemon', 'async function daemon(', '.then(() => run(');
});
