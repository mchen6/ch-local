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
// - one pack is installed (more is left to ch-local upgrade).
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
const {readRecord} = require('./record');
const {readSettings, valueOf} = require('./settings');
const {readStamp, writeStamp} = require('./upgrade-stamp');
const {appendHistory} = require('./history');
const {findUpgrade, releaseAllow, SELF} = require('./npm-upgrade');
const {devOverride} = require('./upgrade');

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
  try { record = readRecord(where); } catch (e) { record = null; }
  if (record == null) return {outcome: 'off'};
  const from = record.runtime != null && record.runtime.versions != null ? record.runtime.versions[SELF] : null;
  const history = (outcome, fields = {}) => appendHistory(where, Object.assign({kind: 'upgrade', how: 'auto', outcome, from}, fields), {now});
  const done = (outcome, line, fields) => { history(outcome, fields); return {outcome, line}; };

  const override = devOverride(io.env, record);
  if (override != null) return done('override', `automatic upgrades are off while a development override is set (${override})`, {reason: override});
  if (rootExpired(require('./sigstore/trusted-root.json'), now)) return done('root-expired', 'this ch-local\'s signing root is out of date: upgrade by hand');
  const packs = Object.keys(record.packs || {});
  if (packs.length !== 1) return done('several-packs', `automatic upgrades handle a home with one pack; this one has ${packs.length}: run ch-local upgrade`);

  const read = readStamp(where.home, {now, platform: io.platform});
  const stamp = read.stamp;
  // not private: not read; the record (and so the wait) starts again
  if (read.problem != null) history('stamp-reset', {reason: read.problem});
  const save = () => writeStamp(where.home, stamp);
  const root = rootDigest();

  const {ALLOWLIST, ALLOWED_ORIGINS} = require('./allowlist');
  const data = Object.assign({}, ALLOWLIST, {allowedOrigins: ALLOWED_ORIGINS});
  let found;
  try {
    found = await findUpgrade({data, installed: from, packs, io, remembered: (v) => stamp.refused.some((r) => r.version === v && r.root === root), ...fromNpm});
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
  if (found.kind === 'major') { save(); return done('major', `ch-local ${found.to} is a major upgrade: run ch-local upgrade to install it`, {to: found.to}); }
  // rolled back from: never installed here again (only a newer one, or ch-local upgrade)
  if (stamp.declined.includes(found.to)) { save(); return {outcome: 'declined'}; }
  if (found.breaking === true) {
    save();
    return done('major', `ch-local ${found.to} may break what ${from} does (a 0.x minor or 0.0.x patch): run ch-local upgrade to see it and install`, {to: found.to});
  }
  if (found.identity.length > 0 || found.adds.length > 0) {
    save();
    const what = found.identity.length > 0 ? `its identity changes (${found.identity.join('; ')})` : `it adds ${found.adds.join('; ')}`;
    return done('needs-upgrade', `ch-local ${found.to} is available, but ${what}: run ch-local upgrade to see it and install`, {to: found.to});
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
  // the install's own lines are kept from the session (they name paths and
  // credentials); its last error line goes to the history record
  const said = [];
  const quiet = Object.assign({}, io, {stdout: {write: () => true}, stderr: {write: (x) => { said.push(String(x)); return true; }}});
  const code = await require('./install').install({pack: packs[0]}, quiet, allow, fromNpm);
  if (code !== 0) return done('failed', `the upgrade to ${found.to} failed; nothing changed`, {to: found.to, reason: said.join('').trim().split('\n').pop() || null});
  return done('installed', `upgraded ch-local ${from} -> ${found.to}; ch-local rollback undoes it`, {to: found.to});
}

module.exports = {autoApply, rootExpired, WAIT_MS};
