#!/usr/bin/env node
'use strict';
// Capture a home built by an older ch-local, for the older-format readers'
// test (test/home-formats.test.js): every format a home holds, as that
// release wrote it, read by this tree's readers on every run.
//
//   CH_SMOKE_RUNTIME_TGZ=<countinghouse-x.y.z.tgz> node scripts/capture-home.js --from <commit> --label <name>
//
// It checks out <commit> (git archive), installs its dependencies, and with
// that tree's own code installs the smoke fixture pack, stores a credential
// and sets a setting in a temporary home. The home's record, its module
// store, and its data files go to test/fixtures/homes/<name>/home; what that
// release's own readers read from them to test/fixtures/homes/<name>/
// expected.json. Release gating: capture from the release commit, so the
// release's exact formats are pinned (CONTRIBUTING.md).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const h = require('../test/upgrade-helpers');

const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const commit = arg('--from');
const label = arg('--label');
const runtimeTgz = process.env.CH_SMOKE_RUNTIME_TGZ;
if (commit == null || label == null || !/^[a-z0-9][a-z0-9.-]*$/.test(label) || runtimeTgz == null) {
  console.error('usage: CH_SMOKE_RUNTIME_TGZ=<countinghouse tarball> node scripts/capture-home.js --from <commit> --label <name>');
  process.exit(2);
}

// The files a home's user data is in, and its record and store: what a newer
// ch-local must read. Program files (app/, bin/, shim/, shim.json,
// previous/), run state (run/) and the history log are a release's own or
// this machine's -- rebuilt by every install, or holding this machine's
// paths -- and are never captured.
const KEEP = ['modules.json', 'settings.json', 'installed-clients.json', 'upgrade-check.json', 'credentials', 'module-store'];

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-capture-'));
  try {
    h.commitHere(commit);
    const short = h.run('git', ['-C', h.ROOT, 'rev-parse', '--short=8', commit]).trim();
    const full = h.run('git', ['-C', h.ROOT, 'rev-parse', commit]).trim();
    const old = h.treeAt(full, path.join(work, 'old'), `0.1.0-from.${short}`);
    const home = path.join(work, 'home');
    const env = {...process.env, COUNTINGHOUSE_HOME: home, CH_LOCAL_DEV: '1'};
    const io = h.realIo(env);
    const rel = await h.releaseFor(old, io, path.join(work, 'r'), runtimeTgz);
    await h.installWith(old, io, rel);
    await h.userDataWith(old, io, home);
    const expected = h.summaryWith(old, env);

    // (built beside the fixtures, then put in place by renames: a failed
    // capture leaves any earlier one as it was)
    const final = path.join(h.ROOT, 'test', 'fixtures', 'homes', label);
    fs.mkdirSync(path.dirname(final), {recursive: true});
    const dest = path.join(path.dirname(final), `.capturing-${label}-${process.pid}`);
    fs.rmSync(dest, {recursive: true, force: true});
    fs.mkdirSync(path.join(dest, 'home'), {recursive: true});
    for (const name of KEEP) {
      const src = path.join(home, name);
      if (fs.existsSync(src)) fs.cpSync(src, path.join(dest, 'home', name), {recursive: true});
    }
    fs.writeFileSync(path.join(dest, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
    fs.writeFileSync(path.join(dest, 'from.json'), JSON.stringify({commit: full, version: rel.version}, null, 2) + '\n');
    // (nothing of this machine's in a fixture: a path under the temporary
    // home, the user's home or the node binary refuses the capture)
    // (each in either spelling: as given and by its real path -- /private/var
    // on macOS, the long name for an 8.3 one on Windows -- since a reader can
    // record either)
    const realOf = (x) => { try { return fs.realpathSync.native(x); } catch (e) { return x; } };
    const raw = [...new Set([work, os.homedir(), process.execPath].flatMap((x) => [x, realOf(x)]))].filter((x) => typeof x === 'string' && x.length >= 4);
    const leaks = [...raw, ...raw.map((x) => JSON.stringify(x).slice(1, -1))];
    const walk = (dir) => fs.readdirSync(dir, {withFileTypes: true}).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      const text = fs.readFileSync(p, 'latin1');
      const hit = leaks.find((l) => text.includes(l));
      if (hit != null) {
        const rel = path.relative(dest, p);
        fs.rmSync(dest, {recursive: true, force: true});
        throw new Error(`${rel} holds a path of this machine's; nothing was captured`);
      }
    });
    walk(dest);
    const aside = `${final}.previous-${process.pid}`;
    if (fs.existsSync(final)) fs.renameSync(final, aside);
    fs.renameSync(dest, final);
    fs.rmSync(aside, {recursive: true, force: true});
    console.log(`captured ${label} from ${short} into ${path.relative(h.ROOT, final)}`);
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
})().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
