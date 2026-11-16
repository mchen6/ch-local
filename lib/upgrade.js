'use strict';
// ch-local upgrade (spec §2, "Upgrade: easy, never silent"): shows the installed
// and available versions and asks once. `--auto on|off` stores the opt-in
// automatic-upgrade setting (off by default) and contacts nothing.
const {layout} = require('./home');
const {latestVersions} = require('./registry');
const {readRecord, packVersions} = require('./record');
const {UNRELEASED_LINE} = require('./pins');
const {appendHistory} = require('./history');
const {findUpgrade, releaseAllow, SELF} = require('./npm-upgrade');

const nums = (v) => String(v).split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
function newer(a, b) {
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// The development overrides (docs/development/auto-upgrade.md,
// "Development overrides never reach a real upgrade"): while one is in force,
// neither upgrade nor the automatic one runs. -> its name, or null
function devOverride(env, record) {
  if (env != null && env.CH_LOCAL_DEV != null && env.CH_LOCAL_DEV !== '') return 'CH_LOCAL_DEV';
  if (env != null && env.CH_LOCAL_REMOTE_MAP != null && env.CH_LOCAL_REMOTE_MAP !== '') return 'CH_LOCAL_REMOTE_MAP';
  if (record != null && record.unreleased === true) return 'an unreleased install';
  return null;
}

// fromNpm: {registry, trust}, passed only by a test's own code
async function upgrade({auto}, io, fromNpm = {}) {
  const say = (s) => io.stdout.write(s + '\n');
  const fail = (s) => io.stderr.write(`ch-local: ${s}\n`);
  const where = layout(io.env, io.homedir);
  if (auto !== undefined) {
    if (auto !== 'on' && auto !== 'off') { fail('--auto takes on or off'); return 2; }
    // turning it on loosens a guarding setting: the ceiling, and a yes at a terminal
    const {code} = await require('./cli-change').cliSet(where, 'autoUpgrade', auto, io);
    if (code !== 0) return code;
    say(auto === 'on'
      ? 'automatic upgrades are on: start checks for new versions at most once a day; a new one, checked by its pins and its provenance, installs automatically 72 hours after it is published, and runs new code with your keys; ch-local rollback undoes one'
      : 'automatic upgrades are off (the default): upgrade always asks');
    return 0;
  }
  let record = null;
  try { record = readRecord(where); } catch (err) { fail(err.message); return 1; }
  if (record == null) { fail('nothing is installed yet'); return 1; }
  const from = record.runtime != null && record.runtime.versions != null ? record.runtime.versions[SELF] : null;
  const history = (outcome, fields) => appendHistory(where, Object.assign({kind: 'upgrade', how: 'cli', outcome, from}, fields));
  if (record.unreleased) { history('override', {reason: 'an unreleased install'}); fail(`${UNRELEASED_LINE}: reinstall with \`ch-local install --pack <name> --from <release directory>\` first`); return 1; }
  const override = devOverride(io.env, record);
  if (override != null) { history('override', {reason: override}); fail(`upgrades are off while a development override is set (${override})`); return 1; }

  const {ALLOWLIST, ALLOWED_ORIGINS} = require('./allowlist');
  const data = Object.assign({}, ALLOWLIST, {allowedOrigins: ALLOWED_ORIGINS});
  const packs = Object.keys(record.packs || {});
  let found;
  try {
    found = await findUpgrade({data, installed: from, packs, io, allowMajor: true, ...fromNpm});
  } catch (err) {
    const to = err.version != null ? err.version : null;
    fail(`${err.package != null ? err.package : SELF}${to != null ? `@${to}` : ''}: ${err.message}: not installed${err.code != null ? ` (${err.code})` : ''}`);
    history(err.code === 'FETCH_FAILED' || err.code === 'FETCH_TOO_LARGE' ? 'unreachable' : 'refused', {to, reason: err.code || err.message});
    return 1;
  }
  if (found.kind === 'up-to-date') { say('everything is up to date'); return 0; }
  say(`ch-local ${from} -> ${found.to}, its provenance checked (published ${found.publishedAt.toISOString()})`);
  // a major goes through every check above; it is shown so, and installed only on a yes
  if (found.major === true) say(`ch-local ${found.to} is a major upgrade: it may change how things work (an automatic upgrade never takes it)`);
  if (found.breaking === true) say('under semver a 0.x minor or 0.0.x patch may break what works now (an automatic upgrade never takes it)');
  if (found.adds.length > 0) say(`it adds:\n${found.adds.map((x) => `  ${x}`).join('\n')}`);
  if (found.identity.length > 0) say(`its identity changes (an automatic upgrade never takes these):\n${found.identity.map((x) => `  ${x}`).join('\n')}`);
  if (found.named.length > 0) say(`for packs not installed:\n${found.named.map((x) => `  ${x}`).join('\n')}`);
  if (packs.length !== 1) { history('several-packs', {to: found.to}); fail(`upgrading a home with ${packs.length} packs arrives later; reinstall each with \`ch-local install\`; nothing changed`); return 1; }
  // the yes is a person's at a terminal, as for any loosening (lib/cli-change.js):
  // a piped answer would take a release under 72 hours, its changes unseen
  if (io.interactive !== true) { history('no-terminal', {to: found.to}); fail(`installing ${found.to} is confirmed at a terminal: run ch-local upgrade in one; nothing changed`); return 2; }
  const answer = String(await io.ask(`Upgrade to ${found.to}? (yes/no) `)).trim().toLowerCase();
  if (answer !== 'yes') { history('declined', {to: found.to}); say('nothing changed'); return 0; }
  const allow = releaseAllow(found.data, found.to, {found, installedSelf: ALLOWLIST.self});
  const code = await require('./install').install({pack: packs[0]}, io, allow, fromNpm);
  if (code !== 0) { history('failed', {to: found.to}); fail(`the upgrade to ${found.to} failed; nothing changed`); return code; }
  history('installed', {to: found.to});
  say(`upgraded ch-local ${from} -> ${found.to}; ch-local rollback undoes it`);
  return 0;
}

// After an install (docs/development/auto-upgrade.md, "Turning it on"): with
// autoUpgrade never answered, asked once, at a terminal only, through
// cliSet, whose own question under the operator's ceiling is the one asked;
// a no is kept as off, so it is never asked again; with no terminal, off,
// said so.
async function offerAuto(io) {
  const say = (s) => io.stdout.write(s + '\n');
  const where = layout(io.env, io.homedir);
  const {readSettings, setSetting} = require('./settings');
  if (readSettings(where).values.autoUpgrade !== undefined) return;
  if (io.interactive !== true) { say('automatic upgrades are off (no terminal to ask); ch-local upgrade --auto on turns them on'); return; }
  say('Automatic upgrades install new versions of ch-local and its packs, each checked by its pin and its provenance, 72 hours after each is published; ch-local rollback undoes one.');
  const {code} = await require('./cli-change').cliSet(where, 'autoUpgrade', 'on', io);
  if (code === 0) { say('automatic upgrades are on'); return; }
  // asked and declined: the answer is kept, never asked again
  if (code === 1) { try { setSetting(where, 'autoUpgrade', 'off', {by: 'cli'}); } catch (e) { /* left unset */ } }
  say('automatic upgrades stay off; ch-local upgrade --auto on turns them on');
}

module.exports = {upgrade, newer, devOverride, offerAuto};
