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
// The install command for a prepared local release (--release-dir), as the
// install doc's pre-release variant gives it: this checkout's launcher, with
// CH_LOCAL_DEV=1 and the release's pins
// The one command that installs from a prepared local release <dir>, as the
// setup skill builds it: the folder's own launcher, each path one
// single-quoted word, forward slashes (Windows too: node takes them), the
// folder's path only of FOLDER's characters (the high on #105, 2) -> the line,
// or null for a folder path that isn't
const FOLDER = /^[A-Za-z0-9_/.:@%+=,~ -]+$/;
const slashed = (dir) => String(dir).replace(/\\/g, '/').replace(/\/+$/, '');
function releaseLine({dir}) {
  const f = slashed(dir);
  if (!FOLDER.test(f)) return null;
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
    `  claude mcp add --scope user countinghouse${homeFlag} -- ${word(node)} ${word(launcher)} start --stdio`,
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
async function buildRelease(plan, work, say) {
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
    if (st != null && (!st.isDirectory() || fs.readdirSync(dir).length > 0)) return fail(`${dir} is not a new or empty directory: --release-dir builds into one`, 2);
    // built in a working directory (the sources, the lockfile's scratch),
    // removed after; the folder is put together beside <dir> and renamed into
    // place only once whole, so a failure anywhere leaves no half-made folder
    fs.mkdirSync(path.dirname(dir), {recursive: true});
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-dogfood-work-'));
    const stage = fs.mkdtempSync(path.join(path.dirname(dir), `.${path.basename(dir)}.partial-`));
    try {
      const built = await buildRelease(plan, work, say);
      if (built.problem != null) return fail(built.problem);
      fs.cpSync(built.release, path.join(stage, 'release'), {recursive: true});
      fs.copyFileSync(built.pinsFile, path.join(stage, 'pins.json'));
      // the folder's own launcher: this checkout's ch-local, as packed
      const own = fs.readdirSync(built.release).filter((n) => /ch-local-\d[^/]*\.tgz$/.test(n));
      if (own.length !== 1) return fail(`the release holds ${own.length} ch-local tarballs, not one`);
      const unpacked = fs.mkdtempSync(path.join(work, 'own-'));
      const tar = run('tar', ['-xzf', path.join(built.release, own[0]), '-C', unpacked], {cwd: unpacked});
      if (tar != null && tar.status != null && tar.status !== 0) return fail(`ch-local's tarball could not be unpacked (tar exit ${tar.status})`);
      fs.renameSync(path.join(unpacked, 'package'), path.join(stage, 'ch-local'));
      if (st != null) fs.rmdirSync(dir);
      fs.renameSync(stage, dir);
      say('');
      say(`A prepared local release is in ${dir}; nothing was installed. It installs with:`);
      say('');
      say(`  ${releaseLine({dir})}`);
      if (process.platform === 'win32') say('(on Windows, in Git Bash: the path is written with forward slashes)');
      return 0;
    } catch (err) {
      return fail(err.message);
    } finally {
      fs.rmSync(work, {recursive: true, force: true});
      fs.rmSync(stage, {recursive: true, force: true});
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

module.exports = {main, instructions, releaseLine, parseArgs, sources, planSources, homeFor, buildRelease, resolveRefs, run, PACK};
