'use strict';
// One install with the real npm: this repository packed into a tarball, pinned,
// installed into a temporary home, and run through <home>/bin/ch-local.js the
// way a client runs it. ch-local has no dependencies, so npm needs no network.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {install, appManifest} = require('../lib/install');
const {npm} = require('../lib/npm');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

test('a real install of this launcher runs from <home>/bin/ch-local.js', {timeout: 120000}, async () => {
  const from = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-real-from-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-real-home-'));
  try {
    const io = {
      out: '', err: '', env: {COUNTINGHOUSE_HOME: home}, node: process.execPath, version: process.version, platform: process.platform, homedir: os.homedir,
      stdout: {write: (s) => { io.out += s; }}, stderr: {write: (s) => { io.err += s; }},
      exec: async (cmd, args, {cwd}) => spawnSync(cmd, args, {cwd, encoding: 'utf8'}),
      fetch: async () => { throw new Error('no network'); }
    };
    const packed = await npm(io, ['pack', '--json', '--pack-destination', from], ROOT);
    assert.strictEqual(packed.status, 0, packed.stderr);
    const file = JSON.parse(packed.stdout)[0].filename;
    const integrity = 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(path.join(from, file))).digest('base64');
    // The runtime is this launcher alone; the pack holds no package.
    const allow = {runtime: {packages: [pkg.name], lockfile: null}, packs: {solo: {packages: [], credentials: ['GITHUB_TOKEN']}}, pins: {[pkg.name]: {version: pkg.version, integrity}}};
    // What a release does: the runtime's lockfile, from the manifest install writes.
    const release = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-real-release-'));
    try {
      fs.mkdirSync(path.join(release, 'tarballs'));
      fs.copyFileSync(path.join(from, file), path.join(release, 'tarballs', file));
      fs.writeFileSync(path.join(release, 'package.json'), JSON.stringify(appManifest(allow.runtime, allow.pins)));
      const locked = await npm(io, ['install', '--package-lock-only', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund'], release);
      assert.strictEqual(locked.status, 0, locked.stderr);
      allow.runtime.lockfile = JSON.parse(fs.readFileSync(path.join(release, 'package-lock.json'), 'utf8'));
    } finally {
      fs.rmSync(release, {recursive: true, force: true});
    }
    assert.strictEqual(await install({pack: 'solo', from}, io, allow), 0, io.err);
    const r = spawnSync(process.execPath, [path.join(home, 'bin', 'ch-local.js'), 'snippet', 'codex'], {encoding: 'utf8', env: {...process.env, COUNTINGHOUSE_HOME: home}});
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /^\[mcp_servers\.countinghouse\]$/m);
    assert.ok(r.stdout.includes(JSON.stringify(path.join(home, 'bin', 'ch-local.js'))));
    assert.ok(fs.existsSync(path.join(home, 'app', 'package-lock.json')));
  } finally {
    fs.rmSync(from, {recursive: true, force: true});
    fs.rmSync(home, {recursive: true, force: true});
  }
});
