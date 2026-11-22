'use strict';
// The shared runtime's log (C-daemon-log): <home>/run/daemon/runtime.log.
// The daemon writes its own lines there, and a shared runtime's stdout and
// stderr (under --sessionSocket countinghouse serves MCP on the session
// socket; its stdout carries only its log). The shim starts the daemon with
// its output discarded, so without this file a shared runtime logs nowhere.
//
// - Private: in run/daemon (made private and judged on its real path by
//   ensureRunDir); POSIX opened O_APPEND|O_CREAT|O_NOFOLLOW at 0600 and,
//   once open, a regular file this user owns with no mode bits beyond 0600;
//   Windows a regular file (never a link) whose DACL win-acl's privateProblem
//   accepts, made through createPrivate. One that isn't is set aside as
//   runtime.log.1, never appended to, and a fresh one made; said in it.
// - Bounded: at a daemon's own start (not a hand-over's, which goes on in
//   the same file) the last log becomes runtime.log.1, one kept; past
//   CAP_BYTES while running, the same. A rename that fails (on Windows a file
//   another process holds) is never fatal: the lines go on into the file and
//   the rename is tried again at the next one.
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
    const after = fsx.fstatSync(fd);
    if (!after.isFile()) { fsx.closeSync(fd); return {problem: 'it is not a plain file', aside: true}; }
    return {fd, size: after.size};
  }
  let fd;
  try {
    fd = fsx.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600);
  } catch (e) { return {problem: `it could not be opened (${e.code || e.message})`, aside: e.code === 'ELOOP'}; }
  const s = fsx.fstatSync(fd);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const why = !s.isFile() ? 'it is not a plain file'
    : (uid != null && s.uid !== uid) ? 'it is owned by another user'
      : ((s.mode & 0o777) & ~0o600) !== 0 ? `its mode is ${(s.mode & 0o777).toString(8)}, wider than 600` : null;
  if (why != null) { fsx.closeSync(fd); return {problem: why, aside: true}; }
  return {fd, size: s.size};
}

// The log for a daemon in runDir. rotate: a daemon's own start (false for a
// hand-over's). -> {file, write(text), forward(stream), close(), note, problem}
// note: something said about the file as it was opened; problem: it is not
// used (write and forward then take lines and drop them).
function openRuntimeLog(runDir, {platform = process.platform, acl = null, rotate = true, fsx = fs, sink = null,
  cap = CAP_BYTES, lineCap = LINE_CAP, pendingMax = PENDING_MAX, now = () => new Date()} = {}) {
  const file = path.join(runDir, NAME);
  const old = `${file}.1`;
  const notes = [];
  const renameAside = () => { try { fsx.renameSync(file, old); return true; } catch (e) { return e.code === 'ENOENT'; } };
  if (rotate) renameAside();
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
  // past the cap: the file becomes runtime.log.1 and a fresh one is opened;
  // a rename that fails leaves the file as it is, tried again next line
  const rotateNow = () => {
    try { fsx.renameSync(file, old); } catch (e) { return; }
    const next = openPrivate(file, {platform, acl, fsx});
    try { fsx.closeSync(fd); } catch (e) { /* closed */ }
    fd = next.problem == null ? next.fd : null;
    size = next.problem == null ? next.size : 0;
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
      while (queue.length > 0 && fd != null) {
        const buf = queue.shift();
        queued -= buf.length;
        if (size + buf.length > cap) rotateNow();
        if (fd == null) break;
        if (dropped > 0) {
          // (writing still fails: this line goes the same way, counted)
          const said = Buffer.from(`${now().toISOString()} ch-local daemon: ${dropped} lines dropped\n`);
          if (!await writeOne(said)) { dropped++; continue; }
          size += said.length;
          dropped = 0;
        }
        if (await writeOne(buf)) size += buf.length;
        else dropped++;
      }
    } finally {
      busy = false;
      if (closing != null && queue.length === 0) closing();
    }
  };
  const take = (line) => {
    const buf = Buffer.from(`${capped(line, lineCap)}\n`);
    if (fd == null || closing != null || queued + buf.length > pendingMax) { dropped++; return; }
    queue.push(buf);
    queued += buf.length;
    pump();
  };
  for (const n of notes) take(`${now().toISOString()} ch-local daemon: ${n}`);
  return {
    file,
    note: notes.length > 0 ? notes[0] : null,
    problem: opened.problem != null ? `${file} is not used: ${opened.problem}` : null,
    // the daemon's own lines (each stamped)
    write(text) {
      for (const line of String(text).split('\n')) if (line !== '') take(`${now().toISOString()} ${line}`);
      return true;
    },
    // a runtime's stdout or stderr: whole lines, each at most lineCap; read
    // always, never paused
    forward(stream) {
      if (stream == null) return;
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
        const finish = () => { if (fd != null) { try { fsx.closeSync(fd); } catch (e) { /* closed */ } fd = null; } resolve(); };
        const t = setTimeout(finish, ms);
        if (typeof t.unref === 'function') t.unref();
        closing = () => { clearTimeout(t); finish(); };
        if (!busy && queue.length === 0) closing();
      });
    }
  };
}

module.exports = {openRuntimeLog, NAME, CAP_BYTES, LINE_CAP, PENDING_MAX};
