'use strict';
// The opt-in automatic upgrade check (packs in place, part 2, plan Task B4;
// the spec's "easy, opt-in automatic, never silent"): run by start in the
// background when autoUpgrade is on, at most once a day (or a week, as
// upgradeCheck says), never when it is off or upgradeCheck is never. Its last
// run is stamped in <home>/upgrade-check.json, shared by every start. What it
// finds is said and recorded in <home>/history.jsonl, a failure too.
// Installing from npm arrives with the first release (lib/upgrade.js): until
// then a newer version is announced, not installed.
const fs = require('node:fs');
const path = require('node:path');
const {readRecord, packVersions} = require('./record');
const {latestVersions} = require('./registry');
const {readSettings, valueOf} = require('./settings');
const {newer} = require('./upgrade');
const {writeAtomic} = require('./atomic');
const {appendHistory} = require('./history');

const PERIOD_MS = {daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000};

// -> {checked: false, why} or {checked: true, newer: [{name, have, latest}]}
const TIMEOUT_MS = 15000;
const RETRY_MS = 60 * 60 * 1000;   // a failed check is tried again an hour later
const LOCK_STALE_MS = 10 * 60 * 1000;

async function autoCheck({where, io, say, host, now = Date.now(), signal = null, timeoutMs = TIMEOUT_MS}) {
  const settings = readSettings(where);
  if (valueOf(settings, 'autoUpgrade') !== true) return {checked: false, why: 'off'};
  const period = PERIOD_MS[valueOf(settings, 'upgradeCheck')];
  if (period == null) return {checked: false, why: 'never'};
  const stampFile = path.join(where.home, 'upgrade-check.json');
  let last = 0;
  try { last = JSON.parse(fs.readFileSync(stampFile, 'utf8')).lastCheck || 0; } catch (err) { last = 0; }
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
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const both = (signal != null && typeof AbortSignal.any === 'function') ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let found;
  try {
    const record = readRecord(where);
    if (record == null) return {checked: false, why: 'nothing installed'};
    const versions = {...record.runtime.versions, ...packVersions(record)};
    const latest = await latestVersions(Object.keys(versions), io, {signal: both});
    found = Object.keys(versions).filter((n) => latest[n] != null && newer(latest[n], versions[n])).map((n) => ({name: n, have: versions[n], latest: latest[n]}));
    writeAtomic(stampFile, JSON.stringify({lastCheck: now}) + '\n');
  } catch (err) {
    const why = both.aborted ? `no answer within ${timeoutMs / 1000} s` : err.message;
    // tried again an hour later, not a whole period
    writeAtomic(stampFile, JSON.stringify({lastCheck: now - period + RETRY_MS}) + '\n');
    const notice = `automatic upgrade check failed (${why}); nothing changed`;
    history({change: 'upgrade check', notice, problem: why});
    say(notice);
    return {checked: true, failed: why, newer: []};
  } finally {
    clearTimeout(timer);
    fs.rmSync(lock, {force: true});
  }
  for (const f of found) {
    const notice = `${f.name} ${f.latest} is available (installed ${f.have}); installing from npm arrives with the first release`;
    history({change: 'upgrade available', notice});
    say(notice);
  }
  return {checked: true, newer: found};
}

module.exports = {autoCheck, PERIOD_MS};
