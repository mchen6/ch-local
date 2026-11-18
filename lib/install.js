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
// - each module of the pack, and of every installed pack this release lists,
//   is placed in the module store at this release's pins (lib/module-store.js),
//   or skipped when it is there already; a release is a tested set, so every
//   installed pack moves to its pins, up or down, with no question
//   (lib/install-plan.js, #413 section 9.4).
// The new app is built beside the old one and replaces it only when it is
// complete; then <home>/bin/ch-local.js runs it and <home>/modules.json
// records it (lib/module-record.js). A home an earlier ch-local made
// (packs.json) is migrated in the same step (section 10).
const fs = require('node:fs');
const path = require('node:path');
const {ALLOWLIST} = require('./allowlist');
const {layout} = require('./home');
const {writeAtomic} = require('./atomic');
const {npm} = require('./npm');
const {pickCredential} = require('./credential');
const {tarballName} = require('./unpack');
const {collect, collectStore} = require('./gc');
const {writeRecord, own} = require('./record');
const {readModulesRecord, writeModulesRecord} = require('./module-record');
const {placeModule, isComplete, readMarker} = require('./module-store');
const plan = require('./install-plan');
const {withLock} = require('./lock');
const {effectiveAllow, UNRELEASED_LINE} = require('./pins');

const SELF = require('../package.json').name;
// the registry npm ci may take dependencies from, whatever its environment or
// any .npmrc says, and the lockfile's resolved hosts never replaced
const NPM_FLAGS = ['--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', '--replace-registry-host=never'];

const {integrityOf} = require('./integrity');

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
// runtimeOnly: an upgrade's install with no pack named: the runtime, and
// every installed pack this release lists brought to its pins; a pack it no
// longer lists stays recorded, its modules withdrawn (section 9.7). Held
// packs are never dropped by an install (nothing is deleted but by
// remove-pack).
async function install({pack, from, unreleasedPins, runtimeOnly = false}, io, release = ALLOWLIST, fromNpm = {}) {
  const say = (s) => io.stdout.write(s + '\n');
  const fail = (s) => io.stderr.write(`ch-local: ${s}\n`);
  const spec = runtimeOnly ? {packages: [], credentials: []} : (own(release.packs, pack) ? release.packs[pack] : null);
  if (spec == null) { fail(`unknown pack "${pack}"; one of: ${Object.keys(release.packs).join(', ')}`); return 2; }
  // the operator's allowlist of packs (the runtime's reader, when one is
  // installed; start enforces it whatever is installed)
  const unlisted = runtimeOnly ? null : notAllowed(layout(io.env, io.homedir), pack, io);
  if (unlisted != null) { fail(unlisted); return 2; }
  if (from == null && unreleasedPins != null) { fail('--unreleased-pins is for tarballs on disk: pass --from <directory of tarballs> with it'); return 2; }
  const eff = effectiveAllow(release, unreleasedPins, io.env);
  if (eff.problem != null) { fail(eff.problem); return 2; }
  let allow = eff.allow;
  const where0 = layout(io.env, io.homedir);
  // what this install takes, read without the lock (installLocked reads it
  // again under it): only the modules the store does not hold at their pin
  // are fetched, so a module already installed is not installed again
  let home0 = {record: null, migrating: null};
  try { home0 = plan.readHome(where0, {release: allow}); } catch (err) { home0 = {record: null, migrating: null}; }
  const touched0 = plan.touchedPacks(home0.record, {pack: runtimeOnly ? null : pack, allow, eff});
  const unpinned = touched0.find((n) => !allow.packs[n].packages.every((m) => allow.pins[m] != null));
  // from npm, ch-local's own pin is the digest its provenance verifies
  const pinned = (name) => allow.pins[name] != null || (from == null && name === SELF);
  if (unpinned != null || !allow.runtime.packages.every(pinned)) { fail(`no release of the pack "${unpinned != null ? unpinned : pack}" is pinned in this ch-local yet`); return 1; }
  const names = [...allow.runtime.packages, ...plan.toFetch(where0, plan.planInstall(home0.record, {pack: runtimeOnly ? null : pack, allow, eff}).modules)];
  if (allow.runtime.lockfile == null) { fail('no lockfile is pinned for the runtime: its dependencies would be unpinned'); return 1; }

  let fetched = null;
  if (from == null && (allow.self == null || allow.release == null || typeof allow.release.version !== 'string')) {
    fail('this ch-local carries no release identity to install from npm with; pass --from <directory of tarballs>');
    return 1;
  }
  if (from == null) {
    // no downgrade from npm: rollback is the way back to an older release
    const rec = home0.record;
    const installed = rec != null && rec.runtime != null && rec.runtime.versions != null ? rec.runtime.versions[SELF] : null;
    const strictGreater = (a, b) => { const re = /^(\d+)\.(\d+)\.(\d+)$/; const x = re.exec(String(a)); const y = re.exec(String(b)); if (x == null || y == null) return false; for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]); return false; };
    if (installed != null && strictGreater(installed, allow.release.version)) {
      fail(`${allow.release.version} is lower than the installed ${installed}: ch-local rollback is the way back; nothing was installed`);
      return 1;
    }
    fetched = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ch-local-release-'));
    try {
      say(`fetching ${names.length} package(s) from the npm registry, each checked against its pin and its provenance`);
      const r = await require('./npm-release').fetchRelease({data: {pins: allow.pins, self: allow.self, runtime: allow.runtime},
        version: allow.release.version, names, dir: path.join(fetched, 'release'), io, verifiedSelf: allow.verifiedSelf || null, ...fromNpm});
      allow = Object.assign({}, allow, {pins: r.pins, runtime: Object.assign({}, allow.runtime, {lockfile: r.lockfile})});
      from = path.join(fetched, 'release');
    } catch (err) {
      fs.rmSync(fetched, {recursive: true, force: true});
      fail(`${err.package != null ? `${err.package}: ` : ''}${err.message}${err.code != null ? ` (${err.code})` : ''}`);
      fail('nothing was installed');
      return 1;
    }
  }
  let code;
  try {
    code = await installFrom({pack, spec, eff, allow, names, from, runtimeOnly}, io, {say, fail});
  } finally {
    if (fetched != null) fs.rmSync(fetched, {recursive: true, force: true});
  }
  // from npm: this platform's native shim too (lib/shim-install.js), after the
  // app is in place, and recorded; a shim that cannot be installed leaves
  // each session its own runtime, said, and fails nothing. Any other install
  // (from --from, or a release with no shim section) sets the one there
  // aside, so a stale shim is never the one used.
  if (code === 0) {
    if (fetched != null && allow.shim != null) await placeShim(allow, io, {say, fail}, fromNpm);
    else setAsideShim(io, say);
  }
  return code;
}

// the shim there, moved to ch-shim.previous: it is not this release's
function setAsideShim(io, say) {
  const where = layout(io.env, io.homedir);
  try {
    if (require('./shim-install').setAside(where.home)) say('the shared runtime\'s shim from before is set aside: each session runs its own runtime');
  } catch (err) {
    io.stderr.write(`ch-local: the shared runtime's shim from before could not be set aside (${err.code || err.message})\n`);
  }
}

async function placeShim(allow, io, {say, fail}, fromNpm) {
  const where = layout(io.env, io.homedir);
  let r;
  try {
    r = await require('./shim-install').installShim({home: where.home, data: {shim: allow.shim, pins: allow.pins}, io, ...fromNpm});
  } catch (err) {
    fail(`the shared runtime's shim could not be installed (${err.message}${err.code != null ? `, ${err.code}` : ''}); each session runs its own runtime`);
    setAsideShim(io, say);
    return;
  }
  const rec = readModulesRecord(where);
  if (r.status === 'installed') {
    rec.shim = {package: allow.shim.packages[`${process.platform}-${process.arch}`], version: r.version};
    say(`the shared runtime's shim ${r.version} is at ${r.path}`);
  } else {
    delete rec.shim;
    say(r.status === 'unpinned' ? 'no shared-runtime shim is pinned for this platform in this release: each session runs its own runtime'
      : 'there is no shared-runtime shim for this platform: each session runs its own runtime');
    setAsideShim(io, say);
  }
  writeModulesRecord(where, rec, {roleOf: plan.roleFor(where), release: allow});
}

const SHIM_JSON_REPAIR = 'the relay\'s settings (shim.json) are missing or invalid, and an automatic upgrade does not write them: run ch-local install to repair the relay\'s settings';

// a shim.json there that this user wrote and the shim would take
function shimJsonKept(home, platform) {
  try {
    const bytes = require('./own-file').readOwnFile(path.join(home, 'shim.json'), {max: 64 * 1024, platform});
    return bytes != null && require('./shim-config').shimJsonProblem(JSON.parse(bytes.toString('utf8')), platform) == null;
  } catch (e) {
    return false;
  }
}

async function installFrom({pack, spec, eff, allow, names, from, runtimeOnly}, io, {say, fail}) {
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
  const code = await withLock(where, io, () => installLocked({pack: runtimeOnly ? null : pack, spec, eff, allow, bytes, where, runtimeOnly}, io, {say, fail}));
  // a running daemon restarts its runtime, or itself, onto what was installed
  // (#236 section 6, "Upgrade"); with none running, nothing is written. After
  // packs.lock is released, never under it: the daemon holds start.lock and
  // waits on packs.lock in its start, so taking start.lock under packs.lock
  // would deadlock (the review of #35).
  if (code === 0) await require('./daemon-requests').requestUpgrade(where.home, {io});
  return code;
}

async function installLocked({pack, spec, eff, allow, bytes, where, runtimeOnly = false}, io, {say, fail}) {
  // An interrupted rollback is finished first: its journal says which app is
  // which, and an install would replace one of them (review of rollback-2).
  if (fs.existsSync(where.journal)) { fail('a rollback was interrupted; run `ch-local rollback` to finish it; nothing was installed'); return 1; }
  // the home as it is now, the earlier format read for its migration
  let home = {record: null, migrating: null};
  try { home = plan.readHome(where, {release: allow}); } catch (err) { home = {record: null, migrating: null}; }
  const previous = home.record;
  const after = plan.planInstall(previous, {pack, allow, eff});
  // every module this install takes is fetched now or whole in the store at
  // its pin (the hint was read without the lock; collection may have run)
  const whole = (m, pin) => isComplete(where, m, pin.version) && readMarker(where, m, pin.version).integrity === pin.integrity;
  const lost = Object.entries(after.modules).filter(([m, pin]) => bytes[m] == null && !whole(m, pin)).map(([m]) => m);
  if (lost.length > 0) { fail(`the module store changed while this install ran (${lost.join(', ')}); run it again; nothing was installed`); return 1; }
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
    // Each module into the module store, or skipped when it is there at its
    // pin; the app holds the runtime only. A module placed here and not
    // recorded (the swap below failing) is collected later.
    try {
      const inUse = plan.inUseFor(where, io);
      for (const [m, pin] of Object.entries(after.modules)) if (bytes[m] != null) placeModule(where, m, bytes[m], pin, {inUse});
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
      // the record as it was, held packs too. A home migrated now keeps its
      // earlier packs.json there, which rollback refuses: the kept release
      // predates the module store (section 10)
      if (home.migrating != null) writeRecord({packs: where.previousRecord}, home.migrating);
      else fs.copyFileSync(where.modulesRecord, where.previousModulesRecord);
    }
    fs.rmSync(old, {recursive: true, force: true});
  } finally {
    fs.rmSync(build, {recursive: true, force: true});
  }
  writeAtomic(where.launcher, shim(path.join(where.app, 'node_modules', ...SELF.split('/'), 'bin', 'ch-local.js')));
  // what the shared runtime's native shim runs (countinghouse #236, section 6).
  // The automatic upgrade never writes it: its environment is the session's
  // (a client config's PATH, HOME, TMPDIR), which the shared daemon would
  // give every client (the review of #48). One missing or invalid there is
  // left, recorded and said: an install from the command repairs it.
  if (allow.keepShimJson === true) {
    if (!shimJsonKept(where.home, io.platform)) {
      require('./history').appendHistory(where, {change: 'shim.json', notice: SHIM_JSON_REPAIR});
      say(SHIM_JSON_REPAIR);
    }
  } else {
    require('./shim-config').writeShimJson(where.home, {node: io.node, env: io.env, platform: io.platform});
  }
  const listedNow = (name) => own(allow.packs || {}, name);
  const written = writeModulesRecord(where, {
    runtime: {versions: runtimeVersions},
    release: allow.release != null ? allow.release : null,
    unreleased: eff.unreleased,
    packs: after.packs,
    held: after.held
  }, {roleOf: plan.roleFor(where), release: allow});
  // the migration ends here: modules.json is the home's record
  if (home.migrating != null) {
    fs.rmSync(where.packs, {force: true});
    say('this home\'s record is now modules.json, its packs\' modules in the module store');
  }
  fs.rmSync(where.installed, {force: true});
  collect(where, {alive: io.alive, hostname: io.hostname});
  collectStore(where, {alive: io.alive, hostname: io.hostname});
  // a module this pack shares with an installed pack, at the same pin, was
  // not installed again
  const sharedWith = (name) => allow.packs[name].packages.filter((m) => bytes[m] == null && previous != null &&
    Object.entries(previous.packs).some(([p, e]) => p !== name && e.modules[m] === allow.pins[m].version));
  if (pack != null) {
    say(`installed the pack "${pack}" into ${where.moduleStore}; clients run ${where.launcher}`);
    const shared = sharedWith(pack);
    if (shared.length > 0) say(`it shares ${shared.map((m) => m.replace(/^@[^/]+\//, '')).join(', ')} with the packs already installed`);
  } else {
    say(`installed ${SELF} ${runtimeVersions[SELF]}; clients run ${where.launcher}`);
  }
  for (const name of after.touched) if (name !== pack) say(`the pack "${name}" is at this release's pins`);
  for (const name of Object.keys(written.packs).filter((n) => !listedNow(n) && eff.unreleased !== true)) say(require('./packs').withdrawnStatusLine(name));
  if (eff.unreleased) io.stderr.write(`ch-local: ${UNRELEASED_LINE}\n`);
  if (pack != null) credentialLines(io, say, spec.credentials);
  return 0;
}

module.exports = {install, tarballName, loadTarballs, appManifest, credentialLines, shimJsonKept, SHIM_JSON_REPAIR};
