'use strict';
// The smoke test (reviewer, 2026-11-12): the profile end to end with the real
// runtime and no network call from it. A fixture pack with no remotes (one
// scenario, one step, one tool) and this launcher are packed, installed with
// --unreleased-pins into a temporary home, and started the way a client
// starts them (<home>/bin/ch-local.js start --stdio, in a repository whose
// origin is on GitHub). It then speaks MCP over stdio: initialize, tools/list
// (exactly the tool and countinghouse_usage_report), and one tools/call,
// which answers through the step, with the launcher's defaultRepo and a
// receipt of zero server calls.
//
// It needs a countinghouse tarball: CH_SMOKE_RUNTIME_TGZ=<path>. CI's smoke
// job packs countinghouse master and fails if the variable is missing;
// elsewhere the test is skipped and says why. Installing the runtime's own
// dependencies reaches the npm registry, as a user's install does.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const {install, appManifest, tarballName} = require('../lib/install');
const {npm} = require('../lib/npm');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'smoke');
const RUNTIME = process.env.CH_SMOKE_RUNTIME_TGZ;
const SCENARIO = '@countinghouse/ch-pack-smoke';
const STEP = '@countinghouse/ch-step-smoke';
const integrityOf = (file) => 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
const realIo = (env) => {
  const io = {
    out: '', err: '', env, node: process.execPath, version: process.version, platform: process.platform, homedir: os.homedir,
    stdout: {write: (s) => { io.out += s; }}, stderr: {write: (s) => { io.err += s; }},
    exec: async (cmd, args, {cwd}) => spawnSync(cmd, args, {cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024}),
    fetch: async () => { throw new Error('no network from the launcher in this test'); }
  };
  return io;
};

// One MCP session over the child's stdio: newline-delimited JSON-RPC.
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

test('the smoke test: a no-remote pack installed with --unreleased-pins, started through ch-local, answers over MCP with a receipt',
  {timeout: 900000, skip: RUNTIME == null && 'CH_SMOKE_RUNTIME_TGZ is not set (CI\'s smoke job sets it to a countinghouse tarball)'}, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-smoke-'));
    const from = path.join(work, 'release');
    const home = path.join(work, 'home');
    fs.mkdirSync(from);
    const io = realIo({...process.env, COUNTINGHOUSE_HOME: home, CH_LOCAL_DEV: '1'});
    let child = null;
    try {
      // The release directory: this launcher, the runtime, and the fixture pack.
      const pins = {};
      for (const dir of [ROOT, path.join(FIXTURES, 'ch-pack-smoke'), path.join(FIXTURES, 'ch-step-smoke')]) {
        const packed = await npm(io, ['pack', '--json', '--pack-destination', from], dir);
        assert.strictEqual(packed.status, 0, packed.stderr);
        const {name, version, filename} = JSON.parse(packed.stdout)[0];
        pins[name] = {version, integrity: integrityOf(path.join(from, filename))};
      }
      const m = /^countinghouse-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.tgz$/.exec(path.basename(RUNTIME));
      assert.ok(m != null, `CH_SMOKE_RUNTIME_TGZ must be npm pack's countinghouse-<version>.tgz, not ${path.basename(RUNTIME)}`);
      fs.copyFileSync(RUNTIME, path.join(from, tarballName('countinghouse', m[1])));
      pins.countinghouse = {version: m[1], integrity: integrityOf(RUNTIME)};

      // What a release does: the runtime's lockfile, from the manifest install writes.
      const runtime = {packages: ['@countinghouse/ch-local', 'countinghouse'], lockfile: null};
      const lockDir = path.join(work, 'lock');
      fs.mkdirSync(path.join(lockDir, 'tarballs'), {recursive: true});
      for (const name of runtime.packages) fs.copyFileSync(path.join(from, tarballName(name, pins[name].version)), path.join(lockDir, 'tarballs', tarballName(name, pins[name].version)));
      fs.writeFileSync(path.join(lockDir, 'package.json'), JSON.stringify(appManifest(runtime, pins)));
      const locked = await npm(io, ['install', '--package-lock-only', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], lockDir);
      assert.strictEqual(locked.status, 0, locked.stderr);
      const pinsFile = path.join(work, 'pins.json');
      fs.writeFileSync(pinsFile, JSON.stringify({pins, runtimeLockfile: JSON.parse(fs.readFileSync(path.join(lockDir, 'package-lock.json'), 'utf8'))}));

      const allow = {runtime, packs: {smoke: {packages: [SCENARIO, STEP], credentials: []}}, pins: {}};
      assert.strictEqual(await install({pack: 'smoke', from, unreleasedPins: pinsFile}, io, allow), 0, io.err);

      // A client's start, in a repository whose origin is on GitHub.
      const repo = path.join(work, 'repo');
      fs.mkdirSync(path.join(repo, '.git'), {recursive: true});
      fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:octo/smoke.git\n');
      let stderr = '';
      child = spawn(process.execPath, [path.join(home, 'bin', 'ch-local.js'), 'start', '--stdio'], {cwd: repo, env: {...process.env, COUNTINGHOUSE_HOME: home}, stdio: ['pipe', 'pipe', 'pipe']});
      child.stderr.on('data', (d) => { stderr += d; });
      const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
      const mcp = session(child);
      const init = await mcp.request('initialize', {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'ch-local-smoke', version: '0'}}, 120000)
        .catch((err) => { throw new Error(`${err.message}\n--- stderr ---\n${stderr.slice(-4000)}`); });
      assert.ok(init.result != null, JSON.stringify(init));
      mcp.notify('notifications/initialized', {});

      // The module may still be loading (the runtime serves MCP first): list until it is there, as
      // countinghouse's own test/usage/12 does, then hold the list to exactly the expected tools.
      let listed = null;
      for (const until = Date.now() + 60000; Date.now() < until;) {
        listed = await mcp.request('tools/list', {});
        if ((listed.result.tools || []).some((x) => x.name === 'smoke_echo')) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.deepStrictEqual(listed.result.tools.map((t) => t.name).sort(), ['countinghouse_usage_report', 'smoke_echo'], `the pack's tool and the usage report; no part, balance or authoring tool\n--- stderr ---\n${stderr.slice(-6000)}`);

      // Called the moment it is listed, as an agent does: the runtime waits for the
      // scenario's composition verdict (countinghouse composition/14), so no retry.
      const called = await mcp.request('tools/call', {name: 'smoke_echo', arguments: {text: 'hello'}});
      const result = called.result;
      assert.ok(result != null && result.isError === false, JSON.stringify(called).slice(0, 2000) + `\n--- stderr ---\n${stderr.slice(-4000)}`);
      const OUTPUT = {shout: 'HELLO', defaultRepo: 'octo/smoke'};
      assert.deepStrictEqual(result.structuredContent, OUTPUT, 'through the step, with the launcher\'s defaultRepo');
      assert.strictEqual(result.content.length, 2);
      const text = JSON.stringify(OUTPUT);
      assert.deepStrictEqual(result._meta['countinghouse/receipt'], {calls: 0, linesIn: 0, bytesIn: 0, linesOut: 1, bytesOut: Buffer.byteLength(text), servers: []});
      assert.strictEqual(result.content[1].text, `no server was called; 1 line (${Buffer.byteLength(text)} B) reached the model.`);

      // The client closes its end; the runtime exits and start cleans up.
      child.stdin.end();
      const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 30000))]);
      assert.notStrictEqual(code, 'timeout', 'the runtime exits when the client closes stdin');
      child = null;
      assert.deepStrictEqual(fs.existsSync(path.join(home, 'run')) ? fs.readdirSync(path.join(home, 'run')) : [], [], 'the run directory is removed');
      assert.strictEqual(stderr.split('\n').filter((l) => /unreleased install/.test(l)).length, 1, 'start says once that the install is unreleased');
      assert.match(stderr, /loading smoke/);
    } finally {
      if (child != null) child.kill('SIGKILL');
      fs.rmSync(work, {recursive: true, force: true});
    }
  });
