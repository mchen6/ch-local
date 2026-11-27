#!/usr/bin/env node
'use strict';
// The checks of .github/workflows/windows-client.yml: Claude Code's own steps
// around the acceptance install, as a user on Windows takes them.
//
//   node scripts/client-plugin-check.js listed <plugin list --json file> <id>
//     the plugin is installed and enabled, with its countinghouse server;
//   node scripts/client-plugin-check.js absent <plugin list --json file> <id>
//     no plugin of that id is listed;
//   node scripts/client-plugin-check.js timed <acceptance report> <plugin ms> [<out file>]
//     the time from the first command (`claude plugin marketplace add`) to
//     the first result: the plugin steps, then the acceptance run's install
//     to its first result (its build from the mains is the run's own, not a
//     user's, so it is not counted), under 5 minutes, as the acceptance
//     run's own check.
// Exit 0 when the check holds, 1 when it does not, 2 on a usage error; one
// line on stdout says what was seen.
const fs = require('node:fs');

const LIMIT_MS = 300000;   // as scripts/acceptance.js

// `claude plugin list --json`'s text -> its entries (an array), or throws
function entries(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('claude plugin list --json did not answer a list');
  return list;
}

// -> {ok, line}
function listed(text, id) {
  const found = entries(text).filter((e) => e != null && e.id === id);
  if (found.length !== 1) return {ok: false, line: `${id}: listed ${found.length} times, not once`};
  const e = found[0];
  const server = e.mcpServers != null && e.mcpServers.countinghouse != null;
  const ok = e.enabled === true && server;
  return {ok, line: `${id}: listed, ${e.enabled === true ? 'enabled' : 'not enabled'}, ${server ? 'with' : 'without'} its countinghouse server${typeof e.version === 'string' ? ` (version ${e.version})` : ''}`};
}

function absent(text, id) {
  const n = entries(text).filter((e) => e != null && e.id === id).length;
  return {ok: n === 0, line: n === 0 ? `${id}: not listed` : `${id}: still listed`};
}

// the acceptance report and the plugin steps' ms -> {ok, line, timing}
function timed(report, pluginMs) {
  const t = (report != null && report.timings) || {};
  if (report == null || report.ok !== true || !Number.isFinite(t.built) || !Number.isFinite(t.firstResult)) {
    return {ok: false, line: 'the acceptance run has no first result to time (its report is not ok)', timing: null};
  }
  if (!Number.isInteger(pluginMs) || pluginMs < 0) return {ok: false, line: `the plugin steps' time is not a count of ms: ${pluginMs}`, timing: null};
  const installMs = t.firstResult - t.built;
  const totalMs = pluginMs + installMs;
  const timing = {pluginMs, installToFirstResultMs: installMs, firstCommandToFirstResultMs: totalMs, limitMs: LIMIT_MS};
  const s = (ms) => `${(ms / 1000).toFixed(1)} s`;
  return {ok: totalMs < LIMIT_MS, timing,
    line: `first command to first result: ${s(totalMs)} (the plugin steps ${s(pluginMs)}, then install to first result ${s(installMs)}); ${totalMs < LIMIT_MS ? 'under' : 'NOT under'} 5 minutes`};
}

function main(argv, io = {stdout: process.stdout, stderr: process.stderr}) {
  const [what, file, arg, out] = argv;
  const usage = () => { io.stderr.write('usage: client-plugin-check.js listed|absent <list.json> <id> | timed <report.json> <plugin ms> [<out.json>]\n'); return 2; };
  if (file == null || arg == null) return usage();
  let r;
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (what === 'listed') r = listed(text, arg);
    else if (what === 'absent') r = absent(text, arg);
    else if (what === 'timed') {
      if (!/^\d+$/.test(arg)) return usage();
      r = timed(JSON.parse(text), Number(arg));
      if (out != null && r.timing != null) fs.writeFileSync(out, JSON.stringify(r.timing, null, 2) + '\n');
    } else return usage();
  } catch (err) {
    io.stderr.write(`client-plugin-check: ${err.message}\n`);
    return 2;
  }
  io.stdout.write(r.line + '\n');
  return r.ok ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {listed, absent, timed, main, LIMIT_MS};
