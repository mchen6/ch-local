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
// saw the version. In upgrade-check.json:
// - firstSeen: {version: ms};
// - refused: [{version, root}], a version that failed verification, under
//   the root it failed under, not fetched again; a transport failure is
//   never remembered;
// - lastSuccess: the last check that reached the registry; seven days
//   without one are announced.
// Each outcome is one line (`line`, which start shows the session) and one
// history record {kind: 'upgrade', how: 'auto', outcome, from, to, reason}.
// fromNpm: only a test's own code passes it.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {layout} = require('./home');
const {readRecord} = require('./record');
const {readSettings, valueOf} = require('./settings');
const {writeAtomic} = require('./atomic');
const {appendHistory} = require('./history');
const {findUpgrade, releaseAllow, SELF} = require('./npm-upgrade');
const {devOverride} = require('./upgrade');

const H = 3600 * 1000;
const WAIT_MS = 72 * H;
const SILENT_MS = 7 * 24 * H;
const TRANSPORT = new Set(['FETCH_FAILED', 'FETCH_TOO_LARGE']);

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

  const stampFile = path.join(where.home, 'upgrade-check.json');
  let stamp = {};
  try { stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8')) || {}; } catch (e) { stamp = {}; }
  stamp.firstSeen = stamp.firstSeen || {};
  stamp.refused = Array.isArray(stamp.refused) ? stamp.refused : [];
  const save = () => writeAtomic(stampFile, JSON.stringify(stamp) + '\n');
  const root = rootDigest();

  const {ALLOWLIST, ALLOWED_ORIGINS} = require('./allowlist');
  const data = Object.assign({}, ALLOWLIST, {allowedOrigins: ALLOWED_ORIGINS});
  let found;
  try {
    found = await findUpgrade({data, installed: from, packs, io, remembered: (v) => stamp.refused.some((r) => r.version === v && r.root === root), ...fromNpm});
  } catch (err) {
    if (TRANSPORT.has(err.code)) {
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
  if (found.identity.length > 0 || found.adds.length > 0) {
    save();
    const what = found.identity.length > 0 ? `its identity changes (${found.identity.join('; ')})` : `it adds ${found.adds.join('; ')}`;
    return done('needs-upgrade', `ch-local ${found.to} is available, but ${what}: run ch-local upgrade to see it and install`, {to: found.to});
  }
  if (stamp.firstSeen[found.to] == null) stamp.firstSeen[found.to] = now;
  const start = Math.max(found.publishedAt.getTime(), stamp.firstSeen[found.to]);
  if (now - start < WAIT_MS) {
    save();
    return done('waiting', `ch-local ${found.to} is available; it installs automatically after ${new Date(start + WAIT_MS).toISOString()}`, {to: found.to});
  }
  save();
  const allow = releaseAllow(found.data, found.to, {found, installedSelf: ALLOWLIST.self});
  const code = await require('./install').install({pack: packs[0]}, io, allow, fromNpm);
  if (code !== 0) return done('failed', `the upgrade to ${found.to} failed; nothing changed`, {to: found.to});
  return done('installed', `upgraded ch-local ${from} -> ${found.to}; ch-local rollback undoes it`, {to: found.to});
}

module.exports = {autoApply, rootExpired, WAIT_MS};
