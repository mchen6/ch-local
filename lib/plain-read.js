'use strict';
// One way to read the shim's files (ch-shim, ch-shim.previous): only as a
// regular file under its own name, never through a link and never blocking
// on a FIFO -- lstat, then an O_NOFOLLOW | O_NONBLOCK descriptor judged and
// read on its own (Windows has no O_NOFOLLOW: lstat refuses a link there).
// lib/shim-install.js reads whole binaries with it (the reviewer's high on
// #120, 2 and 3) and lib/session.js a binary's first bytes, before it runs
// one; kept apart from shim-install so a session start loads nothing more.
const fs = require('node:fs');

const MAX_BINARY = 64 * 1024 * 1024;
// errors that mean "not a plain file here", not "could not be read"
const NOT_THERE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'EMLINK']);

// (file, {limit}) -> {bytes: Buffer | null, code: errno | null}. bytes null
// with code null: no plain file there (absent, a link, a FIFO, a directory,
// past MAX_BINARY); with a code: one there that could not be read. limit:
// read only the first limit bytes (whole, bounded by MAX_BINARY, without).
function readPlain(file, {limit = null} = {}) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return {bytes: null, code: NOT_THERE.has(e.code) ? null : (e.code || 'EIO')}; }
  if (st.isSymbolicLink() || !st.isFile() || (limit == null && st.size > MAX_BINARY)) return {bytes: null, code: null};
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (e) {
    return {bytes: null, code: NOT_THERE.has(e.code) ? null : (e.code || 'EIO')};
  }
  try {
    const at = fs.fstatSync(fd);
    if (!at.isFile() || (limit == null && at.size > MAX_BINARY)) return {bytes: null, code: null};
    if (limit == null) return {bytes: fs.readFileSync(fd), code: null};
    const buf = Buffer.alloc(limit);
    let got = 0;
    while (got < limit) {
      const n = fs.readSync(fd, buf, got, limit - got, null);
      if (n <= 0) break;
      got += n;
    }
    return {bytes: buf.subarray(0, got), code: null};
  } catch (e) {
    return {bytes: null, code: e.code || 'EIO'};
  } finally {
    fs.closeSync(fd);
  }
}

// <home>/shim/versions.json, sha512 hex -> version: as lib/shim-install.js
// writes it, read only as this user's own private file (lib/own-file.js);
// anything else reads as none -> {}
function readVersions(file, platform = process.platform) {
  try {
    const bytes = require('./own-file').readOwnFile(file, {max: 64 * 1024, platform});
    if (bytes == null) return {};
    const doc = JSON.parse(bytes.toString('utf8'));
    if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) return {};
    return Object.fromEntries(Object.entries(doc).filter(([k, v]) => /^[0-9a-f]{128}$/.test(k) && typeof v === 'string'));
  } catch (e) {
    return {};
  }
}

module.exports = {readPlain, readVersions, MAX_BINARY};
