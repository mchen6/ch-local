'use strict';
// npm as `node npm-cli.js`: no shell on any system (Windows will not spawn
// npm.cmd without one).
const fs = require('node:fs');
const path = require('node:path');

function npmCli() {
  const fromNpm = process.env.npm_execpath;
  if (fromNpm && /npm-cli\.js$/.test(fromNpm) && fs.existsSync(fromNpm)) return fromNpm;
  const bin = path.dirname(process.execPath);
  for (const candidate of [path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`npm was not found beside ${process.execPath}`);
}

// One npm command in `cwd` -> {status, stdout, stderr}.
const npm = (io, args, cwd) => io.exec(io.node, [npmCli(), ...args], {cwd});

module.exports = {npm};
