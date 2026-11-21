#!/usr/bin/env node
'use strict';
// Pack 1 for our own sessions, before any release (reviewer, 2026-11-12;
// docs/development/dogfood.md). It builds every package from its repository's
// current main (countinghouse at master; ch-local itself from this checkout,
// whose launcher reads what this install writes), generates their pins and
// the runtime's lockfile, and installs pack 1 into a home (default
// ~/.countinghouse) with CH_LOCAL_DEV=1 and --unreleased-pins. Then it prints
// the client line, with a placeholder where the token goes: it never reads,
// prints or stores a token, and touches no client file.
//
//   node scripts/dogfood.js [--home <dir>] [--src <dir of clones>]
//                           [--clone <repo>=<path>]... [--ref <repo>=<ref>]...
//   node scripts/dogfood.js --release-dir <dir> [--src ...] [--clone ...] [--ref ...]
//
// --release-dir: build a prepared local release into <dir> (absolute, new or
// empty) and install nothing. Self-contained, so the folder a person names is
// the whole of what runs (the reviewer's high on #105, 1): <dir>/ch-local
// (this checkout's launcher, packed and unpacked), <dir>/release (the
// tarballs) and <dir>/pins.json. The setup skill and the install doc build
// the one command that installs from it, from the folder alone (releaseLine).
//
// --src: local clones, <dir>/<repo>, used at their last fetched origin/main
// (origin/master for countinghouse), through git archive, so no working tree
// is read or touched and nothing is fetched. --clone names a clone elsewhere;
// --ref another ref. Without a clone, the repository is cloned from GitHub at
// that branch. Installing the runtime's dependencies reaches the npm registry.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OWNER = 'mchen6';
const PACK = 'ci-failure-triage';
const SOURCES = [['countinghouse', 'origin/master'], ['ch-pack-ci-failure-triage', 'origin/main'], ['ch-access-github', 'origin/main'],
  ...['redact', 'log-clean', 'error-patterns', 'failure-signature', 'dedupe', 'owner-hint', 'report'].map((s) => [`ch-step-${s}`, 'origin/main'])];
const USAGE = 'usage: node scripts/dogfood.js [--home <dir> | --release-dir <dir>] [--src <dir of clones>] [--clone <repo>=<path>]... [--ref <repo>=<ref>]...\n';

const sources = () => SOURCES.map(([repo, ref]) => ({repo, ref}));

function parseArgs(argv) {
  const out = {src: null, clones: {}, refs: {}, home: null};
  const repos = new Set(SOURCES.map(([r]) => r));
  const pair = (v, flag) => {
    const m = /^([a-z0-9-]+)=(.+)$/.exec(v || '');
    if (m == null) throw new Error(`${flag} takes repo=value\n${USAGE}`);
    if (!repos.has(m[1])) throw new Error(`unknown repo ${m[1]} for ${flag}\n${USAGE}`);
    return [m[1], m[2]];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(USAGE); return argv[++i]; };
    if (a === '--src') out.src = next();
    else if (a === '--home') out.home = next();
    // build a prepared local release into this (absolute, new or empty)
    // directory and install nothing: what the install doc's pre-release
    // command runs from (A-firstrun d2: Matt's acceptance run)
    else if (a === '--release-dir') {
      out.releaseDir = next();
      if (!path.isAbsolute(out.releaseDir)) throw new Error(`--release-dir must be an absolute path\n${USAGE}`);
    }
    else if (a === '--clone') { const [r, v] = pair(next(), '--clone'); out.clones[r] = v; }
    else if (a === '--ref') { const [r, v] = pair(next(), '--ref'); out.refs[r] = v; }
    else throw new Error(USAGE);
  }
  // (nothing is installed with --release-dir: a home would be ignored, and
  // the command it prints installs into the default home)
  if (out.releaseDir != null && out.home != null) throw new Error(`--home is for dogfood's own install; --release-dir installs nothing\n${USAGE}`);
  return out;
}

// A shell word: quoted when it holds anything but plain path characters.
const word = (s) => (/^[A-Za-z0-9_/.:@%+=,-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
const DEFAULT_HOME = () => path.join(os.homedir(), '.countinghouse');

// --home, else COUNTINGHOUSE_HOME as every ch-local command reads it, else ~/.countinghouse.
function homeFor(args, env = process.env) {
  if (args.home != null) return path.resolve(args.home);
  if (typeof env.COUNTINGHOUSE_HOME === 'string' && env.COUNTINGHOUSE_HOME !== '') return path.resolve(env.COUNTINGHOUSE_HOME);
  return DEFAULT_HOME();
}

// What the user runs. The token is gh's: the launcher asks `gh auth token`
// at every start and holds it in memory, so no line carries a token value and
// none is written to Claude Code's configuration (maintainer's decision,
// 2026-11-13). A home other than the default goes with every command, since
// the launcher finds
// its home by COUNTINGHOUSE_HOME.
// The one command that installs from a prepared local release <dir>, as the
// setup skill builds it: the folder's own launcher, each path one
// single-quoted word, forward slashes (on Windows only, where a backslash
// is the separator: anywhere else it is part of a name, and refused), the
// folder's path absolute and only of CHARS's characters: on Windows X:/...
// only (MSYS rewrites a /-rooted path for node.exe, so it could name a folder
// never checked; //host neither), elsewhere one leading / (never one node
// would read as an option or a shell as ~) (the high on #105, 2, and its
// round 2, 3; the medium on round 1, 3 and 4) -> the line, or null
// (a stage's name: <dir>/.partial-*, or .<name>.partial-* beside it)
const STAGE = '.partial-';
const CHARS = /^[A-Za-z0-9_/.:@%+=,~ -]*$/;
const ROOTED = {win32: /^[A-Za-z]:\/(?!\/)/, other: /^\/(?!\/)/};
const folderOk = (f, platform) => CHARS.test(f) && (platform === 'win32' ? ROOTED.win32 : ROOTED.other).test(f);
const slashed = (dir, platform) => (platform === 'win32' ? String(dir).replace(/\\/g, '/') : String(dir)).replace(/(.)\/+$/, '$1');
function releaseLine({dir}, platform = process.platform) {
  const f = slashed(dir, platform);
  if (!folderOk(f, platform)) return null;
  return `CH_LOCAL_DEV=1 node '${f}/ch-local/bin/ch-local.js' install --pack ${PACK} --from '${f}/release' --unreleased-pins '${f}/pins.json'`;
}

function instructions({node, home, defaultHome = DEFAULT_HOME()}) {
  const launcher = path.join(home, 'bin', 'ch-local.js');
  const other = path.resolve(home) !== path.resolve(defaultHome);
  const homeFlag = other ? ` -e "COUNTINGHOUSE_HOME=${home}"` : '';
  const homeEnv = other ? `COUNTINGHOUSE_HOME=${word(home)} ` : '';
  return [
    ...(process.platform === 'win32' ? ['These commands are for bash: run them in Git Bash or WSL.', ''] : []),
    'Log the GitHub CLI in, once (the launcher asks it for the token at each start and keeps it',
    'in memory; no token goes into Claude Code\'s configuration):',
    '',
    '  gh auth login',
    '',
    'Add the server to Claude Code, then restart your session so it loads it:',
    '',
    `  claude mcp add --scope user countinghouse${homeFlag} -- ${word(node)} ${word(launcher)} session`,
    '  claude --resume',
    '',
    'What is installed, and how to take it all back:',
    '',
    `  ${homeEnv}${word(node)} ${word(launcher)} status`,
    `  ${homeEnv}${word(node)} ${word(launcher)} uninstall`,
    '  claude mcp remove --scope user countinghouse',
    ''
  ].join('\n');
}

// Where each package comes from -> {sources: [{repo, ref, dir}]} or {problem}.
// A repo under --src, or named by --clone, is read from that clone; an
// explicit --clone must exist. Any other repo is cloned from GitHub, so its
// ref must be a branch (origin/<branch> or <branch>). Checked before anything
// is built.
function planSources(args) {
  const out = [];
  for (const s of sources()) {
    const ref = args.refs[s.repo] || s.ref;
    let dir = null;
    if (args.clones[s.repo] != null) {
      dir = path.resolve(args.clones[s.repo]);
      if (!fs.existsSync(path.join(dir, '.git'))) return {problem: `no clone of ${s.repo} at ${dir}`};
    } else if (args.src != null && fs.existsSync(path.join(path.resolve(args.src), s.repo, '.git'))) {
      dir = path.join(path.resolve(args.src), s.repo);
    }
    if (dir == null && !/^(origin\/)?[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(ref)) return {problem: `${s.repo} has no clone, so its ref must be a branch (origin/<branch>), not ${ref}`};
    if (dir == null && /^[0-9a-f]{7,40}$/.test(ref.replace(/^origin\//, ''))) return {problem: `${s.repo} has no clone, so its ref must be a branch (origin/<branch>), not ${ref}`};
    out.push({...s, ref, dir});
  }
  return {sources: out};
}

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts});

// Packs ch-local (this checkout) and every source in `plan` into
// <work>/release, writes the pins and the runtime lockfile as a release would
// -> {release, pinsFile, pins} or {problem}. Shared with scripts/acceptance.js.
// This machine's shim, built from this checkout (cargo build --release
// --locked, the host target) and packed as its platform package, the shape
// publish makes (npm-shim/assemble.js writeTarget), into release/: pinned by
// its sha512 as the packs are, so install --from places and records it
// (A-shim-from, the reviewer, 11-21). build: (shimDir, exe) -> the binary's
// path (a test's own); null: no shim for this machine. -> the
// `<name>@<version>` packed, or null
async function shimInto(npmIo, release, work, pins, say, {build = cargoBuild, platform = process.platform, arch = process.arch} = {}) {
  const {writeTarget, cargoVersion, exe} = require('../npm-shim/assemble');
  const t = require('../npm-shim/targets').find((x) => x.os === platform && x.cpu === arch);
  if (t == null) { say(`ch-shim: no target for ${platform}-${arch}; the folder brings no shim`); return null; }
  const version = cargoVersion(path.join(ROOT, 'shim', 'Cargo.toml'));
  if (version == null) throw new Error('shim/Cargo.toml names no [package] version');
  const bin = build(path.join(ROOT, 'shim'), exe(t));
  const dir = writeTarget(path.join(work, 'shim-package', `ch-shim-${t.key}`), t, version, bin);
  const {packInto} = require('../lib/release');
  const {name, integrity} = await packInto(npmIo, dir, release);
  pins[name] = {version, integrity};
  return `${name}@${version}`;
}
function cargoBuild(shimDir, exeName) {
  const r = run('cargo', ['build', '--release', '--locked'], {cwd: shimDir});
  if (r.error != null || r.status !== 0) throw new Error(`cargo build of the shim failed (${r.error != null ? r.error.code : `exit ${r.status}`}): ${String(r.stderr || '').split('\n').slice(-6).join('\n')}`);
  return path.join(shimDir, 'target', 'release', exeName);
}

async function buildRelease(plan, work, say, {shim = null} = {}) {
  const {packInto, runtimeLockfile} = require('../lib/release');
  const {ALLOWLIST} = require('../lib/allowlist');
  const npmIo = {node: process.execPath, exec: async (cmd, a, {cwd}) => run(cmd, a, {cwd})};
  const release = path.join(work, 'release');
  fs.mkdirSync(release);
  const pins = {};
  const pack = async (dir) => {
    const {name, version, integrity} = await packInto(npmIo, dir, release);
    pins[name] = {version, integrity};
    return `${name}@${version}`;
  };
  say(`ch-local: this checkout (${ROOT}) -> ${await pack(ROOT)}`);
  for (const p of plan) {
    const tree = path.join(work, 'src', p.repo);
    fs.mkdirSync(tree, {recursive: true});
    if (p.dir != null) {
      const archive = run('git', ['-C', p.dir, 'archive', '--format=tar', p.ref], {encoding: 'buffer'});
      if (archive.status !== 0) return {problem: `git archive of ${p.repo} at ${p.ref} failed`};
      const x = run('tar', ['-x', '-f', '-', '-C', tree], {input: archive.stdout, encoding: 'buffer'});
      if (x.status !== 0) return {problem: `could not unpack ${p.repo}: ${String(x.stderr)}`};
    } else {
      const branch = p.ref.replace(/^origin\//, '');
      const c = run('git', ['clone', '--quiet', '--depth', '1', '--branch', branch, `https://github.com/${OWNER}/${p.repo}.git`, tree]);
      if (c.status !== 0) return {problem: `git clone of ${OWNER}/${p.repo} at ${branch} failed: ${c.stderr.trim()}`};
      p.commit = run('git', ['-C', tree, 'rev-parse', 'HEAD']).stdout.trim();
      fs.rmSync(path.join(tree, '.git'), {recursive: true, force: true});
    }
    say(`${p.repo}: ${p.dir != null ? `${p.dir} ` : 'GitHub '}${p.ref} ${String(p.commit).slice(0, 7)} -> ${await pack(tree)}`);
  }
  // (a prepared folder: this machine's shim too; not dogfood's own install
  // or acceptance, which run each session's own runtime)
  if (shim != null) {
    const packed = await shimInto(npmIo, release, work, pins, say, shim);
    if (packed != null) say(`ch-shim: this checkout's shim/ -> ${packed}`);
  }
  const missing = [...ALLOWLIST.runtime.packages, ...ALLOWLIST.packs[PACK].modules].filter((n) => pins[n] == null);
  if (missing.length > 0) return {problem: `the build has no ${missing.join(', ')}`};
  say('generating the runtime lockfile (npm registry)');
  const lockfile = await runtimeLockfile(npmIo, release, ALLOWLIST.runtime, pins, path.join(work, 'lock'));
  const pinsFile = path.join(work, 'pins.json');
  // (its own descriptions of the pack modules it pins, from what was just
  // packed: install checks them as a release's: lib/pins.js)
  let modules;
  try { modules = require('./describe-release').describePinned(ALLOWLIST, pins, release); } catch (err) { return {problem: `describing the build: ${err.message}`}; }
  fs.writeFileSync(pinsFile, JSON.stringify({pins, runtimeLockfile: lockfile, modules}, null, 2));
  return {release, pinsFile, pins};
}

// The prepared release put together as <dir>: release/, pins.json and the
// folder's own launcher, ch-local/ (its tarball from the release, unpacked,
// checked to hold every dependency it bundles: a checkout packed without
// node_modules drops them silently). Assembled in a stage on <dir>'s own
// file system (unpacked there, never renamed in from elsewhere), then:
// - <dir> absent: its parent made now (after a successful build), the stage
//   beside it, given the mode a new directory gets, renamed into place;
// - <dir> an empty directory: the stage inside it (a mount point, or a link
//   to another device, is its own file system), the parts moved up, pins.json
//   last (its own mode, owner and ACL kept), and on a failure the parts moved
//   removed.
// Nothing half-made is left either way (the high on #105, 9, and its round
// 2, 5; the medium on round 1, 1, 2, 6, 9 and 10) -> null, or the problem.
function placeRelease({release, pinsFile, pins, dir}) {
  const name = require('../package.json').name;
  const own = pins[name] != null ? require('../lib/unpack').tarballName(name, pins[name].version) : null;
  if (own == null || !fs.existsSync(path.join(release, own))) return `the release holds no ${name} tarball`;
  const exists = fs.existsSync(dir);
  let made = null;     // the first directory made above <dir>, removed on a failure
  let stage = null;
  const moved = [];
  let done = false;
  try {
    if (!exists) made = fs.mkdirSync(path.dirname(dir), {recursive: true}) || null;
    stage = fs.mkdtempSync(exists ? path.join(dir, STAGE) : path.join(path.dirname(dir), `.${path.basename(dir)}${STAGE}`));
    fs.cpSync(release, path.join(stage, 'release'), {recursive: true});
    fs.copyFileSync(pinsFile, path.join(stage, 'pins.json'));
    // (the archive on stdin: GNU tar, Git Bash's, reads C:... as a host)
    const tar = run('tar', ['-x', '-z', '-f', '-', '-C', stage], {input: fs.readFileSync(path.join(release, own)), encoding: 'buffer'});
    if (tar.error != null || tar.signal != null || tar.status !== 0) return `${own} could not be unpacked (${tar.error != null ? tar.error.code : tar.signal != null ? tar.signal : `tar exit ${tar.status}`})`;
    fs.renameSync(path.join(stage, 'package'), path.join(stage, 'ch-local'));
    const problem = bundledProblem(path.join(stage, 'ch-local'), own);
    if (problem != null) return problem;
    if (!exists) {
      // (a new directory's mode, not mkdtemp's 0700)
      const umask = process.umask();
      fs.chmodSync(stage, 0o777 & ~umask);
      fs.renameSync(stage, dir);
      stage = null;
      done = true;
      return null;
    }
    // (still empty but for this stage: nothing made meanwhile is replaced;
    // the medium on round 2, 8)
    const now = fs.readdirSync(dir).filter((n) => n !== path.basename(stage));
    if (now.length > 0) return `${dir} is no longer empty (${now.slice(0, 3).join(', ')}): nothing was put there`;
    for (const part of ['ch-local', 'release', 'pins.json']) {
      fs.renameSync(path.join(stage, part), path.join(dir, part));
      moved.push(part);
    }
    done = true;
    return null;
  } catch (err) {
    return err.message;
  } finally {
    if (!done) {
      for (const part of moved) fs.rmSync(path.join(dir, part), {recursive: true, force: true});
      // (the parents this run made, with the stage in them: the medium on
      // round 2, 1)
      if (made != null) fs.rmSync(made, {recursive: true, force: true});
    }
    if (stage != null) fs.rmSync(stage, {recursive: true, force: true});
  }
}

// The unpacked ch-local holds every dependency it bundles, each loadable
// with its own dependencies (a checkout packed without node_modules drops
// them silently; bundleDependencies true bundles them all) -> null, or the
// problem, naming the tarball
function bundledProblem(dir, own) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch (err) { return `${own}: its package.json can't be read (${err.message})`; }
  const listed = manifest.bundleDependencies != null ? manifest.bundleDependencies : manifest.bundledDependencies;
  const bundled = listed === true ? Object.keys(manifest.dependencies || {}) : Array.isArray(listed) ? listed : [];
  if (bundled.length === 0) return null;
  // (each one loaded from the unpacked tree, as the launcher will: a
  // dependency of a dependency missing fails here, not at the user's
  // install)
  const r = run(process.execPath, ['-e', `for (const d of ${JSON.stringify(bundled)}) { try { require(d); } catch (e) { console.log(d); } }`], {cwd: dir});
  if (r.error != null || r.status !== 0) return `${own}: its bundled dependencies could not be checked (${r.error != null ? r.error.code : `exit ${r.status}`})`;
  const lacking = String(r.stdout).split('\n').filter(Boolean);
  return lacking.length > 0 ? `${own} lacks the dependencies it bundles (${lacking.join(', ')}): pack ch-local from a checkout with its node_modules installed (npm ci)` : null;
}

// Each local clone's ref, resolved to its commit -> null or a problem.
function resolveRefs(plan) {
  for (const p of plan) {
    if (p.dir == null) continue;
    const r = run('git', ['-C', p.dir, 'rev-parse', '--verify', `${p.ref}^{commit}`]);
    if (r.status !== 0) return `no ${p.ref} in ${p.dir}`;
    p.commit = r.stdout.trim();
  }
  return null;
}

async function main(argv, io = {stdout: process.stdout, stderr: process.stderr}) {
  const say = (s) => io.stdout.write(s + '\n');
  const fail = (s, code = 1) => { io.stderr.write(`dogfood: ${s}\n`); return code; };
  let args;
  try { args = parseArgs(argv); } catch (err) { io.stderr.write(err.message.endsWith('\n') ? err.message : err.message + '\n'); return 2; }
  const home = homeFor(args);
  const planned = planSources(args);
  if (planned.problem != null) return fail(planned.problem);
  const plan = planned.sources;

  // Every local clone's ref is checked before anything is built.
  const refProblem = resolveRefs(plan);
  if (refProblem != null) return fail(refProblem);

  // a prepared local release only: built into the directory, kept, nothing
  // installed; the command that installs from it is printed
  if (args.releaseDir != null) {
    const dir = path.resolve(args.releaseDir);
    if (releaseLine({dir}) == null) return fail(`${dir}: a release folder's path uses only ASCII letters, digits, spaces and _ / . : @ % + = , ~ - (the setup skill refuses any other)`, 2);
    let st = null;
    try { st = fs.statSync(dir); } catch (e) { st = null; }
    const left = st != null && st.isDirectory() ? fs.readdirSync(dir) : [];
    // (a stage an interrupted run left is named, not hidden: the medium on
    // round 2, 9)
    if (left.length > 0 && left.every((n) => n.startsWith(STAGE))) return fail(`${dir} holds ${left.join(', ')}, left by an interrupted dogfood run: remove it, then run again`, 2);
    if (st != null && (!st.isDirectory() || left.length > 0)) return fail(`${dir} is not a new or empty directory: --release-dir builds into one`, 2);
    // built in a working directory (the sources, the lockfile's scratch),
    // removed after; the folder put together by placeRelease
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-dogfood-work-'));
    try {
      const built = await buildRelease(plan, work, say, {shim: {}});
      if (built.problem != null) return fail(built.problem);
      const problem = placeRelease({release: built.release, pinsFile: built.pinsFile, pins: built.pins, dir});
      if (problem != null) return fail(problem);
      say('');
      say(`A prepared local release is in ${dir}; nothing was installed. It installs with this line, run as written in bash, zsh or Git Bash:`);
      say('');
      say(`  ${releaseLine({dir})}`);
      return 0;
    } catch (err) {
      return fail(err.message);
    } finally {
      fs.rmSync(work, {recursive: true, force: true});
    }
  }

  const {install} = require('../lib/install');
  const {ALLOWLIST} = require('../lib/allowlist');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-dogfood-work-'));
  try {
    const built = await buildRelease(plan, work, say);
    if (built.problem != null) return fail(built.problem);
    const {release, pinsFile} = built;

    // Without this shell's token variables: the client gets its token from the
    // line printed below, and install is not to look at this one's.
    const env = {...process.env, COUNTINGHOUSE_HOME: home, CH_LOCAL_DEV: '1'};
    for (const name of require('../lib/packs').packVariables(ALLOWLIST, PACK)) delete env[name];
    const installIo = {
      env,
      node: process.execPath, version: process.version, platform: process.platform, homedir: os.homedir,
      alive: require('../lib/run-liveness').processAlive, hostname: os.hostname(),
      stdout: io.stdout, stderr: io.stderr,
      exec: async (cmd, a, {cwd}) => run(cmd, a, {cwd}),
      fetch: async () => { throw new Error('dogfood: install makes no network call of its own'); }
    };
    const code = await install({pack: PACK, from: release, unreleasedPins: pinsFile}, installIo);
    if (code !== 0) return fail(`install failed (exit ${code})`, code);
    say('');
    say(instructions({node: process.execPath, home}));
    return 0;
  } catch (err) {
    return fail(err.message);
  } finally {
    fs.rmSync(work, {recursive: true, force: true});
  }
}

// Run only when executed, never when required: test/dogfood.test.js requires it.
if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { process.stderr.write(`dogfood: ${err.message}\n`); process.exitCode = 1; });
}

module.exports = {main, instructions, releaseLine, placeRelease, bundledProblem, parseArgs, sources, planSources, homeFor, buildRelease, shimInto, resolveRefs, run, PACK};
