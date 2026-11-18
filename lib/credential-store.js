'use strict';
// The credentials ch-local holds for the packs (a read-only GitHub token
// first): entered once at a terminal (`ch-local credentials add`), used by
// the daemon's shared runtime, which no client's environment reaches, and
// by start (lib/github-token.js chooseGitHubToken). Never from the
// conversation, a client config or a client's environment; never printed,
// logged or recorded; modules never reach the ch-local home.
//
//   <home>/credentials/credentials.json
//   {"v": 1, "values": {"<VARIABLE>": {"value": "...", "module": "<package>"}}}
//
// Keyed by the variable a pack declares, and bound to the access module that
// declared it (lib/packs.js's installed packs): pack 2's credentials go here
// too. The binding is recorded only; enforcing it at a call is later work.
//
// The directory and the file are this user's alone, checked, never
// repaired: one that fails a check is refused, saying the path, what was
// seen, and how to fix it, and nothing is written through it or beside it.
// - POSIX: the directory not a link, owned by this user, mode 0700 (nothing
//   for group or others); the file through lib/own-file.js (no link, owned
//   by this user, nothing for group or others, written by an exclusive
//   temporary file renamed into place, 0600).
// - Windows: the directory's and the file's owner and DACL pass
//   lib/win-acl.js privateProblem (a new directory gets a protected
//   owner-only DACL, and each write is a file made private before it is
//   renamed into place). Another program running as this user can read the
//   file, as it can read gh's own token: the limit the docs state.
const fs = require('node:fs');
const path = require('node:path');
const {readOwnFile, writeOwnFile} = require('./own-file');

const DIR = 'credentials';
const FILE = 'credentials.json';
const MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 64;
// a variable, as a release's pins name one (lib/release-pins.js)
const VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;
// a token's own characters (as gh's, and the conditions check's TOKEN)
const VALUE = /^[A-Za-z0-9_]{8,255}$/;
const {PACKAGE} = require('./names');

class StoreProblem extends Error {
  constructor(message, code = 'CREDENTIALS_NOT_PRIVATE') {
    super(message);
    this.code = code;
  }
}

const paths = (home) => ({dir: path.join(home, DIR), file: path.join(home, DIR, FILE)});
const isWindows = (platform) => platform === 'win32' || process.platform === 'win32';
const euid = () => (typeof process.geteuid === 'function' ? process.geteuid() : null);

// The directory, checked as it is. -> 'ok' | 'missing'; throws StoreProblem.
// create: make it when missing (0700; on Windows a protected owner-only DACL)
function checkDir(dir, {platform = process.platform, acl = null, create = false} = {}) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw new StoreProblem(`${dir} could not be read (${e.code || e.message})`);
    if (!create) return 'missing';
    try {
      fs.mkdirSync(dir, {mode: 0o700});
    } catch (made) {
      // another made it meanwhile: checked as found, below
      if (made.code !== 'EEXIST') throw new StoreProblem(`${dir} could not be made (${made.code || made.message})`, 'CREDENTIALS_WRITE');
    }
    if (isWindows(platform)) {
      const [made] = (acl != null && acl.makePrivateDirs ? acl : require('./win-acl')).makePrivateDirs([dir], [dir]);
      const why = (acl != null && acl.privateProblem ? acl : require('./win-acl')).privateProblem(dir, made, {directory: true});
      if (why != null) throw new StoreProblem(`${dir}: ${why}`);
    }
    st = fs.lstatSync(dir);
  }
  if (st.isSymbolicLink()) throw new StoreProblem(`${dir} is a link; remove it (ch-local makes the directory itself) and run the command again`);
  if (!st.isDirectory()) throw new StoreProblem(`${dir} is not a directory; remove it and run the command again`);
  if (isWindows(platform)) {
    const winAcl = require('./win-acl');
    let read;
    try { read = (acl != null && acl.fileAcl ? acl.fileAcl : winAcl.fileAcl)(dir); } catch (e) { throw new StoreProblem(`${dir}: its access list could not be read (${e.code || e.message})`); }
    const why = (acl != null && acl.privateProblem ? acl.privateProblem : winAcl.privateProblem)(dir, read, {directory: true});
    if (why != null) {
      const hint = winAcl.fixHint(dir, read);
      throw new StoreProblem(`${why}${hint != null ? `; to make it this user's alone:\n  ${hint}` : ''}`);
    }
    return 'ok';
  }
  // the directory itself, opened without following a link, as it is now
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const at = fs.fstatSync(fd);
    if (!at.isDirectory()) throw new StoreProblem(`${dir} is not a directory`);
    if (euid() != null && at.uid !== euid()) throw new StoreProblem(`${dir} is owned by uid ${at.uid}, not this user; remove it and run the command again`);
    const mode = at.mode & 0o777;
    if ((mode & 0o077) !== 0) throw new StoreProblem(`${dir} is open to others (mode ${mode.toString(8).padStart(4, '0')}); make it this user's alone: chmod 700 "${dir}"`);
  } finally {
    fs.closeSync(fd);
  }
  return 'ok';
}

const isObject = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const exactly = (o, keys) => JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());

// text -> Map(variable -> {value, module}); throws StoreProblem
function parse(text, file) {
  const bad = (why) => new StoreProblem(`${file} is not a credentials file (${why}); remove it and add the credential again`, 'CREDENTIALS_INVALID');
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw bad('not JSON'); }
  if (!isObject(doc) || !exactly(doc, ['v', 'values']) || doc.v !== 1 || !isObject(doc.values)) throw bad('not {v: 1, values}');
  const names = Object.keys(doc.values);
  if (names.length > MAX_ENTRIES) throw bad(`more than ${MAX_ENTRIES} entries`);
  const out = new Map();
  for (const name of names) {
    const e = doc.values[name];
    if (!VARIABLE.test(name)) throw bad('an entry that is not a variable name');
    if (!isObject(e) || !exactly(e, ['value', 'module']) || typeof e.value !== 'string' || !VALUE.test(e.value) || typeof e.module !== 'string' || !PACKAGE.test(e.module)) {
      // the name only: never the value
      throw bad(`the entry for ${name} is not {value, module}`);
    }
    out.set(name, {value: e.value, module: e.module});
  }
  return out;
}

// home -> Map(variable -> {value, module}): empty when there is none.
// Throws StoreProblem for a directory or file that fails a check.
function readStore(home, {platform = process.platform, acl = null} = {}) {
  const {dir, file} = paths(home);
  if (checkDir(dir, {platform, acl}) === 'missing') return new Map();
  let bytes;
  try {
    bytes = readOwnFile(file, {max: MAX_BYTES, platform});
  } catch (e) {
    if (e.code === 'NOT_PRIVATE') throw new StoreProblem(`${e.message}; ${isWindows(platform) ? 'remove it and add the credential again' : `make it this user's alone (chmod 600 "${file}"), or remove it and add the credential again`}`);
    throw new StoreProblem(`${file} could not be read (${e.code || e.message})`);
  }
  if (bytes == null) return new Map();
  return parse(bytes.toString('utf8'), file);
}

// The home's own ownership. POSIX: lib/home.js homeOwnershipProblem (this
// user's, no group or world write). Windows: its owner and DACL by win-acl
// privateProblem (this user, SYSTEM, Administrators only), read through the
// acl seam; an unreadable DACL is a problem, never a pass.
function homeProblem(realHome, {platform, acl}) {
  if (!isWindows(platform)) return require('./home').homeOwnershipProblem(realHome, platform);
  const winAcl = require('./win-acl');
  let read;
  try { read = (acl != null && acl.fileAcl ? acl.fileAcl : winAcl.fileAcl)(realHome); } catch (e) { return `its access list could not be read (${e.code || e.message})`; }
  return (acl != null && acl.privateProblem ? acl.privateProblem : winAcl.privateProblem)('it', read, {directory: true});
}

// the file written whole, this user's alone, by an exclusive temporary file
// renamed into place (never through a link, never beside one that fails)
function writeStore(home, entries, {platform = process.platform, acl = null} = {}) {
  // the home itself this user's alone (no other user can swap the directory
  // in it between the check and the write; the same user can do anything
  // the store does), and written through the real path that was checked, so
  // a link re-pointed meanwhile can't redirect the write
  let realHome;
  try { realHome = fs.realpathSync(home); } catch (e) { throw new StoreProblem(`${home} could not be read (${e.code || e.message})`); }
  const owned = homeProblem(realHome, {platform, acl});
  if (owned != null) throw new StoreProblem(`${home}: ${owned}`);
  const {dir, file} = paths(realHome);
  try {
    writeChecked(dir, file, entries, {platform, acl});
  } catch (e) {
    if (e instanceof StoreProblem) throw e;
    throw new StoreProblem(`${file} could not be written (${e.code || e.message}); nothing was stored`, 'CREDENTIALS_WRITE');
  }
  // and after: the directory is still the one checked, and the file reads
  // back as this user's own (a link swapped in meanwhile is refused here)
  checkDir(dir, {platform, acl});
  try { readOwnFile(file, {max: MAX_BYTES, platform}); } catch (e) { throw new StoreProblem(`${file} did not read back as this user's own (${e.message}); remove ${dir} and add the credential again`); }
}

function writeChecked(dir, file, entries, {platform, acl}) {
  checkDir(dir, {platform, acl, create: true});
  const values = {};
  for (const [name, e] of [...entries].sort(([a], [b]) => (a < b ? -1 : 1))) values[name] = {value: e.value, module: e.module};
  const text = `${JSON.stringify({v: 1, values}, null, 2)}\n`;
  if (!isWindows(platform)) return writeOwnFile(file, text);
  const winAcl = acl != null && acl.createPrivate ? acl : require('./win-acl');
  const temp = path.join(dir, `.${FILE}.${process.pid}.${Date.now()}.tmp`);
  let placed = false;
  try {
    winAcl.createPrivate(temp, text);
    fs.renameSync(temp, file);
    placed = true;
  } finally {
    if (!placed) { try { fs.unlinkSync(temp); } catch (e) { /* gone */ } }
  }
}

// -> the stored value of variable, or null
function get(home, variable, opts) {
  const e = readStore(home, opts).get(variable);
  return e != null ? e.value : null;
}

// -> [{variable, module}], never a value
function list(home, opts) {
  return [...readStore(home, opts)].map(([variable, e]) => ({variable, module: e.module}));
}

// add or replace; refuses a name or value outside the forms, without echoing
// the value
function add(home, variable, value, module, opts) {
  if (!VARIABLE.test(String(variable))) throw new StoreProblem(`${String(variable).slice(0, 64)} is not a variable name`, 'CREDENTIALS_INVALID');
  if (typeof value !== 'string' || !VALUE.test(value)) throw new StoreProblem('that does not look like a token (8 to 255 letters, digits or _); nothing was stored', 'CREDENTIALS_INVALID');
  if (typeof module !== 'string' || !PACKAGE.test(module)) throw new StoreProblem(`${String(module).slice(0, 128)} is not a package name`, 'CREDENTIALS_INVALID');
  const entries = readStore(home, opts);
  if (!entries.has(variable) && entries.size >= MAX_ENTRIES) throw new StoreProblem(`at most ${MAX_ENTRIES} credentials are held`, 'CREDENTIALS_INVALID');
  entries.set(variable, {value, module});
  writeStore(home, entries, opts);
}

// -> true when one was removed; the file goes once it holds none
function remove(home, variable, opts) {
  const entries = readStore(home, opts);
  if (!entries.delete(variable)) return false;
  if (entries.size === 0) {
    const {file} = paths(home);
    fs.rmSync(file, {force: true});
    return true;
  }
  writeStore(home, entries, opts);
  return true;
}

module.exports = {readStore, get, list, add, remove, checkDir, paths, StoreProblem, VARIABLE, VALUE, MAX_ENTRIES};
