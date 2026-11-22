'use strict';
// The shared runtime's log (C-daemon-log): <home>/run/daemon/runtime.log.
// The daemon writes its own lines there, and a shared runtime's stdout and
// stderr (under --sessionSocket countinghouse serves MCP on the session
// socket; its stdout carries only its log). The shim starts the daemon with
// its output discarded, so without this file a shared runtime logs nowhere.
//
// - Private: in run/daemon (made private by ensureRunDir); POSIX opened
//   O_APPEND|O_CREAT|O_NOFOLLOW at 0600 and, once open, a regular file this
//   user owns, with one link, no mode bits beyond 0600, and the same file as
//   the name now names; Windows a regular file (never a link) whose DACL
//   win-acl's privateProblem accepts, made through createPrivate, and the
//   same file once open. One that isn't is set aside as runtime.log.1, never
//   appended to, and a fresh one made; said in it.
// - Bounded: once a daemon has taken the home over at its own start (not a
//   hand-over's, which goes on in the same file; not a second daemon that
//   finds one serving), fresh() makes the last log runtime.log.1, one kept;
//   past CAP_BYTES while running, the same. A fresh file is created
//   exclusively, never through PowerShell (on Windows it takes run/daemon's
//   inherited owner-only DACL), so nothing on the running path waits on it.
//   A rename that fails (on Windows a file another process holds) is never
//   fatal: lines go on into the file, the rename is tried again at the next
//   one, and past twice the cap lines are dropped and counted instead.
// - Never in the runtime's way: every line read from it is taken at once;
//   the writes are queued, and past PENDING_MAX queued, or when a write
//   fails, lines are dropped, counted, and said ("<n> lines dropped") once
//   writing works again. One line is at most LINE_CAP bytes, cut with a
//   marker past it.
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'runtime.log';
const CAP_BYTES = 5 * 1024 * 1024;
const LINE_CAP = 8 * 1024;
const PENDING_MAX = 256 * 1024;

// a line as it is kept: at most lineCap bytes, the rest said as cut
function capped(line, lineCap) {
  const bytes = Buffer.byteLength(line);
  if (bytes <= lineCap) return line;
  return `${Buffer.from(line).subarray(0, lineCap).toString('utf8')} …[cut: ${bytes - lineCap} more bytes]`;
}

// file, opened for appending, private -> {fd, size} | {problem, aside}
// (aside: something is there that this must not append to)
function openPrivate(file, {platform, acl, fsx}) {
  let st = null;
  try { st = fsx.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') return {problem: `it could not be read (${e.code || e.message})`}; }
  if (st != null && (st.isSymbolicLink() || !st.isFile())) return {problem: 'it is not a plain file', aside: true};
  if (platform === 'win32') {
    const winAcl = acl || require('./win-acl');
    try {
      if (st != null) {
        const problem = winAcl.privateProblem(NAME, winAcl.fileAcl(file));
        if (problem != null) return {problem, aside: true};
      } else winAcl.createPrivate(file, '');
    } catch (e) { return {problem: `its access could not be checked (${e.code || e.message})`}; }
    let fd;
    try { fd = fsx.openSync(file, 'a'); } catch (e) { return {problem: `it could not be opened (${e.code || e.message})`}; }
    return checked(file, fd, {platform, fsx});
  }
  let fd;
  try {
    fd = fsx.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
  } catch (e) { return {problem: `it could not be opened (${e.code || e.message})`, aside: e.code === 'ELOOP'}; }
  return checked(file, fd, {platform, fsx});
}

// a fresh file at file, created exclusively (never one that is there), with
// no PowerShell: on Windows it takes run/daemon's inherited owner-only DACL
// -> {fd, size} | {problem}
function openFresh(file, {platform, fsx}) {
  let fd;
  try {
    fd = platform === 'win32' ? fsx.openSync(file, 'ax')
      : fsx.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  } catch (e) { return {problem: `a fresh one could not be made (${e.code || e.message})`}; }
  return checked(file, fd, {platform, fsx});
}

// an open fd at file: a regular file, the one the name names now (no link or
// junction swapped in), with one link; on POSIX this user's, at most 0600
// -> {fd, size} | {problem, aside} (fd closed)
function checked(file, fd, {platform, fsx}) {
  let s;
  let named;
  try {
    s = fsx.fstatSync(fd);
    named = fsx.lstatSync(file);
  } catch (e) {
    try { fsx.closeSync(fd); } catch (e2) { /* closed */ }
    return {problem: `it could not be read once open (${e.code || e.message})`};
  }
  const uid = platform !== 'win32' && typeof process.getuid === 'function' ? process.getuid() : null;
  const why = !s.isFile() || named.isSymbolicLink() ? 'it is not a plain file'
    : (s.ino !== named.ino || s.dev !== named.dev) ? 'it changed as it was opened'
      : s.nlink !== 1 ? 'it has another name (a hard link)'
        : (uid != null && s.uid !== uid) ? 'it is owned by another user'
          : (platform !== 'win32' && ((s.mode & 0o777) & ~0o600) !== 0) ? `its mode is ${(s.mode & 0o777).toString(8)}, wider than 600` : null;
  if (why != null) { try { fsx.closeSync(fd); } catch (e) { /* closed */ } return {problem: why, aside: true}; }
  return {fd, size: s.size};
}

// The log for a daemon in runDir, appended to as it is; fresh() once the
// daemon has taken the home over at its own start. -> {file, write(text),
// forward(stream), fresh(), close(), note, problem}
// note: something said about the file as it was opened; problem: it is not
// used (write and forward then take lines and drop them).
function openRuntimeLog(runDir, {platform = process.platform, acl = null, fsx = fs, sink = null,
  cap = CAP_BYTES, lineCap = LINE_CAP, pendingMax = PENDING_MAX, now = () => new Date()} = {}) {
  // (a hard limit, for a rename that keeps failing)
  const hardCap = 2 * cap;
  const file = path.join(runDir, NAME);
  const old = `${file}.1`;
  const notes = [];
  const renameAside = () => { try { fsx.renameSync(file, old); return true; } catch (e) { return e.code === 'ENOENT'; } };
  let opened = openPrivate(file, {platform, acl, fsx});
  if (opened.problem != null && opened.aside) {
    const why = opened.problem;
    opened = renameAside() ? openPrivate(file, {platform, acl, fsx}) : {problem: `${why}, and it could not be set aside`};
    if (opened.problem == null) notes.push(`the earlier ${NAME} was set aside as ${NAME}.1, unread: ${why}`);
  }
  let fd = opened.problem == null ? opened.fd : null;
  let size = opened.problem == null ? opened.size : 0;
  const write = sink || ((d, buf, cb) => fsx.write(d, buf, 0, buf.length, null, (err) => cb(err)));
  const queue = [];
  let queued = 0;
  let busy = false;
  let dropped = 0;
  let closing = null;
  let ended = false;          // closed: the fd is the queue's no more
  let closeAfter = false;     // closed while a write was out: the fd goes after it
  const streams = new Set();  // (each forgotten once it ends)
  // past the cap: the file becomes runtime.log.1 and a fresh one is opened;
  // a rename that fails leaves the file as it is, tried again next line
  // (a reopen that fails keeps the old fd, now runtime.log.1's, and tries
  // again at the next line)
  let stale = false;
  const rotateNow = () => {
    try {
      if (!stale) fsx.renameSync(file, old);
      stale = true;
      const next = openFresh(file, {platform, fsx});
      if (next.problem != null) return;
      try { fsx.closeSync(fd); } catch (e) { /* closed */ }
      fd = next.fd;
      size = next.size;
      stale = false;
    } catch (e) { /* the rename failed: tried again at the next line */ }
  };
  const writeOne = (buf) => new Promise((resolve) => {
    let done = false;
    try {
      write(fd, buf, (err) => { if (done) return; done = true; resolve(err == null); });
    } catch (e) { done = true; resolve(false); }
  });
  const pump = async() => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length > 0 && fd != null && !ended) {
        const buf = queue.shift();
        queued -= buf.length;
        if (stale || size + buf.length > cap) rotateNow();
        if (fd == null) break;
        // (still past twice the cap: the rename keeps failing; dropped)
        if (size + buf.length > hardCap) { dropped++; continue; }
        if (dropped > 0) {
          // (writing still fails: this line goes the same way, counted)
          const said = Buffer.from(`${now().toISOString()} [runtime log] ${dropped} lines dropped\n`);
          if (!await writeOne(said)) { dropped++; continue; }
          size += said.length;
          dropped = 0;
        }
        if (await writeOne(buf)) size += buf.length;
        else dropped++;
      }
    } finally {
      busy = false;
      // (never closed under a write still out: its fd number could be another
      // file's by the time the write runs)
      if (closeAfter && fd != null) { try { fsx.closeSync(fd); } catch (e) { /* closed */ } fd = null; }
      if (closing != null && queue.length === 0) closing();
    }
  };
  const take = (line) => {
    const buf = Buffer.from(`${capped(line, lineCap)}\n`);
    if (fd == null || closing != null || queued + buf.length > pendingMax) { dropped++; return; }
    queue.push(buf);
    queued += buf.length;
    pump().catch(() => { busy = false; if (closing != null) closing(); });
  };
  for (const n of notes) take(`${now().toISOString()} [runtime log] ${n}`);
  return {
    file,
    note: notes.length > 0 ? notes[0] : null,
    problem: opened.problem != null ? `${file} is not used: ${opened.problem}` : null,
    // the daemon's own lines (each stamped)
    write(text) {
      for (const line of String(text).split('\n')) if (line !== '') take(`${now().toISOString()} ${line}`);
      return true;
    },
    // once the daemon has taken the home over at its own start: the last log
    // becomes runtime.log.1, and this one goes on fresh
    fresh() {
      // (an empty log, nothing to keep: it goes on as it is)
      if (fd == null || size === 0) return;
      size = cap + 1;
      take(`${now().toISOString()} [runtime log] a fresh log; the last one is ${NAME}.1`);
    },
    // a runtime's stdout or stderr: whole lines, each at most lineCap; read
    // always, never paused; destroyed at close, so none keeps the daemon up
    forward(stream) {
      if (stream == null) return;
      streams.add(stream);
      stream.on('close', () => streams.delete(stream));
      if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
      let partial = '';
      let skipping = false;
      stream.on('data', (chunk) => {
        const parts = (partial + String(chunk)).split('\n');
        partial = parts.pop();
        for (const p of parts) { if (skipping) { skipping = false; continue; } take(p); }
        if (Buffer.byteLength(partial) > lineCap) { if (!skipping) take(partial); partial = ''; skipping = true; }
      });
      stream.on('end', () => { if (partial !== '' && !skipping) take(partial); partial = ''; });
      stream.on('error', () => { /* the runtime's end */ });
    },
    // the queued lines written (at most ms), then the file closed
    close(ms = 1000) {
      return new Promise((resolve) => {
        const finish = () => {
          for (const st of streams) { try { st.destroy(); } catch (e) { /* gone */ } }
          ended = true;
          if (busy) closeAfter = true;
          else if (fd != null) { try { fsx.closeSync(fd); } catch (e) { /* closed */ } fd = null; }
          resolve();
        };
        const t = setTimeout(finish, ms);
        if (typeof t.unref === 'function') t.unref();
        closing = () => { clearTimeout(t); finish(); };
        if (!busy && queue.length === 0) closing();
      });
    }
  };
}

module.exports = {openRuntimeLog, NAME, CAP_BYTES, LINE_CAP, PENDING_MAX};
