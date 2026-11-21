'use strict';
// C-upgrade-path's helpers: a ch-local tree at a git commit (or the working
// tree), a release directory for it (its launcher, the smoke fixture pack,
// the runtime), a home built with that tree's own code, and the home's data
// files as a tree's own readers read them. Used by the upgrade-path test
// (tier 1) and scripts/capture-home.js, which captures a home's data files
// for the older-format readers' test (tier 2, test/home-formats.test.js).
//
// Each tree's code is required from its own directory, so an older ch-local
// writes the home exactly as it did: never this tree's code standing in.
// They call each tree's own functions (release, install, the credential
// store, the readers) by today's names and arguments: a later change to one
// of those keeps the older trees' call here, beside the newer one -- an
// adapter per release -- never a FROM commit dropped.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCENARIO = '@countinghouse/ch-pack-smoke';
const STEP = '@countinghouse/ch-step-smoke';
// (a plainly fake key, bound to a placeholder origin: the format is what is
// tested, never a call)
const CREDENTIAL = {module: STEP, variable: 'SMOKE_TOKEN', origin: 'https://api.smoke.invalid', value: 'fake-smoke-credential-0001'};
const SETTING = {name: 'ch-pack-smoke.defaultRepo', value: 'octo/smoke'};

const integrityOf = (file) => 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts});
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${String(r.stderr || r.stdout || r.error).slice(-4000)}`);
  return r.stdout;
}

const realIo = (env) => {
  const io = {
    out: '', err: '', env, node: process.execPath, version: process.version, platform: process.platform, homedir: os.homedir,
    alive: require('../lib/run-liveness').processAlive, hostname: os.hostname(),
    stdout: {write: (s) => { io.out += s; }}, stderr: {write: (s) => { io.err += s; }},
    exec: async (cmd, args, {cwd}) => spawnSync(cmd, args, {cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}),
    fetch: async () => { throw new Error('no network from the launcher in this test'); }
  };
  return io;
};

// Every commit is 0.1.0, and install keeps a rollback target only between
// two different releases: each tree is given a version of its own.
function setVersion(dir, version) {
  const file = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
}

// A tree at a commit, its dependencies installed as a release build installs
// them (npm ci --ignore-scripts, as CI's smoke job does).
// The commit in this clone: a shallow clone (CI's checkout) holds no older
// commit, and fetches it at depth 1 from origin by its full name; a full
// clone that lacks it is never made shallow -- it says to fetch. Either
// failing fails the caller, never skips it.
function commitHere(commit) {
  if (spawnSync('git', ['-C', ROOT, 'cat-file', '-e', `${commit}^{commit}`]).status === 0) return;
  const shallow = run('git', ['-C', ROOT, 'rev-parse', '--is-shallow-repository']).trim() === 'true';
  if (!shallow || !/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${commit} is not in this clone: run \`git fetch origin\` (or name a full commit in a shallow one)`);
  run('git', ['-C', ROOT, 'fetch', '--quiet', '--depth=1', 'origin', commit], {timeout: 300000});
}

function treeAt(commit, dir, version) {
  fs.mkdirSync(dir, {recursive: true});
  commitHere(commit);
  const tar = spawnSync('git', ['-C', ROOT, 'archive', '--format=tar', commit], {maxBuffer: 256 * 1024 * 1024});
  if (tar.status !== 0) throw new Error(`git archive ${commit}: ${String(tar.stderr)}`);
  const x = spawnSync('tar', ['-x', '-C', dir], {input: tar.stdout});
  if (x.status !== 0) throw new Error(`tar -x: ${String(x.stderr)}`);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {cwd: dir});
  setVersion(dir, version);
  return dir;
}

// The working tree as it is now (tracked and new files), with this tree's
// installed dependencies.
function workingTree(dir, version) {
  fs.mkdirSync(dir, {recursive: true});
  const files = run('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter((f) => f !== '');
  for (const f of files) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) continue;   // a deleted, not yet committed file
    fs.mkdirSync(path.dirname(path.join(dir, f)), {recursive: true});
    fs.copyFileSync(src, path.join(dir, f));
  }
  fs.cpSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), {recursive: true, verbatimSymlinks: true});
  setVersion(dir, version);
  return dir;
}

const lib = (code, name) => require(path.join(code, 'lib', name));

// A release directory for a tree, as smoke.test builds one, by that tree's own
// release code: its launcher, the fixture pack, the runtime tarball; and the
// allow install takes, naming the release (rollback needs it).
async function releaseFor(code, io, work, runtimeTgz) {
  const from = path.join(work, 'release');
  fs.mkdirSync(from, {recursive: true});
  const {packInto, runtimeLockfile} = lib(code, 'release');
  const {tarballName} = lib(code, 'install');
  const fixtures = path.join(code, 'test', 'fixtures', 'smoke');
  const pins = {};
  for (const dir of [code, path.join(fixtures, 'ch-pack-smoke'), path.join(fixtures, 'ch-step-smoke')]) {
    const {name, version, integrity} = await packInto(io, dir, from);
    pins[name] = {version, integrity};
  }
  const m = /^countinghouse-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(path.basename(runtimeTgz));
  if (m == null) throw new Error(`the runtime must be npm pack's countinghouse-<version>.tgz, not ${path.basename(runtimeTgz)}`);
  fs.copyFileSync(runtimeTgz, path.join(from, tarballName('countinghouse', m[1])));
  pins.countinghouse = {version: m[1], integrity: integrityOf(runtimeTgz)};
  const runtime = {packages: ['@countinghouse/ch-local', 'countinghouse'], lockfile: null};
  const version = JSON.parse(fs.readFileSync(path.join(code, 'package.json'), 'utf8')).version;
  const allow = {release: {version, security: null}, runtime, packs: {smoke: {modules: [SCENARIO, STEP]}}, modules: {}, pins: {}};
  const modules = require(path.join(code, 'scripts', 'describe-release')).describePinned(allow, pins, from);
  const pinsFile = path.join(work, 'pins.json');
  fs.writeFileSync(pinsFile, JSON.stringify({pins, runtimeLockfile: await runtimeLockfile(io, from, runtime, pins, path.join(work, 'lock')), modules}));
  return {from, pinsFile, allow, version};
}

// Install the release into the home with the tree's own install.
async function installWith(code, io, rel) {
  const status = await lib(code, 'install').install({pack: 'smoke', from: rel.from, unreleasedPins: rel.pinsFile}, io, rel.allow);
  if (status !== 0) throw new Error(`install by ${code} failed (${status}): ${io.err.slice(-4000)}`);
}

// A home's user data, written with the tree's own code: the scenario's
// setting, set as a user does (the installed launcher, the tree's own), and
// a stored credential for the step, by the tree's own store.
async function userDataWith(code, io, home) {
  run(process.execPath, [path.join(home, 'bin', 'ch-local.js'), 'settings', 'set', SETTING.name, SETTING.value], {env: io.env, timeout: 60000});
  // (the home this user's alone, as the store requires: a test's temporary
  // directory may be made group-writable by the umask)
  fs.chmodSync(home, 0o700);
  const store = lib(code, 'credential-store');
  await store.withStoreLock(home, io, 'the upgrade-path test', (held) => store.bind(home, CREDENTIAL.module, CREDENTIAL.variable,
    {origin: CREDENTIAL.origin, source: 'stored', value: CREDENTIAL.value}, {held}));
}

// The user's own module (B-own-add), added by a tree's own add-module: the
// folder written, the sandbox set to enforce (an own module loads only
// there), and add-module run in-process, as the user's own act at their
// terminal -- an io that is interactive, its output a terminal, answering
// yes. The question itself is the acceptance and smoke tests' (through a
// pty); here what matters is that the record and the copy survive. -> the
// module's tree hash.
const OWN = {name: 'upgrade-own-probe', tool: 'own_probe', output: {own: 'here'}};
function writeOwnModule(dir) {
  fs.mkdirSync(path.join(dir, 'handlers', 'probeService'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: OWN.name, version: '1.0.0', private: true, countinghouse: {role: 'scenario', calls: []}}, null, 2));
  fs.writeFileSync(path.join(dir, 'api.json'), JSON.stringify({device: {friendlyName: OWN.name, manufacturer: 'ch-local-test', modelDescription: 'the upgrade-path test\'s own module',
    serviceList: {'urn:ch-local-test:serviceID:probeService': {actionList: [{name: OWN.tool, description: 'Says it is here.',
      input: {schema: `/probeService/${OWN.tool}/input`}, output: {schema: `/probeService/${OWN.tool}/output`}}]}}}}, null, 2));
  fs.writeFileSync(path.join(dir, 'schema.json'), JSON.stringify({$schema: 'https://json-schema.org/draft/2020-12/schema', $id: '#/', type: 'object',
    probeService: {[OWN.tool]: {input: {type: 'object', additionalProperties: false},
      output: {type: 'object', properties: {own: {type: 'string'}}, required: ['own'], additionalProperties: false}}}}, null, 2));
  fs.writeFileSync(path.join(dir, 'handlers', 'probeService', `${OWN.tool}.js`), `'use strict';\nmodule.exports = async () => ({output: ${JSON.stringify(OWN.output)}});\n`);
}
const hasOwnModules = (code) => fs.existsSync(path.join(code, 'lib', 'own-command.js'));
async function ownWith(code, io, home, work) {
  run(process.execPath, [path.join(home, 'bin', 'ch-local.js'), 'settings', 'set', 'moduleSandbox', 'enforce'], {env: io.env, timeout: 60000});
  const dir = path.join(work, 'own-src');
  writeOwnModule(dir);
  const asked = [];
  const tty = Object.assign(io, {interactive: true, stdoutTTY: true, ask: async (q) => { asked.push(q); return 'y'; }});
  const code0 = await lib(code, 'own-command').addModule({dir}, tty);
  if (code0 !== 0 || asked.length !== 1) throw new Error(`add-module: ${code0}, asked ${asked.length}\n${io.out}\n${io.err}`);
  return JSON.parse(fs.readFileSync(path.join(home, 'own.json'), 'utf8')).modules[OWN.name].tree;
}
// <home>/own.json and everything under <home>/own: the record and the
// copies, byte for byte, with their modes. <home>/own itself is not data:
// every start of a tree with own modules makes it, the modules root, for
// one added while it runs (lib/start.js), so an older release's home has it
// once this tree has started there.
function ownFiles(home) {
  const out = {};
  const add = (rel) => {
    const p = path.join(home, rel);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) { out[`${rel}/`] = {mode: st.mode & 0o777}; for (const n of fs.readdirSync(p).sort()) add(path.join(rel, n)); }
    else out[rel] = {bytes: fs.readFileSync(p).toString('base64'), mode: st.mode & 0o777};
  };
  if (fs.existsSync(path.join(home, 'own.json'))) add('own.json');
  if (fs.existsSync(path.join(home, 'own'))) add('own');
  delete out['own/'];
  return out;
}

// A test's tree removed, with the read-only folders under `readOnly` (an
// own module's copies, <home>/own) made writable by their owner first --
// only those, never following a link. A failure here is said, never thrown
// over the test's own.
function removeTree(dir, readOnly = []) {
  const open = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (!st.isDirectory()) return;
    try { fs.chmodSync(p, st.mode | 0o700); } catch (e) { /* as it is */ }
    let names = [];
    try { names = fs.readdirSync(p); } catch (e) { /* as it is */ }
    for (const n of names) open(path.join(p, n));
  };
  try {
    for (const r of readOnly) open(r);
    fs.rmSync(dir, {recursive: true, force: true});
  } catch (err) {
    process.stderr.write(`(the upgrade-path test's work tree ${dir} could not be removed: ${err.message})\n`);
  }
}

// The home's data as a tree's own readers read it: what must survive.
function summaryWith(code, env) {
  const where = lib(code, 'home').layout(env);
  const home = lib(code, 'home').home(env);
  const record = lib(code, 'module-record').readModulesRecord(where);
  const settings = lib(code, 'settings').readSettings(where);
  const creds = lib(code, 'credential-store').readStore(home);
  // (each module the record names, its version, and its store entry's
  // marker as the store reads it)
  const store = lib(code, 'module-store');
  const modules = {};
  for (const [name, entry] of Object.entries(record.modules || {})) {
    const version = entry != null && typeof entry === 'object' ? entry.version : entry;
    const marker = store.readMarker(where, name, version);
    modules[name] = {version, role: entry != null && typeof entry === 'object' ? entry.role : null,
      marker: marker == null ? null : {name: marker.name, version: marker.version, integrity: marker.integrity}};
  }
  // (Maps as plain objects, keys in order: comparable as JSON)
  const plain = (v) => {
    if (v instanceof Map) return Object.fromEntries([...v.keys()].sort().map((k) => [k, plain(v.get(k))]));
    if (Array.isArray(v)) return v.map(plain);
    if (v != null && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, plain(v[k])]));
    return v;
  };
  // (a reader's error names the file by its path: the home's own, as <home>)
  const homeless = (v) => (typeof v === 'string' ? v.split(home).join('<home>') : v);
  return plain({
    // (each pack's modules at their versions; the record's runtime versions
    // name the installed ch-local itself, which an upgrade changes by design)
    packs: Object.fromEntries(Object.keys(record.packs || {}).sort().map((p) => [p, {modules: record.packs[p].modules || {}}])),
    modules,
    // (a reader that refuses or doubts an older file says so: never the same)
    settings: {values: settings.values, kept: settings.kept, error: homeless(settings.error) || null, warning: homeless(settings.warning) || null, unreadable: settings.unreadable === true},
    credentials: creds
  });
}

// The data files of a home, the ones that must survive an upgrade and a
// rollback byte for byte (path -> {bytes, mode}); the record and the program
// files change with each, by design.
// (each when present: a client's entries, the upgrade check's record, and
// the runtime's own -- its identity secret, its auth -- which no install
// or rollback may touch)
const DATA_FILES = ['settings.json', path.join('credentials', 'credentials.json'), 'installed-clients.json', 'upgrade-check.json',
  path.join('store', '.identity-secret'), 'auth.json'];
function dataFiles(home) {
  const out = {};
  for (const f of DATA_FILES) {
    const p = path.join(home, f);
    if (!fs.existsSync(p)) continue;
    out[f] = {bytes: fs.readFileSync(p).toString('base64'), mode: fs.statSync(p).mode & 0o777};
  }
  return out;
}

// One MCP session over a child's stdio: newline-delimited JSON-RPC (the
// smoke test's, shared).
function session(child) {
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) !== -1;) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line === '') continue;
      let msg;
      try { msg = JSON.parse(line); } catch (err) { continue; }
      if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  let id = 0;
  return {
    request: (method, params, ms = 60000) => new Promise((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error(`no answer to ${method} in ${ms} ms`)), ms);
      waiting.set(n, (msg) => { clearTimeout(timer); resolve(msg); });
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: n, method, params}) + '\n');
    }),
    notify: (method, params) => child.stdin.write(JSON.stringify({jsonrpc: '2.0', method, params}) + '\n')
  };
}

// The home started as a client starts it (<home>/bin/ch-local.js start
// --stdio, in a repository whose origin is elsewhere), the pack's tool
// called once: -> {tools, output, stderr}. The client then closes its end
// and the runtime must exit.
async function startAndCall(home, work, env = process.env, {alsoCall = null} = {}) {
  const {spawn} = require('node:child_process');
  const repo = fs.mkdtempSync(path.join(work, 'repo-'));
  fs.mkdirSync(path.join(repo, '.git'), {recursive: true});
  fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:octo/elsewhere.git\n');
  let stderr = '';
  // (its own process group: on a failure the runtime it started goes with it)
  const child = spawn(process.execPath, [path.join(home, 'bin', 'ch-local.js'), 'start', '--stdio'], {cwd: repo, env: {...env, COUNTINGHOUSE_HOME: home}, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32'});
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const tail = () => `\n--- stderr ---\n${stderr.slice(-4000)}`;
  try {
    const mcp = session(child);
    const init = await mcp.request('initialize', {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'ch-local-upgrade-path', version: '0'}}, 120000)
      .catch((err) => { throw new Error(err.message + tail()); });
    if (init.result == null) throw new Error(JSON.stringify(init) + tail());
    mcp.notify('notifications/initialized', {});
    let listed = null;
    for (const until = Date.now() + 60000; Date.now() < until;) {
      listed = await mcp.request('tools/list', {});
      // (every tool this start should answer with listed: the pack's, and the
      // own module's when one is called -- they load as separate units)
      const names = (listed.result.tools || []).map((x) => x.name);
      if (names.includes('smoke_echo') && (alsoCall == null || names.includes(alsoCall))) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const tools = (listed.result.tools || []).map((t) => t.name).sort();
    const called = await mcp.request('tools/call', {name: 'smoke_echo', arguments: {text: 'hello'}});
    if (called.result == null || called.result.isError !== false) throw new Error(JSON.stringify(called).slice(0, 2000) + tail());
    // (and another tool, an own module's: its output)
    let also = null;
    if (alsoCall != null) {
      const r = await mcp.request('tools/call', {name: alsoCall, arguments: {}});
      if (r.result == null || r.result.isError !== false) throw new Error(JSON.stringify(r).slice(0, 2000) + tail());
      also = r.result.structuredContent;
    }
    child.stdin.end();
    const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 30000))]);
    if (code === 'timeout') throw new Error('the runtime did not exit when the client closed stdin' + tail());
    const runs = fs.existsSync(path.join(home, 'run')) ? fs.readdirSync(path.join(home, 'run')) : [];
    if (runs.length > 0) throw new Error(`the run directory is left: ${runs.join(', ')}` + tail());
    return {tools, output: called.result.structuredContent, also, stderr};
  } finally {
    // (the whole group, its leader gone or not: the runtime it started too.
    // A Ctrl-C to the test runner does not reach it: a known limit)
    if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { /* none left */ } }
    else if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  }
}

// The ch-local a home runs (its launcher's version)
const launcherVersion = (home) => JSON.parse(fs.readFileSync(path.join(home, 'app', 'node_modules', '@countinghouse', 'ch-local', 'package.json'), 'utf8')).version;

module.exports = {removeTree, OWN, writeOwnModule, hasOwnModules, ownWith, ownFiles, commitHere, session, startAndCall, launcherVersion, ROOT, SCENARIO, STEP, CREDENTIAL, SETTING, run, realIo, setVersion, treeAt, workingTree, releaseFor, installWith, userDataWith, summaryWith, dataFiles, DATA_FILES};
