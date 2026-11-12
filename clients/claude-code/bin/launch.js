#!/usr/bin/env node
'use strict';
// The plugin's entry: runs the installed launcher, <home>/bin/ch-local.js, with
// this process's arguments and stdio, passes a stop on to it, and exits with
// its code. It fetches and installs nothing. The plugin is copied on its own,
// so the home rule is repeated from packages/ch-local/lib/home.js (a test
// checks the two agree).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const FLOOR = [22, 16];

function whereIs(env) {
  const set = env.COUNTINGHOUSE_HOME;
  if (typeof set !== 'string' || set === '') return path.join(os.homedir(), '.countinghouse', 'bin', 'ch-local.js');
  if (!path.isAbsolute(set)) return null;
  return path.join(path.normalize(set), 'bin', 'ch-local.js');
}

function nodeOk(version) {
  const [major, minor] = String(version).replace(/^v/, '').split('.').map(Number);
  return major > FLOOR[0] || (major === FLOOR[0] && minor >= FLOOR[1]);
}

const fail = (line) => { process.stderr.write(`ch-packs: ${line}\n`); process.exit(1); };

function main() {
  if (!nodeOk(process.version)) fail(`needs Node 22.16 or later; this is ${process.version} (the \`node\` on the PATH Claude Code sees)`);
  const launcher = whereIs(process.env);
  if (launcher == null) fail(`COUNTINGHOUSE_HOME must be an absolute path, not "${process.env.COUNTINGHOUSE_HOME}"`);
  if (!fs.existsSync(launcher)) fail(`the launcher is not installed at ${launcher}; install it with: npx @countinghouse/ch-local install --pack ci-failure-triage`);
  const child = spawn(process.execPath, [launcher, ...process.argv.slice(2)], {stdio: 'inherit'});
  child.on('error', (err) => fail(`could not start ${launcher} (${err.code || err.message})`));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => { if (child.exitCode == null) child.kill(signal); });
  }
  child.on('exit', (code, signal) => process.exit(code != null ? code : 1));
}

if (require.main === module) main();

module.exports = {whereIs, nodeOk};
