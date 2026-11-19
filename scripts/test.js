'use strict';
// npm test: the test files, each process with test/tmp-dirs.js preloaded
// (which removes the ch-* temporary directories it makes), then a count of
// the ch-* directories the run left in the temporary directory.
//
//   npm test                          every test/*.test.js
//   npm test -- test/a.test.js ...    only those files (any other argument
//                                     is a node --test flag)
//
// In CI (CI=true) a run that leaves any fails, naming them (the Reviewer,
// 11-19: /tmp ran out of inodes from leftovers). Locally other runs may be
// making ch-* directories at the same time, so a leftover is only said.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const tmp = os.tmpdir();
const {PREFIX} = require('../test/tmp-dirs');
// this user's shared-runtime socket directory (lib/session-socket.js
// fallbackSocket: made on purpose and kept), as that module names it, and
// only that one
let socketDir = null;
try { socketDir = path.basename(path.dirname(require('../lib/session-socket').fallbackSocket({env: {}}))); } catch (err) { socketDir = null; }
const ours = () => {
  try { return new Set(fs.readdirSync(tmp).filter((n) => n.startsWith(PREFIX) && n !== socketDir)); } catch (err) { return new Set(); }
};

const given = process.argv.slice(2);
const named = given.filter((a) => /\.test\.js$/.test(a));
const flags = given.filter((a) => !named.includes(a));
const files = named.length > 0 ? named
  : fs.readdirSync(path.join(root, 'test')).filter((n) => n.endsWith('.test.js')).sort().map((n) => path.join('test', n));

const before = ours();
const run = spawnSync(process.execPath, ['--require', path.join(root, 'test', 'tmp-dirs.js'), '--test', ...flags, ...files], {cwd: root, stdio: 'inherit'});
if (run.error != null) process.stderr.write(`\nthe tests could not be run: ${run.error.code || run.error.message}\n`);
const left = [...ours()].filter((n) => !before.has(n)).sort();
let code = run.status == null ? 1 : run.status;
if (left.length > 0) {
  const list = `${left.slice(0, 20).join(', ')}${left.length > 20 ? ` and ${left.length - 20} more` : ''}`;
  if (process.env.CI === 'true') {
    process.stderr.write(`\nthe test run left ${left.length} ch-* director${left.length === 1 ? 'y' : 'ies'} in ${tmp}: ${list}\n`);
    if (code === 0) code = 1;
  } else {
    process.stderr.write(`\n(${left.length} new ch-* director${left.length === 1 ? 'y' : 'ies'} in ${tmp} since the run began, maybe another run's: ${list})\n`);
  }
} else if (run.error == null) {
  process.stderr.write(`\nthe test run left no ch-* directory in ${tmp}\n`);
}
process.exit(code);
