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
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-npm-cli-'));
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

test('A10: beside node.exe (<bin>/node_modules/npm, Windows\'s layout), first', () => {
  const t = prefix((p, cliAt) => { cliAt(path.join(p, 'lib', 'node_modules', 'npm')); return cliAt(path.join(p, 'bin', 'node_modules', 'npm')); });
  try { assert.strictEqual(found(t), t.cli); } finally { t.done(); }
});

test('A10: an npm_execpath that is not npm-cli.js, or not there: the layout', () => {
  const t = prefix((p, cliAt) => cliAt(path.join(p, 'lib', 'node_modules', 'npm')));
  try {
    // (one there but not npm-cli.js: only the name refuses it)
    fs.writeFileSync(path.join(t.p, 'npx-cli.js'), '');
    for (const bogus of [path.join(t.p, 'npx-cli.js'), path.join(t.p, 'gone', 'npm-cli.js')]) {
      assert.strictEqual(fs.realpathSync(npmCli({execPath: t.execPath, env: {npm_execpath: bogus}})), t.cli, bogus);
    }
  } finally { t.done(); }
});

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
    const v = require('../package.json').version;
    const {homePrefix, homeNote} = require('../lib/command-line');
    const {layout} = require('../lib/home');
    const said = (homeEnv) => { try { npmCli({execPath: t.execPath, env: {}, homeEnv}); } catch (e) { return e.message; } return null; };
    const lead = `npm was not found beside ${t.execPath}; run the same ch-local command through npx instead: `;
    // (the default home: on Windows under this process's LOCALAPPDATA)
    assert.strictEqual(said(WIN ? {LOCALAPPDATA: process.env.LOCALAPPDATA} : {}), `${lead}\`npx @countinghouse/ch-local@${v} …\``, 'the default home');
    // (a home that isn't the default, from the env the io acts on: named, as every npx hint names it)
    const where = layout({COUNTINGHOUSE_HOME: path.join(t.p, 'home')});
    assert.strictEqual(said({COUNTINGHOUSE_HOME: where.home}), `${lead}\`${homePrefix(where)}npx @countinghouse/ch-local@${v} …\`${homeNote(where)}`);
    assert.ok(WIN ? homeNote(where) !== '' : homePrefix(where) !== '', 'the home named');
    // (one that can't be read: said in words, never the default home's command alone)
    assert.strictEqual(said({COUNTINGHOUSE_HOME: 'rel/home'}), `${lead}\`npx @countinghouse/ch-local@${v} …\` (with COUNTINGHOUSE_HOME set to the full path of its home)`);
  } finally { t.done(); }
});
