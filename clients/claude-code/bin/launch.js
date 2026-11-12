#!/usr/bin/env node
'use strict';
// The plugin's entry: runs the installed launcher, <home>/bin/ch-local.js, with
// this process's arguments and stdio, passes a stop on to it, and ends the way
// it ended. It fetches and installs nothing. The plugin is copied on its own,
// so the home rule is repeated from lib/home.js (a test checks they agree).
// Plain require names, so a Node too old for 'node:' still gets the one-line
// message below.
const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn} = require('child_process');

const FLOOR = [22, 16];

function nodeOk(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > FLOOR[0] || (major === FLOOR[0] && minor >= FLOOR[1]);
}

function isFullPath(p, platform = process.platform) {
  if (platform === 'win32') return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p);
  return path.posix.isAbsolute(p);
}

function whereIs(env) {
  const set = env.COUNTINGHOUSE_HOME;
  if (typeof set !== 'string' || set === '') return path.join(os.homedir(), '.countinghouse', 'bin', 'ch-local.js');
  if (!isFullPath(set)) return null;
  return path.join(path.normalize(set), 'bin', 'ch-local.js');
}

const fail = (line) => { process.stderr.write(`ch-packs: ${line}\n`); process.exit(1); };

function main() {
  if (!nodeOk(process.version)) fail(`needs Node 22.16 or later; this is ${process.version} (the \`node\` on the PATH Claude Code sees)`);
  const launcher = whereIs(process.env);
  if (launcher == null) fail(`COUNTINGHOUSE_HOME must be an absolute path, not "${process.env.COUNTINGHOUSE_HOME}"`);
  if (!fs.existsSync(launcher)) fail(`the launcher is not installed at ${launcher}; install it with: npx @countinghouse/ch-local install --pack ci-failure-triage`);
  const child = spawn(process.execPath, [launcher, ...process.argv.slice(2)], {stdio: 'inherit'});
  child.on('error', (err) => fail(`could not start ${launcher} (${err.code || err.message})`));
  const forward = (signal) => {
    if (child.exitCode != null || child.signalCode != null) return;
    // Windows cannot send every signal (SIGHUP throws ENOSYS): stop it plainly.
    try { child.kill(signal); } catch { child.kill(); }
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, forward);
  child.on('exit', (code, signal) => {
    if (signal != null) {
      // End the way the launcher ended, so a clean stop does not read as a failure.
      process.removeAllListeners(signal);
      try { process.kill(process.pid, signal); } catch { /* fall through */ }
    }
    process.exit(code != null ? code : 1);
  });
}

if (require.main === module) main();

module.exports = {whereIs, nodeOk, isFullPath};
