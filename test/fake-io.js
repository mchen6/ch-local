'use strict';
// A fake io for the launcher's commands: captured output, scripted answers, a
// stubbed npm (exec) and no network (fetch throws unless a test gives one).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// On Windows the default home is under LOCALAPPDATA (lib/home.js defaultHome), never ~/.countinghouse: a fake io given neither
// LOCALAPPDATA nor COUNTINGHOUSE_HOME gets the LOCALAPPDATA its user folder would have (else this process's), as a session's
// environment has it; homeUnder(user) is the default home a fixture lays out for that user.
const WIN_HOME = process.platform === 'win32';
const homeUnder = (user) => (WIN_HOME ? path.join(user, 'AppData', 'Local', 'countinghouse') : path.join(user, '.countinghouse'));

// The node a fake io names: absolute on the platform under test, as a real
// one is (shim.json refuses a path that isn't, per platform: ch-local #31).
const FAKE_NODE = process.platform === 'win32' ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/local/bin/node';

function fakeIo({env = {}, answers = [], exec, fetch, version = 'v24.21.0', homedir} = {}) {
  if (WIN_HOME && env != null && env.LOCALAPPDATA === undefined && env.COUNTINGHOUSE_HOME === undefined) {
    env.LOCALAPPDATA = (typeof homedir === 'string') ? path.join(homedir, 'AppData', 'Local') : process.env.LOCALAPPDATA;
  }
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
    // the running ch-local's version (lib/packs.js recordRelease): not known
    // unless a test says, since a test home's app holds the npm stub's
    // ch-local, not this package
    selfVersion: null,
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
// with no home, or none installed: the shipped one, then), in the pins'
// version 2 (#413 section 9.3): each pack's modules, and each recorded
// module's description, its credential read from the store as the release
// step reads one (the first remote with a credential: its variable and its
// url's origin; fallbackEnv is never described).
function installedRelease(home) {
  if (typeof home !== 'string' || home === '') return null;
  const fs = require('node:fs');
  const path = require('node:path');
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(home, 'modules.json'), 'utf8')); } catch (e) { return null; }
  const {ALLOWLIST} = require('../lib/allowlist');
  const describe = (name, version) => {
    const none = {role: null, credentials: [], calls: [], confirmSettings: {}};
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(home, 'module-store', ...name.split('/'), version, 'package.json'), 'utf8')); } catch (e) { return none; }
    const remotes = m.countinghouse != null && Array.isArray(m.countinghouse.remotes) ? m.countinghouse.remotes : [];
    const r = remotes.find((x) => x != null && x.credential != null);
    if (r == null) return none;
    const variable = typeof r.credential === 'string' ? r.credential : r.credential.env;
    let origin = null;
    try { origin = new URL(r.url).origin; } catch (e) { origin = null; }
    return typeof variable === 'string' && origin != null ? {...none, credentials: [{variable, origin}]} : none;
  };
  // a test's own pins credentials, when it gave them (test/store-helpers.js
  // setPackCredentials: a pack's variables): the first on the pack's first
  // module, at GitHub's MCP origin; a pack given none has none
  let given = {};
  try { given = JSON.parse(fs.readFileSync(path.join(home, 'test-pack-credentials.json'), 'utf8')); } catch (e) { given = {}; }
  const packs = {};
  const modules = {};
  for (const [name, p] of Object.entries(record.packs || {})) {
    const list = Object.keys(p.modules || {});
    packs[name] = {modules: list};
    for (const m of list) modules[m] = describe(m, p.modules[m]);
    if (Array.isArray(given[name])) {
      for (const m of list) modules[m] = {...modules[m], credentials: []};
      if (given[name].length > 0 && list.length > 0) modules[list[0]] = {...modules[list[0]], credentials: [{variable: given[name][0], origin: 'https://api.githubcopilot.com'}]};
    }
  }
  // and it pins each recorded module at its version (a test home's are no
  // shipped release's: #413 section 5.2's version check)
  const pins = Object.fromEntries(Object.entries(record.modules || {}).map(([m, e]) => [m, {version: e.version}]));
  return {...ALLOWLIST, packs: {...ALLOWLIST.packs, ...packs}, modules: {...ALLOWLIST.modules, ...modules}, pins: {...ALLOWLIST.pins, ...pins}};
}

module.exports = {fakeIo, tmp, FAKE_NODE, installedRelease, homeUnder};
