'use strict';
// The opt-in automatic upgrade check (packs in place, part 2, plan Task B4;
// the spec's "easy, opt-in automatic, never silent"): run by start in the
// background when autoUpgrade is on, at most once a day (or a week, as
// upgradeCheck says), never when it is off or upgradeCheck is never. Its last
// run is stamped in <home>/upgrade-check.json, shared by every start. What it
// finds is said and recorded in <home>/history.jsonl, a failure too.
// When a check is due it runs `<home>/bin/ch-local.js upgrade --apply-auto`
// (lib/auto-apply.js) in a child of its own, with shim.json's environment
// allowlist and the home (no npm_execpath, NODE_OPTIONS, npm_config_*, proxy
// or CA variable: docs/development/auto-upgrade.md), and says each line the
// child prints. The child re-checks everything itself and keeps its own
// fields in upgrade-check.json; this check merges lastCheck into them.
const fs = require('node:fs');
const path = require('node:path');
const {allowedEnv} = require('./shim-config');
const {readSettings, valueOf} = require('./settings');
const {writeAtomic} = require('./atomic');
const {appendHistory} = require('./history');

const PERIOD_MS = {daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000};

// -> {checked: false, why} or {checked: true, newer: [{name, have, latest}]}
// the child fetches, verifies and may install: minutes, not seconds
const TIMEOUT_MS = 15 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;   // a failed check is tried again an hour later
const LOCK_STALE_MS = 10 * 60 * 1000;

// signal: start's end; the child is not stopped by it (an install in progress
// finishes, or is abandoned whole: install swaps its app atomically)
// eslint-disable-next-line no-unused-vars
async function autoCheck({where, io, say, host, now = Date.now(), signal = null, timeoutMs = TIMEOUT_MS}) {
  const settings = readSettings(where);
  if (valueOf(settings, 'autoUpgrade') !== true) return {checked: false, why: 'off'};
  // the operator's ceiling: forbidden, or a ceiling that cannot be trusted, is off
  const {ceilingRefusal, ceilingFor} = require('./ceiling');
  if (ceilingRefusal(ceilingFor(where, {platform: io.platform, env: io.env}), 'autoUpgrade', true) != null) return {checked: false, why: 'ceiling'};
  const period = PERIOD_MS[valueOf(settings, 'upgradeCheck')];
  if (period == null) return {checked: false, why: 'never'};
  const stampFile = path.join(where.home, 'upgrade-check.json');
  let stamp = {};
  try { stamp = JSON.parse(fs.readFileSync(stampFile, 'utf8')) || {}; } catch (err) { stamp = {}; }
  const last = stamp.lastCheck || 0;
  // the child's fields kept: only lastCheck is this check's
  const writeStamp = (lastCheck) => {
    let now2 = {};
    try { now2 = JSON.parse(fs.readFileSync(stampFile, 'utf8')) || {}; } catch (err) { now2 = {}; }
    writeAtomic(stampFile, JSON.stringify(Object.assign(now2, {lastCheck})) + '\n');
  };
  if (now - last < period) return {checked: false, why: 'not due'};
  // one start checks at a time: the others, starting at once, leave it
  const lock = path.join(where.home, 'upgrade-check.lock');
  try {
    fs.writeFileSync(lock, String(now), {flag: 'wx'});
  } catch (err) {
    let at = 0;
    try { at = Number(fs.readFileSync(lock, 'utf8')) || 0; } catch (e) { at = 0; }
    if (now - at < LOCK_STALE_MS) return {checked: false, why: 'another start is checking'};
    fs.writeFileSync(lock, String(now));
  }
  const history = (entry) => appendHistory(where, {by: 'auto-upgrade', ...entry}, {host, pid: io.pid, now});
  try {
    const env = Object.assign(allowedEnv(io.env, io.platform), {COUNTINGHOUSE_HOME: where.home});
    const r = await io.exec(io.node, [where.launcher, 'upgrade', '--apply-auto'], {cwd: where.home, env, timeout: timeoutMs});
    if (r.status !== 0) throw new Error(r.status == null ? `no answer within ${timeoutMs / 1000} s` : `exit ${r.status}: ${String(r.stderr).trim().split('\n').pop() || 'no output'}`);
    writeStamp(now);
    const lines = String(r.stdout).split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) say(line);
    return {checked: true, lines};
  } catch (err) {
    // tried again an hour later, not a whole period
    writeStamp(now - period + RETRY_MS);
    const notice = `automatic upgrade check failed (${err.message}); nothing changed`;
    history({change: 'upgrade check', notice, problem: err.message});
    say(notice);
    return {checked: true, failed: err.message, lines: []};
  } finally {
    fs.rmSync(lock, {force: true});
  }
}

module.exports = {autoCheck, PERIOD_MS};
