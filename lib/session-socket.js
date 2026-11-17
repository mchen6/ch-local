'use strict';
// Where the shared runtime listens (countinghouse's shared-runtime design,
// section 1, "Where it listens"; C4c). ch-local daemon picks it for each
// runtime start and passes it as --sessionSocket, with --sessionDir its run
// directory (<home>/run/daemon), where the secret is (countinghouse C2).
// - Windows: a named pipe, \\.\pipe\countinghouse-<32 hex>, its name random
//   (16 bytes) per runtime start: a predictable one could be taken ahead by
//   another user, so the runtime would never start. It is recorded in
//   daemon.json, which is owner-only.
// - POSIX: <home>/run/daemon/sessions.sock, unless that is over the
//   platform's limit (107 bytes on Linux, 103 on macOS, without the NUL):
//   then $TMPDIR/ch-<uid>/sessions.sock, its directory made 0700 and checked
//   like the run directory (the user's, not a link). The runtime checks it
//   again, and refuses a path still over the limit.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOCKET = 'sessions.sock';
const PIPE_NAME = /^\\\\\.\\pipe\\countinghouse-[0-9a-f]{32}$/;
const isPipeName = (p) => typeof p === 'string' && PIPE_NAME.test(p);
const socketPathMax = (platform) => (platform === 'darwin' ? 103 : 107);
const newPipeName = (random = crypto.randomBytes) => `\\\\.\\pipe\\countinghouse-${random(16).toString('hex')}`;

// the long-home fallback's socket: $TMPDIR (else the system's) /ch-<uid>/
function fallbackSocket({env = process.env, uid = (typeof process.geteuid === 'function' ? process.geteuid() : null)} = {}) {
  const base = typeof env.TMPDIR === 'string' && path.isAbsolute(env.TMPDIR) ? env.TMPDIR : os.tmpdir();
  return path.join(base, `ch-${uid}`, SOCKET);
}

// the socket for one runtime start: {socket, fallback} (fallback: the
// directory to make and check first, or null)
function socketFor(runDir, {platform = process.platform, env = process.env, uid, random} = {}) {
  if (platform === 'win32') return {socket: newPipeName(random), fallback: null};
  const inRun = path.join(runDir, SOCKET);
  if (Buffer.byteLength(inRun) <= socketPathMax(platform)) return {socket: inRun, fallback: null};
  const socket = fallbackSocket({env, ...(uid !== undefined ? {uid} : {})});
  return {socket, fallback: path.dirname(socket)};
}

// $TMPDIR/ch-<uid>/: made 0700 if missing, then the user's, a directory,
// not a link, 0700 -> null or what is wrong
function socketDirProblem(dir) {
  try {
    fs.mkdirSync(dir, {mode: 0o700});
  } catch (e) {
    if (e.code !== 'EEXIST') return `its socket directory ${dir} could not be made (${e.code || e.message})`;
  }
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { return `its socket directory ${dir} could not be read (${e.code || e.message})`; }
  if (st.isSymbolicLink() || !st.isDirectory()) return `its socket directory ${dir} is not a directory`;
  if (typeof process.geteuid === 'function' && st.uid !== process.geteuid()) return `its socket directory ${dir} is not this user's`;
  if ((st.mode & 0o777) !== 0o700) {
    try { fs.chmodSync(dir, 0o700); } catch (e) { return `its socket directory ${dir} could not be made 0700 (${e.code || e.message})`; }
  }
  return null;
}

// a daemon.json's socket that a daemon of this home may have chosen: a pipe
// name of the form (Windows, random per start), or exactly what socketFor
// gives on POSIX
function socketOk(socket, runDir, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform === 'win32') return isPipeName(socket);
  return typeof socket === 'string' && socket === socketFor(runDir, opts).socket;
}

module.exports = {SOCKET, PIPE_NAME, isPipeName, newPipeName, socketFor, fallbackSocket, socketDirProblem, socketOk, socketPathMax};
