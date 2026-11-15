'use strict';
// <home>/shim.json (countinghouse's shared-runtime design, #236, section 6,
// "The shim's home and shim.json"): what the native shim runs, from paths
// ch-local resolves at install. The shim spawns `<node> <chLocal> daemon` and
// `<node> <chLocal> conditions --for <pid>` from it, and gives the daemon a
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
const ALLOWED = new Set([...POSIX_KEYS, ...WINDOWS_KEYS]);

// a variable of env by name, case-insensitively on Windows (Path, PATH)
function pick(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const k = Object.keys(env).find((n) => n.toUpperCase() === name.toUpperCase());
  return k != null ? env[k] : undefined;
}

// the body install writes: node (io.node), chLocal (the installed launcher)
// and the allowlisted variables present at install
function shimJsonFor({node, home, env = process.env, platform = process.platform}) {
  const keys = platform === 'win32' ? WINDOWS_KEYS : POSIX_KEYS;
  const out = {};
  for (const k of keys) {
    const v = pick(env, k, platform);
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return {node, chLocal: path.join(home, 'bin', 'ch-local.js'), env: out};
}

// -> null, or what the shim would refuse
function shimJsonProblem(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) return 'shim.json is not an object';
  for (const k of ['node', 'chLocal']) {
    if (typeof body[k] !== 'string' || !(isFullPath(body[k], 'linux') || isFullPath(body[k], 'win32'))) return `${k} is not an absolute path`;
  }
  if (body.env == null || typeof body.env !== 'object' || Array.isArray(body.env)) return 'env is not an object';
  for (const [k, v] of Object.entries(body.env)) {
    if (!ALLOWED.has(k)) return `env names ${k}, which the daemon may not be given`;
    if (typeof v !== 'string') return `env's ${k} is not a string`;
  }
  return null;
}

// writes <home>/shim.json -> the body written
function writeShimJson(home, args) {
  const body = shimJsonFor({...args, home});
  const problem = shimJsonProblem(body);
  if (problem != null) throw new Error(`shim.json would be refused: ${problem}`);
  const file = path.join(home, 'shim.json');
  const temp = path.join(home, `.shim.json.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
  let placed = false;
  try {
    try {
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

module.exports = {shimJsonFor, shimJsonProblem, writeShimJson, POSIX_KEYS, WINDOWS_KEYS};
