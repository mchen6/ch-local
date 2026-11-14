'use strict';
// ch-local upgrade (spec §2, "Upgrade: easy, never silent"): shows the installed
// and available versions and asks once. `--auto on|off` stores the opt-in
// automatic-upgrade setting (off by default) and contacts nothing.
const {layout} = require('./home');
const {latestVersions} = require('./registry');
const {readRecord, packVersions} = require('./record');
const {UNRELEASED_LINE} = require('./pins');

const nums = (v) => String(v).split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
function newer(a, b) {
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

async function upgrade({auto}, io) {
  const say = (s) => io.stdout.write(s + '\n');
  const where = layout(io.env, io.homedir);
  if (auto !== undefined) {
    if (auto !== 'on' && auto !== 'off') { io.stderr.write('ch-local: --auto takes on or off\n'); return 2; }
    require('./settings').setSetting(where, 'autoUpgrade', auto, {by: 'cli', mayLoosen: true});
    say(auto === 'on'
      ? 'automatic upgrades are on: start checks for new versions at most once a day and announces them; installing them automatically arrives with the first release, and will run new code with your keys'
      : 'automatic upgrades are off (the default): upgrade always asks');
    return 0;
  }
  let record = null;
  try { record = readRecord(where); } catch (err) { io.stderr.write(`ch-local: ${err.message}\n`); return 1; }
  if (record == null) { io.stderr.write('ch-local: nothing is installed yet\n'); return 1; }
  if (record.unreleased) { io.stderr.write(`ch-local: ${UNRELEASED_LINE}: reinstall with \`ch-local install --pack <name> --from <release directory>\` first\n`); return 1; }
  const installed = {versions: {...record.runtime.versions, ...packVersions(record)}};
  const names = Object.keys(installed.versions);
  const latest = await latestVersions(names, io);
  const width = Math.max(...names.map((n) => n.length));
  const ahead = [];
  for (const name of names) {
    const have = installed.versions[name];
    const shown = latest[name] == null ? `${have} (not on npm yet)` : newer(latest[name], have) ? `${have} -> ${latest[name]}` : `${have} (up to date)`;
    if (latest[name] != null && newer(latest[name], have)) ahead.push(name);
    say(`  ${name.padEnd(width)}  ${shown}`);
  }
  if (ahead.length === 0) {
    say(names.every((n) => latest[n] != null) ? 'everything is up to date' : 'nothing newer on npm');
    return 0;
  }
  const answer = String(await io.ask(`Upgrade ${ahead.length} package(s) to these versions? (yes/no) `)).trim().toLowerCase();
  if (answer !== 'yes') { say('nothing changed'); return 0; }
  io.stderr.write('ch-local: installing from npm arrives with the first release; nothing changed\n');
  return 1;
}

module.exports = {upgrade, newer};
