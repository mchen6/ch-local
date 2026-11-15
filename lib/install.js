'use strict';
const {notAllowed} = require('./ceiling');
// ch-local install --pack <name> [--from <dir>] [--unreleased-pins <file>]
// (spec §2, "Install at exact versions"; reviewer, 2026-11-12): every tarball
// is checked against its pinned version and integrity first. With no --from,
// the tarballs come from the npm registry (lib/npm-release.js): each matches
// its pin and passes its provenance, ch-local's own by its provenance alone,
// before any is written to a temporary release directory, which is then read
// exactly as --from's is (docs/development/auto-upgrade.md). Then:
// - the runtime (this launcher and countinghouse) goes into <home>/app as an
//   npm project with its pinned lockfile, by `npm ci --omit=optional`, which
//   checks every dependency against that lockfile too;
// - the pack's dependency-free packages are unpacked beside it (lib/unpack.js).
// The new app is built beside the old one and replaces it only when it is
// complete; then <home>/bin/ch-local.js runs it and <home>/packs.json records
// it. An install replaces the whole app: other packs the home held are
// dropped, and install names them.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {ALLOWLIST} = require('./allowlist');
const {layout} = require('./home');
const {writeAtomic} = require('./atomic');
const {npm} = require('./npm');
const {pickCredential} = require('./credential');
const {tarballName} = require('./unpack');
const {placePack} = require('./pack-dir');
const {collect} = require('./gc');
const {readRecord, writeRecord, own, withoutHeld} = require('./record');
const {withLock} = require('./lock');
const {effectiveAllow, UNRELEASED_LINE} = require('./pins');

const SELF = require('../package.json').name;
// the registry npm ci may take dependencies from, whatever its environment or
// any .npmrc says, and the lockfile's resolved hosts never replaced
const NPM_FLAGS = ['--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', '--replace-registry-host=never'];

const integrityOf = (buf) => 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');

// The tarballs for `packages`, each read once: {problems, bytes}. Only
// bytes whose integrity is the pinned one are returned, and those same bytes
// are what is unpacked or handed to npm (reviewer, 2026-11-12), so a file
// changed after the check is never installed. A tarball no pin names is a
// problem; another pinned package's tarball (a release directory holds every
// pack) is not.
function loadTarballs(from, packages, pins) {
  let files;
  try {
    files = fs.readdirSync(from).filter((f) => f.endsWith('.tgz'));
  } catch (err) {
    return {problems: [`cannot read ${from} (${err.code})`], bytes: {}};
  }
  const known = new Set(Object.entries(pins).map(([name, pin]) => tarballName(name, pin.version)));
  const problems = files.filter((f) => !known.has(f)).map((f) => `${f} is not on this launcher's allowlist`);
  const bytes = {};
  for (const name of packages) {
    const file = tarballName(name, pins[name].version);
    const at = `${name}@${pins[name].version}`;
    if (!files.includes(file)) { problems.push(`${at}: no ${file} in ${from}`); continue; }
    let buf;
    try {
      buf = fs.readFileSync(path.join(from, file));
    } catch (err) {
      problems.push(`${at}: cannot read ${file} (${err.code || err.message})`);
      continue;
    }
    if (integrityOf(buf) !== pins[name].integrity) problems.push(`${at}: the tarball's integrity is not the pinned one`);
    else bytes[name] = buf;
  }
  return {problems, bytes};
}

// The app's package.json: each runtime tarball as a file: dependency. A
// release generates the runtime's lockfile from exactly this.
function appManifest(runtime, pins) {
  return {
    name: 'countinghouse-home-app',
    private: true,
    dependencies: Object.fromEntries(runtime.packages.map((name) => [name, `file:tarballs/${tarballName(name, pins[name].version)}`])),
    chLocal: {runtime: Object.fromEntries(runtime.packages.map((name) => [name, pins[name].version]))}
  };
}

const shim = (installedBin) => `#!/usr/bin/env node
'use strict';
// Written by \`ch-local install\`: runs the installed launcher. Every install
// writes it again; edits are lost.
require(${JSON.stringify(installedBin)}).run();
`;

function credentialLines(io, say, credentials) {
  for (const name of credentials) say(`${name} is ${pickCredential(io.env, [name]) != null ? 'set' : 'not set'}`);
  const chosen = pickCredential(io.env, credentials);
  say(chosen != null ? `start will use ${chosen.name}` : `set ${credentials.join(' or ')} in the environment your client starts from`);
}

// fromNpm: {registry, trust}, passed only by a test's own code (a fake
// registry and its test root); the command never passes it
async function install({pack, from, unreleasedPins}, io, release = ALLOWLIST, fromNpm = {}) {
  const say = (s) => io.stdout.write(s + '\n');
  const fail = (s) => io.stderr.write(`ch-local: ${s}\n`);
  const spec = own(release.packs, pack) ? release.packs[pack] : null;
  if (spec == null) { fail(`unknown pack "${pack}"; one of: ${Object.keys(release.packs).join(', ')}`); return 2; }
  // the operator's allowlist of packs (the runtime's reader, when one is
  // installed; start enforces it whatever is installed)
  const unlisted = notAllowed(layout(io.env, io.homedir), pack, io);
  if (unlisted != null) { fail(unlisted); return 2; }
  if (from == null && unreleasedPins != null) { fail('--unreleased-pins is for tarballs on disk: pass --from <directory of tarballs> with it'); return 2; }
  const eff = effectiveAllow(release, unreleasedPins, io.env);
  if (eff.problem != null) { fail(eff.problem); return 2; }
  let allow = eff.allow;
  const names = [...allow.runtime.packages, ...spec.packages];
  // from npm, ch-local's own pin is the digest its provenance verifies
  const pinned = (name) => allow.pins[name] != null || (from == null && name === SELF);
  if (!names.every(pinned)) { fail(`no release of the pack "${pack}" is pinned in this ch-local yet`); return 1; }
  if (allow.runtime.lockfile == null) { fail('no lockfile is pinned for the runtime: its dependencies would be unpinned'); return 1; }

  let fetched = null;
  if (from == null && (allow.self == null || allow.release == null || typeof allow.release.version !== 'string')) {
    fail('this ch-local carries no release identity to install from npm with; pass --from <directory of tarballs>');
    return 1;
  }
  if (from == null) {
    // no downgrade from npm: rollback is the way back to an older release
    let installed = null;
    try { const rec = readRecord(layout(io.env, io.homedir)); installed = rec != null && rec.runtime != null && rec.runtime.versions != null ? rec.runtime.versions[SELF] : null; } catch (e) { installed = null; }
    const strictGreater = (a, b) => { const re = /^(\d+)\.(\d+)\.(\d+)$/; const x = re.exec(String(a)); const y = re.exec(String(b)); if (x == null || y == null) return false; for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]); return false; };
    if (installed != null && strictGreater(installed, allow.release.version)) {
      fail(`${allow.release.version} is lower than the installed ${installed}: ch-local rollback is the way back; nothing was installed`);
      return 1;
    }
    fetched = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ch-local-release-'));
    try {
      say(`fetching ${names.length} package(s) from the npm registry, each checked against its pin and its provenance`);
      const r = await require('./npm-release').fetchRelease({data: {pins: allow.pins, self: allow.self, runtime: allow.runtime},
        version: allow.release.version, names, dir: path.join(fetched, 'release'), io, ...fromNpm});
      allow = Object.assign({}, allow, {pins: r.pins, runtime: Object.assign({}, allow.runtime, {lockfile: r.lockfile})});
      from = path.join(fetched, 'release');
    } catch (err) {
      fs.rmSync(fetched, {recursive: true, force: true});
      fail(`${err.package != null ? `${err.package}: ` : ''}${err.message}${err.code != null ? ` (${err.code})` : ''}`);
      fail('nothing was installed');
      return 1;
    }
  }
  try {
    return await installFrom({pack, spec, eff, allow, names, from}, io, {say, fail});
  } finally {
    if (fetched != null) fs.rmSync(fetched, {recursive: true, force: true});
  }
}

async function installFrom({pack, spec, eff, allow, names, from}, io, {say, fail}) {
  const {problems, bytes} = loadTarballs(from, names, allow.pins);
  // the lockfile against the runtime tarballs just read: a bundled entry only
  // where its parent's tarball really holds it (lib/lockfile-rules.js)
  if (problems.length === 0) {
    const why = require('./lockfile-rules').lockfileProblem(allow.runtime.lockfile, {runtime: allow.runtime.packages, pins: allow.pins, tarballs: bytes});
    if (why != null) problems.push(why);
  }
  if (problems.length > 0) {
    for (const p of problems) fail(p);
    fail('nothing was installed');
    return 1;
  }

  const where = layout(io.env, io.homedir);
  // The home is install's to create; the lock only guards it.
  fs.mkdirSync(where.home, {recursive: true});
  return withLock(where, io, () => installLocked({pack, spec, eff, allow, bytes, where}, io, {say, fail}));
}

async function installLocked({pack, spec, eff, allow, bytes, where}, io, {say, fail}) {
  // An interrupted rollback is finished first: its journal says which app is
  // which, and an install would replace one of them (review of rollback-2).
  if (fs.existsSync(where.journal)) { fail('a rollback was interrupted; run `ch-local rollback` to finish it; nothing was installed'); return 1; }
  let previous = null;
  try { previous = readRecord(where); } catch (err) { previous = null; }
  const build = `${where.app}.new`;
  const old = `${where.app}.old`;
  const runtimeVersions = Object.fromEntries(allow.runtime.packages.map((name) => [name, allow.pins[name].version]));
  fs.rmSync(build, {recursive: true, force: true});
  try {
    fs.mkdirSync(path.join(build, 'tarballs'), {recursive: true});
    for (const name of allow.runtime.packages) fs.writeFileSync(path.join(build, 'tarballs', tarballName(name, allow.pins[name].version)), bytes[name]);
    fs.writeFileSync(path.join(build, 'package.json'), JSON.stringify(appManifest(allow.runtime, allow.pins), null, 2) + '\n');
    fs.writeFileSync(path.join(build, 'package-lock.json'), JSON.stringify(allow.runtime.lockfile, null, 2) + '\n');
    say(`npm ci in ${build}`);
    const r = await npm(io, ['ci', ...NPM_FLAGS], build);
    if (r.status !== 0) {
      fail(`npm ci failed (exit ${r.status}); the previous install, if any, is unchanged`);
      if (r.stderr) io.stderr.write(String(r.stderr).split('\n').slice(-20).join('\n') + '\n');
      return 1;
    }
    const installed = path.join(build, 'node_modules', ...SELF.split('/'));
    const got = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
    if (got !== runtimeVersions[SELF]) { fail(`the installed ${SELF} is ${got}, not the pinned ${runtimeVersions[SELF]}; nothing was installed`); return 1; }
    // The pack in its version's own tree (packs in place, part 2); the app
    // holds the runtime only.
    try {
      if (spec.packages.length > 0) placePack(where, pack, bytes, spec.packages, allow.pins);
    } catch (err) {
      fail(`${err.message}; nothing was installed`);
      return 1;
    }
    // The swap: the old app moves aside, the new one takes its place; if that
    // fails (a client holding files open on Windows), the old one goes back.
    fs.rmSync(old, {recursive: true, force: true});
    const hadApp = fs.existsSync(where.app);
    const busy = (err) => { fail(`could not replace ${where.app} (${err.code || err.message}); is a client running it? the previous install is unchanged`); return 1; };
    try {
      if (hadApp) fs.renameSync(where.app, old);
    } catch (err) {
      return busy(err);
    }
    try {
      fs.renameSync(build, where.app);
    } catch (err) {
      if (hadApp) fs.renameSync(old, where.app);
      return busy(err);
    }
    // The replaced release's programs are kept, one level, for rollback
    // (<home>/previous: its app and its record). Data is never moved. A
    // reinstall of the same release keeps what was kept: replacing it with a
    // copy of the current release would lose the real rollback target.
    const sameRelease = previous != null && previous.release != null && previous.release.version != null &&
      allow.release != null && previous.release.version === allow.release.version;
    if (!sameRelease) fs.rmSync(where.previous, {recursive: true, force: true});
    if (!sameRelease && hadApp && previous != null) {
      fs.mkdirSync(where.previous, {recursive: true});
      fs.renameSync(old, where.previousApp);
      writeRecord({packs: where.previousRecord}, withoutHeld(previous));
    }
    fs.rmSync(old, {recursive: true, force: true});
  } finally {
    fs.rmSync(build, {recursive: true, force: true});
  }
  writeAtomic(where.launcher, shim(path.join(where.app, 'node_modules', ...SELF.split('/'), 'bin', 'ch-local.js')));
  // what the shared runtime's native shim runs (countinghouse #236, section 6)
  require('./shim-config').writeShimJson(where.home, {node: io.node, env: io.env, platform: io.platform});
  writeRecord(where, {
    runtime: {versions: runtimeVersions},
    packs: {[pack]: {packages: Object.fromEntries(spec.packages.map((name) => [name, allow.pins[name].version])), credentials: spec.credentials}},
    unreleased: eff.unreleased,
    release: allow.release != null ? allow.release : null
  });
  fs.rmSync(where.installed, {force: true});
  collect(where, {alive: io.alive, hostname: io.hostname});
  say(`installed the pack "${pack}" into ${path.join(where.packsDir, pack)}; clients run ${where.launcher}`);
  for (const dropped of [...Object.keys(previous != null ? previous.packs : {}), ...Object.keys(previous != null && previous.held != null ? previous.held : {})].filter((p) => p !== pack)) {
    say(`the pack "${dropped}" was dropped; add it again with \`ch-local add-pack ${dropped}\``);
  }
  if (eff.unreleased) io.stderr.write(`ch-local: ${UNRELEASED_LINE}\n`);
  credentialLines(io, say, spec.credentials);
  return 0;
}

module.exports = {install, tarballName, loadTarballs, appManifest, credentialLines};
