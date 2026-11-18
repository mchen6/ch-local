'use strict';
// A fake io for the launcher's commands: captured output, scripted answers, a
// stubbed npm (exec) and no network (fetch throws unless a test gives one).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The node a fake io names: absolute on the platform under test, as a real
// one is (shim.json refuses a path that isn't, per platform: ch-local #31).
const FAKE_NODE = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/local/bin/node';

function fakeIo({env = {}, answers = [], exec, fetch, version = 'v24.21.0', homedir} = {}) {
  const io = {
    out: '',
    err: '',
    asked: [],
    execs: [],
    fetches: [],
    env,
    node: FAKE_NODE,
    version,
    platform: process.platform,
    homedir: () => homedir,
    // no start of a test is alive unless a test says so (collection needs
    // the answer: lib/gc.js)
    alive: () => false,
    stdout: {write: (s) => { io.out += s; }},
    stderr: {write: (s) => { io.err += s; }},
    ask: async (q) => { io.asked.push(q); return answers.length > 0 ? answers.shift() : ''; },
    exec: async (cmd, args, opts) => {
      io.execs.push({cmd, args, cwd: opts && opts.cwd});
      return exec != null ? exec(cmd, args, opts) : {status: 0, stdout: '', stderr: ''};
    },
    fetch: async (url, opts) => {
      io.fetches.push(url);
      if (fetch == null) throw new Error(`no network in tests: ${url}`);
      return fetch(url, opts);
    }
  };
  // The running release's allowlist (lib/packs.js withdrawnPacks): a test
  // home's packs are no shipped release's, so by default the release lists
  // every pack the home holds, read when asked (a pack added while start
  // runs is listed too). A test of a withdrawn pack sets its own.
  let release;
  Object.defineProperty(io, 'release', {enumerable: true, configurable: true,
    get: () => (release !== undefined ? release : installedRelease(env.COUNTINGHOUSE_HOME)),
    set: (v) => { release = v; }});
  return io;
}

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// The shipped allowlist, its packs those the home's record lists (null
// with no home, or none installed: the shipped one, then).
function installedRelease(home) {
  if (typeof home !== 'string' || home === '') return null;
  let record;
  try { record = JSON.parse(require('node:fs').readFileSync(require('node:path').join(home, 'packs.json'), 'utf8')); } catch (e) { return null; }
  const {ALLOWLIST} = require('../lib/allowlist');
  const packs = {};
  for (const [name, p] of Object.entries(record.packs || {})) packs[name] = {packages: Object.keys(p.packages || {}), credentials: Array.isArray(p.credentials) ? p.credentials : []};
  return {...ALLOWLIST, packs: {...ALLOWLIST.packs, ...packs}};
}

module.exports = {fakeIo, tmp, FAKE_NODE, installedRelease};
