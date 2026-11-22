'use strict';
// <home>/shim.json (countinghouse's shared-runtime design, #236, section 6,
// "The shim's home and shim.json"): what the native shim runs, from paths
// ch-local resolves at install. The shim spawns `<node> <chLocal> daemon` and
// `<node> <chLocal> conditions --for <pid> --home <home>` from it, and gives the daemon a
// cleared environment holding exactly `env`.
//
//   {"node": <absolute>, "chLocal": <absolute: <home>/bin/ch-local.js>,
//    "env": {PATH, HOME | USERPROFILE, LANG?, TMPDIR? (POSIX) |
//            SystemRoot, TEMP, TMP, APPDATA, LOCALAPPDATA (Windows)}}
//
// 0600, written through a temporary file created exclusively and renamed into
// place, so a symlink at the path is replaced, never written through. The
// shim refuses any other key (naming it), a relative path or a non-string
// value; shimJsonProblem applies the same rule here.
const fs = require('node:fs');
const path = require('node:path');
const {isFullPath} = require('./home');

const POSIX_KEYS = ['PATH', 'HOME', 'LANG', 'TMPDIR'];
const WINDOWS_KEYS = ['PATH', 'USERPROFILE', 'LANG', 'SystemRoot', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA'];

// a variable of env by name, case-insensitively on Windows (Path, PATH)
function pick(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const k = Object.keys(env).find((n) => n.toUpperCase() === name.toUpperCase());
  return k != null ? env[k] : undefined;
}

// the body install writes: node (io.node), chLocal (the installed launcher)
// and the allowlisted variables present at install
function shimJsonFor({node, home, env = process.env, platform = process.platform}) {
  // joined by that platform's rules, as the shim there reads it
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return {node, chLocal: join(home, 'bin', 'ch-local.js'), env: allowedEnv(env, platform)};
}

// env's variables on shim.json's allowlist for `platform`, and no others: the
// daemon's environment, and its runtime's, however the daemon was started
function allowedEnv(env, platform = process.platform) {
  const keys = platform === 'win32' ? WINDOWS_KEYS : POSIX_KEYS;
  const out = {};
  for (const k of keys) {
    const v = pick(env, k, platform);
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

// A per-session runtime's environment (#413 section 6.9; the Reviewer's
// high review of L5a, 1): an allowlist, never the client's whole
// environment, so no credential a client sets reaches the runtime or a
// worker. The daemon's keys (above), plus the locale and time zone, the
// extra CA bundle a corporate network needs (a path), the acceptance switch
// (honoured only with an acceptance run's origin map), and on Windows what a
// process needs to run a .cmd. No test switch: a client's environment never
// turns on the runtime's test-only delays. No proxy variable: countinghouse
// makes no call through an HTTP proxy (its lockdown sets proxy: null on a
// module's request; its remote client has its own agent), so a proxy here
// would only be readable by a module that declares it. Start adds the
// credential slots after this.
const LOCALE = /^(LC_[A-Z]+|LANGUAGE|TZ)$/;
const RUNTIME_EXTRA = ['NODE_EXTRA_CA_CERTS', 'COUNTINGHOUSE_ACCEPTANCE'];
// what a Windows process needs to run a .cmd (npm, git) and find its
// system directories: no secret among them
const WINDOWS_EXTRA = ['PATHEXT', 'ComSpec', 'SystemDrive', 'WINDIR', 'PROGRAMDATA', 'ProgramFiles'];
function runtimeEnv(env, platform = process.platform) {
  const out = allowedEnv(env, platform);
  if (platform === 'win32') for (const k of WINDOWS_EXTRA) { const v = pick(env || {}, k, platform); if (typeof v === 'string' && v !== '') out[k] = v; }
  // by any case on win32, as the whole allowlist is there (the Reviewer's
  // round 3, 8); on POSIX by their own names
  const win = platform === 'win32';
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof v !== 'string' || v === '' || k in out) continue;
    const name = win ? k.toUpperCase() : k;
    if (LOCALE.test(name) || RUNTIME_EXTRA.includes(name)) out[k] = v;
  }
  return out;
}

// -> null, or what the shim would refuse on `platform`: paths absolute for
// that platform, its own allowlist only, and never a .cmd or .bat node (run
// through cmd.exe, with its parsing), as the shim's config.rs refuses
function shimJsonProblem(body, platform = process.platform) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return 'shim.json is not an object';
  for (const k of ['node', 'chLocal']) {
    if (typeof body[k] !== 'string' || !isFullPath(body[k], platform)) return `${k} is not an absolute path`;
  }
  if (/\.(cmd|bat)$/i.test(body.node)) return 'node is a .cmd or .bat script, not a program';
  if (body.env == null || typeof body.env !== 'object' || Array.isArray(body.env)) return 'env is not an object';
  const allowed = new Set(platform === 'win32' ? WINDOWS_KEYS : POSIX_KEYS);
  for (const [k, v] of Object.entries(body.env)) {
    if (!allowed.has(k)) return `env names ${k}, which the daemon may not be given`;
    if (typeof v !== 'string') return `env's ${k} is not a string`;
  }
  return null;
}

// Whether the shim could start what <home>/shim.json names, now: this user's
// own file (lib/own-file.js), valid (shimJsonProblem), its node runnable
// and its chLocal readable. shim.json names the Node install ran under, and a
// Node upgrade that moves it (brew, nvm) leaves the shim starting nothing
// (A3, the final pass). access: fs.accessSync (a test's own); fileAcl: the
// session's ACL reader (Windows). -> null, or
// {which: 'shim.json' | 'node' | 'chLocal', code}: which, and the errno, for
// a line that names no path
function shimJsonRunProblem(home, {platform = process.platform, access = fs.accessSync, fileAcl = null} = {}) {
  let bytes;
  try {
    bytes = require('./own-file').readOwnFile(path.join(home, 'shim.json'), {max: 64 * 1024, platform, fileAcl});
  } catch (e) {
    // (a check that couldn't be made is said as such, never as a bad file:
    // the medium on A3, 3)
    return {which: 'shim.json', code: e.code || 'unreadable'};
  }
  if (bytes == null) return {which: 'shim.json', code: 'missing'};
  let body;
  try { body = JSON.parse(bytes.toString('utf8')); } catch (e) { return {which: 'shim.json', code: 'invalid'}; }
  if (shimJsonProblem(body, platform) != null) return {which: 'shim.json', code: 'invalid'};
  // (a regular file each, and runnable or readable: access alone passes a
  // directory, and X_OK is an existence check on Windows -- the medium, 4)
  for (const [which, mode] of [['node', fs.constants.X_OK], ['chLocal', fs.constants.R_OK]]) {
    try {
      if (!fs.statSync(body[which]).isFile()) return {which, code: 'not a file'};
      access(body[which], mode);
    } catch (e) {
      return {which, code: e.code || 'refused'};
    }
  }
  return null;
}

// writes <home>/shim.json -> the body written
function writeShimJson(home, args) {
  const body = shimJsonFor({...args, home});
  const problem = shimJsonProblem(body, args.platform || process.platform);
  if (problem != null) throw new Error(`shim.json would be refused: ${problem}`);
  const file = path.join(home, 'shim.json');
  const temp = path.join(home, `.shim.json.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  let placed = false;
  try {
    try {
      // 0600 whatever the umask (one of 0277 would leave 0400, which the
      // shim refuses)
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, file);
    placed = true;
  } finally {
    if (!placed) { try { fs.unlinkSync(temp); } catch (e) { /* gone */ } }
  }
  return body;
}

module.exports = {shimJsonFor, shimJsonProblem, writeShimJson, POSIX_KEYS, WINDOWS_KEYS, allowedEnv, runtimeEnv, shimJsonRunProblem};
