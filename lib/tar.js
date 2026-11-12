'use strict';
// A pack's or part's npm tarball unpacked without npm: they have no
// dependencies (#43), so npm adds nothing but its own trust surface. This is
// security code (reviewer, 2026-11-12), so it accepts the least it can:
// - regular files and directories under package/, nothing else: no links,
//   devices or FIFOs, no GNU extensions; a pax header (type x) only with the
//   path, time and size keys, parsed strictly, the size equal to the header's;
// - names that cannot mean anything else on another system: no backslash,
//   colon, NUL, empty, . or .. segment, Windows-reserved name or trailing
//   dot or space, and no path twice (also by case or Unicode form, or as a
//   file and a directory);
// - the total and per-file sizes and the entry count capped, including
//   while decompressing (a gzip bomb).
// Every header is read and checked before anything is written, and a
// tarball refused part-way leaves nothing behind.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const LIMITS = {maxBytes: 64 * 1024 * 1024, maxFileBytes: 16 * 1024 * 1024, maxEntries: 10000};
// size is accepted only when it equals the header's own (node-tar writes it).
const PAX_KEYS = new Set(['path', 'mtime', 'atime', 'ctime', 'size']);
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function refuse(why) {
  const err = new Error(`refused the tarball: ${why}`);
  err.code = 'TAR_REFUSED';
  return err;
}

const cstr = (buf, start, len) => {
  const s = buf.subarray(start, start + len);
  const end = s.indexOf(0);
  return s.subarray(0, end === -1 ? len : end).toString('utf8');
};

function octal(buf, start, len, what) {
  if (buf[start] & 0x80) throw refuse(`a ${what} in base-256`);
  const s = cstr(buf, start, len).replace(/[ \0]+$/, '').replace(/^ +/, '');
  if (!/^[0-7]*$/.test(s)) throw refuse(`a ${what} that is not octal`);
  return s === '' ? 0 : parseInt(s, 8);
}

function checksumOk(h) {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : h[i];
  return sum === octal(h, 148, 8, 'checksum');
}

// "<len> <key>=<value>\n" records, each length exact.
function parsePax(data) {
  const out = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const lenText = space === -1 ? '' : data.subarray(pos, space).toString('ascii');
    const len = /^[1-9][0-9]*$/.test(lenText) ? Number(lenText) : NaN;
    if (!(len > 0) || pos + len > data.length || data[pos + len - 1] !== 0x0a) throw refuse('a malformed pax header');
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq <= 0) throw refuse('a malformed pax header');
    const key = record.slice(0, eq);
    if (!PAX_KEYS.has(key)) throw refuse(`a pax header with the key ${JSON.stringify(key)}`);
    out[key] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

// The member's path under package/ -> its segments; refuses anything else.
function segmentsOf(name, isDir) {
  const shown = JSON.stringify(name);
  if (/[\\:\0]/.test(name)) throw refuse(`the member ${shown} has a backslash, colon or NUL`);
  // eslint-disable-next-line no-control-regex
  if (/[<>"|?*\u0001-\u001f]/.test(name)) throw refuse(`the member ${shown} has a character Windows does not allow in a name`);
  if (name.startsWith('/')) throw refuse(`the member ${shown} is an absolute path`);
  if (!name.startsWith('package/')) throw refuse(`the member ${shown} is not under package/`);
  let rest = name.slice('package/'.length);
  if (isDir && rest.endsWith('/')) rest = rest.slice(0, -1);
  if (rest === '') return isDir ? [] : (() => { throw refuse(`the member ${shown} has no name`); })();
  const segments = rest.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') throw refuse(`the member ${shown} has an empty, . or .. segment`);
    if (RESERVED.test(s) || /[. ]$/.test(s)) throw refuse(`the member ${shown} has a name Windows would change`);
  }
  return segments;
}

// buffer: the .tgz bytes. dest: a directory that must not exist yet.
function extractPackage(buffer, dest, limits = {}) {
  const {maxBytes, maxFileBytes, maxEntries} = {...LIMITS, ...limits};
  if (fs.existsSync(dest)) throw refuse(`${dest} exists; a package is never unpacked over another`);
  let tar;
  try {
    // Headers and padding are at most 1 KiB per entry beyond the data.
    tar = zlib.gunzipSync(buffer, {maxOutputLength: maxBytes + (maxEntries + 2) * 1024});
  } catch (err) {
    throw refuse(err.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError ? 'it is over the size cap uncompressed' : 'it is not a gzip tarball');
  }

  const entries = [];
  const files = new Set();
  const dirs = new Set();
  // Each directory's spelling, by its case- and form-folded key: two
  // spellings of one key would be two directories here and one on macOS or
  // Windows.
  const spelling = new Map();
  const spell = (key, exact, name) => {
    if (spelling.has(key) && spelling.get(key) !== exact) throw refuse(`the member ${JSON.stringify(name)} spells a directory that is already there in another case or Unicode form`);
    spelling.set(key, exact);
  };
  let total = 0;
  let pending = null;
  let offset = 0;
  for (;;) {
    if (offset + 512 > tar.length) throw refuse('it ends inside a header');
    const h = tar.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) throw refuse(`a header checksum is wrong at byte ${offset}`);
    if (!cstr(h, 257, 6).startsWith('ustar')) throw refuse(`a header at byte ${offset} is not ustar`);
    const size = octal(h, 124, 12, 'size');
    const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
    const dataStart = offset + 512;
    if (dataStart + size > tar.length) throw refuse('it ends inside a member');
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      if (pending != null) throw refuse('two pax headers in a row');
      if (size > 64 * 1024) throw refuse('a pax header over 64 KiB');
      pending = parsePax(data);
      continue;
    }
    const prefix = cstr(h, 345, 155);
    const headerName = prefix !== '' ? `${prefix}/${cstr(h, 0, 100)}` : cstr(h, 0, 100);
    const name = pending != null && pending.path != null ? pending.path : headerName;
    if (pending != null && pending.size != null && pending.size !== String(size)) throw refuse(`a pax size of ${JSON.stringify(pending.size)} for the member ${JSON.stringify(name)}, whose header says ${size}`);
    pending = null;
    if (type !== '0' && type !== '5') {
      throw refuse(`the member ${JSON.stringify(name)} is of type ${JSON.stringify(type)}${type === '1' || type === '2' ? ' (a link)' : ''}; only files and directories are allowed`);
    }
    if (entries.length + 1 > maxEntries) throw refuse(`it has more than ${maxEntries} entries`);
    const isDir = type === '5';
    const segments = segmentsOf(name, isDir);
    if (segments.length === 0) continue;
    const key = segments.join('/').normalize('NFC').toLowerCase();
    const ancestors = segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join('/').normalize('NFC').toLowerCase());
    if (ancestors.some((a) => files.has(a))) throw refuse(`the member ${JSON.stringify(name)} is under a path that is a file`);
    if (isDir) {
      if (files.has(key)) throw refuse(`the member ${JSON.stringify(name)} is both a file and a directory`);
    } else {
      if (files.has(key) || dirs.has(key)) throw refuse(`the member ${JSON.stringify(name)} is there twice (or as a directory)`);
      if (size > maxFileBytes) throw refuse(`the member ${JSON.stringify(name)} is over the per-file cap of ${maxFileBytes} bytes`);
      total += size;
      if (total > maxBytes) throw refuse(`its files are over the total cap of ${maxBytes} bytes`);
      files.add(key);
    }
    ancestors.forEach((a, i) => { spell(a, segments.slice(0, i + 1).join('/'), name); dirs.add(a); });
    if (isDir) { spell(key, segments.join('/'), name); dirs.add(key); }
    entries.push({segments, isDir, data});
  }
  if (pending != null) throw refuse('a pax header with no member after it');

  try {
    fs.mkdirSync(dest, {recursive: true});
    for (const {segments, isDir, data} of entries) {
      const at = path.join(dest, ...segments);
      if (isDir) { fs.mkdirSync(at, {recursive: true}); continue; }
      fs.mkdirSync(path.dirname(at), {recursive: true});
      fs.writeFileSync(at, data, {flag: 'wx', mode: 0o644});
    }
  } catch (err) {
    fs.rmSync(dest, {recursive: true, force: true});
    throw err;
  }
}

module.exports = {extractPackage, LIMITS};
