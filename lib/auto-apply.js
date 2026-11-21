'use strict';
// `ch-local upgrade --apply-auto` (docs/development/auto-upgrade.md, "The
// child that applies it", "The 72-hour wait", "Announcements"): the
// automatic upgrade, run by start's background check in a child of its own.
// Any process of this user can run it, so it trusts nothing its parent
// decided. It re-checks, in order:
// - autoUpgrade is on, and the operator's ceiling allows it;
// - no development override is in force (CH_LOCAL_DEV, CH_LOCAL_REMOTE_MAP,
//   an unreleased install);
// - the shipped trusted root has not expired (announced at every check);
// - the home's record can be read (one that can't is said, never passed
//   over for the bundled pins).
// A release is installed as one: every pack the release lists moves to its
// pins, whichever way each module's version moves (#413 rev 3 section 9.6;
// L4).
// Then findUpgrade (lib/npm-upgrade.js). A release with identity changes, or
// adding a package, credential or origin, is announced and left to
// `ch-local upgrade`. Otherwise it installs only 72 hours after the later of
// its publish attestation's verified log time and when this install first
// saw the version: it waits unless both are known and 72 hours have passed
// since the later (a malformed time waits, never installs). A 0.x minor or a
// 0.0.x patch is treated as a major (under semver either may break):
// announced, never installed here. In upgrade-check.json (lib/upgrade-stamp.js,
// read only when this user's alone, and held to its shape):
// - firstSeen: {version: ms};
// - refused: [{version, root}], a version that failed verification, under
//   the root it failed under, not fetched again; a transport failure, a
//   version not (yet) on the registry and attestations not (yet) there are
//   never remembered;
// - declined: the versions a rollback left, never installed here again;
// - lastSuccess: the last check that reached the registry; seven days
//   without one are announced.
// The install it runs says nothing of its own: only the one line comes out
// (its output may name paths and credentials), and it keeps shim.json as it
// is, since this child's environment is the session's, not the install's.
// Each outcome is one line (`line`, which start shows the session) and one
// history record {kind: 'upgrade', how: 'auto', outcome, from, to, reason}.
// fromNpm: only a test's own code passes it.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {layout} = require('./home');
const {readModulesRecord: readRecord, earlierLine, judgedDigest} = require('./module-record');
const {readSettings, valueOf} = require('./settings');
const {readStamp, writeStamp} = require('./upgrade-stamp');
const {appendHistory} = require('./history');
const {withdrawnLine, relistedLine, releaseSelection} = require('./packs');
const {findUpgrade, releaseAllow, SELF} = require('./npm-upgrade');
const {devOverride, newer, releaseMoves, autoMovesText} = require('./upgrade');
const {chLocal} = require('./command-line');

const H = 3600 * 1000;
const WAIT_MS = 72 * H;
const SILENT_MS = 7 * 24 * H;
const TRANSPORT = new Set(['FETCH_FAILED', 'FETCH_TOO_LARGE']);
// not yet there: tried again at the next check, never remembered
const TRANSIENT = new Set(['NOT_PUBLISHED', 'NO_PROVENANCE']);

// a trusted root whose every Fulcio CA's window has ended
function rootExpired(trustedRoot, now) {
  const cas = trustedRoot != null && Array.isArray(trustedRoot.certificateAuthorities) ? trustedRoot.certificateAuthorities : [];
  if (cas.length === 0) return true;
  return cas.every((ca) => ca.validFor != null && ca.validFor.end != null && Date.parse(ca.validFor.end) < now);
}

const rootDigest = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'sigstore', 'trusted-root.json'))).digest('hex');

async function autoApply({io, now = Date.now(), fromNpm = {}}) {
  const where = layout(io.env, io.homedir);
  if (valueOf(readSettings(where), 'autoUpgrade') !== true) return {outcome: 'off'};
  const {ceilingRefusal, ceilingFor} = require('./ceiling');
  if (ceilingRefusal(ceilingFor(where, {platform: io.platform, env: io.env}), 'autoUpgrade', true) != null) return {outcome: 'off'};
  let record = null;
  // (nothing installed: nothing to do, said nothing; a record that can't be
  // read: nothing is installed, said with no path, and recorded in history;
  // an earlier format is told to migrate: the Reviewer on L4, and its high, 7)
  try { record = readRecord(where); } catch (e) {
    const earlier = e.code === 'RECORD_EARLIER' || e.code === 'RECORD_EARLIER_DEV';
    const interrupted = fs.existsSync(where.journal);
    // (a development home's own advice names its pack and --from: the
    // medium on the high round, 2)
    const why = e.code === 'RECORD_EARLIER_DEV' ? e.message
      : earlier ? `this home was made by an earlier ch-local: run \`${chLocal(where, 'install')}\` again to bring it to this one`
      : interrupted ? `a rollback was interrupted: run \`${chLocal(where, 'rollback')}\` to finish it`
        : `this home's record can't be read: run \`${chLocal(where, 'status')}\``;
    appendHistory(where, {kind: 'upgrade', how: 'auto', outcome: 'record-unreadable', reason: earlier ? 'earlier' : interrupted ? 'rollback-interrupted' : (e.code || 'unreadable')}, {now});
    return {outcome: 'record-unreadable', line: `automatic upgrades are paused: ${why}`};
  }
  if (record == null) return {outcome: 'off'};
  const from = record.runtime != null && record.runtime.versions != null ? record.runtime.versions[SELF] : null;
  const history = (outcome, fields = {}) => appendHistory(where, Object.assign({kind: 'upgrade', how: 'auto', outcome, from}, fields), {now});
  const done = (outcome, line, fields) => { history(outcome, fields); return {outcome, line}; };

  const override = devOverride(io.env, record);
  if (override != null) return done('override', `automatic upgrades are off while a development override is set (${override})`, {reason: override});
  if (rootExpired(require('./sigstore/trusted-root.json'), now)) return done('root-expired', 'this ch-local\'s signing root is out of date: upgrade by hand');
  const packs = Object.keys(record.packs || {});

  const read = readStamp(where.home, {now, platform: io.platform});
  const stamp = read.stamp;
  // not private: not read; the record (and so the wait) starts again
  if (read.problem != null) history('stamp-reset', {reason: read.problem});
  const save = () => writeStamp(where.home, stamp);
  const root = rootDigest();

  const {ALLOWLIST} = require('./allowlist');
  const data = ALLOWLIST;
  let found;
  try {
    // (additions judged against what the home has installed, by its own
    // release's pins: L4, post-rel L4 baseline)
    found = await findUpgrade({data, now: () => require('./installed-description').homeDescription(where, record, data), installed: from, packs, io, remembered: (v) => stamp.refused.some((r) => r.version === v && r.root === root), ...fromNpm});
  } catch (err) {
    if (TRANSPORT.has(err.code) || TRANSIENT.has(err.code)) {
      if (TRANSIENT.has(err.code)) {
        stamp.lastSuccess = now;
        save();
        return done('not-yet', `${err.package || SELF}@${err.version}: ${err.message}; trying again at the next check`, {to: err.version, reason: err.code});
      }
      // never remembered: tried again an hour later
      const silent = stamp.lastSuccess != null && now - stamp.lastSuccess > SILENT_MS;
      save();
      return done('unreachable', `could not reach the npm registry (${err.message}); trying again in an hour${silent ? `; no upgrade check has succeeded for 7 days` : ''}`, {reason: err.code});
    }
    stamp.lastSuccess = now;
    if (err.version != null) stamp.refused.push({version: err.version, root});
    save();
    return done('refused', `${err.package || SELF}@${err.version}: ${err.message}: not installed (${err.code})`, {to: err.version, reason: err.code});
  }
  stamp.lastSuccess = now;
  if (found.kind === 'up-to-date') { save(); return {outcome: 'none'}; }
  if (found.kind === 'remembered') { save(); return {outcome: 'remembered'}; }
  // a held release is announced once per version, then said no more until
  // a newer one (L4; upgrade-check.json's announced)
  // Keyed by the version and what is said, so a reason that changes is said
  // again; a version no longer newer than the installed one is dropped (the
  // medium on L4, 7)
  const announce = (outcome, line) => {
    const key = crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);
    stamp.announced = stamp.announced.filter((e) => newer(e.version, from));
    if (stamp.announced.some((e) => e.version === found.to && e.key === key)) { save(); return {outcome: 'announced', to: found.to}; }
    stamp.announced.push({version: found.to, key});
    save();
    return done(outcome, line, {to: found.to});
  };
  if (found.kind === 'major') return announce('major', `ch-local ${found.to} is a major upgrade: run ${chLocal(where, 'upgrade')} to install it`);
  // rolled back from: never installed here again (only a newer one, or ch-local upgrade)
  if (stamp.declined.includes(found.to)) { save(); return {outcome: 'declined'}; }
  if (found.breaking === true) return announce('major', `ch-local ${found.to} may break what ${from} does (a 0.x minor or 0.0.x patch): run ${chLocal(where, 'upgrade')} to see it and install`);
  if (found.identity.length > 0 || found.adds.length > 0) {
    const what = found.identity.length > 0 ? `its identity changes (${found.identity.join('; ')})` : `it adds ${found.adds.join('; ')}`;
    return announce('needs-upgrade', `ch-local ${found.to} is available, but ${what}: run ${chLocal(where, 'upgrade')} to see it and install`);
  }
  if (stamp.firstSeen[found.to] === undefined) stamp.firstSeen[found.to] = now;
  const published = found.publishedAt instanceof Date ? found.publishedAt.getTime() : NaN;
  const start = Math.max(published, stamp.firstSeen[found.to]);
  // installs only when both times are known and 72 hours have passed
  if (!(Number.isFinite(start) && now - start >= WAIT_MS)) {
    save();
    const when = Number.isFinite(start) ? new Date(start + WAIT_MS).toISOString() : 'its publish time is known';
    return done('waiting', `ch-local ${found.to} is available; it installs automatically after ${when}`, {to: found.to});
  }
  save();
  const allow = Object.assign(releaseAllow(found.data, found.to, {found, installedSelf: ALLOWLIST.self}), {keepShimJson: true});
  // a release that withdraws the home's pack installs like any other
  // (maintainer's decision, 2026-11-17: usually for a security problem): the
  // runtime only; the pack stays recorded, its modules in the record's
  // withdrawn list, files and data kept; the next start skips it, said
  // (one rule with ch-local upgrade: lib/packs.js releaseSelection; a pack
  // the record has withdrawn and this release lists again never gets here:
  // its modules are additions, so the release was held above)
  const {withdrawn, served, target} = releaseSelection(record, allow, data);
  // what moves, said and recorded: a module moving back and one dropped are
  // never silent, though neither holds the upgrade (the Reviewer's high on
  // L4, 1)
  const moved = releaseMoves(record, allow, packs, served);
  // a pack held after a rollback that this release lists: added back with
  // add-pack, said (a pack the record's withdrawn list names needs nothing:
  // the install brings it to this release's pins)
  const relisted = Object.keys(record.held || {}).filter((name) => Object.prototype.hasOwnProperty.call(allow.packs || {}, name));
  // the install's own lines are kept from the session (they name paths and
  // credentials); its last error line goes to the history record
  const said = [];
  // quiet never prompts: a module that needs a credential is named with its
  // command instead (the Fable pass on L5a, F2)
  const quiet = Object.assign({}, io, {terminal: false, readHidden: undefined, ask: undefined,
    stdout: {write: () => true}, stderr: {write: (x) => { said.push(String(x)); return true; }}});
  // (install from a release moves every pack of the record it lists, at its
  // pins, no version asked: lib/install-plan.js touchedPacks)
  // (the record judged here: install refuses another, under its lock; said
  // once, and the next check judges the home as it is then: the Reviewer's
  // high on #101, round 2)
  // (the shim's outcome, set by install: said here in fixed words)
  const report = {};
  const code = await require('./install').install({...target, judged: judgedDigest(record), report}, quiet, allow, fromNpm);
  if (code !== 0 && said.join('').includes(require('./install').HOME_CHANGED)) {
    return announce('home-changed', `ch-local ${found.to} was not installed: this home changed while the upgrade was prepared; the next check judges it again`);
  }
  // a home another user could write into: install's own line, whole, with
  // its chmod (the reviewer on #122), never a bare "failed"
  const unsafe = code !== 0 ? said.join('').split('\n').find((l) => l.includes(require('./install').HOME_UNSAFE)) : undefined;
  if (unsafe != null) {
    const line = unsafe.replace(/^ch-local: /, '');
    return done('failed', `ch-local ${found.to} was not installed: ${line}`, {to: found.to, reason: line});
  }
  if (code !== 0) return done('failed', `the upgrade to ${found.to} failed; nothing changed`, {to: found.to, reason: said.join('').trim().split('\n').pop() || null});
  // shim.json is never written here: one missing or invalid is said in the line
  const {shimJsonKept} = require('./install');
  const repair = shimJsonKept(where.home, io.platform) ? '' : `; the relay's settings (shim.json) are missing or invalid: run ${chLocal(where, 'install')} to repair the relay's settings`;
  for (const name of withdrawn) appendHistory(where, {change: 'withdrawn', pack: name, by: 'auto-upgrade', to: found.to, notice: withdrawnLine(name, where)}, {now});
  const gone = withdrawn.map((name) => `; ${withdrawnLine(name, where)}`).join('') + relisted.map((name) => `; ${relistedLine(name, where)}`).join('');
  // install's end named each module that needs a credential: carried into
  // the result, which reaches the session, never dropped with the rest of
  // install's lines (the Reviewer's round 3, 9)
  const {isCredentialLine} = require('./credentials-command');
  const needs = said.join('').split('\n').filter((l) => isCredentialLine(l) || /^the stored credentials are not used \(/.test(l));
  const credentialLines = needs.map((l) => `; ${l}`).join('');
  // and a shim that could not be placed (a session still running the old
  // one, say): the way back reaches the session, in fixed words from
  // install's structured outcome -- never install's own lines, which name
  // paths (the reviewer's high on #120, 4)
  const SHIM_SAID = {
    busy: `the shared runtime's shim could not be replaced: a session still uses the old one; close it, then run ${chLocal(where, 'install')} to place the new one`,
    stale: `the shared runtime's shim changed while the upgrade ran: run ${chLocal(where, 'install')} to place it`,
    failed: `the shared runtime's shim could not be installed, so each session runs its own runtime: run ${chLocal(where, 'install')} to try again`
  };
  // (and the one before that could not be set aside, whatever the new one
  // did: a session may still be handed it -- the medium on #120)
  const shimSaid = [];
  if (report.shim != null && report.shim.placed === false && SHIM_SAID[report.shim.why] != null) shimSaid.push(SHIM_SAID[report.shim.why]);
  if (report.shim != null && report.shim.asideFailed === true) shimSaid.push(`the shared runtime's shim from before could not be set aside: run ${chLocal(where, 'install')} to put it right`);
  const shimLines = shimSaid.map((l) => `; ${l}`).join('');
  return done('installed', `upgraded ch-local ${from} -> ${found.to}; ${chLocal(where, 'rollback')} undoes it${autoMovesText(moved)}${gone}${repair}${credentialLines}${shimLines}`, {to: found.to, moves: moved.moves, dropped: moved.dropped});
}

module.exports = {autoApply, rootExpired, WAIT_MS};
