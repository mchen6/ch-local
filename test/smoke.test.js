'use strict';
require('./tmp-dirs');
// (CI runs this file on its own: its ch-* temporary directories are
// removed at its end as npm test's are; test/tmp-dirs.js)
// The smoke test (reviewer, 2026-11-12): the profile end to end with the real
// runtime and no network call from it. A fixture pack with no remotes (one
// scenario, one step, one tool) and this launcher are packed, installed with
// --unreleased-pins into a temporary home, and started the way a client
// starts them (<home>/bin/ch-local.js start --stdio, in a repository whose
// origin is on GitHub). It then speaks MCP over stdio: initialize, tools/list
// (exactly, sorted: countinghouse_overview (countinghouse #490),
// countinghouse_settings (listed under --settingsFile since countinghouse
// #183), countinghouse_usage_report, the three for building your own module
// (countinghouse_load_module, countinghouse_validate_module and
// countinghouse_validate_plan, in the same profile since countinghouse #499)
// and the tool), and one tools/call,
// which answers through the step, with its own setting defaultRepo and a
// receipt of zero server calls.
//
// It needs a countinghouse tarball: CH_SMOKE_RUNTIME_TGZ=<path>. CI's smoke
// job packs countinghouse master and fails if the variable is missing;
// elsewhere the test is skipped and says why. Installing the runtime's own
// dependencies reaches the npm registry, as a user's install does.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUNTIME = process.env.CH_SMOKE_RUNTIME_TGZ;
// (the I/O and the MCP session over stdio, shared with the upgrade path's test)
const {realIo, session, releaseFor, installWith} = require('./upgrade-helpers');

test('the smoke test: a no-remote pack installed with --unreleased-pins, started through ch-local, answers over MCP with a receipt',
  {timeout: 900000, skip: RUNTIME == null && 'CH_SMOKE_RUNTIME_TGZ is not set (CI\'s smoke job sets it to a countinghouse tarball)'}, async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-smoke-'));
    const home = path.join(work, 'home');
    const io = realIo({...process.env, COUNTINGHOUSE_HOME: home, CH_LOCAL_DEV: '1'});
    let child = null;
    try {
      // The release directory -- this launcher, the runtime, the fixture
      // pack, and the runtime's lockfile, as a release builds them -- and
      // the install (test/upgrade-helpers.js, shared with the upgrade path's
      // test).
      const rel = await releaseFor(ROOT, io, work, RUNTIME);
      await installWith(ROOT, io, rel);

      // The scenario's own setting, set as a user does at a terminal (#413
      // rev 3: its defaultRepo is no device config any more), then a
      // client's start in a repository whose origin is elsewhere: the
      // setting is what the scenario reads.
      const set = spawnSync(process.execPath, [path.join(home, 'bin', 'ch-local.js'), 'settings', 'set', 'ch-pack-smoke.defaultRepo', 'octo/smoke'],
        {env: {...process.env, COUNTINGHOUSE_HOME: home, CH_LOCAL_DEV: '1'}, encoding: 'utf8', timeout: 60000});
      assert.strictEqual(set.status, 0, `${set.stdout}\n${set.stderr}`);
      const repo = path.join(work, 'repo');
      fs.mkdirSync(path.join(repo, '.git'), {recursive: true});
      fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:octo/elsewhere.git\n');
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
      assert.deepStrictEqual(listed.result.tools.map((t) => t.name).sort(), ['countinghouse_load_module', 'countinghouse_overview', 'countinghouse_settings', 'countinghouse_usage_report', 'countinghouse_validate_module', 'countinghouse_validate_plan', 'smoke_echo'],
        `the overview, the settings tool, the usage report, the three tools for building your own module (countinghouse #499: load_module only says to run add-module) and the pack's tool; no part or balance tool\n--- stderr ---\n${stderr.slice(-6000)}`);

      // Called the moment it is listed, as an agent does: the runtime waits for the
      // scenario's composition verdict (countinghouse composition/14), so no retry.
      const called = await mcp.request('tools/call', {name: 'smoke_echo', arguments: {text: 'hello'}});
      const result = called.result;
      assert.ok(result != null && result.isError === false, JSON.stringify(called).slice(0, 2000) + `\n--- stderr ---\n${stderr.slice(-4000)}`);
      const OUTPUT = {shout: 'HELLO', defaultRepo: 'octo/smoke'};
      assert.deepStrictEqual(result.structuredContent, OUTPUT, 'through the step, with its own setting defaultRepo');
      assert.strictEqual(result.content.length, 2);
      const text = JSON.stringify(OUTPUT);
      assert.deepStrictEqual(result._meta['countinghouse/receipt'], {calls: 0, linesIn: 0, bytesIn: 0, linesOut: 1, bytesOut: Buffer.byteLength(text), servers: []});
      assert.strictEqual(result.content[1].text, `no server was called; 1 line (${Buffer.byteLength(text)} B) reached the model.`);

      // The home's launcher acts on its own home from a terminal with no
      // COUNTINGHOUSE_HOME (the reviewer on ch-local#110, 2): a printed
      // `node "<home>/bin/ch-local.js" status` names this home's pack.
      const plain = {...process.env, HOME: work, USERPROFILE: work};
      delete plain.COUNTINGHOUSE_HOME;
      const status = spawnSync(process.execPath, [path.join(home, 'bin', 'ch-local.js'), 'status'], {env: plain, encoding: 'utf8', timeout: 60000});
      assert.match(`${status.stdout}${status.stderr}`, /smoke/, `status from a plain terminal:\n${status.stdout}\n${status.stderr}`);

      // The client closes its end; the runtime exits and start cleans up.
      child.stdin.end();
      const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 30000))]);
      assert.notStrictEqual(code, 'timeout', 'the runtime exits when the client closes stdin');
      child = null;
      assert.deepStrictEqual(fs.existsSync(path.join(home, 'run')) ? fs.readdirSync(path.join(home, 'run')) : [], [], 'the run directory is removed');
      assert.strictEqual(stderr.split('\n').filter((l) => /unreleased install/.test(l)).length, 1, 'start says once that the install is unreleased');
      assert.match(stderr, /loading ch-pack-smoke/);

      // A-own-skill: the user's own module, added in their own terminal
      // (B-own-add, ch-local#113) and then served by a start: listed beside
      // the pack's tool and callable, through the pack's step it calls.
      // add-module asks only at a terminal whose output is seen: a run
      // with no terminal is refused and adds nothing; on a pseudo-terminal
      // (test/pty-answer.py) the question is shown and answered y.
      const own = path.join(work, 'own-smoke');
      fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'smoke', 'own-smoke'), own, {recursive: true});
      const launcher = path.join(home, 'bin', 'ch-local.js');
      const noTerminal = spawnSync(process.execPath, [launcher, 'add-module', own], {env: plain, encoding: 'utf8', timeout: 60000});
      assert.strictEqual(noTerminal.status, 2, `${noTerminal.stdout}\n${noTerminal.stderr}`);
      assert.match(noTerminal.stderr, /add-module asks you, in your own terminal: run `node ".+ch-local\.js" add-module ".+own-smoke"` there\./);
      assert.ok(!fs.existsSync(path.join(home, 'own.json')), 'nothing added without a terminal');
      const added = spawnSync('python3', [path.join(ROOT, 'test', 'pty-answer.py'), 'y', 'Add it? [y/N]', process.execPath, launcher, 'add-module', own],
        {env: plain, encoding: 'utf8', timeout: 120000});
      assert.strictEqual(added.status, 0, `${added.stdout}\n${added.stderr}`);
      assert.match(added.stdout, /^Add your own module own-smoke 1\.0\.0 \(code [0-9a-f]{12}, 4 files\)\?\r?$/m, added.stdout);
      assert.match(added.stdout, /^It calls ch-step-smoke\.\r?$/m, added.stdout);
      const hash = /Added own-smoke \(own, ([0-9a-f]{12})\): your clients see it now\./.exec(added.stdout);
      assert.ok(hash != null, added.stdout);
      const ownStatus = spawnSync(process.execPath, [launcher, 'status'], {env: plain, encoding: 'utf8', timeout: 60000});
      assert.match(ownStatus.stdout, new RegExp(`own-smoke \\(own, unpinned, ${hash[1]}\\)\\s+on; tools: own_shout`), ownStatus.stdout);

      let stderr2 = '';
      child = spawn(process.execPath, [launcher, 'start', '--stdio'], {cwd: repo, env: {...process.env, COUNTINGHOUSE_HOME: home}, stdio: ['pipe', 'pipe', 'pipe']});
      child.stderr.on('data', (d) => { stderr2 += d; });
      const exited2 = new Promise((resolve) => child.on('exit', (c) => resolve(c)));
      const mcp2 = session(child);
      const init2 = await mcp2.request('initialize', {protocolVersion: '2026-07-28', capabilities: {}, clientInfo: {name: 'ch-local-smoke', version: '0'}}, 120000)
        .catch((err) => { throw new Error(`${err.message}\n--- stderr ---\n${stderr2.slice(-4000)}`); });
      assert.ok(init2.result != null, JSON.stringify(init2));
      mcp2.notify('notifications/initialized', {});
      let listed2 = null;
      for (const until = Date.now() + 60000; Date.now() < until;) {
        listed2 = await mcp2.request('tools/list', {});
        const names = (listed2.result.tools || []).map((x) => x.name);
        if (names.includes('own_shout') && names.includes('smoke_echo')) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      assert.deepStrictEqual(listed2.result.tools.map((t) => t.name).sort(),
        ['countinghouse_load_module', 'countinghouse_overview', 'countinghouse_settings', 'countinghouse_usage_report', 'countinghouse_validate_module', 'countinghouse_validate_plan', 'own_shout', 'smoke_echo'], `${JSON.stringify(listed2)}\n--- stderr ---\n${stderr2.slice(-4000)}`);
      const ownCalled = await mcp2.request('tools/call', {name: 'own_shout', arguments: {text: 'mine'}});
      assert.ok(ownCalled.result != null && ownCalled.result.isError === false, JSON.stringify(ownCalled).slice(0, 2000) + `\n--- stderr ---\n${stderr2.slice(-4000)}`);
      assert.deepStrictEqual(ownCalled.result.structuredContent, {mine: 'MINE'}, 'through the pack\'s step');
      child.stdin.end();
      const code2 = await Promise.race([exited2, new Promise((resolve) => setTimeout(() => resolve('timeout'), 30000))]);
      assert.notStrictEqual(code2, 'timeout', 'the runtime exits when the client closes stdin');
      child = null;
    } finally {
      if (child != null) child.kill('SIGKILL');
      fs.rmSync(work, {recursive: true, force: true});
    }
  });
