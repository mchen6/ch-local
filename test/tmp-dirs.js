'use strict';
// Every temporary directory a test makes is removed when its test process
// ends. Every test file requires it in its first lines (test/tmp-dirs-loaded
// checks that), so a file run on its own gets it too; npm test
// (scripts/test.js) also preloads it:
// fs.mkdtemp, fs.mkdtempSync and fs.promises.mkdtemp are wrapped, and each
// directory they make directly under the temporary directory with a name
// that begins `ch-` (every test's prefix) is registered, then removed at
// the process's exit, after its last test. A test that removes its own first
// loses nothing (force).
//
// No signal handler: a listener for SIGINT or SIGTERM changes how a process
// ends on one, and tests emit those signals themselves (acceptance's
// trapSignals test: process.emit('SIGINT')), which would remove a file's
// directories mid-run and, re-raised, end the process on Windows (ch-local
// #89's Windows legs). A file killed by a signal leaves its directories;
// scripts/test.js names them.
//
// Why at the process's end, not each test's: it covers the 40 mkdtemp
// sites and every per-file tmp() helper with no call site changed, and
// library code a test runs (a fetched release's directory) the same way.
//
// Why: tests made tens of thousands of ch-* directories on a shared /tmp
// and left them, until it ran out of inodes (the Reviewer, 11-19).
// scripts/test.js counts what a full run leaves.
//
// A process killed by a signal (an outer `timeout`, a stopped run) never
// reaches 'exit', and its directories stayed: whole files' worth at once.
// So each process also keeps a manifest of what it made: a directory of its
// own, made by mkdtemp as MANIFEST_PREFIX + its pid + '-' + a random suffix
// (owner-only, so nothing planted is followed, and never two processes'
// alike), holding dirs.jsonl: a first line of where it was made (the boot,
// the pid namespace, the temporary directory), then one line per directory
// made, its path and its device and inode (a kill mid-write loses at most
// that line). At
// 'exit' the directories go, then the manifest, kept if one could not be
// removed. sweepStale(dir) takes only manifests in dir whose process is
// gone, made on this boot in this pid namespace, and this user's; removes
// only the directories they list that are still the same directory (its
// device, inode and owner, looked at again right before) and still a ch-*
// directly under the temporary directory the manifest records, then the
// manifest: the runner cleaning up its own
// registered output, never a pattern sweep of /tmp. scripts/test.js sweeps
// at its start and after its run (the Reviewer's ruling, 11-19).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const PREFIX = 'ch-';
const MANIFEST_PREFIX = '.ch-local-tmp-';
const MANIFEST_NAME = new RegExp(`^${MANIFEST_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)-[A-Za-z0-9]+$`);
const KEY = Symbol.for('ch-local.test.tmp-dirs');
// fs.mkdtempSync as Node has it, taken before it is wrapped (the probe and
// the manifest's own directory are never registered)
const rawMkdtemp = global[KEY] != null ? global[KEY].rawMkdtemp : fs.mkdtempSync;

// a directory of ours: a ch-* directly under the temporary directory `under`
const ours = (dir, under = os.tmpdir()) => {
  try {
    const d = path.resolve(String(dir));
    return path.dirname(d) === path.resolve(String(under)) && path.basename(d).startsWith(PREFIX);
  } catch (err) { return false; }
};
// Where a pid means something: one boot, one pid namespace (rootless Docker
// shares the uid). Linux: the boot id and the pid namespace's inode;
// elsewhere the hostname (a pid then means this machine's). Unknown parts
// are null, and a manifest is swept only when every part is known and the
// same (the Reviewer's high review of #97, 4).
const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (err) { return null; } };
const nsInode = () => { try { return String(fs.statSync('/proc/self/ns/pid').ino); } catch (err) { return null; } };
const where = () => (process.platform === 'linux'
  ? {boot: read('/proc/sys/kernel/random/boot_id'), pidns: nsInode()}
  : {host: os.hostname()});
const sameWhere = (a, b) => {
  const keys = Object.keys(b);
  return a != null && keys.length > 0 && keys.every((k) => typeof a[k] === 'string' && a[k] !== '' && b[k] != null && a[k] === b[k]);
};
// /proc/<pid>/stat's state and start time (Linux), or null
const procStat = (pid) => {
  const raw = read(`/proc/${pid}/stat`);
  if (raw == null) return null;
  const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
  return {state: rest[0], start: rest[19]};
};
// whether a process is gone: signal 0 answers ESRCH (EPERM: it lives, as
// another user's); a zombie is gone too (the Reviewer's second high review
// of #97, 6)
const gone = (pid) => {
  try { process.kill(pid, 0); } catch (err) { return err.code === 'ESRCH'; }
  const st = procStat(pid);
  return st != null && st.state === 'Z';
};
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
// this user's (POSIX; elsewhere the temporary directory is the user's own;
// a bigint stat's uid is a BigInt)
const mineSt = (st) => uid == null || Number(st.uid) === uid;

// A directory's identity: its device, inode and birth time (tmpfs reuses an
// inode at once, so a directory made again at a path can get the old one).
// Where libuv has no statx (an older kernel, a seccomp profile that blocks
// it) it reports ctime as the birth time, which moves as entries are added:
// probed once per process, the probe itself (never ctime), and a directory
// whose birth time cannot be told is never removed by a sweep (the
// Reviewer's second high review of #97, 1). Every process that sweeps or
// records probes for itself: the runner never calls mkdtemp.
let bornReal = null;
function probeBorn() {
  if (bornReal != null) return bornReal;
  bornReal = false;
  let dir = null;
  try {
    dir = rawMkdtemp.call(fs, path.join(os.tmpdir(), '.ch-local-born-'));
    const first = fs.lstatSync(dir, {bigint: true}).birthtimeNs;
    fs.writeFileSync(path.join(dir, 'x'), '');
    fs.utimesSync(dir, new Date(), new Date(Date.now() + 2000));
    const after = fs.lstatSync(dir, {bigint: true});
    bornReal = first > 0n && after.birthtimeNs === first && after.ctimeNs !== first;
  } catch (err) { bornReal = false; }
  if (dir != null) { try { fs.rmSync(dir, {recursive: true, force: true}); } catch (err) { /* gone */ } }
  return bornReal;
}
const bornOf = (st) => (probeBorn() && st.birthtimeNs != null && st.birthtimeNs > 0n ? String(st.birthtimeNs) : null);
const lstatBig = (d) => fs.lstatSync(d, {bigint: true});

// a manifest's lines -> {meta, dirs: [{dir, dev, ino, born}], pids: [{pid,
// start}]} (a line cut short by a kill is skipped)
const linesOf = (file) => {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { return {meta: null, dirs: [], pids: []}; }
  let meta = null;
  const dirs = [];
  const pids = [];
  for (const line of raw.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch (err) { continue; }
    if (e == null || typeof e !== 'object') continue;
    if (meta == null && e.meta != null && typeof e.meta === 'object') { meta = e.meta; continue; }
    if (typeof e.dir === 'string') dirs.push(e);
    else if (Number.isInteger(e.pid) && typeof e.start === 'string') pids.push(e);
  }
  return {meta, dirs, pids};
};
// a listed directory removed only when it is still the one listed: this
// user's, its device and inode, and a birth time both sides can tell and
// the same -> whether nothing of it is left to keep the manifest for
const removeListed = (e, under) => {
  if (!ours(e.dir, under)) return true;
  if (typeof e.dev !== 'string' || typeof e.ino !== 'string' || typeof e.born !== 'string') return true;
  let st;
  try { st = lstatBig(e.dir); } catch (err) { return err.code === 'ENOENT'; }
  const born = bornOf(st);
  if (!st.isDirectory() || !mineSt(st) || String(st.dev) !== e.dev || String(st.ino) !== e.ino || born == null || born !== e.born) return true;
  // (by path: a swap between the check and the removal is not guarded
  // against, and needn't be for a test's own directories)
  try { fs.rmSync(e.dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); return true; } catch (err) { return err.code === 'ENOENT'; }
};
// a detached process a dead test process started (a daemon in a session of
// its own), ended when it is still that process: its start time the one
// recorded (Linux; elsewhere it is left: no pid is signalled unsure)
const endRecorded = ({pid, start}) => {
  const st = procStat(pid);
  if (st == null || st.start !== start || st.state === 'Z') return;
  try { process.kill(-pid, 'SIGKILL'); } catch (err) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ } }
};
// the manifests in `dir` (the temporary directory, by default) of processes
// that are gone, made on this boot in this pid namespace, and this user's:
// the detached processes they recorded ended, each listed directory still
// the one listed removed (only under the temporary directory the manifest
// records), then the manifest, kept while one could not be -> the number of
// manifests swept
function sweepStale(dir = os.tmpdir()) {
  probeBorn();
  const here = where();
  let swept = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch (err) { return 0; }
  for (const name of names) {
    const m = MANIFEST_NAME.exec(name);
    if (m == null) continue;
    const pid = Number(m[1]);
    const at = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(at); } catch (err) { continue; }
    if (!st.isDirectory() || !mineSt(st) || pid === process.pid || !gone(pid)) continue;
    const {meta, dirs, pids} = linesOf(path.join(at, 'dirs.jsonl'));
    if (meta == null) {
      // one killed before its first line names nothing: removed (its pid
      // gone); one of an earlier format lists directories it cannot prove:
      // left (the Reviewer's second high review of #97, 7)
      if (dirs.length === 0 && pids.length === 0) { try { fs.rmSync(at, {recursive: true, force: true}); swept += 1; } catch (err) { /* next time */ } }
      continue;
    }
    if (meta.pid !== pid || !sameWhere(meta.where, here) || typeof meta.tmpdir !== 'string') continue;
    for (const p of pids) endRecorded(p);
    if (!dirs.map((e) => removeListed(e, meta.tmpdir)).every(Boolean)) continue;
    try { fs.rmSync(at, {recursive: true, force: true}); swept += 1; } catch (err) { /* swept again next time */ }
  }
  return swept;
}

if (global[KEY] == null) {
  const made = new Set();
  const tmpdir = path.resolve(os.tmpdir());
  // made at the first directory or detached child, not at load: a process
  // that makes none has no manifest. Opened once.
  let manifest = null;
  let fd = null;
  const line = (o) => {
    try {
      if (manifest == null) {
        manifest = rawMkdtemp.call(fs, path.join(tmpdir, `${MANIFEST_PREFIX}${process.pid}-`));
        fd = fs.openSync(path.join(manifest, 'dirs.jsonl'), 'wx', 0o600);
        fs.writeSync(fd, `${JSON.stringify({meta: {pid: process.pid, where: where(), tmpdir, bornReal: probeBorn()}})}\n`);
      }
      fs.writeSync(fd, `${JSON.stringify(o)}\n`);
    } catch (err) { /* no manifest: 'exit' still removes them */ }
  };
  // (resolved now: a later chdir never sends the removal elsewhere)
  const keep = (dir) => {
    if (!ours(dir, tmpdir)) return dir;
    const d = path.resolve(String(dir));
    made.add(d);
    try { const st = lstatBig(d); line({dir: d, dev: String(st.dev), ino: String(st.ino), born: bornOf(st)}); } catch (err) { /* not recorded: 'exit' still removes it */ }
    return dir;
  };

  fs.mkdtempSync = function(...args) { return keep(rawMkdtemp.apply(fs, args)); };
  const cbMade = fs.mkdtemp;
  fs.mkdtemp = function(...args) {
    // no callback: Node's own error, never one made up (the medium, 3)
    if (typeof args[args.length - 1] !== 'function') return cbMade.apply(fs, args);
    const cb = args.pop();
    return cbMade.call(fs, ...args, (err, dir) => { if (err == null) keep(dir); cb(err, dir); });
  };
  const promiseMade = fs.promises.mkdtemp;
  fs.promises.mkdtemp = async function(...args) { return keep(await promiseMade.apply(fs.promises, args)); };

  // A detached child (a daemon in a session of its own: handoff-io's,
  // start's session runtimes) outlives a group kill: its pid and start time
  // recorded, so a sweep ends it before removing what it uses (Linux; the
  // Reviewer's second high review of #97, 4)
  const rawSpawn = childProcess.spawn;
  childProcess.spawn = function(...args) {
    const child = rawSpawn.apply(childProcess, args);
    const opts = args.find((a, i) => i > 0 && a != null && typeof a === 'object' && !Array.isArray(a));
    if (opts != null && opts.detached === true && child.pid != null) {
      const st = procStat(child.pid);
      if (st != null) line({pid: child.pid, start: st.start});
    }
    return child;
  };

  // When the runner that started this file is gone (killed outright), the
  // file ends itself, its directories with it (a parent-death check: the
  // Reviewer's second high review of #97, 5). Its parent changes on POSIX;
  // Windows never reparents, and a runner sent SIGTERM there is ended at
  // once with no handler run, so the runner's pid itself is asked too (#97's
  // windows-latest leg).
  const runner = Number(process.env.CH_TEST_RUNNER_PID);
  if (Number.isInteger(runner) && runner > 0 && runner === process.ppid) {
    const runnerGone = () => { try { process.kill(runner, 0); return false; } catch (err) { return err.code === 'ESRCH'; } };
    setInterval(() => { if (process.ppid !== runner || runnerGone()) process.exit(70); }, 1000).unref();
  }
  // The runner, before it ends a file past its time, asks it to name the
  // test it is in (SIGUSR2: no test emits it; the file goes on). Names come
  // from scripts/test-running.js, a reporter beside the spec one.
  if (process.platform !== 'win32') {
    process.on('SIGUSR2', () => {
      const running = global[Symbol.for('ch-local.test.running')];
      const names = running instanceof Map ? [...running.values()] : [];
      try { process.stderr.write(`\nstill running: ${names.length > 0 ? names.join(' > ') : '(no test started)'}\n`); } catch (err) { /* no stderr */ }
    });
  }

  // removes what this process made; a directory still in use (Windows, a
  // child still exiting) is tried for about 5 s, and one that cannot be
  // removed is left, its manifest with it, for a later sweep (scripts/test.js
  // then names it)
  const removeMade = () => {
    let all = true;
    for (const dir of made) {
      try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); } catch (err) { all = false; }
    }
    made.clear();
    if (fd != null) { try { fs.closeSync(fd); } catch (err) { /* closed */ } fd = null; }
    if (all && manifest != null) { try { fs.rmSync(manifest, {recursive: true, force: true}); } catch (err) { /* swept as stale later */ } }
  };
  process.on('exit', removeMade);
  // (where and bornOf: a manifest's own lines, for tmp-manifest's cases)
  global[KEY] = {removeMade, made, PREFIX, MANIFEST_PREFIX, MANIFEST_NAME, sweepStale, where, bornOf, rawMkdtemp};
}

module.exports = global[KEY];
