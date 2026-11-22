'use strict';
// npm as `node npm-cli.js`: no shell on any system (Windows will not spawn
// npm.cmd without one).
const fs = require('node:fs');
const path = require('node:path');

// -> npm-cli.js beside the node that runs this ch-local: npm_execpath (npm
// running us), beside node.exe (Windows), <prefix>/lib/node_modules (the
// official builds, nvm), Homebrew's <prefix>/libexec/lib/node_modules, or the
// package <bin>/npm's link leads into. None there: the npx way out, said.
// (homeEnv: the environment whose home the hint names -- the io's)
function npmCli({execPath = process.execPath, env = process.env, homeEnv = env} = {}) {
  const fromNpm = env.npm_execpath;
  if (fromNpm && /npm-cli\.js$/.test(fromNpm) && fs.existsSync(fromNpm)) return fromNpm;
  const bin = path.dirname(execPath);
  const cliIn = (pkg) => path.join(pkg, 'bin', 'npm-cli.js');
  for (const candidate of [path.join(bin, 'node_modules', 'npm'), path.join(bin, '..', 'lib', 'node_modules', 'npm'), path.join(bin, '..', 'libexec', 'lib', 'node_modules', 'npm')].map(cliIn)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // (<bin>/npm a link into npm's package: its bin/npm, beside npm-cli.js)
  let linked = null;
  try { linked = fs.realpathSync.native(path.join(bin, 'npm')); } catch (e) { linked = null; }
  if (linked != null) {
    const candidate = path.join(path.dirname(linked), 'npm-cli.js');
    if (fs.existsSync(candidate)) return candidate;
  }
  // (this release, on this home: npx runs it with npm_execpath set)
  const {homePrefix, homeNote, NPX} = require('./command-line');
  // (a home that can't be read is said in words: the command never acts on
  // the default home instead)
  let where = null;
  try { where = require('./home').layout(homeEnv); } catch (e) { where = null; }
  const note = where == null ? ' (with COUNTINGHOUSE_HOME set to the full path of its home)' : homeNote(where);
  throw new Error(`npm was not found beside ${execPath}; run the same ch-local command through npx instead: \`${homePrefix(where)}${NPX}@${require('../package.json').version} …\`${note}`);
}

// One npm command in `cwd` -> {status, stdout, stderr}.
// (the hint names the home the io acts on)
const npm = (io, args, cwd) => io.exec(io.node, [npmCli(io.env != null ? {homeEnv: io.env} : {}), ...args], {cwd});

module.exports = {npm, npmCli};
