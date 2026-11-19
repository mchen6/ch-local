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

const PREFIX = 'ch-';
const MANIFEST_PREFIX = '.ch-local-tmp-';
const MANIFEST_NAME = new RegExp(`^${MANIFEST_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)-[A-Za-z0-9]+$`);
const KEY = Symbol.for('ch-local.test.tmp-dirs');
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
// whether a process is gone: signal 0 answers ESRCH (EPERM: it lives, as
// another user's)
const gone = (pid) => {
  try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
};
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
// this user's (POSIX; elsewhere the temporary directory is the user's own)
// (a bigint stat's uid is a BigInt)
const mineSt = (st) => uid == null || Number(st.uid) === uid;
// a manifest's lines -> {meta, dirs: [{dir, dev, ino}]} (a line cut short by
// a kill is skipped; one with no dev or ino is never removed)
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
    if (typeof e.dir === 'string' && typeof e.dev === 'string' && typeof e.ino === 'string' && (e.born == null || typeof e.born === 'string')) dirs.push(e);
  }
  return {meta, dirs};
};
// a directory's identity: its device, inode and birth time (tmpfs reuses an
// inode at once: a directory made again at a path can get the old one; the
// Reviewer on #97's CI). The birth time in ns, or null where the system has
// none (statx with no btime): then device and inode alone. Never ctime,
// which moves as entries are added.
// Where libuv has no statx (an older kernel, a seccomp profile that blocks
// it), it reports ctime as the birth time: probed once, by writing into a
// directory, and the birth time used only where it does not move (the
// medium on #97's second round, 4)
let bornReal = null;
const probeBorn = (made) => {
  if (bornReal != null) return bornReal;
  bornReal = false;
  let dir = null;
  try {
    dir = made(path.join(os.tmpdir(), '.ch-local-born-'));
    const first = fs.lstatSync(dir, {bigint: true}).birthtimeNs;
    fs.writeFileSync(path.join(dir, 'x'), '');
    fs.utimesSync(dir, new Date(), new Date(Date.now() + 2000));
    const after = fs.lstatSync(dir, {bigint: true});
    bornReal = first > 0n && after.birthtimeNs === first && after.ctimeNs !== first;
  } catch (err) { bornReal = false; }
  if (dir != null) { try { fs.rmSync(dir, {recursive: true, force: true}); } catch (err) { /* gone */ } }
  return bornReal;
};
const bornOf = (st) => (bornReal === true && st.birthtimeNs != null && st.birthtimeNs > 0n ? String(st.birthtimeNs) : null);
const lstatBig = (d) => fs.lstatSync(d, {bigint: true});
const sameDir = (st, {dev, ino, born}) => st.isDirectory() && String(st.dev) === dev && String(st.ino) === ino && mineSt(st)
  && (born == null || bornOf(st) == null || bornOf(st) === born);
// removes a listed directory when it is still the one listed and this
// user's -> whether it is gone (the check and the removal are by path: a
// swap between them is not guarded against, and needn't be for a test's own
// directories)
const removeListed = (e, under) => {
  if (!ours(e.dir, under)) return true;
  let st;
  try { st = lstatBig(e.dir); } catch (err) { return err.code === 'ENOENT'; }
  if (!sameDir(st, e)) return true;
  try {
    fs.rmSync(e.dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
    return true;
  } catch (err) { return err.code === 'ENOENT'; }
};
// the manifests in `dir` (the temporary directory, by default) of processes
// that are gone, made on this boot in this pid namespace and this user's:
// each listed directory still the one listed removed (only under the
// temporary directory the manifest records), then the manifest, kept while
// one could not be -> the number of manifests swept
function sweepStale(dir = os.tmpdir()) {
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
    if (!st.isDirectory() || !mineSt(st)) continue;
    const {meta, dirs} = linesOf(path.join(at, 'dirs.jsonl'));
    // one killed before its first line (or never opened) names nothing:
    // removed once it is a minute old, by this user, whatever made it
    if (meta == null) {
      if (dirs.length === 0 && Date.now() - st.mtimeMs > 60000) { try { fs.rmSync(at, {recursive: true, force: true}); swept += 1; } catch (err) { /* next time */ } }
      continue;
    }
    if (meta.pid !== pid || !sameWhere(meta.where, here) || typeof meta.tmpdir !== 'string') continue;
    if (pid === process.pid || !gone(pid)) continue;
    if (!dirs.map((e) => removeListed(e, meta.tmpdir)).every(Boolean)) continue;
    try { fs.rmSync(at, {recursive: true, force: true}); swept += 1; } catch (err) { /* swept again next time */ }
  }
  return swept;
}
if (global[KEY] == null) {
  const made = new Set();
  const tmpdir = path.resolve(os.tmpdir());
  // made at the first directory, not at load: a process that makes none has
  // no manifest (fs.mkdtempSync is taken before it is wrapped). Opened once.
  let manifest = null;
  let fd = null;
  const syncMade = fs.mkdtempSync;
  const line = (o) => { if (fd != null) fs.writeSync(fd, `${JSON.stringify(o)}\n`); };
  const record = (dir, st) => {
    try {
      probeBorn((p) => syncMade.call(fs, p));
      if (manifest == null) {
        manifest = syncMade.call(fs, path.join(tmpdir, `${MANIFEST_PREFIX}${process.pid}-`));
        fd = fs.openSync(path.join(manifest, 'dirs.jsonl'), 'wx', 0o600);
        line({meta: {pid: process.pid, where: where(), tmpdir}});
      }
      line({dir, dev: String(st.dev), ino: String(st.ino), born: bornOf(st)});
    } catch (err) { /* no manifest: 'exit' still removes them */ }
  };
  // (resolved now: a later chdir never sends the removal elsewhere)
  const keep = (dir) => {
    if (!ours(dir, tmpdir)) return dir;
    const d = path.resolve(String(dir));
    made.add(d);
    try { probeBorn((p) => syncMade.call(fs, p)); record(d, lstatBig(d)); } catch (err) { /* not recorded: 'exit' still removes it */ }
    return dir;
  };

  fs.mkdtempSync = function(...args) { return keep(syncMade.apply(fs, args)); };
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
  // (where: a manifest's own first line, for tmp-manifest's stale cases)
  global[KEY] = {removeMade, made, PREFIX, MANIFEST_PREFIX, MANIFEST_NAME, sweepStale, where, bornOf: (st) => { probeBorn((p) => syncMade.call(fs, p)); return bornOf(st); }};
}

module.exports = global[KEY];
