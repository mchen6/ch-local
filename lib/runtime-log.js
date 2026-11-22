'use strict';
// The shared runtime's log (C-daemon-log): <home>/run/daemon/runtime.log.
// The daemon writes its own lines there, and a shared runtime's stdout and
// stderr (under --sessionSocket countinghouse serves MCP on the session
// socket; its stdout carries only its log), each of the runtime's prefixed
// "[runtime] ". The shim starts the daemon with its output discarded, so
// without this file a shared runtime logs nowhere.
//
// - Private: in run/daemon (made private by ensureRunDir). POSIX opened
//   O_APPEND|O_CREAT|O_NOFOLLOW|O_NONBLOCK at 0600 (a FIFO there never
//   blocks the open); Windows created exclusively (it takes run/daemon's
//   inherited owner-only DACL, with no PowerShell), or an existing one opened
//   without O_CREAT after win-acl's privateProblem accepts its DACL. Once
//   open: a regular file, the one the name names, with one link; on POSIX
//   this user's, at most 0600. One that isn't is set aside as runtime.log.1,
//   never appended to, and a fresh one made; said in it.
// - Bounded by size alone: past CAP_BYTES the daemon that has the home (own())
//   renames it runtime.log.1, one kept, and goes on in a fresh one; any other
//   opener (a hand-over's daemon before it has the home, a second daemon that
//   finds one serving) only appends. A rename that fails (on Windows a file
//   another process holds) is never fatal: lines go on, it is tried again at
//   the next line, and past twice the cap lines are dropped and counted. A
//   log removed or moved meanwhile is opened again at its name (checked every
//   CHECK_MS). Lines are cut at LINE_CAP bytes (on a character's boundary),
//   with a marker; control characters but tab become "?", so no line can
//   move a terminal's cursor or pass for another.
// - Never in the runtime's way: every line read from it is taken at once;
//   the writes are queued, and past PENDING_MAX queued, or when a write
//   fails, lines are dropped, counted, and said ("<n> lines dropped") in
//   their place, before the next line kept.
const fs = require('node:fs');
const path = require('node:path');

const NAME = 'runtime.log';
const CAP_BYTES = 5 * 1024 * 1024;
const LINE_CAP = 8 * 1024;
const PENDING_MAX = 256 * 1024;
const CHECK_MS = 30 * 1000;

// a line as it is kept: control characters but tab as "?", at most lineCap
// bytes (cut on a character's boundary), the rest said as cut
function kept(line, lineCap) {
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/\r$/, '').replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/g, '?');
  const b = Buffer.from(clean);
  if (b.length <= lineCap) return clean;
  let i = lineCap;
  while (i > 0 && (b[i] & 0xc0) === 0x80) i--;
  return `${b.subarray(0, i).toString('utf8')} …[cut: ${b.length - i} more bytes]`;
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
  const uid = platform !== 'win32' && typeof process.geteuid === 'function' ? process.geteuid() : null;
  const why = !s.isFile() || named.isSymbolicLink() ? 'it is not a plain file'
    : (s.ino !== named.ino || s.dev !== named.dev) ? 'it changed as it was opened'
      : s.nlink !== 1 ? 'it has another name (a hard link)'
        : (uid != null && s.uid !== uid) ? 'it is owned by another user'
          : (platform !== 'win32' && ((s.mode & 0o777) & ~0o600) !== 0) ? `its mode is ${(s.mode & 0o777).toString(8)}, wider than 600` : null;
  if (why != null) { try { fsx.closeSync(fd); } catch (e) { /* closed */ } return {problem: why, aside: true}; }
  return {fd, size: s.size};
}

const C = fs.constants;
const POSIX_APPEND = C.O_WRONLY | C.O_APPEND | C.O_CREAT | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0);

// file, opened for appending, private -> {fd, size} | {problem, aside}
// (aside: something is there that this must not append to)
function openPrivate(file, {platform, acl, fsx}) {
  let st = null;
  try { st = fsx.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') return {problem: `it could not be read (${e.code || e.message})`}; }
  if (st != null && (st.isSymbolicLink() || !st.isFile())) return {problem: 'it is not a plain file', aside: true};
  if (platform === 'win32') {
    if (st == null) {
      // (made exclusively: a second daemon that made it first is the
      // existing-file case below)
      try { return checked(file, fsx.openSync(file, 'ax'), {platform, fsx}); } catch (e) {
        if (e.code !== 'EEXIST') return {problem: `it could not be made (${e.code || e.message})`};
      }
      try { st = fsx.lstatSync(file); } catch (e) { return {problem: `it could not be read (${e.code || e.message})`}; }
      if (st.isSymbolicLink() || !st.isFile()) return {problem: 'it is not a plain file', aside: true};
    }
    const winAcl = acl || require('./win-acl');
    try {
      const problem = winAcl.privateProblem(NAME, winAcl.fileAcl(file));
      if (problem != null) return {problem, aside: true};
    } catch (e) { return {problem: `its access could not be checked (${e.code || e.message})`}; }
    // (never O_CREAT: a link swapped in now makes nothing at its target)
    let fd;
    try { fd = fsx.openSync(file, C.O_WRONLY | C.O_APPEND); } catch (e) { return {problem: `it could not be opened (${e.code || e.message})`}; }
    return checked(file, fd, {platform, fsx});
  }
  let fd;
  try { fd = fsx.openSync(file, POSIX_APPEND, 0o600); } catch (e) {
    return {problem: `it could not be opened (${e.code || e.message})`, aside: e.code === 'ELOOP' || e.code === 'ENXIO'};
  }
  return checked(file, fd, {platform, fsx});
}

// a fresh file at file after a rotation, created exclusively; one already
// there (another daemon made it) is opened as any existing one
function openFresh(file, {platform, acl, fsx}) {
  let fd;
  try {
    fd = platform === 'win32' ? fsx.openSync(file, 'ax') : fsx.openSync(file, POSIX_APPEND | C.O_EXCL, 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') return openPrivate(file, {platform, acl, fsx});
    return {problem: `a fresh one could not be made (${e.code || e.message})`};
  }
  return checked(file, fd, {platform, fsx});
}

// The log for a daemon in runDir, appended to as it is. own(): this daemon
// has the home, so it rotates at the cap. -> {file, write(text),
// forward(stream), own(), close(), note, problem}. note: something said about
// the file as it was opened; problem: it is not used (lines are taken and
// dropped).
function openRuntimeLog(runDir, {platform = process.platform, acl = null, fsx = fs, sink = null, cap = CAP_BYTES,
  lineCap = LINE_CAP, pendingMax = PENDING_MAX, checkMs = CHECK_MS, now = () => new Date(), clock = () => Date.now()} = {}) {
  const hardCap = 2 * cap;
  const file = path.join(runDir, NAME);
  const old = `${file}.1`;
  const notes = [];
  const stamp = (s) => `${now().toISOString()} ${s}`;
  let opened = openPrivate(file, {platform, acl, fsx});
  if (opened.problem != null && opened.aside) {
    const why = opened.problem;
    let moved = true;
    try { fsx.renameSync(file, old); } catch (e) { moved = e.code === 'ENOENT'; }
    opened = moved ? openPrivate(file, {platform, acl, fsx}) : {problem: `${why}, and it could not be set aside`};
    if (opened.problem == null) notes.push(`the earlier ${NAME} was set aside as ${NAME}.1, unread: ${why}`);
  }
  let fd = opened.problem == null ? opened.fd : null;
  let size = opened.problem == null ? opened.size : 0;
  let owner = false;
  let lastCheck = clock();
  // every byte of buf, a short write going on from where it stopped
  const writeAll = (d, buf, cb) => {
    let off = 0;
    const step = () => fsx.write(d, buf, off, buf.length - off, null, (err, n) => {
      if (err) return cb(err);
      off += n;
      if (off >= buf.length) return cb(null);
      if (n === 0) return cb(new Error('a write wrote nothing'));
      step();
    });
    step();
  };
  const write = sink || writeAll;
  const queue = [];           // {buf, notice: the drop count it says, or 0}
  let queued = 0;
  let busy = false;
  let dropped = 0;
  let closing = null;
  let ended = false;          // closed: the fd is the queue's no more
  let closeAfter = false;     // closed while a write was out: the fd goes after it
  const streams = new Set();  // (each forgotten once it ends)
  const swap = (next) => { try { fsx.closeSync(fd); } catch (e) { /* closed */ } fd = next.fd; size = next.size; };
  // past the cap, the owner only: the file becomes runtime.log.1 and a fresh
  // one goes on; a rename that fails leaves it as it is, tried at the next line
  const rotate = () => {
    try { fsx.renameSync(file, old); } catch (e) { if (e.code !== 'ENOENT') return; }
    const next = openFresh(file, {platform, acl, fsx});
    if (next.problem == null) swap(next);
  };
  // the name still names this file: one removed or moved is opened again
  const recheck = () => {
    lastCheck = clock();
    let named = null;
    let mine = null;
    try { mine = fsx.fstatSync(fd); named = fsx.lstatSync(file); } catch (e) { named = null; }
    if (named != null && mine != null && named.ino === mine.ino && named.dev === mine.dev) return;
    const next = openPrivate(file, {platform, acl, fsx});
    if (next.problem == null) swap(next);
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
        const item = queue.shift();
        queued -= item.buf.length;
        if (clock() - lastCheck >= checkMs) recheck();
        if (owner && size + item.buf.length > cap) rotate();
        // (still past twice the cap: a rename that keeps failing, or a log
        // this daemon may not rotate; dropped)
        if (size + item.buf.length > hardCap) { dropped += item.notice || 1; continue; }
        if (await writeOne(item.buf)) size += item.buf.length;
        else dropped += item.notice || 1;
      }
    } finally {
      busy = false;
      // (never closed under a write still out: its fd number could be another
      // file's by the time the write runs)
      if (closeAfter && fd != null) { try { fsx.closeSync(fd); } catch (e) { /* closed */ } fd = null; }
      if (closing != null && queue.length === 0) closing();
    }
  };
  const push = (buf, notice) => { queue.push({buf, notice}); queued += buf.length; };
  const take = (line) => {
    const buf = Buffer.from(`${kept(line, lineCap)}\n`);
    if (fd == null || closing != null || queued + buf.length > pendingMax) { dropped++; return; }
    // (the drops said where they were, before this line)
    if (dropped > 0) { push(Buffer.from(`${stamp(`[runtime log] ${dropped} lines dropped`)}\n`), dropped); dropped = 0; }
    push(buf, 0);
    pump().catch(() => { busy = false; if (closing != null) closing(); });
  };
  for (const n of notes) take(stamp(`[runtime log] ${n}`));
  return {
    file,
    note: notes.length > 0 ? notes[0] : null,
    problem: opened.problem != null ? `${file} is not used: ${opened.problem}` : null,
    // the daemon's own lines (each stamped)
    write(text) {
      for (const line of String(text).split('\n')) if (line !== '') take(stamp(line));
      return true;
    },
    // this daemon has the home: it rotates at the cap
    own() { owner = true; },
    // a runtime's stdout or stderr: whole lines, "[runtime] " first, each at
    // most lineCap; read always, never paused; destroyed at close, so none
    // keeps the daemon up, and forgotten once it ends
    forward(stream) {
      if (stream == null) return;
      streams.add(stream);
      stream.on('close', () => streams.delete(stream));
      if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');
      let partial = '';
      let skipping = false;
      const one = (p) => take(`[runtime] ${p}`);
      stream.on('data', (chunk) => {
        const parts = (partial + String(chunk)).split('\n');
        partial = parts.pop();
        for (const p of parts) { if (skipping) { skipping = false; continue; } one(p); }
        if (Buffer.byteLength(partial) > lineCap) { if (!skipping) one(partial); partial = ''; skipping = true; }
      });
      stream.on('end', () => { if (partial !== '' && !skipping) one(partial); partial = ''; });
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
        closing = () => { clearTimeout(t); finish(); };
        if (!busy && queue.length === 0) closing();
      });
    }
  };
}

module.exports = {openRuntimeLog, NAME, CAP_BYTES, LINE_CAP, PENDING_MAX, CHECK_MS};
