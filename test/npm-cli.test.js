'use strict';
require('./tmp-dirs');
// A10: npm found beside the node that runs ch-local, as each install lays it
// out -- beside node.exe (Windows), <prefix>/lib/node_modules (the official
// builds, nvm), and Homebrew's <prefix>/libexec/lib/node_modules, or wherever
// <bin>/npm's link leads -- and, when none is there, the way out said.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {npmCli} = require('../lib/npm');

const WIN = process.platform === 'win32';
// a prefix with bin/node and npm laid out by `lay` (the prefix's own dirs)
function prefix(lay) {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-cli-'));
  fs.mkdirSync(path.join(p, 'bin'));
  fs.writeFileSync(path.join(p, 'bin', 'node'), '');
  const cliAt = (dir) => {
    fs.mkdirSync(path.join(dir, 'bin'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name": "npm"}');
    fs.writeFileSync(path.join(dir, 'bin', 'npm-cli.js'), '');
    return path.join(dir, 'bin', 'npm-cli.js');
  };
  const cli = lay(p, cliAt);
  return {p, execPath: path.join(p, 'bin', 'node'), cli: cli == null ? null : fs.realpathSync(cli), done: () => fs.rmSync(p, {recursive: true, force: true})};
}
const found = (t) => { const c = npmCli({execPath: t.execPath, env: {}}); return fs.realpathSync(c); };

test('A10: <prefix>/lib/node_modules/npm, as before', () => {
  const t = prefix((p, cliAt) => cliAt(path.join(p, 'lib', 'node_modules', 'npm')));
  try { assert.strictEqual(found(t), t.cli); } finally { t.done(); }
});

test('A10: Homebrew\'s <prefix>/libexec/lib/node_modules/npm', () => {
  const t = prefix((p, cliAt) => cliAt(path.join(p, 'libexec', 'lib', 'node_modules', 'npm')));
  try { assert.strictEqual(found(t), t.cli); } finally { t.done(); }
});

test('A10: wherever <bin>/npm\'s link leads (its package\'s bin/npm-cli.js)', {skip: WIN && 'no bin/npm link on Windows'}, () => {
  const t = prefix((p, cliAt) => {
    const cli = cliAt(path.join(p, 'Cellar', 'npm', '11.0.0', 'lib', 'node_modules', 'npm'));
    fs.writeFileSync(path.join(path.dirname(cli), 'npm'), '');
    fs.symlinkSync(path.join(path.dirname(cli), 'npm'), path.join(p, 'bin', 'npm'));
    return cli;
  });
  try { assert.strictEqual(found(t), t.cli); } finally { t.done(); }
});

test('A10: npm_execpath first, when it is npm-cli.js and there', () => {
  const t = prefix((p, cliAt) => cliAt(path.join(p, 'elsewhere', 'npm')));
  try { assert.strictEqual(fs.realpathSync(npmCli({execPath: t.execPath, env: {npm_execpath: t.cli}})), t.cli); } finally { t.done(); }
});

test('A10: none there: the error names the npx way out', () => {
  const t = prefix(() => null);
  try {
    assert.throws(() => npmCli({execPath: t.execPath, env: {}}), (e) => e.message === `npm was not found beside ${t.execPath}; run the same ch-local command through npx instead: \`npx @countinghouse/ch-local …\``);
  } finally { t.done(); }
});
