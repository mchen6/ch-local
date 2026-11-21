'use strict';
// ch-local upgrade (spec §2, "Upgrade: easy, never silent"): shows the installed
// and available versions and asks once. `--auto on|off` stores the opt-in
// automatic-upgrade setting (off by default) and contacts nothing.
const {layout} = require('./home');
const {latestVersions} = require('./registry');
const {readModulesRecord: readRecord, own, judgedDigest} = require('./module-record');
const {UNRELEASED_LINE} = require('./pins');
const {appendHistory} = require('./history');
const {findUpgrade, releaseAllow, SELF, pluginVersionOf, PLUGIN_MANIFEST} = require('./npm-upgrade');
const {withdrawnLine, removeHint, releaseSelection} = require('./packs');
const {short} = require('./release-pins');
const {chLocal} = require('./command-line');

const nums = (v) => String(v).split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
function newer(a, b) {
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// What a release does to the installed modules (#413 rev 3 section 9.6: the
// preview, before anything is fetched), from the home's record and the new
// release's pins. packs: the record's packs (those the release lists are the
// ones it moves, a pack relisted after a withdrawal included: install's
// touchedPacks). Judged per pack, against that pack's own list in the new
// release (the medium on L4, 4 and 5); each module is told once, with every
// such pack that holds it (as additions does):
//   moves:   [{module, from, to, back, packs}]: a version that changes,
//            back saying it moves back
//   dropped: [{module, packs, keptBy}]: a module a pack no longer lists;
//            keptBy, the served packs (releaseSelection's) whose new list
//            keeps it (it stays running through them), or none (section 9.7:
//            it stays installed and is not started; the Reviewer's high on
//            L4, 6; a pack not running keeps nothing running: its medium, 6)
// A pack the release does not list is withdrawn as a whole and said so
// elsewhere; its modules are not counted here.
function releaseMoves(record, allow, packs, served = packs) {
  const moved = new Map();     // module -> {from, to, packs}
  const dropped = new Map();   // module -> [pack]
  for (const name of packs) {
    if (!own(allow.packs, name) || !own(record.packs, name)) continue;
    const listed = new Set(allow.packs[name].modules || []);
    for (const m of Object.keys(record.packs[name].modules || {})) {
      if (!listed.has(m)) { if (!dropped.has(m)) dropped.set(m, []); dropped.get(m).push(name); continue; }
      const was = own(record.modules, m) ? record.modules[m].version : null;
      const to = own(allow.pins, m) ? allow.pins[m].version : null;
      if (was == null || to == null || was === to) continue;
      if (!moved.has(m)) moved.set(m, {from: was, to, packs: []});
      moved.get(m).packs.push(name);
    }
  }
  const keeps = (m) => served.filter((n) => own(allow.packs, n) && own(record.packs, n) && (allow.packs[n].modules || []).includes(m)).sort();
  const byName = ([a], [b]) => (a < b ? -1 : 1);
  return {
    moves: [...moved].sort(byName).map(([m, x]) => ({module: m, from: x.from, to: x.to, back: newer(x.from, x.to), packs: x.packs.sort()})),
    dropped: [...dropped].sort(byName).map(([m, ps]) => ({module: m, packs: ps.sort(), keptBy: keeps(m)}))
  };
}
const droppedWhat = (x) => (x.keptBy.length > 0 ? `it stays running through ${x.keptBy.join(', ')}` : 'it stays installed and is not started');
// the preview's lines for releaseMoves()
function movesLines({moves, dropped}) {
  const lines = [];
  if (moves.length > 0) {
    lines.push(`its modules move:\n${moves.map((x) => `  ${short(x.module)} ${x.from} -> ${x.to}${x.back ? ', back to an earlier version' : ''} (${x.packs.join(', ')})`).join('\n')}`);
  }
  if (dropped.length > 0) {
    lines.push(`it no longer lists:\n${dropped.map((x) => `  ${short(x.module)} (${x.packs.join(', ')}): ${droppedWhat(x)}`).join('\n')}`);
  }
  return lines;
}
// The automatic upgrade's session line (the Reviewer's high on L4, 1): a
// module moving back and a module dropped are never silent, though neither
// holds the upgrade. -> its parts, each starting "; ".
function autoMovesText({moves, dropped}) {
  return moves.filter((x) => x.back).map((x) => `; ${short(x.module)} moved back ${x.from} -> ${x.to} (${x.packs.join(', ')})`).join('') +
    dropped.map((x) => `; ${short(x.module)} is no longer in ${x.packs.join(', ')}: ${droppedWhat(x)}`).join('');
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

// The Claude Code plugin's version in the installed release: the home's
// installed ch-local package's manifest, else this ch-local's own (null:
// none readable)
function installedPlugin(where) {
  const read = (file) => pluginVersionOf(() => require('node:fs').readFileSync(file, 'utf8'));
  const app = read(require('node:path').join(where.app, 'node_modules', ...SELF.split('/'), ...PLUGIN_MANIFEST.split('/')));
  return app != null ? app : read(require('node:path').join(__dirname, '..', ...PLUGIN_MANIFEST.split('/')));
}
// The plugin step, said whenever the release's plugin version differs from
// the installed release's: Claude Code's own steps, as its CLI help gives
// them (`claude plugin --help`, 2.1.329: marketplace update, then plugin
// update, "restart required to apply"). Said whether or not the user has
// updated already; no program is run to find out (the reviewer, 11-20).
// (installed: the installed release's version, read BEFORE any install: after
// it the home's app holds the new release's manifest) -> the line, or null
function pluginStep(found, installed, done) {
  // (newer only: never a "move" back; the medium on the easy upgrades, 5)
  if (found.plugin == null || installed == null || !newer(found.plugin, installed)) return null;
  return `If you use the countinghouse plugin in Claude Code, it ${done ? 'moved' : 'moves'} with this release (${installed} -> ${found.plugin}): ${done ? '' : 'after the upgrade, '}run \`claude plugin marketplace update ch-packs\`, then \`claude plugin update ch-packs@ch-packs\`, then restart Claude Code.`;
}
// `upgrade --check`'s result, for the overview: <home>/upgrade-available.json,
// written whole (not upgrade-check.json, the automatic upgrade's own stamp,
// which decides when new code runs)
// (a result that no longer holds -- a check that could not be made, an
// install, a rollback -- is removed, never left saying an update is there:
// the medium on the easy upgrades, 3; a write that fails changes nothing the
// check says, 7)
const AVAILABLE_FILE = 'upgrade-available.json';
function writeAvailable(where, fields) {
  try {
    require('./atomic').writeAtomic(require('node:path').join(where.home, AVAILABLE_FILE), `${JSON.stringify(Object.assign({v: 1, checkedAt: new Date().toISOString()}, fields))}\n`);
  } catch (e) { /* the overview then says nothing of it */ }
}
function forgetAvailable(where) {
  try { require('node:fs').rmSync(require('node:path').join(where.home, AVAILABLE_FILE), {force: true}); } catch (e) { /* as above */ }
}

// fromNpm: {registry, trust}, passed only by a test's own code
// check: `upgrade --check`, read-only: everything upgrade shows up to its
// question, then the install line for the user's own terminal; nothing asked
// or installed, no terminal needed, nothing recorded in history; the result
// written for the overview (A-own-skill's easy upgrades)
async function upgrade({auto, check = false}, io, fromNpm = {}) {
  const say = (s) => io.stdout.write(s + '\n');
  const where = layout(io.env, io.homedir);
  // (a check that could not be made leaves no earlier answer standing: the
  // medium on the easy upgrades, 3)
  const fail = (s) => { if (check) forgetAvailable(where); io.stderr.write(`ch-local: ${s}\n`); };
  if (auto !== undefined) {
    if (auto !== 'on' && auto !== 'off') { fail('--auto takes on or off'); return 2; }
    // turning it on loosens a guarding setting: the ceiling, and a yes at a terminal
    const {code} = await require('./cli-change').cliSet(where, 'autoUpgrade', auto, io);
    if (code !== 0) return code;
    say(auto === 'on'
      ? `automatic upgrades are on: start checks for new versions at most once a day; a new one, checked by its pins and its provenance, installs automatically 72 hours after it is published, and runs new code with your keys; ${chLocal(where, 'rollback')} undoes one`
      : 'automatic upgrades are off (the default): upgrade always asks');
    return 0;
  }
  let record = null;
  try { record = readRecord(where); } catch (err) { fail(err.message); return 1; }
  if (record == null) { fail('nothing is installed yet'); return 1; }
  const from = record.runtime != null && record.runtime.versions != null ? record.runtime.versions[SELF] : null;
  const history = (outcome, fields) => { if (!check) appendHistory(where, Object.assign({kind: 'upgrade', how: 'cli', outcome, from}, fields)); };
  if (record.unreleased) { history('override', {reason: 'an unreleased install'}); fail(`${UNRELEASED_LINE}: reinstall with \`${chLocal(where, 'install --pack <name> --from <release directory>')}\` first`); return 1; }
  const override = devOverride(io.env, record);
  if (override != null) { history('override', {reason: override}); fail(`upgrades are off while a development override is set (${override})`); return 1; }

  const {ALLOWLIST} = require('./allowlist');
  const data = ALLOWLIST;
  const packs = Object.keys(record.packs || {});
  let found;
  try {
    // (additions judged against what the home has installed: L4)
    // (computed only once a release is found to judge: the medium on L4, 8)
    // (by the home's own release's pins, whichever ch-local runs: post-rel
    // L4 baseline)
    const now = () => require('./installed-description').homeDescription(where, record, data);
    found = await findUpgrade({data, now, installed: from, packs, io, allowMajor: true, ...fromNpm});
  } catch (err) {
    const to = err.version != null ? err.version : null;
    fail(`${err.package != null ? err.package : SELF}${to != null ? `@${to}` : ''}: ${err.message}: not installed${err.code != null ? ` (${err.code})` : ''}`);
    history(err.code === 'FETCH_FAILED' || err.code === 'FETCH_TOO_LARGE' ? 'unreachable' : 'refused', {to, reason: err.code || err.message});
    return 1;
  }
  if (found.kind === 'up-to-date') {
    if (check) writeAvailable(where, {installed: from, available: null, major: false, breaking: false, plugin: null});
    say('everything is up to date');
    return 0;
  }
  say(`ch-local ${from} -> ${found.to}, its provenance checked (published ${found.publishedAt.toISOString()})`);
  // a major goes through every check above; it is shown so, and installed only on a yes
  if (found.major === true) say(`ch-local ${found.to} is a major upgrade: it may change how things work (an automatic upgrade never takes it)`);
  if (found.breaking === true) say('under semver a 0.x minor or 0.0.x patch may break what works now (an automatic upgrade never takes it)');
  if (found.adds.length > 0) say(`it adds:\n${found.adds.map((x) => `  ${x}`).join('\n')}`);
  if (found.identity.length > 0) say(`its identity changes (an automatic upgrade never takes these):\n${found.identity.map((x) => `  ${x}`).join('\n')}`);
  if (found.named.length > 0) say(`for packs not installed:\n${found.named.map((x) => `  ${x}`).join('\n')}`);
  // A release is a tested set, installed as one (#413 rev 3 section 9.6;
  // L4): every pack the release lists moves to its pins in one operation,
  // whichever way each module's version moves, and none is asked about. A
  // pack the record lists as withdrawn stays recorded (section 9.7); one the
  // release lists again is served again, its modules additions ("it adds"
  // says so: the Reviewer's high on L4, 4); a home with no pack served
  // still upgrades, runtime only (a later release may be the security fix
  // it needs)
  // a release that withdraws the home's pack still upgrades (maintainer's
  // decision, 2026-11-17: a pack is usually withdrawn for a security problem,
  // and the old release would keep running it): the runtime only, the pack's
  // entry, files and data kept; start then skips it, said
  const allow = releaseAllow(found.data, found.to, {found, installedSelf: ALLOWLIST.self});
  // (one rule with the automatic upgrade: lib/packs.js releaseSelection)
  const {withdrawn, served, target} = releaseSelection(record, allow, data);
  if (withdrawn.length > 0) say(`it withdraws:\n${withdrawn.map((x) => `  ${x} (it stays installed and is not started after the upgrade; ${removeHint(x, where)})`).join('\n')}`);
  // each installed module whose version changes, and each the release no
  // longer lists, once each (section 9.6)
  for (const line of movesLines(releaseMoves(record, allow, packs, served))) say(line);
  // (the installed release's plugin version, read before anything installs)
  const pluginBefore = installedPlugin(where);
  const step = pluginStep(found, pluginBefore, false);
  if (check) {
    writeAvailable(where, {installed: from, available: found.to, major: found.major === true, breaking: found.breaking === true,
      plugin: found.plugin != null ? {installed: pluginBefore, latest: found.plugin} : null});
    if (step != null) say(step);
    say(`To install it, run in your own terminal: \`${chLocal(where, 'upgrade')}\``);
    return 0;
  }
  // the yes is a person's at a terminal, as for any loosening (lib/cli-change.js):
  // a piped answer would take a release under 72 hours, its changes unseen
  if (io.interactive !== true) { history('no-terminal', {to: found.to}); fail(`installing ${found.to} is confirmed at a terminal: run ${chLocal(where, 'upgrade')} in one; nothing changed`); return 2; }
  const answer = String(await io.ask(`Upgrade to ${found.to}? (yes/no) `)).trim().toLowerCase();
  if (answer !== 'yes') { history('declined', {to: found.to}); say('nothing changed'); return 0; }
  // (install from a release moves every pack of the record the release
  // lists, at its pins, with no version question: lib/install-plan.js
  // touchedPacks; a home with none it lists is the runtime only)
  // (the record this preview judged: install refuses another, under its lock)
  const code = await require('./install').install({...target, judged: judgedDigest(record)}, io, allow, fromNpm);
  if (code !== 0) { history('failed', {to: found.to}); fail(`the upgrade to ${found.to} failed; nothing changed`); return code; }
  history('installed', {to: found.to});
  const pluginMoved = pluginStep(found, pluginBefore, true);
  say(`upgraded ch-local ${from} -> ${found.to}; ${chLocal(where, 'rollback')} undoes it`);
  for (const name of withdrawn) {
    appendHistory(where, {change: 'withdrawn', pack: name, by: 'cli', to: found.to, notice: withdrawnLine(name, where)});
    say(withdrawnLine(name, where));
  }
  if (pluginMoved != null) say(pluginMoved);
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
  if (io.interactive !== true) { say(`automatic upgrades are off (no terminal to ask); ${chLocal(where, 'upgrade --auto on')} turns them on`); return; }
  say(`Automatic upgrades install new versions of ch-local and its packs, each checked by its pin and its provenance, 72 hours after each is published; ${chLocal(where, 'rollback')} undoes one.`);
  const {code} = await require('./cli-change').cliSet(where, 'autoUpgrade', 'on', io);
  if (code === 0) { say('automatic upgrades are on'); return; }
  // asked and declined: the answer is kept, never asked again
  if (code === 1) { try { setSetting(where, 'autoUpgrade', 'off', {by: 'cli'}); } catch (e) { /* left unset */ } }
  say(`automatic upgrades stay off; ${chLocal(where, 'upgrade --auto on')} turns them on`);
}

module.exports = {releaseMoves, movesLines, autoMovesText, upgrade, newer, devOverride, offerAuto, forgetAvailable, AVAILABLE_FILE};
