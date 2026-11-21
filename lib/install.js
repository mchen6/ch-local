'use strict';
const {notAllowed} = require('./ceiling');
// what an upgrade's install says when the home is not the one it judged
const HOME_CHANGED = 'this home changed while the upgrade was prepared; run it again; nothing was installed';
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
const {tarballName} = require('./unpack');
const {keepOldTreesAside, collectStore} = require('./gc');
const {writeRecord, own} = require('./record');
const {readModulesRecord, writeModulesRecord, buildModulesRecord, writeRecordAsIs, judgedDigest} = require('./module-record');
const {placeModule, versionState} = require('./module-store');
const plan = require('./install-plan');
const {withLock} = require('./lock');
const {effectiveAllow, UNRELEASED_LINE} = require('./pins');
const table = require('./pack-table');
const {chLocal} = require('./command-line');

// install --pack under development pins, over a home with packs, meets
// section 9.4's table as add-pack does (L1b-2: the reviewer's answer, in a
// development home an added pack meets the table). The packs compared are
// every installed one, this pack's earlier entry included, and its new pins
// are judged against the whole record's active versions, so a reinstall
// never lowers a module silently (the high review of #94, 1). A release
// compares none: it brings every pack it lists to its pins and withdraws
// the others (L1a), as do a migration and a runtime-only install.
const tableFor = (home, eff, runtimeOnly, {pack, allow}) => !runtimeOnly && pack != null && home.record != null && home.migrating == null
  && table.fromOtherPins(home.record, plan.fromRelease(allow, eff), {except: eff.unreleased === true ? [] : Object.keys(home.record.packs || {})});

const SELF = require('../package.json').name;
// the registry npm ci may take dependencies from, whatever its environment or
// any .npmrc says, and the lockfile's resolved hosts never replaced
const NPM_FLAGS = ['--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org/', '--replace-registry-host=never'];

const {integrityOf} = require('./integrity');
const {preloadForSwap} = require('./swap-preload');

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

// The launcher written into a home: runs the installed ch-local on THIS home
// unless COUNTINGHOUSE_HOME names another (an explicit variable, or start's
// --home, still wins), so a command printed with this launcher's path runs
// where it says, from any terminal (the reviewer on ch-local#110, 2)
const shim = (installedBin, home) => `#!/usr/bin/env node
'use strict';
// Written by \`ch-local install\`: runs the installed launcher, on this home
// unless COUNTINGHOUSE_HOME names another. Every install writes it again;
// edits are lost.
if (process.env.COUNTINGHOUSE_HOME == null || process.env.COUNTINGHOUSE_HOME === '') process.env.COUNTINGHOUSE_HOME = ${JSON.stringify(home)};
require(${JSON.stringify(installedBin)}).run();
`;

// fromNpm: {registry, trust}, passed only by a test's own code (a fake
// registry and its test root); the command never passes it
// runtimeOnly: an upgrade's install with no pack named: the runtime, and
// every installed pack this release lists brought to its pins; a pack it no
// longer lists stays recorded, its modules withdrawn (section 9.7). Held
// packs are never dropped by an install (nothing is deleted but by
// remove-pack).
// `install` with no --pack (the reviewer on the install hints, 2026-11-21):
// reinstalls exactly what the home's record lists, at this ch-local's own
// pins, through install itself (its checks, its lock, its description
// check). It never adds a pack (the packs are the record's, as an automatic
// upgrade takes them: lib/packs.js releaseSelection) and never moves the
// home to another release than this ch-local's (the pins are this
// release's). Nothing installed: the --pack line. An unreleased home: the
// full line, since its record keeps neither the directory nor the pins file.
// No network: install's fetch says the --from line (reinstalling).
async function reinstall({from, unreleasedPins}, io, release, fromNpm) {
  const fail = (s) => io.stderr.write(`ch-local: ${s}\n`);
  if (unreleasedPins != null) { fail('--unreleased-pins reinstalls only with the pack it is for: pass --pack <name> with it'); return 2; }
  const where = layout(io.env, io.homedir);
  let record;
  try { record = readModulesRecord(where); } catch (err) { fail(`${err.message}; nothing was installed`); return 1; }
  if (record == null) {
    fail(`nothing is installed here, so there is nothing to reinstall: run \`${chLocal(where, 'install --pack <name>')}\` (with --from <directory of tarballs> for tarballs on disk)`);
    return 2;
  }
  if (record.unreleased === true) {
    const first = Object.keys(record.packs || {})[0] || '<name>';
    fail(`this is an unreleased install (development only): reinstall it with \`${chLocal(where, `install --pack ${first} --from <release directory> --unreleased-pins <pins file>`)}\`; nothing was installed`);
    return 2;
  }
  const {target} = require('./packs').releaseSelection(record, release, release);
  return install({...target, from, reinstalling: true}, io, release, fromNpm);
}

async function install({pack, from, unreleasedPins, runtimeOnly = false, judged = null, report = null, reinstalling = false}, io, release = ALLOWLIST, fromNpm = {}) {
  if (pack == null && runtimeOnly !== true) return reinstall({from, unreleasedPins}, io, release, fromNpm);
  const say = (s) => io.stdout.write(s + '\n');
  const fail = (s) => io.stderr.write(`ch-local: ${s}\n`);
  const spec = runtimeOnly ? {modules: []} : (own(release.packs, pack) ? release.packs[pack] : null);
  if (spec == null) { fail(`unknown pack "${pack}"; one of: ${Object.keys(release.packs).join(', ')}`); return 2; }
  // the operator's allowlist of packs (the runtime's reader, when one is
  // installed; start enforces it whatever is installed)
  const unlisted = runtimeOnly ? null : notAllowed(layout(io.env, io.homedir), pack, io, spec.modules);
  if (unlisted != null) { fail(unlisted); return 2; }
  if (from == null && unreleasedPins != null) { fail('--unreleased-pins is for tarballs on disk: pass --from <directory of tarballs> with it'); return 2; }
  const eff = effectiveAllow(release, unreleasedPins, io.env);
  if (eff.problem != null) { fail(eff.problem); return 2; }
  let allow = eff.allow;
  const where0 = layout(io.env, io.homedir);
  // what this install takes, read without the lock (installLocked reads it
  // again under it): only the modules the store does not hold at their pin
  // are fetched, so a module already installed is not installed again
  // (a record this cannot read for an error, not its format, refuses the
  // install here, as under the lock: the medium review of the Reviewer's
  // round on #83, 9)
  let home0 = {record: null, migrating: null};
  try { home0 = plan.readHome(where0, {release: allow, eff}); } catch (err) {
    if (err.code === 'RECORD_IO') { fail(`${err.reason}; nothing was installed`); return 1; }
    home0 = {record: null, migrating: null};
  }
  const touched0 = plan.touchedPacks(home0.record, {pack: runtimeOnly ? null : pack, allow, eff, migrating: home0.migrating != null});
  const unpinned = touched0.find((n) => !allow.packs[n].modules.every((m) => allow.pins[m] != null));
  // from npm, ch-local's own pin is the digest its provenance verifies
  const pinned = (name) => allow.pins[name] != null || (from == null && name === SELF);
  if (unpinned != null || !allow.runtime.packages.every(pinned)) { fail(`no release of the pack "${unpinned != null ? unpinned : pack}" is pinned in this ch-local yet`); return 1; }
  // every pack this install moves (a release moves every pack of the record
  // it lists: #413 rev 3 section 9.6), not only the one named, is held to
  // the operator's allowlist: one it refuses refuses the install, nothing
  // moved (the medium on L4, 3)
  for (const n of touched0) {
    if (n === pack) continue;
    const refused = notAllowed(where0, n, io, allow.packs[n].modules);
    if (refused != null) { fail(refused); return 2; }
  }
  // (a migration reinstalls every pack it lists, from these pins' tarballs)
  const wanted0 = plan.planInstall(home0.record, {pack: runtimeOnly ? null : pack, allow, eff, migrating: home0.migrating != null}).modules;
  let names = [...allow.runtime.packages, ...plan.toFetch(where0, wanted0)];
  if (allow.runtime.lockfile == null) { fail('no lockfile is pinned for the runtime: its dependencies would be unpinned'); return 1; }
  // the table's questions, asked before the lock and anything written
  // (lib/pack-table.js askAll); checked again under the lock
  let asked = null;
  // the tarballs read now, each once, are installFrom's too
  let preBytes = {};
  if (tableFor(home0, eff, runtimeOnly, {pack, allow})) {
    const before = table.decideBeforeLock(where0, home0.record, pack, spec, allow.pins, (n) => loadTarballs(from, n, allow.pins));
    if (before.problems != null) { for (const p of before.problems) fail(p); fail('nothing was installed'); return 1; }
    preBytes = before.bytes;
    const got = await table.askAll(where0, before.decided, pack, io, fail);
    if (got.code != null) return got.code;
    asked = got.signature;
    // a module the table does not place is not fetched (the high review of #94, 3)
    const notPlaced = new Set(before.decided.rows.filter((r) => !r.place && r.case !== 'same').map((r) => r.module));
    names = names.filter((n) => !notPlaced.has(n));
  }

  let fetched = null;
  // the shim, prepared (from npm: prepareShim's answer), or null: the one
  // there is set aside (from --from, or a release with no shim section)
  let shimReady = null;
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
      fail(`${allow.release.version} is lower than the installed ${installed}: ${chLocal(where0, 'rollback')} is the way back; nothing was installed`);
      return 1;
    }
    fetched = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ch-local-release-'));
    try {
      say(`fetching ${names.length} package(s) from the npm registry, each checked against its pin and its provenance`);
      const r = await require('./npm-release').fetchRelease({data: {pins: allow.pins, self: allow.self, runtime: allow.runtime},
        version: allow.release.version, names, dir: path.join(fetched, 'release'), io, verifiedSelf: allow.verifiedSelf || null, ...fromNpm});
      allow = Object.assign({}, allow, {pins: r.pins, runtime: Object.assign({}, allow.runtime, {lockfile: r.lockfile})});
      from = path.join(fetched, 'release');
      // this platform's native shim, fetched and verified now, before the
      // lock; placed and recorded inside the install's one locked record
      // write (the medium on B-shim-allow)
      if (allow.shim != null) shimReady = await require('./shim-install').prepareShim({data: {shim: allow.shim, pins: allow.pins}, record: home0.record, home: where0.home, io, ...fromNpm});
    } catch (err) {
      fs.rmSync(fetched, {recursive: true, force: true});
      // a reinstall that can't reach the registry: one line, with the way
      // that needs no network (the reviewer: never a prompt, since hints are
      // run by agents and scripts too)
      if (reinstalling && err.code === 'FETCH_FAILED') {
        fail(`could not fetch this release from the npm registry (${err.message}); with no network, run \`${chLocal(where0, 'install --from <release directory>')}\` with this release's tarballs; nothing was installed`);
        return 1;
      }
      fail(`${err.package != null ? `${err.package}: ` : ''}${err.message}${err.code != null ? ` (${err.code})` : ''}`);
      fail('nothing was installed');
      return 1;
    }
  }
  let code;
  try {
    code = await installFrom({pack, spec, eff, allow, names, from, runtimeOnly, asked, preBytes, judged, planned: touched0, shimReady, report}, io, {say, fail});
  } finally {
    if (fetched != null) fs.rmSync(fetched, {recursive: true, force: true});
  }
  return code;
}

// every line the shim step fails with starts so
const SHIM_LINE = 'the shared runtime\'s shim';

// The shim step, under the lock, after the app is swapped and before the
// one record write: the plan's shim put in place and named in the record
// (built.shim), or the one there set aside and the record naming none, so
// the record always names what is in place and a rollback never restores a
// shim that was not this release's (the medium on B-shim-allow: one lock,
// one write; and before a running daemon is asked to restart). A shim that
// cannot be placed leaves each session its own runtime, said, and fails
// nothing.
// report.shim: {placed: true} | {placed: false, why: 'busy' | 'stale' |
// 'failed' | 'unpinned' | 'unsupported' | 'none', asideFailed?: true (the
// one before could not be set aside)} -- what an automatic
// upgrade says, in its own fixed words (never install's lines, which name
// paths: the reviewer's high on #120, 4)
function shimStep(where, ready, built, io, {say, fail}, report = null) {
  const si = require('./shim-install');
  const outcome = (o) => { if (report != null) report.shim = Object.assign(o, report.shim != null && report.shim.asideFailed === true ? {asideFailed: true} : {}); };
  const asideFailed = () => { if (report != null && report.shim != null) report.shim.asideFailed = true; };
  outcome({placed: false, why: ready == null ? 'none' : ready.status === 'unpinned' || ready.status === 'unsupported' ? ready.status : 'failed'});
  // (nothing throws past here: the app is already swapped -- the medium on
  // B-shim-allow's round 3, 2)
  try {
    shimStepInner(si, where, ready, built, {say, fail}, outcome, asideFailed);
  } catch (err) {
    // (as any failure: set aside, the record naming none)
    delete built.shim;
    outcome({placed: false, why: 'failed'});
    fail(`${SHIM_LINE} could not be installed (${err != null && err.message != null ? err.message : String(err)}${err != null && err.code != null ? `, ${err.code}` : ''}); each session runs its own runtime`);
    try { si.setAside(where.home); } catch (e) { asideFailed(); fail(`${SHIM_LINE} from before could not be set aside (${e.code || e.message})`); }
  }
}
function shimStepInner(si, where, ready, built, {say, fail}, outcome, asideFailed) {
  const aside = () => {
    try {
      if (si.setAside(where.home)) say('the shared runtime\'s shim from before is set aside: each session runs its own runtime');
    } catch (err) {
      asideFailed();
      fail(`${SHIM_LINE} from before could not be set aside (${err.code || err.message})`);
    }
  };
  if (ready == null) return aside();
  if (ready.status === 'unsupported' || ready.status === 'unpinned') {
    say(ready.status === 'unpinned' ? 'no shared-runtime shim is pinned for this platform in this release: each session runs its own runtime'
      : 'there is no shared-runtime shim for this platform: each session runs its own runtime');
    return aside();
  }
  const failed = (err) => {
    delete built.shim;
    // (a stale shim never runs: set aside, the record naming none -- the
    // reviewer's ruling (b) on a busy one, with the way back said)
    const code = err != null ? err.code : null;
    outcome({placed: false, why: code === 'SHIM_BUSY' ? 'busy' : code === 'SHIM_STALE' ? 'stale' : 'failed'});
    if (code === 'SHIM_BUSY') fail(`${SHIM_LINE} could not be replaced: a session still uses the old one. Close that session (or the client running it), then run \`${chLocal(where, 'install')}\` to place the new one; until then each session runs its own runtime`);
    // (the shim in place changed since it was judged current, before the
    // lock: another install or a rollback meanwhile -- the medium's round 3)
    else if (code === 'SHIM_STALE') fail(`${SHIM_LINE} in place changed while this install ran: run \`${chLocal(where, 'install')}\` again to place it; until then each session runs its own runtime`);
    else fail(`${SHIM_LINE} could not be installed (${err != null && err.message != null ? err.message : 'an error'}${code != null ? `, ${code}` : ''}); each session runs its own runtime`);
    aside();
  };
  if (ready.status === 'failed') return failed(ready.error);
  try {
    const r = si.placeShim(where.home, ready);
    built.shim = {package: ready.name, version: ready.version};
    outcome({placed: true});
    say(`the shared runtime's shim ${r.version} is at ${r.path}`);
  } catch (err) {
    failed(err);
  }
}

// (where: the home's layout, for the command's launcher form:
// lib/command-line.js)
const shimJsonRepair = (where) => `the relay's settings (shim.json) are missing or invalid, and an automatic upgrade does not write them: run ${chLocal(where, 'install')} to repair the relay's settings`;

// a shim.json there that this user wrote and the shim would take
function shimJsonKept(home, platform) {
  try {
    const bytes = require('./own-file').readOwnFile(path.join(home, 'shim.json'), {max: 64 * 1024, platform});
    return bytes != null && require('./shim-config').shimJsonProblem(JSON.parse(bytes.toString('utf8')), platform) == null;
  } catch (e) {
    return false;
  }
}

// shimReady: install's prepared shim (see shimStep), carried into the lock;
// report: the caller's, where the shim's outcome is set
async function installFrom({pack, spec, eff, allow, names, from, runtimeOnly, asked = null, preBytes = {}, judged = null, planned = null, shimReady = null, report = null}, io, {say, fail}) {
  // (a tarball read before the lock is not read or hashed again)
  const loaded = loadTarballs(from, names.filter((n) => preBytes[n] == null), allow.pins);
  const problems = loaded.problems;
  const bytes = {...preBytes, ...loaded.bytes};
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
  // (the packs it moved, as planned under the lock: installLockedInner)
  const moved = {touched: []};
  const code = await withLock(where, io, () => installLocked({pack: runtimeOnly ? null : pack, spec, eff, allow, bytes, where, runtimeOnly, asked, from, moved, judged, planned, shimReady, report}, io, {say, fail}));
  // a running daemon restarts its runtime, or itself, onto what was installed
  // (#236 section 6, "Upgrade"); with none running, nothing is written. After
  // packs.lock is released, never under it: the daemon holds start.lock and
  // waits on packs.lock in its start, so taking start.lock under packs.lock
  // would deadlock (the review of #35).
  if (code === 0) await require('./daemon-requests').requestUpgrade(where.home, {io});
  // each of the pack's modules that needs a credential and has none stored
  // (#413 section 6.2): after the lock, never holding it while someone types
  // (every pack it moved, as planned under the lock, the runtime-only
  // install's included, so a module it brought in is asked for too: the
  // medium on L4, 3; the Reviewer's high on L4, 4 and 5)
  const asking = [...new Set([...(!runtimeOnly && pack != null ? spec.modules : []), ...moved.touched.flatMap((n) => (own(allow.packs, n) ? allow.packs[n].modules : []))])];
  if (code === 0 && asking.length > 0) await require('./credentials-command').askMissing(io, asking);
  return code;
}

// A record set aside goes back whenever this install ends without writing
// the new one, a throw included (the medium review of the Reviewer's round
// on #83, 3): nothing is left with no record and nothing said.
async function installLocked(args, io, cbs) {
  const guard = {putBack: null, written: false};
  try {
    return await installLockedInner(args, io, cbs, guard);
  } catch (err) {
    if (!guard.written && guard.putBack != null) guard.putBack();
    throw err;
  }
}

async function installLockedInner({pack, spec, eff, allow, bytes, where, runtimeOnly = false, asked = null, from = null, moved = {touched: []}, judged = null, planned = null, shimReady = null, report = null}, io, {say, fail}, guard) {
  // An interrupted rollback is finished first: its journal says which app is
  // which, and an install would replace one of them (review of rollback-2).
  if (fs.existsSync(where.journal)) { fail(`a rollback was interrupted; run \`${chLocal(where, 'rollback')}\` to finish it; nothing was installed`); return 1; }
  // The home as it is now, the earlier format read for its migration (a
  // migration reinstalls every pack it lists from the pinned tarballs: the
  // Reviewer on #83). A record that cannot be read is never taken for
  // "nothing installed" silently:
  // - a format problem (not JSON, not a record of either shape) is set aside
  //   and named, just before the swap, and this install starts a new one,
  //   the rollback target kept (#83's high review, 4);
  // - an error reading it (EACCES, EIO, EMFILE, EBUSY: the file may be
  //   whole) refuses the install, and drops no pack (the Reviewer's check of
  //   #83's fixes, 4);
  // - a home an earlier development launcher made (installed.json only) is
  //   installed over, as before.
  let home;
  let setAside = null;
  try {
    home = plan.readHome(where, {release: allow, eff});
  } catch (err) {
    if (err.code === 'RECORD_EARLIER_DEV') {
      home = {record: null, migrating: null};
    } else if (err.code === 'RECORD_FORMAT') {
      setAside = {why: err.reason, moved: []};
      home = {record: null, migrating: null};
    } else {
      fail(`${err.reason || err.message}; nothing was installed`);
      return 1;
    }
  }
  const previous = home.record;
  // an upgrade's install acts only on the record it judged: the preview,
  // what it adds and what moves were said of that one (the Reviewer's high
  // on #101, round 2). Another (a pack added during the question, one
  // removed or a rollback during the fetch) refuses, before anything is
  // planned, so no pack the record here lacks is written back
  if (judged != null && judgedDigest(previous) !== judged) { fail(HOME_CHANGED); return 1; }
  const after = plan.planInstall(previous, {pack, allow, eff, migrating: home.migrating != null});
  // every pack this plan moves is held to the operator's allowlist again,
  // as planned here under the lock: the record read before it may have
  // changed (the Reviewer's high on L4, 5)
  for (const n of after.touched) {
    const refused = notAllowed(where, n, io, allow.packs[n].modules);
    if (refused != null) { fail(refused); return 2; }
  }
  // an install that judged no record (install, add-pack): a pack the record
  // gained since its first read was never fetched for, asked about, nor
  // checked as this install's: nothing is installed, said (an upgrade's
  // digest above covers this and more: the medium on #101 round 2, 2)
  const gained = planned == null ? [] : after.touched.filter((n) => !planned.includes(n));
  if (gained.length > 0) { fail(`this home's packs changed while this install ran (${gained.join(', ')}): run it again; nothing was installed`); return 1; }
  moved.touched = after.touched;
  // under development pins, the table as decided and answered before the
  // lock (a change since is refused): a module never lowered is recorded at
  // the installed version and not placed at the pack's
  let rows = [];
  const tableRan = tableFor(home, eff, runtimeOnly, {pack, allow});
  if (tableRan) {
    const again = table.recheck(where, previous, pack, spec, allow.pins, asked);
    if (again.problem != null) { fail(again.problem); return 1; }
    rows = again.rows;
    for (const r of rows) {
      after.packs[pack].modules[r.module] = r.recordAs;
      if (!r.place && r.case !== 'same') delete after.modules[r.module];
    }
  }
  // What is placed, before anything is: each module this install takes,
  // from its fetched, integrity-checked tarball, unless the store holds it
  // whole at its pin already. One look at each version's marker and
  // directory in this plan (the Reviewer's check of #83's fixes, 10;
  // placeModule checks again under its own guard as it places); one that
  // cannot be read refuses the install
  const placements = [];
  const lost = [];
  try {
    for (const [m, pin] of Object.entries(after.modules)) {
      const {marker, dir} = versionState(where, m, pin.version);
      if (dir && marker != null && marker.integrity === pin.integrity) continue;
      if (bytes[m] != null) placements.push({m, version: pin.version, integrity: pin.integrity, bytes: bytes[m], pin, marker});
      else lost.push(m);
    }
  } catch (err) {
    fail(`${err.message}; nothing was installed`);
    return 1;
  }
  // a module the table kept before the lock (not read) that it now places,
  // the home having changed meanwhile: read now, as add-pack does (the
  // medium review of the round, 4)
  // (or no longer runs: the packs it compared went)
  if (lost.length > 0 && from != null) {
    const late = loadTarballs(from, lost, allow.pins);
    // (read now: the description check reads them too)
    Object.assign(bytes, late.bytes);
    for (const m of lost.filter((x) => late.bytes[x] != null)) {
      const pin = after.modules[m];
      placements.push({m, version: pin.version, integrity: pin.integrity, bytes: late.bytes[m], pin, marker: versionState(where, m, pin.version).marker});
    }
    lost.splice(0, lost.length, ...lost.filter((x) => late.bytes[x] == null));
  }
  if (lost.length > 0) { fail(`the module store changed while this install ran (${lost.join(', ')}); run it again; nothing was installed`); return 1; }
  // each module as the pins describe it (#413 section 9.3; L5b): what an
  // upgrade showed is what is installed. Before anything is placed.
  // (at the version the record will hold each at: section 9.4's table can
  // keep one installed at another version)
  // (calls resolve to what a start would load once this install is made:
  // the home after it, by start's own rule; the packs it changes at their
  // new versions, a module the new version drops gone: the Reviewer's high
  // review of #98's round 2, 1 and 5)
  // (unreleased as this install writes it: from the pins it runs on alone; a
  // clean install from a release resets it: the medium on the cut, 1)
  const afterState = {...after, unreleased: eff.unreleased === true};
  // (its withdrawn list as the write derives it: the medium on round 2, 2)
  const afterContext = require('./description-check').activeContext({...afterState, withdrawn: require('./module-record').withdrawnOf(afterState, allow)}, allow);
  const notDescribed = require('./description-check').descriptionRefusal(where, Object.keys(after.modules), allow, bytes, (m) => (after.modules[m] != null ? after.modules[m].version : allow.pins[m].version),
    afterContext, {live: new Set(Object.keys(afterContext))});
  if (notDescribed != null) { fail(`${notDescribed}; nothing was installed`); return 1; }
  // Never other contents under a version the record names: a rebuild of one
  // version (development pins) needs a new version (#83's high review, 8).
  // Refused before anything is placed.
  const recorded = new Set();
  for (const r of [previous, (() => { try { return readModulesRecord({modulesRecord: where.previousModulesRecord}); } catch (e) { return null; } })()]) {
    if (r == null) continue;
    for (const e of [...Object.values(r.packs || {}), ...Object.values(r.held || {})]) for (const [m, v] of Object.entries(e.modules || {})) recorded.add(`${m}@${v}`);
  }
  for (const p of placements) {
    if (p.marker != null && p.marker.integrity !== p.integrity && recorded.has(`${p.m}@${p.version}`)) {
      fail(`${p.m} ${p.version} is installed with other contents; a changed module takes a new version (a rebuild of one version is not installed over the one the record names); nothing was installed`);
      return 1;
    }
  }
  const build = `${where.app}.new`;
  const old = `${where.app}.old`;
  const runtimeVersions = Object.fromEntries(allow.runtime.packages.map((name) => [name, allow.pins[name].version]));
  let built = null;
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
      for (const p of placements) placeModule(where, p.m, p.bytes, p.pin, {inUse});
    } catch (err) {
      fail(`${err.message}; nothing was installed`);
      return 1;
    }
    // the record this install writes, built and checked now, before anything
    // is swapped: one that would not be valid changes nothing (the medium
    // review of L1a-2, 4)
    try {
      built = buildModulesRecord({runtime: {versions: runtimeVersions}, release: allow.release != null ? allow.release : null, unreleased: eff.unreleased,
        packs: after.packs, held: after.held}, {roleOf: plan.roleFor(where), release: allow});
    } catch (err) {
      fail(`${err.message}; nothing was installed`);
      return 1;
    }
    // An unreadable record is set aside now, as nothing after this refuses
    // but the swap, which puts it back; one that cannot be moved stops the
    // install with nothing changed, never overwritten (the Reviewer's check
    // of #83's fixes, 5)
    // never silent: a record that cannot go back is named, where it is and
    // what to do (the Reviewer's round on #83, 5)
    const putBack = () => {
      for (const [f, to] of setAside != null ? setAside.moved.slice().reverse() : []) {
        try { fs.renameSync(to, f); } catch (e) { fail(`your previous record could not be put back (${e.code || e.message}): it is at ${to}; rename it to ${path.basename(f)}`); }
      }
    };
    guard.putBack = putBack;
    if (setAside != null) {
      const at = new Date().toISOString().replace(/[:.]/g, '-');
      for (const f of [where.modulesRecord, where.packs]) {
        if (!fs.existsSync(f)) continue;
        const to = `${f}.unreadable-${at}`;
        try {
          fs.renameSync(f, to);
          setAside.moved.push([f, to]);
        } catch (e) {
          putBack();
          fail(`${setAside.why}; it could not be set aside (${e.code || e.message}); nothing was installed`);
          return 1;
        }
      }
    }
    // The swap: the old app moves aside, the new one takes its place; if that
    // fails (a client holding files open on Windows), the old one goes back.
    fs.rmSync(old, {recursive: true, force: true});
    // (everything the code after the swap may require, loaded from this
    // release first: lib/swap-preload.js)
    preloadForSwap();
    const hadApp = fs.existsSync(where.app);
    // (put back once: after it, nothing is left for the guard to put back)
    const busy = (err) => { putBack(); guard.putBack = null; fail(`could not replace ${where.app} (${err.code || err.message}); is a client running it? the previous install is unchanged`); return 1; };
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
    // the new app is in: an unreadable record set aside stays aside (putting
    // it back beside the new app would be worse); the message names it (the
    // medium review of the Reviewer's round, 8), said now. Kept for reference
    // only: what it named is not kept for it (the medium review of #83's
    // fixes, 8)
    guard.putBack = null;
    if (setAside != null) say(`the home's record could not be read (${setAside.why}); it is kept as ${setAside.moved.map(([, to]) => path.basename(to)).join(' and ')} for reference, and this install starts a new one: add the other packs again with \`${chLocal(where, 'add-pack <pack>')}\``);
    // The replaced release's programs are kept, one level, for rollback
    // (<home>/previous: its app and its record). Data is never moved. A
    // reinstall of the same release keeps what was kept: replacing it with a
    // copy of the current release would lose the real rollback target.
    const sameRelease = previous != null && previous.release != null && previous.release.version != null &&
      allow.release != null && previous.release.version === allow.release.version;
    // (a record set aside keeps the rollback target as it was: what this
    // install replaces is not known)
    if (!sameRelease && setAside == null) fs.rmSync(where.previous, {recursive: true, force: true});
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
  writeAtomic(where.launcher, shim(path.join(where.app, 'node_modules', ...SELF.split('/'), 'bin', 'ch-local.js'), where.home));
  // (what upgrade --check found was for the release before this one)
  require('./upgrade').forgetAvailable(where);
  // what the shared runtime's native shim runs (countinghouse #236, section 6).
  // The automatic upgrade never writes it: its environment is the session's
  // (a client config's PATH, HOME, TMPDIR), which the shared daemon would
  // give every client (the review of #48). One missing or invalid there is
  // left, recorded and said: an install from the command repairs it.
  if (allow.keepShimJson === true) {
    if (!shimJsonKept(where.home, io.platform)) {
      require('./history').appendHistory(where, {change: 'shim.json', notice: shimJsonRepair(where)});
      say(shimJsonRepair(where));
    }
  } else {
    require('./shim-config').writeShimJson(where.home, {node: io.node, env: io.env, platform: io.platform});
  }
  // the shim, placed (or set aside) and named in the record it writes
  shimStep(where, shimReady, built, io, {say, fail}, report);
  const listedNow = (name) => own(allow.packs || {}, name);
  const written = writeRecordAsIs(where.modulesRecord, built);
  guard.written = true;
  // the migration ends here: modules.json is the home's record, holding
  // only the packs these pins list, reinstalled. Every other pack of the
  // earlier record (unlisted, unpinned, held, withdrawn) is not carried
  // over: named, and the earlier ch-local's packs/ directory is kept whole
  // beside the home, never collected, so nothing is deleted (the Reviewer's
  // round on #83: one rule)
  if (home.migrating != null) {
    fs.rmSync(where.packs, {force: true});
    say('this home\'s record is now modules.json, its packs\' modules in the module store');
    // its pack.* settings become enabled.<module> in the same operation
    // (section 10); a failure here is said, never undoes the install (start
    // still reads pack.<name> as its module's entry, off winning)
    try {
      for (const mv of require('./settings').migratePackSettings(where, written)) say(`${mv.setting} is now ${mv.to}`);
    } catch (err) {
      say(`the settings' pack.* names were not moved (${err.code || err.message}); they are still read as their modules' entries`);
    }
    // each pack of the earlier record not carried over, once, with why
    // (the medium review of the Reviewer's round, 5 to 7)
    const old = home.migrating;
    const named = [...new Set([...Object.keys(old.packs || {}), ...Object.keys(old.held || {})])].filter((n) => !after.touched.includes(n));
    for (const name of named) {
      const spec = own(allow.packs || {}, name) ? allow.packs[name] : null;
      const addAgain = chLocal(where, `add-pack ${name}`);
      const why = spec == null ? `add it again with \`${addAgain}\` once a release lists it`
        : !spec.modules.every((m) => allow.pins[m] != null) ? `these pins do not pin all of its modules; add it again with \`${addAgain}\` with pins that do`
          : `add it again with \`${addAgain}\``;
      say(`not carried over: ${name}; ${why}`);
    }
  }
  // the earlier ch-local's pack trees: never deleted, kept aside whole once
  // no start from before uses them (lib/gc.js keepOldTreesAside)
  const aside = keepOldTreesAside(where, {alive: io.alive, hostname: io.hostname});
  if (aside.keptAt != null) say(`the earlier packs' files are kept at ${aside.keptAt}`);
  else if (aside.waiting === true) say('the earlier packs\' files stay in place while a client from before runs from them; a later install keeps them aside');
  else if (aside.problem != null) fail(aside.problem);
  fs.rmSync(where.installed, {force: true});
  collectStore(where, {alive: io.alive, hostname: io.hostname});
  // a module this pack shares with an installed pack, at the same pin, was
  // not installed again
  const sharedWith = (name) => allow.packs[name].modules.filter((m) => bytes[m] == null && previous != null &&
    Object.entries(previous.packs).some(([p, e]) => p !== name && e.modules[m] === allow.pins[m].version));
  if (pack != null) {
    say(`installed the pack "${pack}" into ${where.moduleStore}; clients run ${where.launcher}`);
    // as the table decided it, when it ran (add-pack's set and text)
    const shared = tableRan ? table.sharedOf(rows) : sharedWith(pack);
    if (shared.length > 0) say(table.sharesText(shared));
    for (const line of table.changedLines(rows, pack, where)) say(line);
  } else {
    say(`installed ${SELF} ${runtimeVersions[SELF]}; clients run ${where.launcher}`);
  }
  for (const name of after.touched) if (name !== pack) say(`the pack "${name}" is at this release's pins`);
  for (const name of Object.keys(written.packs).filter((n) => !listedNow(n) && eff.unreleased !== true)) say(require('./packs').withdrawnStatusLine(name, where));
  // a pack held after a rollback that this release lists: add-pack brings it
  // back (the medium review of L1a-2, 2)
  for (const name of Object.keys(written.held || {}).filter(listedNow)) say(require('./packs').relistedLine(name, where));
  if (eff.unreleased) io.stderr.write(`ch-local: ${UNRELEASED_LINE}\n`);
  return 0;
}

module.exports = {install, tarballName, loadTarballs, appManifest, shimJsonKept, shimJsonRepair, HOME_CHANGED, launcherText: shim};
