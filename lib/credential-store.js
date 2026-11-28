'use strict';
// The credentials ch-local holds, each bound to one module (#413 section
// 6.3; L5a): entered at a terminal, or on standard input with the origin it
// is for (`ch-local credentials add`). Never from the conversation, a client
// config or a client's environment; never printed, logged or recorded;
// modules never reach the ch-local home.
//
//   <home>/credentials/credentials.json, version 2:
//   {"v": 2, "modules": {"<package>": {"<VARIABLE>":
//      {"origin": "<https origin>", "source": "gh"} |
//      {"origin": "<https origin>", "source": "stored", "value": "..."}}}}
//
// An entry is the binding: this value, for this module's credential of this
// name, to this origin. At most 64 entries, the file at most 512 KiB. A file
// that is not of this form is refused, naming the entry and never a value.
//
// Version 1 ({"v": 1, "values": {"<VARIABLE>": {value, module}}}, ch-local
// before L5a) is read as it is (readStore's {version: 1, values}); what its
// entries bind is lib/module-credentials.js's to say (section 10). The first
// add or remove writes version 2.
//
// The directory and the file are this user's alone, checked, never
// repaired: one that fails a check is refused, saying the path, what was
// seen, and how to fix it, and nothing is written through it or beside it.
// - POSIX: the directory not a link, owned by this user, mode 0700 (nothing
//   for group or others); the file through lib/own-file.js (no link, owned
//   by this user, nothing for group or others, written by an exclusive
//   temporary file renamed into place, 0600).
// - Every change (add, remove, uninstall's removal) is made under the
//   store's lock, <home>/credentials.lock (lib/lock.js's protocol with its
//   started and ageOtherHosts options; post-rel cred-race): bind and unbind
//   take the `held` withStoreLock hands its function (branded: one it
//   minted), and check it is still this holder's before credentials/ is
//   made and just before the file is replaced or removed. No write without
//   it. start and list only read: each write is a whole file
//   renamed into place.
// - Windows: the directory's and the file's owner and DACL pass
//   lib/win-acl.js privateProblem (a new directory gets a protected
//   owner-only DACL, and each write is a file made private before it is
//   renamed into place). Another program running as this user can read the
//   file, as it can read gh's own token: the limit the docs state.
const fs = require('node:fs');
const path = require('node:path');
// (through the module object: one seam a test can stub for every read)
const ownFile = require('./own-file');

const DIR = 'credentials';
const LOCK = 'credentials.lock';
const FILE = 'credentials.json';
const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 64;
// a variable, as the runtime reads a declaration's (countinghouse
// lib/remote/declaration.js VARIABLE, copied: test/credentials.test.js
// pins the copy), so every declaration the runtime takes can get a key (the
// Reviewer's high review of L5a, 2)
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// a value: 8 to 4096 visible ASCII characters, no space, so that it is a
// safe header value (section 6.2)
const VALUE = /^[\x21-\x7e]{8,4096}$/;
// version 1's own value grammar (its entries are read as they were written)
const V1_VALUE = /^[A-Za-z0-9_]{8,255}$/;
const SOURCES = ['gh', 'stored'];
// the one origin a gh login's token is ever for (section 6.8): an entry
// that pairs gh with another is refused at add, and at use for its module
// alone (lib/module-credentials.js stateOf), so one hand-written entry never
// takes the whole store down (the Fable pass on L5a, F5)
const GH_ORIGIN = 'https://api.githubcopilot.com';
// an https origin as the runtime reads a declaration's: scheme, host and
// port, nothing else (the same string URL.origin gives back)
function isOrigin(o) {
  if (typeof o !== 'string') return false;
  let u;
  try { u = new URL(o); } catch (e) { return false; }
  return u.protocol === 'https:' && u.origin === o;
}
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
      const hint = winAcl.fixHint(dir, read, {directory: true});
      throw new StoreProblem(`${why}${hint != null ? `; to make it this user's alone, in Windows PowerShell (powershell.exe):\n  ${hint}` : ''}`);
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

// text -> {version: 2, modules: Map(module -> Map(variable -> entry))} or
// {version: 1, values: Map(variable -> {value, module})}; throws StoreProblem
function parse(text, file) {
  const bad = (why) => new StoreProblem(`${file} is not a credentials file (${why}); remove it and add the credentials again`, 'CREDENTIALS_INVALID');
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw bad('not JSON'); }
  if (isObject(doc) && doc.v === 1) return {version: 1, values: parseV1(doc, bad)};
  if (!isObject(doc) || !exactly(doc, ['v', 'modules']) || doc.v !== 2 || !isObject(doc.modules)) throw bad('not {v: 2, modules}');
  const modules = new Map();
  let count = 0;
  for (const module of Object.keys(doc.modules)) {
    if (!PACKAGE.test(module)) throw bad('an entry that is not a package name');
    const vars = doc.modules[module];
    if (!isObject(vars)) throw bad(`the entry for ${module} is not an object`);
    const out = new Map();
    for (const variable of Object.keys(vars)) {
      count += 1;
      if (count > MAX_ENTRIES) throw bad(`more than ${MAX_ENTRIES} entries`);
      if (!VARIABLE.test(variable)) throw bad(`an entry of ${module} that is not a variable name`);
      const e = vars[variable];
      // the module and the name only: never the value
      const at = `${module} ${variable}`;
      if (!isObject(e) || !isOrigin(e.origin) || !SOURCES.includes(e.source)) throw bad(`the entry for ${at} is not {origin, source}`);
      if (e.source === 'gh' && !exactly(e, ['origin', 'source'])) throw bad(`the entry for ${at} is not {origin, source: "gh"}`);
      if (e.source === 'stored' && (!exactly(e, ['origin', 'source', 'value']) || typeof e.value !== 'string' || !VALUE.test(e.value))) throw bad(`the entry for ${at} is not {origin, source: "stored", value}`);
      out.set(variable, e.source === 'gh' ? {origin: e.origin, source: 'gh'} : {origin: e.origin, source: 'stored', value: e.value});
    }
    if (out.size > 0) modules.set(module, out);
  }
  return {version: 2, modules};
}
function parseV1(doc, bad) {
  if (!exactly(doc, ['v', 'values']) || !isObject(doc.values)) throw bad('not {v: 1, values}');
  const names = Object.keys(doc.values);
  if (names.length > MAX_ENTRIES) throw bad(`more than ${MAX_ENTRIES} entries`);
  const out = new Map();
  for (const name of names) {
    const e = doc.values[name];
    if (!VARIABLE.test(name)) throw bad('an entry that is not a variable name');
    if (!isObject(e) || !exactly(e, ['value', 'module']) || typeof e.value !== 'string' || !V1_VALUE.test(e.value) || typeof e.module !== 'string' || !PACKAGE.test(e.module)) {
      // the name only: never the value
      throw bad(`the entry for ${name} is not {value, module}`);
    }
    out.set(name, {value: e.value, module: e.module});
  }
  return out;
}

// home -> parse()'s answer: {version: 2, modules} empty when there is none.
// Throws StoreProblem for a directory or file that fails a check.
const empty = () => ({version: 2, modules: new Map()});
function readStore(home, {platform = process.platform, acl = null} = {}) {
  const {dir, file} = paths(home);
  // Windows: the folder's ACL and the file's in one PowerShell run (cold-start
  // part 3; win-acl prefetch: a link or a missing path is never read through,
  // a failed read gets today's single read and its error), used for this one
  // read only, so the window between the read and its use is no longer than
  // today's two separate reads
  let checking = acl;
  let fileAcl = null;
  if (isWindows(platform)) {
    const prefetch = acl != null ? acl.prefetch : require('./win-acl').prefetch;
    if (typeof prefetch === 'function') {
      fileAcl = prefetch([dir, file], acl != null && typeof acl.fileAcl === 'function' ? {single: acl.fileAcl} : {single: (p) => require('./win-acl').fileAcl(p)});
      checking = Object.assign({}, acl || {}, {fileAcl});
    }
  }
  if (checkDir(dir, {platform, acl: checking}) === 'missing') return empty();
  let bytes;
  try {
    // an atomic write (a racing add's rename) can swap the file between the
    // check and the read: read once more, and a second race is transient
    // too, never a file found wrong (the Reviewer's round 3, 1); the second
    // read's ACL is read fresh, as the file is a new one
    const read = (given) => ownFile.readOwnFile(file, {max: MAX_BYTES, platform, fileAcl: given});
    try { bytes = read(fileAcl); } catch (e) { if (e.raced !== true) throw e; bytes = read(null); }
  } catch (e) {
    if (e.raced === true) throw Object.assign(new StoreProblem(`${file} was being replaced while it was read`), {transient: true});
    if (e.code === 'NOT_PRIVATE') throw new StoreProblem(`${e.message}; ${isWindows(platform) ? 'remove it and add the credential again' : `make it this user's alone (chmod 600 "${file}"), or remove it and add the credential again`}`);
    // a read that failed, not a file found wrong: transient (the applier
    // keeps its last good states and reads again)
    throw Object.assign(new StoreProblem(`${file} could not be read (${e.code || e.message})`), {transient: true});
  }
  if (bytes == null) return empty();
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
// modules: Map(module -> Map(variable -> entry)), written as version 2
function writeStore(home, modules, {platform = process.platform, acl = null, held = null} = {}) {
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
    writeChecked(dir, file, modules, {platform, acl, held, home});
  } catch (e) {
    if (e instanceof StoreProblem) throw e;
    throw new StoreProblem(`${file} could not be written (${e.code || e.message}); nothing was stored`, 'CREDENTIALS_WRITE');
  }
  // and after: the directory is still the one checked, and the file reads
  // back as this user's own (a link swapped in meanwhile is refused here)
  checkDir(dir, {platform, acl});
  try { ownFile.readOwnFile(file, {max: MAX_BYTES, platform}); } catch (e) { throw new StoreProblem(`${file} did not read back as this user's own (${e.message}); remove ${dir} and add the credential again`); }
}

function writeChecked(dir, file, modules, {platform, acl, held, home}) {
  // (before the directory is made too: a holder whose lock was taken over
  // never recreates credentials/ an uninstall removed; the reviewer's high
  // on #102, 4)
  checkHeld(held, home);
  checkDir(dir, {platform, acl, create: true});
  // objects with no prototype: a variable named __proto__ (the runtime's
  // grammar takes it) is an own key, written as any other
  const out = Object.create(null);
  const byName = (a, b) => (a[0] < b[0] ? -1 : 1);
  for (const [module, vars] of [...modules].sort(byName)) {
    if (vars.size === 0) continue;
    out[module] = Object.create(null);
    for (const [variable, e] of [...vars].sort(byName)) out[module][variable] = e.source === 'gh' ? {origin: e.origin, source: 'gh'} : {origin: e.origin, source: 'stored', value: e.value};
  }
  const text = `${JSON.stringify({v: 2, modules: out}, null, 2)}\n`;
  const beforeRename = () => checkHeld(held, home);
  if (!isWindows(platform)) return ownFile.writeOwnFile(file, text, {beforeRename});
  const winAcl = acl != null && acl.createPrivate ? acl : require('./win-acl');
  const temp = path.join(dir, `.${FILE}.${process.pid}.${Date.now()}.tmp`);
  let placed = false;
  try {
    winAcl.createPrivate(temp, text);
    beforeRename();
    fs.renameSync(temp, file);
    placed = true;
  } finally {
    if (!placed) { try { fs.unlinkSync(temp); } catch (e) { /* gone */ } }
  }
}

// One module's binding set (add) or removed (remove), the whole file
// written as version 2. migrate(read) -> Map(module -> Map(variable ->
// entry)): a version 1 file's bindings as lib/module-credentials.js reads
// them (section 10), so its other entries carry over; without one a version
// 1 file is refused, never dropped. Neither echoes a value.
function bindingsOf(read, migrate) {
  if (read.version === 2) return new Map([...read.modules].map(([m, v]) => [m, new Map(v)]));
  if (typeof migrate !== 'function') throw new StoreProblem('the stored credentials are of an earlier ch-local; nothing was changed', 'CREDENTIALS_INVALID');
  return migrate(read);
}
// A change made with no lock, or once the lock is no longer this
// holder's, is refused: nothing written (post-rel cred-race).
const lockLost = () => new StoreProblem('another ch-local took over the stored credentials\' lock while this change was being made; nothing was changed', 'CREDENTIALS_LOCK');
// A held is branded: withStoreLock mints each into this module's own
// WeakSet, and only one found there is taken (the reviewer's high on #102,
// 7). testOnlyHeld, for the tests' fixtures, is the one other minter;
// test/credential-lock.test.js pins that its name is nowhere else under lib/
// or bin/.
// Each held is minted for one home's lock file, by its real path, and
// taken only where the home's lock file is that same file now: a home
// spelled another way is the same home, and a home re-pointed since (a
// link, which writeStore resolves) is another, refused (the reviewer's high
// on #102's round 1, 1; the medium on it, 1 and 4). A fixture's is for any
// home.
const MINTED = new WeakMap();
const ANY_HOME = Symbol('any home');
const realLock = (home) => { try { return fs.realpathSync(path.join(home, LOCK)); } catch (e) { return null; } };
function requireHeld(held, home) {
  const file = MINTED.get(held);
  if (file === undefined || (file !== ANY_HOME && (home == null || file !== realLock(home)))) {
    throw new StoreProblem('the stored credentials are changed only under their lock; nothing was changed', 'CREDENTIALS_LOCK');
  }
}
// tests only: a branded held whose check is `check` (by default, always
// still held)
// (exported, so reachable by any module that requires the store: the
// limit, stated. The pin keeps lib/ and bin/ from naming it; a computed
// lookup would get past it, and is no pattern this codebase uses.)
function testOnlyHeld(check = () => {}) {
  const held = Object.freeze({check});
  MINTED.set(held, ANY_HOME);
  return held;
}
// the lock still this holder's, just before a change lands: a lock taken
// over is said as that; any other failure of the check as itself
function checkHeld(held, home) {
  requireHeld(held, home);
  try { held.check(); } catch (e) {
    if (e.code === 'LOCK_LOST') throw lockLost();
    throw new StoreProblem(`the stored credentials' lock could not be checked (${e.code || e.message}); nothing was changed`, 'CREDENTIALS_LOCK');
  }
}

// fn(held) -> an exit code, run under <home>/credentials.lock; 1 with a line
// on standard error when another ch-local still holds it after STALE_MS (a
// section can take seconds of ACL calls on Windows: the reviewer's high on
// #102, 6; on this host a holder that old is gone and cleared, so only a
// live one, or another host's, is waited out); io.credentialsLockWaitMs
// caps the wait, for the tests.
// doing: the command, named to whoever finds it held. missing(): the
// answer with no home (nothing installed), never fn run unlocked.
async function withStoreLock(home, io, doing, fn, {missing = () => { throw new StoreProblem('nothing is installed; nothing was changed', 'CREDENTIALS_INVALID'); }} = {}) {
  const {withLockFile, STALE_MS} = require('./lock');
  const file = path.join(home, LOCK);
  // fn's own throw passes through as it is; a lock that can't be made (a
  // home not writable) is the store's own write problem, said, never an
  // unhandled error
  let entered = false;
  const locked = (release, held) => {
    entered = true;
    // (by its real path: the lock file is there now, this holder's)
    const real = realLock(home);
    if (real != null) MINTED.set(held, real);
    return fn(held);
  };
  try {
    return await withLockFile(file, home, io, locked, {
      started: true, ageOtherHosts: false, missing, doing,
      waitMs: io != null && Number.isInteger(io.credentialsLockWaitMs) ? io.credentialsLockWaitMs : STALE_MS,
      what: 'to finish changing the stored credentials',
      heldMessage: ({holder, who, removable}) => `ch-local: another ch-local (${who}${holder != null && typeof holder.doing === 'string' ? `, \`${holder.doing}\`` : ''}) is changing the stored credentials; nothing was changed. Try again when it is done${removable ? require('./lock').removeHint(file, holder) : ''}.`,
    });
  } catch (e) {
    if (entered || e instanceof StoreProblem) throw e;
    throw new StoreProblem(`${file} could not be made (${e.code || e.message}); nothing was changed`, 'CREDENTIALS_WRITE');
  }
}

function bind(home, module, variable, entry, {migrate = null, held = null, ...opts} = {}) {
  requireHeld(held, home);
  if (typeof module !== 'string' || !PACKAGE.test(module)) throw new StoreProblem('that is not a package name', 'CREDENTIALS_INVALID');
  if (!VARIABLE.test(String(variable))) throw new StoreProblem('that is not a variable name', 'CREDENTIALS_INVALID');
  if (entry == null || !isOrigin(entry.origin) || !SOURCES.includes(entry.source)) throw new StoreProblem('that is not an https origin', 'CREDENTIALS_INVALID');
  if (entry.source === 'gh' && entry.origin !== GH_ORIGIN) throw new StoreProblem(`a gh login is only ever used for ${GH_ORIGIN}`, 'CREDENTIALS_INVALID');
  if (entry.source === 'stored' && (typeof entry.value !== 'string' || !VALUE.test(entry.value))) {
    throw new StoreProblem('that does not look like a key (8 to 4096 visible characters, no space); nothing was stored', 'CREDENTIALS_INVALID');
  }
  const modules = bindingsOf(readStore(home, opts), migrate);
  // a module has one credential in release 1: its binding replaces any other
  const count = [...modules].filter(([m]) => m !== module).reduce((n, [, v]) => n + v.size, 0);
  if (count + 1 > MAX_ENTRIES) throw new StoreProblem(`at most ${MAX_ENTRIES} credentials are held`, 'CREDENTIALS_INVALID');
  modules.set(module, new Map([[variable, entry.source === 'gh' ? {origin: entry.origin, source: 'gh'} : {origin: entry.origin, source: 'stored', value: entry.value}]]));
  writeStore(home, modules, {...opts, held});
}
// -> true when the module had a binding; the file goes once it holds none
function unbind(home, module, {migrate = null, held = null, ...opts} = {}) {
  requireHeld(held, home);
  const modules = bindingsOf(readStore(home, opts), migrate);
  if (!modules.delete(module)) return false;
  if ([...modules.values()].every((v) => v.size === 0)) {
    checkHeld(held, home);
    fs.rmSync(paths(home).file, {force: true});
    return true;
  }
  writeStore(home, modules, {...opts, held});
  return true;
}

module.exports = {readStore, bind, unbind, withStoreLock, checkHeld, testOnlyHeld, LOCK, checkDir, paths, StoreProblem, isOrigin, VARIABLE, VALUE, MAX_ENTRIES, MAX_BYTES, GH_ORIGIN};
