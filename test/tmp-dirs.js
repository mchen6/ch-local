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
// alike), holding dirs.jsonl, one line appended per directory made: its path
// and its device and inode (a kill mid-write loses at most that line). At
// 'exit' the directories go, then the manifest, kept if one could not be
// removed. sweepStale() takes only manifests whose process is gone (and this
// user's), removes only the directories they list that are still the same
// directory (its device and inode) and still a ch-* directly under the
// temporary directory, then the manifest: the runner cleaning up its own
// registered output, never a pattern sweep of /tmp. scripts/test.js sweeps
// at its start and after its run (the Reviewer's ruling, 11-19).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREFIX = 'ch-';
const MANIFEST_PREFIX = '.ch-local-tmp-';
const MANIFEST_NAME = new RegExp(`^${MANIFEST_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)-[A-Za-z0-9]+$`);
const KEY = Symbol.for('ch-local.test.tmp-dirs');
const ours = (dir) => {
  try {
    const d = path.resolve(String(dir));
    return path.dirname(d) === path.resolve(os.tmpdir()) && path.basename(d).startsWith(PREFIX);
  } catch (err) { return false; }
};
// whether a process is gone: signal 0 answers ESRCH (EPERM: it lives, as
// another user's)
const gone = (pid) => {
  try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
};
// this user's (POSIX; elsewhere the temporary directory is the user's)
const mine = (file) => {
  if (typeof process.getuid !== 'function') return true;
  try { return fs.lstatSync(file).uid === process.getuid(); } catch (err) { return false; }
};
// a manifest's lines -> [{dir, dev, ino}] (a line cut short by a kill is
// skipped)
const linesOf = (file) => {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    try { const e = JSON.parse(line); if (e != null && typeof e.dir === 'string') out.push(e); } catch (err) { /* cut short */ }
  }
  return out;
};
// removes a listed directory when it is still the one listed -> whether it
// is gone
const removeListed = ({dir, dev, ino}) => {
  if (!ours(dir)) return true;
  let st;
  try { st = fs.lstatSync(dir); } catch (err) { return err.code === 'ENOENT'; }
  if (!st.isDirectory() || (dev != null && String(st.dev) !== String(dev)) || (ino != null && String(st.ino) !== String(ino))) return true;
  try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); return true; } catch (err) { return false; }
};
// the manifests of processes that are gone: each listed directory still the
// one listed removed, then the manifest (kept while one could not be) ->
// the number of manifests swept
function sweepStale() {
  let swept = 0;
  let names = [];
  try { names = fs.readdirSync(os.tmpdir()); } catch (err) { return 0; }
  for (const name of names) {
    const m = MANIFEST_NAME.exec(name);
    if (m == null) continue;
    const pid = Number(m[1]);
    const at = path.join(os.tmpdir(), name);
    if (pid === process.pid || !gone(pid) || !mine(at)) continue;
    let st;
    try { st = fs.lstatSync(at); } catch (err) { continue; }
    if (!st.isDirectory()) continue;
    const all = linesOf(path.join(at, 'dirs.jsonl')).map(removeListed).every(Boolean);
    if (!all) continue;
    try { fs.rmSync(at, {recursive: true, force: true}); swept += 1; } catch (err) { /* swept again next time */ }
  }
  return swept;
}
if (global[KEY] == null) {
  const made = new Map();       // dir -> {dev, ino}
  // made at the first directory, not at load: a process that makes none has
  // no manifest (fs.mkdtempSync is taken before it is wrapped)
  let manifest = null;
  const syncMade = fs.mkdtempSync;
  const record = (dir, st) => {
    try {
      if (manifest == null) manifest = syncMade.call(fs, path.join(os.tmpdir(), `${MANIFEST_PREFIX}${process.pid}-`));
      fs.appendFileSync(path.join(manifest, 'dirs.jsonl'), `${JSON.stringify({dir, dev: String(st.dev), ino: String(st.ino)})}\n`, {mode: 0o600});
    } catch (err) { /* no manifest: 'exit' still removes them */ }
  };
  // (resolved now: a later chdir never sends the removal elsewhere)
  const keep = (dir) => {
    if (!ours(dir)) return dir;
    const d = path.resolve(String(dir));
    let st = null;
    try { st = fs.lstatSync(d); } catch (err) { st = null; }
    made.set(d, st != null ? {dev: st.dev, ino: st.ino} : {});
    if (st != null) record(d, st);
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
    for (const dir of made.keys()) {
      try { fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100}); } catch (err) { all = false; }
    }
    made.clear();
    if (all && manifest != null) { try { fs.rmSync(manifest, {recursive: true, force: true}); } catch (err) { /* swept as stale later */ } }
  };
  process.on('exit', removeMade);
  const manifestOf = () => manifest;
  global[KEY] = {removeMade, made, PREFIX, MANIFEST_PREFIX, MANIFEST_NAME, manifestOf, sweepStale};
}

module.exports = global[KEY];
