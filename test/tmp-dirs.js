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
// #89's Windows legs).
//
// So a process killed by a signal (an outer `timeout`, a stopped run, the
// runner's watchdog) never reaches 'exit', and its directories stayed. On
// POSIX each process also keeps a manifest of what it made: a directory of
// its own, made by mkdtemp as MANIFEST_PREFIX + its pid + '-' + a random
// suffix (owner-only, never shared), holding dirs.jsonl. Its first line says
// where it was made (the boot id and the pid namespace's inode, or the
// hostname off Linux, and the temporary directory); then one line per
// directory, its path, device, inode and birth time. At 'exit' the
// directories go, then the manifest. sweepStale(dir) takes only manifests
// whose process is gone, made on this boot in this pid namespace, and this
// user's, and removes only the directories they list that are still the same
// one: this user's, its device, inode and birth time, a ch-* directly under
// the temporary directory the manifest records. Where the birth time cannot
// be told the directory is left (a leak, never a wrong delete), its manifest
// with it. The runner cleans up its own registered output, never a pattern
// sweep of /tmp; scripts/test.js sweeps at its start and at its end (the
// Reviewer's rulings on #97, 11-19).
//
// Windows: the exit-time removal only. No manifest is written and no sweep
// runs there (the Reviewer's cut on #97: the leak fixed here was the Linux
// machine's).
//
// Left as it is (the residual, the Reviewer's cut on #97): only the file's
// own pid is ended, so anything a killed file started (a server, a session
// runtime, detached or not) outlives it, and the sweep may remove a home it
// still uses. A leaked child stays the test's own teardown bug. A runner
// killed outright (SIGKILL) leaves its files running: an outer kill of the
// whole group (systemd's scope, `timeout`, a terminal's Ctrl-C) reaches them.
//
// Why: tests made tens of thousands of ch-* directories on a shared /tmp
// and left them, until it ran out of inodes (the Reviewer, 11-19).
// scripts/test.js counts what a full run leaves.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREFIX = 'ch-';
const MANIFEST_PREFIX = '.ch-local-tmp-';
const MANIFEST_NAME = new RegExp(`^${MANIFEST_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)-[A-Za-z0-9]+$`);
const MANIFESTS = process.platform !== 'win32';
const KEY = Symbol.for('ch-local.test.tmp-dirs');
// fs.mkdtempSync as Node has it, taken before it is wrapped (a probe and the
// manifest's own directory are never registered)
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
// elsewhere the hostname. A manifest is swept only when every part is known
// and the same.
const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch (err) { return null; } };
const nsInode = () => { try { return String(fs.statSync('/proc/self/ns/pid').ino); } catch (err) { return null; } };
const where = () => (process.platform === 'linux'
  ? {boot: read('/proc/sys/kernel/random/boot_id'), pidns: nsInode()}
  : {host: os.hostname()});
const sameWhere = (a, b) => {
  const keys = Object.keys(b);
  return a != null && keys.length > 0 && keys.every((k) => typeof a[k] === 'string' && a[k] !== '' && b[k] != null && a[k] === b[k]);
};
// whether a process is gone: signal 0 answers ESRCH (EPERM: it lives, as
// another user's), or it is a zombie, dead and not yet reaped (Linux)
const zombie = (pid) => {
  const raw = read(`/proc/${pid}/stat`);
  return raw != null && raw.slice(raw.lastIndexOf(')') + 2, raw.lastIndexOf(')') + 3) === 'Z';
};
const gone = (pid) => {
  try { process.kill(pid, 0); } catch (err) { return err.code === 'ESRCH'; }
  return zombie(pid);
};
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
// this user's (a bigint stat's uid is a BigInt)
const mineSt = (st) => uid == null || Number(st.uid) === uid;

// Whether this system tells a directory's birth time: a fresh directory's
// is above 0 (the Reviewer's cut on #97: probed simply, once per process).
// Without it a directory made again at a listed path (tmpfs reuses an inode
// at once) cannot be told from the old one, so the sweep leaves it.
// Where libuv has no statx it reports ctime as the birth time: a moved ctime
// reads as made again, so the directory is left (fails safe: a leak, never a
// wrong delete; the Reviewer, #97).
let bornReal = null;
function probeBorn() {
  if (bornReal != null) return bornReal;
  bornReal = false;
  let dir = null;
  try {
    dir = rawMkdtemp.call(fs, path.join(os.tmpdir(), '.ch-local-born-'));
    bornReal = fs.lstatSync(dir, {bigint: true}).birthtimeNs > 0n;
  } catch (err) { bornReal = false; }
  if (dir != null) { try { fs.rmSync(dir, {recursive: true, force: true}); } catch (err) { /* gone */ } }
  return bornReal;
}
// A temporary directory removed whole: an own module's copy under one is
// read-only (B-own-add), so on EACCES/EPERM every folder and file under it
// is made writable by its owner -- by lstat, never through a link -- and the
// removal tried again.
function removeTree(dir) {
  try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); return; } catch (err) {
    if (err.code !== 'EACCES' && err.code !== 'EPERM' && err.code !== 'ENOTEMPTY') throw err;
  }
  const unlock = (at) => {
    let st;
    try { st = fs.lstatSync(at); } catch (e) { return; }
    if (st.isSymbolicLink()) return;
    try { fs.chmodSync(at, (st.mode & 0o777) | (st.isDirectory() ? 0o700 : 0o200)); } catch (e) { return; }
    if (st.isDirectory()) { let names = []; try { names = fs.readdirSync(at); } catch (e) { names = []; } for (const n of names) unlock(path.join(at, n)); }
  };
  unlock(dir);
  fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
}
const bornOf = (st) => (probeBorn() && st.birthtimeNs != null && st.birthtimeNs > 0n ? String(st.birthtimeNs) : null);
const lstatBig = (d) => fs.lstatSync(d, {bigint: true});

// a manifest's lines -> {meta, dirs} (a line cut short by a kill skipped)
const linesOf = (file) => {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { return {meta: null, dirs: []}; }
  let meta = null;
  const dirs = [];
  for (const line of raw.split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch (err) { continue; }
    if (e == null || typeof e !== 'object') continue;
    if (meta == null && e.meta != null && typeof e.meta === 'object') { meta = e.meta; continue; }
    if (typeof e.dir === 'string') dirs.push(e);
  }
  return {meta, dirs};
};
// a listed directory, removed only while it is still the one listed ->
// whether its manifest may go: once it is gone or proven another directory;
// never while it is there and cannot be told either way
const removeListed = (e, under) => {
  if (!ours(e.dir, under)) return true;
  let st;
  try { st = lstatBig(e.dir); } catch (err) { return err.code === 'ENOENT'; }
  if (!st.isDirectory() || !mineSt(st)) return true;
  if (typeof e.dev !== 'string' || typeof e.ino !== 'string') return false;
  if (String(st.dev) !== e.dev || String(st.ino) !== e.ino) return true;
  const born = bornOf(st);
  if (typeof e.born !== 'string' || born == null) return false;
  if (born !== e.born) return true;
  try { removeTree(e.dir); return true; } catch (err) { return err.code === 'ENOENT'; }
};
// the manifests in `dir` (the temporary directory, by default) of processes
// that are gone, made on this boot in this pid namespace, and this user's:
// each listed directory still the one listed removed, then the manifest,
// kept while one could not be -> the number of manifests swept
function sweepStale(dir = os.tmpdir()) {
  if (!MANIFESTS) return 0;
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
    const {meta, dirs} = linesOf(path.join(at, 'dirs.jsonl'));
    if (meta == null) {
      // one killed before its first line names nothing: removed once a
      // minute old (a writer in another pid namespace may be between its two
      // steps); one naming directories it cannot prove is left
      if (dirs.length === 0 && Date.now() - st.mtimeMs > 60000) { try { fs.rmSync(at, {recursive: true, force: true}); swept += 1; } catch (err) { /* next time */ } }
      continue;
    }
    if (meta.pid !== pid || !sameWhere(meta.where, here) || typeof meta.tmpdir !== 'string') continue;
    if (!dirs.map((e) => removeListed(e, meta.tmpdir)).every(Boolean)) continue;
    try { fs.rmSync(at, {recursive: true, force: true}); swept += 1; } catch (err) { /* swept again next time */ }
  }
  return swept;
}

if (global[KEY] == null) {
  const made = new Set();
  const tmpdir = path.resolve(os.tmpdir());
  // made at the first directory, not at load: a process that makes none has
  // no manifest. Opened once.
  let manifest = null;
  let fd = null;
  const line = (o) => {
    if (!MANIFESTS) return;
    try {
      if (manifest == null) {
        manifest = rawMkdtemp.call(fs, path.join(tmpdir, `${MANIFEST_PREFIX}${process.pid}-`));
        fd = fs.openSync(path.join(manifest, 'dirs.jsonl'), 'wx', 0o600);
        fs.writeSync(fd, `${JSON.stringify({meta: {pid: process.pid, where: where(), tmpdir}})}\n`);
      }
      fs.writeSync(fd, `${JSON.stringify(o)}\n`);
    } catch (err) { /* no manifest: 'exit' still removes them */ }
  };
  // (resolved now: a later chdir never sends the removal elsewhere)
  const keep = (dir) => {
    if (!ours(dir, tmpdir)) return dir;
    const d = path.resolve(String(dir));
    made.add(d);
    if (MANIFESTS) { try { const st = lstatBig(d); line({dir: d, dev: String(st.dev), ino: String(st.ino), born: bornOf(st)}); } catch (err) { /* not recorded: 'exit' still removes it */ } }
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

  // removes what this process made; a directory still in use (Windows, a
  // child still exiting) is tried for about 5 s, and one that cannot be
  // removed is left, its manifest with it, for a later sweep (POSIX; on
  // Windows there is none, and scripts/test.js names what is left)
  const removeMade = () => {
    let all = true;
    for (const dir of made) {
      try { removeTree(dir); } catch (err) { all = false; }
    }
    made.clear();
    if (fd != null) { try { fs.closeSync(fd); } catch (err) { /* closed */ } fd = null; }
    if (all && manifest != null) { try { fs.rmSync(manifest, {recursive: true, force: true}); } catch (err) { /* swept as stale later */ } }
  };
  process.on('exit', removeMade);
  // (where and bornOf: a manifest's own lines, for tmp-manifest's cases)
  global[KEY] = {removeMade, made, PREFIX, MANIFEST_PREFIX, MANIFEST_NAME, MANIFESTS, sweepStale, where, bornOf, rawMkdtemp};
}

module.exports = global[KEY];
