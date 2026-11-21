'use strict';
require('./tmp-dirs');
// scripts/dogfood.js (reviewer, 2026-11-12): pack 1 for our own sessions, from
// the current mains, into a home with --unreleased-pins. It prints the client
// line with a placeholder for the token, never a value, and touches no client
// file. The full run needs local clones (CH_DOGFOOD_SRC) and reaches only the
// npm registry; without them it is skipped and says why.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {tmp} = require('./fake-io');
const dogfood = require('../scripts/dogfood');

test('requiring the script runs nothing', () => {
  assert.strictEqual(typeof dogfood.main, 'function');
  assert.strictEqual(typeof dogfood.instructions, 'function');
});

// The printed commands are for bash (dogfood is a developer path; reviewer,
// 2026-11-12): Windows paths are another form.
const BASH_ONLY = process.platform === 'win32' && 'the printed commands are for bash (Git Bash or WSL on Windows)';

test('the instructions: gh auth login, the claude mcp add line with no token, claude --resume; never a token value', {skip: BASH_ONLY}, () => {
  const before = process.env.COUNTINGHOUSE_GITHUB_TOKEN;
  const value = `t${require('node:crypto').randomBytes(12).toString('hex')}`;
  process.env.COUNTINGHOUSE_GITHUB_TOKEN = value;
  try {
    const text = dogfood.instructions({node: '/usr/bin/node', home: '/home/me/.countinghouse', defaultHome: '/home/me/.countinghouse'});
    assert.match(text, /^  gh auth login$/m, 'the token is gh\'s, held in memory by the launcher');
    assert.ok(text.includes('  claude mcp add --scope user countinghouse -- /usr/bin/node /home/me/.countinghouse/bin/ch-local.js session'), text);
    assert.match(text, /^  claude --resume$/m);
    assert.ok(!text.includes(value));
    assert.ok(!/COUNTINGHOUSE_GITHUB_TOKEN|read -rs/.test(text), 'no token variable goes into Claude Code\'s configuration');
    assert.ok(!/claude mcp add.*[<>]/.test(text), 'nothing a shell would read as a redirection');
    assert.ok(!text.includes('COUNTINGHOUSE_HOME'), 'the default home needs no variable');
  } finally {
    if (before === undefined) delete process.env.COUNTINGHOUSE_GITHUB_TOKEN; else process.env.COUNTINGHOUSE_GITHUB_TOKEN = before;
  }
});

test('another home is carried into the line, status and uninstall, quoted when it has spaces', {skip: BASH_ONLY}, () => {
  const text = dogfood.instructions({node: '/opt/my node/bin/node', home: '/home/me/my home', defaultHome: '/home/me/.countinghouse'});
  assert.ok(text.includes(`-e "COUNTINGHOUSE_HOME=/home/me/my home" -- '/opt/my node/bin/node' '/home/me/my home/bin/ch-local.js' session`), text);
  assert.ok(text.includes(`COUNTINGHOUSE_HOME='/home/me/my home' '/opt/my node/bin/node' '/home/me/my home/bin/ch-local.js' status`), text);
  assert.ok(text.includes(`COUNTINGHOUSE_HOME='/home/me/my home' '/opt/my node/bin/node' '/home/me/my home/bin/ch-local.js' uninstall`), text);
});

test('the home: --home, else COUNTINGHOUSE_HOME as every ch-local command reads it, else ~/.countinghouse', () => {
  assert.strictEqual(dogfood.homeFor({home: '/h'}, {COUNTINGHOUSE_HOME: '/e'}), path.resolve('/h'));
  assert.strictEqual(dogfood.homeFor({home: null}, {COUNTINGHOUSE_HOME: '/e'}), path.resolve('/e'));
  assert.strictEqual(dogfood.homeFor({home: null}, {}), path.join(os.homedir(), '.countinghouse'));
});

test('the plan: a repo missing under --src is cloned from GitHub; an explicit --clone must exist; a ref without a clone must be a branch', () => {
  const src = tmp('ch-dogfood-src-');
  fs.mkdirSync(path.join(src, 'ch-step-redact', '.git'), {recursive: true});
  const plan = dogfood.planSources(dogfood.parseArgs(['--src', src]));
  assert.ok(plan.problem == null, plan.problem);
  assert.strictEqual(plan.sources.find((s) => s.repo === 'ch-step-redact').dir, path.join(src, 'ch-step-redact'));
  assert.strictEqual(plan.sources.find((s) => s.repo === 'countinghouse').dir, null, 'not under --src: cloned');
  assert.match(dogfood.planSources(dogfood.parseArgs(['--clone', `countinghouse=${path.join(src, 'nope')}`])).problem, /no clone of countinghouse at/);
  assert.match(dogfood.planSources(dogfood.parseArgs(['--ref', 'ch-access-github=3f2a9c1'])).problem, /ch-access-github has no clone, so its ref must be a branch/);
  assert.strictEqual(dogfood.planSources(dogfood.parseArgs(['--ref', 'ch-access-github=origin/feature-x'])).problem, undefined);
  fs.rmSync(src, {recursive: true, force: true});
});

test('the sources: countinghouse at master, ch-local from this checkout, the pack and every part at main', () => {
  const {sources} = dogfood;
  const names = sources().map((s) => s.repo);
  assert.deepStrictEqual(names, ['countinghouse', 'ch-pack-ci-failure-triage', 'ch-access-github', 'ch-step-redact', 'ch-step-log-clean', 'ch-step-error-patterns', 'ch-step-failure-signature', 'ch-step-dedupe', 'ch-step-owner-hint', 'ch-step-report']);
  assert.strictEqual(sources()[0].ref, 'origin/master');
  assert.ok(sources().slice(1).every((s) => s.ref === 'origin/main'));
});

test('arguments: --src, --clone repo=path, --ref repo=ref, --home; anything else is refused', () => {
  const a = dogfood.parseArgs(['--src', '/c', '--clone', 'countinghouse=/x/ch', '--ref', 'countinghouse=origin/lm1-c-compose-wait', '--home', '/h']);
  assert.deepStrictEqual(a, {src: '/c', clones: {countinghouse: '/x/ch'}, refs: {countinghouse: 'origin/lm1-c-compose-wait'}, home: '/h'});
  for (const bad of [['--token', 'x'], ['--clone', 'nope'], ['--ref', 'unknown-repo=main'], ['stray']]) assert.throws(() => dogfood.parseArgs(bad), /usage|unknown|repo=/, bad.join(' '));
});

test('a missing explicit clone is named before anything is built or installed', async () => {
  const parent = tmp('ch-dogfood-');
  const home = path.join(parent, 'home');
  const out = {text: '', write(s) { this.text += s; }};
  const code = await dogfood.main(['--clone', `countinghouse=${path.join(parent, 'none')}`, '--home', home], {stdout: out, stderr: out});
  assert.strictEqual(code, 1);
  assert.match(out.text, /no clone of countinghouse at /);
  assert.ok(!fs.existsSync(home));
  fs.rmSync(parent, {recursive: true, force: true});
});

const SRC = process.env.CH_DOGFOOD_SRC;
test('the whole path into a temporary home', {timeout: 900000, skip: BASH_ONLY || (SRC == null && 'CH_DOGFOOD_SRC is not set (a directory of clones; CH_DOGFOOD_CLONES and CH_DOGFOOD_REFS may add repo=path and repo=ref pairs)')}, async () => {
  const parent = tmp('ch-dogfood-');
  const home = path.join(parent, 'home');
  const works = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ch-dogfood-work-')).length;
  const worksBefore = works();
  const pairs = (v, flag) => (v || '').split(',').filter(Boolean).flatMap((p) => [flag, p]);
  const out = {text: '', write(s) { this.text += s; }};
  const before = process.env.COUNTINGHOUSE_GITHUB_TOKEN;
  const value = `t${require('node:crypto').randomBytes(12).toString('hex')}`;
  process.env.COUNTINGHOUSE_GITHUB_TOKEN = value;
  let code;
  try {
    code = await dogfood.main(['--src', SRC, ...pairs(process.env.CH_DOGFOOD_CLONES, '--clone'), ...pairs(process.env.CH_DOGFOOD_REFS, '--ref'), '--home', home], {stdout: out, stderr: out});
  } finally {
    if (before === undefined) delete process.env.COUNTINGHOUSE_GITHUB_TOKEN; else process.env.COUNTINGHOUSE_GITHUB_TOKEN = before;
  }
  assert.strictEqual(code, 0, out.text.slice(-3000));
  const record = JSON.parse(fs.readFileSync(path.join(home, 'packs.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(record.packs), ['ci-failure-triage']);
  assert.strictEqual(record.unreleased, true);
  assert.ok(fs.existsSync(path.join(home, 'app', 'node_modules', 'countinghouse', 'bin', 'countinghouse-stdio.js')));
  assert.ok(out.text.includes(`claude mcp add --scope user countinghouse -e "COUNTINGHOUSE_HOME=${home}" -- ${process.execPath} ${path.join(home, 'bin', 'ch-local.js')} session`), out.text.slice(-1500));
  assert.ok(!out.text.includes(value), 'never a token value');
  assert.ok(!/COUNTINGHOUSE_GITHUB_TOKEN is set|start will use/.test(out.text), 'install did not look at this shell\'s token');
  assert.deepStrictEqual(fs.readdirSync(parent), ['home'], 'nothing beside the home');
  assert.strictEqual(works(), worksBefore, 'the work directory is removed');
  fs.rmSync(parent, {recursive: true, force: true});
});

// A-firstrun d2: a prepared local release for Matt's acceptance run, and the
// one command that installs from it, as the setup skill builds it: the
// folder's own launcher, each path one single-quoted word, forward slashes
// (the reviewer's high on #105, 1 and 2). Platform-aware: a Windows path is
// written with forward slashes.
test('--release-dir takes an absolute path only; the command for a prepared release is the folder\'s own launcher, each path quoted, in the skill\'s shape', () => {
  assert.strictEqual(dogfood.parseArgs(['--release-dir', path.resolve('/r')]).releaseDir, path.resolve('/r'));
  assert.throws(() => dogfood.parseArgs(['--release-dir', 'relative/r']), /--release-dir must be an absolute path/);
  // (nothing is installed: a home would be ignored, so it is refused)
  assert.throws(() => dogfood.parseArgs(['--release-dir', path.resolve('/r'), '--home', path.resolve('/h')]), /--home is for dogfood's own install; --release-dir installs nothing/);
  assert.strictEqual(dogfood.releaseLine({dir: '/r/rel 1'}, 'linux'),
    "CH_LOCAL_DEV=1 node '/r/rel 1/ch-local/bin/ch-local.js' install --pack ci-failure-triage --from '/r/rel 1/release' --unreleased-pins '/r/rel 1/pins.json'");
  assert.strictEqual(dogfood.releaseLine({dir: 'C:\\Users\\m\\rel'}, 'win32'),
    "CH_LOCAL_DEV=1 node 'C:/Users/m/rel/ch-local/bin/ch-local.js' install --pack ci-failure-triage --from 'C:/Users/m/rel/release' --unreleased-pins 'C:/Users/m/rel/pins.json'", 'Windows: forward slashes');
  // (the skill's shape, slot by slot: one variable, single-quoted paths of
  // the allowed characters, nothing chained)
  const SHAPE = /^CH_LOCAL_DEV=1 node '[A-Za-z0-9_\/.:@%+=,~ -]+\/ch-local\/bin\/ch-local\.js' install --pack ci-failure-triage --from '[A-Za-z0-9_\/.:@%+=,~ -]+\/release' --unreleased-pins '[A-Za-z0-9_\/.:@%+=,~ -]+\/pins\.json'$/;
  assert.match(dogfood.releaseLine({dir: path.resolve('/srv/rel')}), SHAPE);
  // (absolute only, never an option or a ~; a backslash is a separator on
  // Windows alone: the medium on round 1, 3 and 4)
  for (const bad of ['rel', '~/rel', '-r/x', '--require=/x', '/srv/a\\b']) assert.strictEqual(dogfood.releaseLine({dir: bad}, 'linux'), null, JSON.stringify(bad));
  assert.strictEqual(dogfood.releaseLine({dir: 'C:\\a\\b'}, 'linux'), null, 'a backslash off Windows');
  // (Windows: X:/ only -- MSYS rewrites a /-rooted path for node.exe; never
  // //host; elsewhere one leading /: the high on round 1, 3)
  for (const bad of ['/c/rel', '//host/share/rel', '\\\\host\\share']) assert.strictEqual(dogfood.releaseLine({dir: bad}, 'win32'), null, JSON.stringify(bad));
  assert.strictEqual(dogfood.releaseLine({dir: '//srv/rel'}, 'linux'), null);
  assert.ok(dogfood.releaseLine({dir: 'C:/rel'}, 'win32') != null);
  // (each platform's own root, so the characters themselves are what is
  // refused: the medium on round 2, 7)
  for (const bad of ["it's", '$HOME', 'a`b', 'a"b', 'a\nb', 'caf\u00e9', 'a$(x)b']) {
    assert.strictEqual(dogfood.releaseLine({dir: `/r/${bad}`}, 'linux'), null, JSON.stringify(bad));
    assert.strictEqual(dogfood.releaseLine({dir: `C:/r/${bad}`}, 'win32'), null, JSON.stringify(bad));
  }
});

// the medium on #105's round 1, 1, 2, 6 and 9: the folder is put together
// beside its target from the release's own ch-local tarball (on stdin, named
// by tarballName), whole or not at all; a new folder gets a new directory's
// mode, an empty one keeps its own
test('placeRelease: a new folder whole, at a new directory\'s mode; an empty one filled in place, its mode kept; a failure leaves nothing', () => {
  const {spawnSync} = require('node:child_process');
  const name = require('../package.json').name;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-dogfood-place-'));
  try {
    const release = path.join(base, 'built', 'release');
    fs.mkdirSync(path.join(base, 'pkg', 'package', 'bin'), {recursive: true});
    fs.writeFileSync(path.join(base, 'pkg', 'package', 'bin', 'ch-local.js'), '// launcher\n');
    fs.writeFileSync(path.join(base, 'pkg', 'package', 'package.json'), JSON.stringify({name, version: '0.1.0', bundleDependencies: ['@x/dep']}));
    fs.mkdirSync(path.join(base, 'pkg', 'package', 'node_modules', '@x', 'dep'), {recursive: true});
    fs.writeFileSync(path.join(base, 'pkg', 'package', 'node_modules', '@x', 'dep', 'package.json'), '{}');
    fs.writeFileSync(path.join(base, 'pkg', 'package', 'node_modules', '@x', 'dep', 'index.js'), 'module.exports = 1;\n');
    fs.mkdirSync(release, {recursive: true});
    const tgz = require('../lib/unpack').tarballName(name, '0.1.0');
    const made = spawnSync('tar', ['-c', '-z', '-f', '-', '-C', path.join(base, 'pkg'), 'package'], {encoding: 'buffer'});
    assert.strictEqual(made.status, 0);
    fs.writeFileSync(path.join(release, tgz), made.stdout);
    const pinsFile = path.join(base, 'built', 'pins.json');
    fs.writeFileSync(pinsFile, '{}\n');
    const pins = {[name]: {version: '0.1.0'}};
    const whole = (dir) => fs.existsSync(path.join(dir, 'ch-local', 'bin', 'ch-local.js')) && fs.existsSync(path.join(dir, 'release', tgz)) && fs.existsSync(path.join(dir, 'pins.json'));
    const leftovers = () => fs.readdirSync(base).filter((n) => n.includes('.partial-'));

    const fresh = path.join(base, 'fresh');
    assert.strictEqual(dogfood.placeRelease({release, pinsFile, pins, dir: fresh}), null);
    assert.ok(whole(fresh));
    if (process.platform !== 'win32') {
      const umask = process.umask();
      assert.strictEqual(fs.statSync(fresh).mode & 0o777, 0o777 & ~umask, 'a new directory\'s mode, not 0700');
    }
    const empty = path.join(base, 'empty');
    fs.mkdirSync(empty, {mode: 0o750});
    fs.chmodSync(empty, 0o750);
    assert.strictEqual(dogfood.placeRelease({release, pinsFile, pins, dir: empty}), null);
    assert.ok(whole(empty));
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(empty).mode & 0o777, 0o750, 'its own mode kept');
    assert.deepStrictEqual(fs.readdirSync(empty).sort(), ['ch-local', 'pins.json', 'release'], 'staged inside it, no stage left');

    // a ch-local packed without the dependencies it bundles: refused, nothing made
    // (the high on round 1, 5)
    const tarOf = (dir) => spawnSync('tar', ['-c', '-z', '-f', '-', '-C', dir, 'package'], {encoding: 'buffer'}).stdout;
    const good = fs.readFileSync(path.join(release, tgz));
    fs.rmSync(path.join(base, 'pkg', 'package', 'node_modules'), {recursive: true});
    fs.writeFileSync(path.join(release, tgz), tarOf(path.join(base, 'pkg')));
    assert.match(dogfood.placeRelease({release, pinsFile, pins, dir: path.join(base, 'nodeps', 'deeper', 'rel')}), /lacks the dependencies it bundles \(@x\/dep\)/);
    assert.ok(!fs.existsSync(path.join(base, 'nodeps')), 'the parents it made are gone too');
    fs.writeFileSync(path.join(release, tgz), good);
    // no tarball of its own: nothing made; a tarball that won't unpack: nothing made, nothing moved
    assert.match(dogfood.placeRelease({release, pinsFile, pins: {}, dir: path.join(base, 'none')}), /holds no .* tarball/);
    assert.ok(!fs.existsSync(path.join(base, 'none')));
    fs.writeFileSync(path.join(release, tgz), 'not a tarball');
    const kept = path.join(base, 'kept');
    fs.mkdirSync(kept);
    assert.match(dogfood.placeRelease({release, pinsFile, pins, dir: kept}), /could not be unpacked/);
    assert.deepStrictEqual(fs.readdirSync(kept), [], 'the empty folder stays empty');
    assert.match(dogfood.placeRelease({release, pinsFile, pins, dir: path.join(base, 'bad')}), /could not be unpacked/);
    assert.ok(!fs.existsSync(path.join(base, 'bad')));
    assert.deepStrictEqual(leftovers(), [], 'no stage left');
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

// the medium on #105's round 2, 6: every bundled dependency loads from the
// unpacked tree (a dependency's own dependency missing too); true bundles all
test('bundledProblem: each bundled dependency must load, its own dependencies included; bundleDependencies true means all', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-dogfood-bundled-'));
  try {
    const mod = (dir, name, body) => {
      fs.mkdirSync(path.join(dir, 'node_modules', ...name.split('/')), {recursive: true});
      fs.writeFileSync(path.join(dir, 'node_modules', ...name.split('/'), 'package.json'), '{}');
      fs.writeFileSync(path.join(dir, 'node_modules', ...name.split('/'), 'index.js'), body);
    };
    fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({dependencies: {'@x/a': '1.0.0'}, bundleDependencies: true}));
    mod(base, '@x/a', "module.exports = require('@x/b');\n");
    assert.match(dogfood.bundledProblem(base, 'own.tgz'), /own\.tgz lacks the dependencies it bundles \(@x\/a\)/, 'its own dependency missing');
    mod(base, '@x/b', 'module.exports = 2;\n');
    assert.strictEqual(dogfood.bundledProblem(base, 'own.tgz'), null);
    fs.writeFileSync(path.join(base, 'package.json'), '{not json');
    assert.match(dogfood.bundledProblem(base, 'own.tgz'), /own\.tgz: its package\.json can't be read/);
  } finally {
    fs.rmSync(base, {recursive: true, force: true});
  }
});

// A-shim-from (the reviewer, 11-21): a prepared folder brings this machine's
// shim, packed as its platform package and pinned by its sha512, which
// install --from checks before placing it
test('shimInto: this machine\'s shim packed into the release as its platform package, pinned by its sha512', async () => {
  const {spawnSync} = require('node:child_process');
  const work = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ch-dogfood-shim-')));
  try {
    const release = path.join(work, 'release');
    fs.mkdirSync(release);
    const fake = path.join(work, 'built');
    fs.writeFileSync(fake, 'the built shim');
    const pins = {};
    const npmIo = {node: process.execPath, exec: async (cmd, a, {cwd}) => spawnSync(cmd, a, {cwd, encoding: 'utf8', shell: process.platform === 'win32'})};
    const said = [];
    const packed = await dogfood.shimInto(npmIo, release, work, pins, (l) => said.push(l), {build: () => fake, platform: 'linux', arch: 'x64'});
    const version = require('../npm-shim/assemble').cargoVersion(path.join(__dirname, '..', 'shim', 'Cargo.toml'));
    // (Cargo's version, -dev. and the binary's sha512: never a released
    // version, each build its own -- the medium, 1-2)
    const dev = `${version}-dev.${require('node:crypto').createHash('sha512').update('the built shim').digest('hex').slice(0, 12)}`;
    assert.strictEqual(packed, `@countinghouse/ch-shim-linux-x64@${dev}`);
    const file = require('../lib/unpack').tarballName('@countinghouse/ch-shim-linux-x64', dev);
    const bytes = fs.readFileSync(path.join(release, file));
    assert.deepStrictEqual(pins['@countinghouse/ch-shim-linux-x64'], {version: dev, integrity: require('../lib/integrity').integrityOf(bytes)});
    assert.strictEqual(require('../lib/tar').readMember(bytes, 'bin/ch-shim').toString(), 'the built shim');
    const manifest = JSON.parse(require('../lib/tar').readMember(bytes, 'package.json').toString());
    assert.deepStrictEqual([manifest.os, manifest.cpu], [['linux'], ['x64']]);
    // (no target for the machine: no shim, said)
    assert.strictEqual(await dogfood.shimInto(npmIo, release, work, {}, (l) => said.push(l), {build: () => fake, platform: 'sunos', arch: 'x64'}), null);
    assert.match(said.join('\n'), /no target for sunos-x64; the folder brings no shim/);
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
});

test('builtExecutable: the executable cargo names in its JSON messages, wherever its target dir is', () => {
  const lines = [
    JSON.stringify({reason: 'compiler-artifact', target: {name: 'libc'}, executable: null}),
    'not json',
    JSON.stringify({reason: 'compiler-artifact', target: {name: 'ch-shim'}, executable: '/elsewhere/x86_64-unknown-linux-musl/release/ch-shim'}),
    JSON.stringify({reason: 'build-finished', success: true}),
  ].join('\n');
  assert.strictEqual(dogfood.builtExecutable(lines, 'ch-shim'), '/elsewhere/x86_64-unknown-linux-musl/release/ch-shim');
  assert.strictEqual(dogfood.builtExecutable(lines, 'ch-shim.exe'), null);
});
