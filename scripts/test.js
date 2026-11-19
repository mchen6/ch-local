'use strict';
// npm test: each test file in a process of its own, with test/tmp-dirs.js
// preloaded (which removes the ch-* temporary directories it makes, and
// keeps a manifest of them), under a wall-clock watchdog; then the manifests
// of processes that are gone swept (their listed directories only), then a
// count of the ch-* directories and manifests the run left.
//
//   npm test                          every test/*.test.js
//   npm test -- test/a.test.js ...    only those files (any other argument
//                                     is a node flag, --test-name-pattern
//                                     say, passed to each file)
//
// The watchdog (the Reviewer's high review of #97): a file still running
// after CH_TEST_FILE_TIMEOUT_MS (15 minutes; LONG_FILES 60) is sent SIGTERM,
// then SIGKILL after GRACE_MS, is FAILED (timed out), and its manifest is
// swept. No --test-timeout (it caps a parent's own longer hook and subtest
// timeouts) and no --test-force-exit (it turns an error thrown after a test
// into a pass, and hides a leaked server): a leak or a hang stays visible.
// The runner itself, sent SIGTERM or SIGINT (an outer `timeout`, a
// systemd-run stop), ends its files the same way, sweeps, and re-raises.
//
// In CI (CI=true) a run that leaves any ch-* directory or manifest fails,
// naming them (the Reviewer, 11-19: /tmp ran out of inodes from leftovers).
// Locally other runs may be making them at the same time, so a leftover is
// only said.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');

const root = path.resolve(__dirname, '..');
// the temporary directory the files are handed (theirs is the runner's)
const tmp = os.tmpdir();
const TMP_DIRS = path.join(root, 'test', 'tmp-dirs.js');
const {PREFIX, MANIFEST_PREFIX, sweepStale} = require('../test/tmp-dirs');
const FILE_TIMEOUT_MS = Number(process.env.CH_TEST_FILE_TIMEOUT_MS) > 0 ? Number(process.env.CH_TEST_FILE_TIMEOUT_MS) : 15 * 60 * 1000;
// the files that run a whole release or a client end to end
const LONG_FILES = new Set(['acceptance.test.js', 'dogfood.test.js']);
const LONG_TIMEOUT_MS = Math.max(FILE_TIMEOUT_MS, 60 * 60 * 1000);
const GRACE_MS = Number(process.env.CH_TEST_GRACE_MS) > 0 ? Number(process.env.CH_TEST_GRACE_MS) : 10 * 1000;
const CONCURRENCY = Number(process.env.CH_TEST_CONCURRENCY) > 0 ? Number(process.env.CH_TEST_CONCURRENCY)
  : Math.max(1, (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) - 1);
// this user's shared-runtime socket directory (lib/session-socket.js
// fallbackSocket: made on purpose and kept), as that module names it, and
// only that one
let socketDir = null;
try { socketDir = path.basename(path.dirname(require('../lib/session-socket').fallbackSocket({env: {}}))); } catch (err) { socketDir = null; }
const ours = () => {
  try { return new Set(fs.readdirSync(tmp).filter((n) => (n.startsWith(PREFIX) && n !== socketDir) || n.startsWith(MANIFEST_PREFIX))); } catch (err) { return new Set(); }
};

const given = process.argv.slice(2);
const named = given.filter((a) => /\.test\.js$/.test(a));
const flags = given.filter((a) => !named.includes(a));
const files = named.length > 0 ? named
  : fs.readdirSync(path.join(root, 'test')).filter((n) => n.endsWith('.test.js')).sort().map((n) => path.join('test', n));
// a file run as its own process (node:test runs its tests in it), so the
// watchdog's pid is the file's own
const reporter = flags.some((f) => f.startsWith('--test-reporter')) ? [] : ['--test-reporter=spec'];

const running = new Map();   // pid -> child
// a child ended: SIGTERM, then SIGKILL after the grace
const end = (child) => {
  try { child.kill('SIGTERM'); } catch (err) { /* gone */ }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch (err) { /* gone */ } }, GRACE_MS).unref();
};

function runFile(file) {
  return new Promise((resolve) => {
    const limit = LONG_FILES.has(path.basename(file)) ? LONG_TIMEOUT_MS : FILE_TIMEOUT_MS;
    const child = spawn(process.execPath, ['--require', TMP_DIRS, ...reporter, ...flags, file], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    running.set(child.pid, child);
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    let timedOut = false;
    const watchdog = setTimeout(() => { timedOut = true; end(child); }, limit);
    child.once('error', (err) => out.push(Buffer.from(`\n${file}: could not be run: ${err.code || err.message}\n`)));
    child.once('close', (code, signal) => {
      clearTimeout(watchdog);
      running.delete(child.pid);
      // (a file ended by a signal never reached 'exit': its manifest now)
      if (signal != null) sweepStale(tmp);
      process.stdout.write(`\n# ${file}\n${Buffer.concat(out).toString('utf8')}`);
      if (timedOut) process.stdout.write(`\nFAILED ${file}: timed out after ${Math.round(limit / 1000)} s (ended by the runner's watchdog)\n`);
      else if (signal != null) process.stdout.write(`\nFAILED ${file}: ended by ${signal}\n`);
      resolve({file, failed: timedOut || code !== 0});
    });
  });
}

// The runner sent SIGTERM or SIGINT: its files ended, swept, then the
// signal raised again, so the runner ends as it was asked to
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    const children = [...running.values()];
    const all = children.map((c) => new Promise((r) => (c.exitCode != null || c.signalCode != null ? r() : c.once('close', r))));
    for (const c of children) end(c);
    const done = () => {
      sweepStale(tmp);
      process.removeAllListeners(sig);
      process.kill(process.pid, sig);
    };
    Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, GRACE_MS + 2000))]).then(done, done);
  });
}

async function main() {
  // a process of an earlier run killed by a signal left its manifest: what
  // it made is removed now (only what it listed)
  sweepStale(tmp);
  const before = ours();
  const queue = files.slice();
  const results = [];
  const worker = async () => {
    while (queue.length > 0 && !stopping) results.push(await runFile(queue.shift()));
  };
  await Promise.all(Array.from({length: Math.min(CONCURRENCY, files.length)}, worker));
  if (stopping) return;
  sweepStale(tmp);
  const failedFiles = results.filter((r) => r.failed).map((r) => r.file);
  let code = failedFiles.length > 0 ? 1 : 0;
  if (failedFiles.length > 0) process.stdout.write(`\n${failedFiles.length} of ${results.length} file${results.length === 1 ? '' : 's'} failed: ${failedFiles.join(', ')}\n`);
  const left = [...ours()].filter((n) => !before.has(n)).sort();
  if (left.length > 0) {
    const list = `${left.slice(0, 20).join(', ')}${left.length > 20 ? ` and ${left.length - 20} more` : ''}`;
    if (process.env.CI === 'true') {
      process.stderr.write(`\nthe test run left ${left.length} ch-* director${left.length === 1 ? 'y' : 'ies'} or manifests in ${tmp}: ${list}\n`);
      if (code === 0) code = 1;
    } else {
      process.stderr.write(`\n(${left.length} new ch-* director${left.length === 1 ? 'y' : 'ies'} or manifests in ${tmp} since the run began, maybe another run's: ${list})\n`);
    }
  } else {
    process.stderr.write(`\nthe test run left no ch-* directory in ${tmp}\n`);
  }
  process.exitCode = code;
}

main();
