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
// The watchdog (the Reviewer's rulings on #97): a file still running after
// CH_TEST_FILE_TIMEOUT_MS (15 minutes; LONG_FILES 60) is sent SIGTERM, then
// SIGKILL after GRACE_MS (to its own pid, while it lives), is FAILED (timed
// out), and its manifest is swept. No --test-timeout (it caps a parent's own
// longer hook and subtest timeouts) and no --test-force-exit (it turns an
// error thrown after a test into a pass, and hides a leaked server): a leak
// or a hang stays visible. Files stay in the runner's process group, so an
// outer kill of the group reaches them as before. The runner, sent SIGTERM
// or SIGINT, ends its files the same way, sweeps, and re-raises.
//
// On Windows the watchdog and each file's exit-time removal are all: no
// manifest is written and no sweep runs there (the Reviewer's cut on #97:
// the leak fixed here was the Linux machine's).
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
const DEFAULT_CONCURRENCY = Number(process.env.CH_TEST_CONCURRENCY) > 0 ? Number(process.env.CH_TEST_CONCURRENCY)
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
// --test-concurrency=N is the runner's own now: how many files at once (a
// file runs as `node file`, where node --test's flag means nothing: the
// medium on #97's second round, 6)
const concurrencyFlag = given.find((a) => /^--test-concurrency=\d+$/.test(a));
const CONCURRENCY = concurrencyFlag != null ? Math.max(1, Number(concurrencyFlag.split('=')[1])) : DEFAULT_CONCURRENCY;
const flags = given.filter((a) => !named.includes(a) && a !== concurrencyFlag);
const files = named.length > 0 ? named
  : fs.readdirSync(path.join(root, 'test')).filter((n) => n.endsWith('.test.js')).sort().map((n) => path.join('test', n));
// a file run as its own process (node:test runs its tests in it), so the
// watchdog's pid is the file's own
const reporter = flags.some((f) => f.startsWith('--test-reporter')) ? [] : ['--test-reporter=spec'];

const running = new Map();   // pid -> child
// SIGTERM, then SIGKILL after the grace (at once when `now`), each to the
// file's own pid and only while it lives; the delayed one is cleared when it
// exits, so no pid is signalled after its 'exit'
const alive = (child) => child.exitCode == null && child.signalCode == null;
const end = (child, now = false) => {
  if (!alive(child)) return;
  try { child.kill(now ? 'SIGKILL' : 'SIGTERM'); } catch (err) { /* gone */ }
  if (!now && child.killTimer == null) child.killTimer = setTimeout(() => { if (alive(child)) { try { child.kill('SIGKILL'); } catch (err) { /* gone */ } } }, GRACE_MS);
};

// A file's output, as it comes: each line under its file's name when files
// run side by side, as is when one at a time (never held back: a stopped or
// killed run keeps what explains it: the medium, 3)
const tagged = CONCURRENCY > 1;
const relay = (file, stream) => {
  let partial = '';
  const tag = `[${path.basename(file)}] `;
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    if (!tagged) { process.stdout.write(d); return; }
    const lines = (partial + d).split('\n');
    partial = lines.pop();
    if (lines.length > 0) process.stdout.write(lines.map((l) => tag + l).join('\n') + '\n');
  });
  stream.on('end', () => { if (tagged && partial !== '') process.stdout.write(tag + partial + '\n'); partial = ''; });
};

function runFile(file) {
  return new Promise((resolve) => {
    const limit = LONG_FILES.has(path.basename(file)) ? LONG_TIMEOUT_MS : FILE_TIMEOUT_MS;
    let settled = false;
    const finish = (r) => { if (settled) return; settled = true; resolve(r); };
    if (!tagged) process.stdout.write(`\n# ${file}\n`);
    const child = spawn(process.execPath, ['--require', TMP_DIRS, ...reporter, ...flags, file], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    let said = false;
    const fail = (why) => { if (said) return; said = true; process.stdout.write(`\nFAILED ${file}: ${why}\n`); };
    // (a spawn that fails, EMFILE say, may never emit 'close': failed now)
    child.once('error', (err) => {
      fail(`could not be run: ${err.code || err.message}`);
      if (child.pid == null) finish({file, failed: true});
    });
    if (child.pid == null) return;
    running.set(child.pid, child);
    relay(file, child.stdout);
    relay(file, child.stderr);
    let timedOut = false;
    const watchdog = setTimeout(() => { timedOut = true; end(child); }, limit);
    // resolved on 'exit', not 'close': something the file started that
    // still holds its pipes never keeps the runner waiting (the medium, 1)
    child.once('exit', (code, signal) => {
      clearTimeout(watchdog);
      if (child.killTimer != null) clearTimeout(child.killTimer);
      running.delete(child.pid);
      // (a file ended by a signal never reached 'exit': its manifest now)
      if (signal != null) sweepStale(tmp);
      const report = () => {
        if (timedOut) fail(`timed out after ${Math.round(limit / 1000)} s (ended by the runner's watchdog)`);
        else if (signal != null) fail(`ended by ${signal}`);
        finish({file, failed: timedOut || code !== 0});
      };
      // its output drained, within a bound
      const t = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); report(); }, 2000);
      child.once('close', () => { clearTimeout(t); report(); });
    });
  });
}

// The runner sent SIGTERM or SIGINT: its files ended (a second signal: at
// once), swept, then the signal raised again, so the runner ends as it was
// asked to
let stopping = false;
let firstSignalAt = 0;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    // (a signal again within 1 s is the same one, delivered twice: by npm
    // and by the group: the Reviewer's second high review of #97, 6)
    if (stopping && Date.now() - firstSignalAt < 1000) return;
    if (!stopping) firstSignalAt = Date.now();
    const children = [...running.values()];
    const finishStop = () => {
      sweepStale(tmp);
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.kill(process.pid, sig);
    };
    if (stopping) {
      // (asked again: no grace, the medium on #97's second round, 7)
      for (const c of children) end(c, true);
      setTimeout(finishStop, 200);
      return;
    }
    stopping = true;
    const all = children.map((c) => new Promise((r) => (c.exitCode != null || c.signalCode != null ? r() : c.once('exit', r))));
    for (const c of children) end(c);
    Promise.race([Promise.all(all), new Promise((r) => setTimeout(r, GRACE_MS + 2000))]).then(finishStop, finishStop);
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
