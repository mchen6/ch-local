'use strict';
require('./tmp-dirs');
// The upgrade path (C-upgrade-path, tier 1): a home built by an older
// ch-local -- its own code, at a fixed commit -- upgraded to this tree,
// started, and rolled back.
//
// For each commit in FROM: that tree is checked out and given a version of
// its own (every commit is 0.1.0, and install keeps a rollback target only
// between two releases); with its own code it installs the smoke fixture
// pack with the real runtime, a user sets the scenario's setting, and a
// credential is stored. The home is started once. Then this tree -- the
// working tree, under a version of its own -- installs over it, through
// install(), which is what `ch-local upgrade` runs once npm and provenance
// have said yes (those are test/upgrade.test.js's; the running daemon's
// handoff is test/daemon-upgrade.test.js's). It must keep every data file
// byte for byte, read the home as the older release read it, and start: the
// pack's tool answers with the setting the older release stored. Then
// `ch-local rollback --yes`: the older launcher is current again, the data
// files are as they were, and it starts.
//
// The older formats themselves, on every run and offline, are
// test/home-formats.test.js's. This test needs a countinghouse tarball
// (CH_SMOKE_RUNTIME_TGZ, as the smoke test) and the npm registry for the
// runtime's dependencies; without the tarball it is skipped and says why.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('./upgrade-helpers');

// The releases a home is upgraded from: for now main at the commit this
// test was written against; release 1's own commit joins it once it exists
// (release gating, CONTRIBUTING.md).
const FROM = ['63d7faf6a162b23a1813c2af3b12659f81e031ec'];
const RUNTIME = process.env.CH_SMOKE_RUNTIME_TGZ;
const OUTPUT = {shout: 'HELLO', defaultRepo: 'octo/smoke'};
const TOOLS = ['countinghouse_overview', 'countinghouse_settings', 'countinghouse_usage_report', 'smoke_echo'];

for (const commit of FROM) {
  test(`a home built by ${commit.slice(0, 8)}, upgraded to this tree: every data file kept, read and started; rolled back, as it was`,
    {timeout: 1800000, skip: RUNTIME == null && 'CH_SMOKE_RUNTIME_TGZ is not set (a countinghouse tarball, as for the smoke test)'}, async () => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-upgrade-path-'));
      try {
        const short = commit.slice(0, 8);
        const old = h.treeAt(commit, path.join(work, 'old'), `0.1.0-from.${short}`);
        const now = h.workingTree(path.join(work, 'new'), `0.1.0-to.${short}`);
        const home = path.join(work, 'home');
        const env = {...process.env, COUNTINGHOUSE_HOME: home, CH_LOCAL_DEV: '1'};

        // the older release's home, by its own code; started once
        const relOld = await h.releaseFor(old, h.realIo(env), path.join(work, 'r-old'), RUNTIME);
        await h.installWith(old, h.realIo(env), relOld);
        await h.userDataWith(old, h.realIo(env), home);
        assert.strictEqual(h.launcherVersion(home), relOld.version);
        const first = await h.startAndCall(home, work);
        assert.deepStrictEqual([first.tools, first.output], [TOOLS, OUTPUT], 'the older release starts, with its setting');
        const before = {summary: h.summaryWith(old, env), files: h.dataFiles(home)};
        assert.ok(Object.keys(before.files).includes(path.join('credentials', 'credentials.json')), 'a credential is stored');

        // the upgrade: this tree's install over it
        const relNew = await h.releaseFor(now, h.realIo(env), path.join(work, 'r-new'), RUNTIME);
        await h.installWith(now, h.realIo(env), relNew);
        assert.strictEqual(h.launcherVersion(home), relNew.version, 'this tree is the launcher now');
        assert.ok(fs.existsSync(path.join(home, 'previous', 'app')), 'the older release kept for rollback');
        assert.deepStrictEqual(h.dataFiles(home), before.files, 'every data file kept, byte for byte, its mode too');
        assert.deepStrictEqual(h.summaryWith(now, env), before.summary, 'this tree reads the home as the older release read it');
        const upgraded = await h.startAndCall(home, work);
        assert.deepStrictEqual([upgraded.tools, upgraded.output], [TOOLS, OUTPUT], 'started after the upgrade, with the setting the older release stored');

        // the rollback, by this tree's own command, as a user runs it
        h.run(process.execPath, [path.join(home, 'bin', 'ch-local.js'), 'rollback', '--yes'], {env, timeout: 300000});
        assert.strictEqual(h.launcherVersion(home), relOld.version, 'the older release is the launcher again');
        // (every data file as it was, but the upgrade check's record: rollback
        // says there that the release it left is declined, so an automatic
        // upgrade never brings it back -- by design, lib/rollback.js)
        const after = h.dataFiles(home);
        const stamp = path.join(home, 'upgrade-check.json');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(stamp, 'utf8')).declined, [relNew.version], 'the release left is declined');
        delete after['upgrade-check.json'];
        const kept = {...before.files};
        delete kept['upgrade-check.json'];
        assert.deepStrictEqual(after, kept, 'every other data file as it was');
        assert.deepStrictEqual(h.summaryWith(old, env), before.summary, 'the older release reads its home as before');
        const back = await h.startAndCall(home, work);
        assert.deepStrictEqual([back.tools, back.output], [TOOLS, OUTPUT], 'the older release starts again');
      } finally {
        fs.rmSync(work, {recursive: true, force: true});
      }
    });
}
