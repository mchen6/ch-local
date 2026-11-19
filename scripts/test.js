'use strict';
// npm test: every test file, each process with test/tmp-dirs.js preloaded
// (which removes the ch-* temporary directories it makes), then a count of
// the ch-* directories the run left in the temporary directory.
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
// (not ch-<uid>: the per-user directory of the shared runtime's fallback
// socket, lib/session-socket.js, made on purpose and kept)
const ours = () => {
  try { return new Set(fs.readdirSync(tmp).filter((n) => n.startsWith('ch-') && !/^ch-\d+$/.test(n))); } catch (err) { return new Set(); }
};
const before = ours();
const files = fs.readdirSync(path.join(root, 'test')).filter((n) => n.endsWith('.test.js')).sort().map((n) => path.join('test', n));
const args = ['--require', path.join(root, 'test', 'tmp-dirs.js'), '--test', ...process.argv.slice(2), ...files];
const run = spawnSync(process.execPath, args, {cwd: root, stdio: 'inherit'});
const left = [...ours()].filter((n) => !before.has(n)).sort();
let code = run.status == null ? 1 : run.status;
if (left.length > 0) {
  const named = `${left.slice(0, 20).join(', ')}${left.length > 20 ? ` and ${left.length - 20} more` : ''}`;
  if (process.env.CI === 'true') {
    process.stderr.write(`\nthe test run left ${left.length} ch-* director${left.length === 1 ? 'y' : 'ies'} in ${tmp}: ${named}\n`);
    if (code === 0) code = 1;
  } else {
    process.stderr.write(`\n(${left.length} new ch-* director${left.length === 1 ? 'y' : 'ies'} in ${tmp} since the run began, maybe another run's: ${named})\n`);
  }
} else {
  process.stderr.write(`\nthe test run left no ch-* directory in ${tmp}\n`);
}
process.exit(code);
