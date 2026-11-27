'use strict';
// The launcher's home: $COUNTINGHOUSE_HOME, else ~/.countinghouse, and on
// Windows %LOCALAPPDATA%\countinghouse (defaultHome). A relative
// COUNTINGHOUSE_HOME is refused: a client starts its servers in whatever
// directory it likes, so it would name a different place each time.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Absolute and anchored: on Windows a drive letter or a share, since
// \\countinghouse is rooted on whichever drive is current.
function isFullPath(p, platform = process.platform) {
  if (platform === 'win32') return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p);
  return path.posix.isAbsolute(p);
}

// The home when COUNTINGHOUSE_HOME is not set. On Windows %LOCALAPPDATA%\countinghouse, never a folder directly in the profile:
// Codex's elevated Windows sandbox gives its CodexSandboxUsers group (and, where the profile is its workspace, a sandbox identity
// with change rights) an explicit entry on every folder directly in %USERPROFILE%, each time it runs a command, so a home there
// does not stay private. Its entry on AppData is an inheritable one, and a home made protected (ensureHome) takes none of it.
// LOCALAPPDATA comes from the environment, refused when missing or not absolute, never guessed. Elsewhere ~/.countinghouse.
// homedir is the user's home directory, a function so a test can give its own.
function defaultHome(env = process.env, homedir = os.homedir, platform = process.platform) {
  if (platform !== 'win32') return path.join(homedir(), '.countinghouse');
  const local = env.LOCALAPPDATA;
  if (typeof local !== 'string' || local === '' || !isFullPath(local, 'win32')) {
    const err = new Error(`LOCALAPPDATA is ${typeof local !== 'string' || local === '' ? 'not set' : `not an absolute path ("${local}")`}, so the home's place (%LOCALAPPDATA%\\countinghouse) is not known: set COUNTINGHOUSE_HOME to an absolute path`);
    err.code = 'HOME_NO_LOCALAPPDATA';
    throw err;
  }
  return path.win32.join(local, 'countinghouse');
}
function home(env = process.env, homedir = os.homedir, platform = process.platform) {
  const set = env.COUNTINGHOUSE_HOME;
  if (typeof set !== 'string' || set === '') return defaultHome(env, homedir, platform);
  if (!isFullPath(set, platform)) {
    const err = new Error(`COUNTINGHOUSE_HOME must be an absolute path, not "${set}"`);
    err.code = 'HOME_RELATIVE';
    throw err;
  }
  return platform === 'win32' ? path.win32.normalize(set) : path.normalize(set);
}

// The installed launcher a client runs (reviewer, 2026-11-11: a .js file run
// by node, because Windows cannot execute an extensionless file). The plugin's
// bin/launch.js applies the same rule; test/plugin.test.js checks they agree.
const launcherPath = (env = process.env, homedir = os.homedir, platform = process.platform) => (platform === 'win32' ? path.win32 : path).join(home(env, homedir, platform), 'bin', 'ch-local.js');
// The home's launcher by the kernel's real path, as a command for the
// person's own terminal may quote it inside double quotes, or null: none
// installed, or a path a shell would read there. The runtime's rule (#490
// lib/held-back.js UNSAFE_IN_COMMAND): no control character, ", `, $, \, %,
// ! or ^, and no typographic quote (U+2018 to U+201F: PowerShell reads them
// as quotes); a backslash only as Windows' separator. One helper for the
// credential line and the held-back file (the reviewer's high on #106, 5, 6
// and 8: never a missing launcher, never one a shell would rewrite).
const UNSAFE_IN_COMMAND = /[\u0000-\u001f\u007f"`$\\%!^\u2018-\u201f]/;
function safeLauncher(where, platform = process.platform) {
  let real;
  try { real = require('node:fs').realpathSync.native(where.launcher); } catch (e) { return null; }
  return UNSAFE_IN_COMMAND.test(platform === 'win32' ? real.replace(/\\/g, '/') : real) ? null : real;
}

// Where everything goes under the home (spec §2, "Where files go"; the store
// and its identity secret are the runtime's, LM1 spec §4).
function layout(env = process.env, homedir = os.homedir) {
  const h = home(env, homedir);
  const at = (...p) => path.join(h, ...p);
  return {
    home: h,
    app: at('app'),
    packsDir: at('packs'),
    bin: at('bin'),
    launcher: at('bin', 'ch-local.js'),
    node: at('node'),
    store: at('store'),
    identitySecret: at('store', '.identity-secret'),
    auth: at('auth.json'),
    installed: at('installed.json'),
    packs: at('packs.json'),
    clients: at('installed-clients.json'),
    settings: at('settings.json'),
    moduleData: at('module_data'),
    modules: at('modules'),
    run: at('run'),
    previous: at('previous'),
    previousApp: at('previous', 'app'),
    previousRecord: at('previous', 'packs.json'),
    // the module store and its record (module-level install, #413 section
    // 9.1-9.2): one directory per module version; modules.json replaces
    // packs.json once install writes it (L1a-2)
    moduleStore: at('module-store'),
    modulesRecord: at('modules.json'),
    previousModulesRecord: at('previous', 'modules.json'),
    journal: at('rollback.journal'),
    // the user's own modules (B-own-add; the own-modules design §2.1): each
    // confirmed copy under <own>/<name>/<tree sha256>/, and their record
    own: at('own'),
    ownRecord: at('own.json')
  };
}

// A home named by --home (ch-local daemon, start --own-runtime): its real
// path must be a directory owned by this user and, on POSIX, not group- or
// world-writable, so no other user can plant its files. On Windows its owner
// and DACL by lib/win-acl.js privateProblem, as a directory (the review of
// ch-local #39: an inherit-only rule for anyone else fails too). fileAcl: for
// the tests. -> null or why not
function homeOwnershipProblem(real, platform = process.platform, {fileAcl} = {}) {
  let st;
  try { st = require('node:fs').statSync(real); } catch (err) { return `it could not be read (${err.code || err.message})`; }
  if (!st.isDirectory()) return 'it is not a directory';
  if (platform === 'win32') {
    const winAcl = require('./win-acl');
    let acl;
    try { acl = (fileAcl || winAcl.fileAcl)(real); } catch (err) { return `its ACL could not be read (${err.code || err.message})`; }
    return winAcl.privateProblem('it', acl, {directory: true});
  }
  const euid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  if (euid != null && st.uid !== euid) return `it is owned by uid ${st.uid}, not this user`;
  if ((st.mode & 0o022) !== 0) return `it is group- or world-writable (mode ${(st.mode & 0o777).toString(8).padStart(4, '0')})`;
  return null;
}

// The home, when ch-local makes it (install, a first setting): 0700 itself,
// never the umask's mode. Ubuntu's default umask 0002 would give 0775, which
// the shared runtime's daemon refuses (homeOwnershipProblem: found in the
// replay's prep, 2026-11-21). Its missing parents are made as mkdir -p makes
// them: only the home is private (the medium, 5). A home that exists is left
// as it is. -> true when it made the home
function ensureHome(dir, platform = process.platform, {makePrivateDirs = null} = {}) {
  const fs = require('node:fs');
  fs.mkdirSync(path.dirname(dir), {recursive: true});
  try {
    fs.mkdirSync(dir, {mode: 0o700});
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  // mkdir's mode is masked by the umask: set it whole, never through a link
  // put in its place (the medium, 6). Windows: a protected DACL, this user
  // and SYSTEM only, as the daemon's run directory has (lib/win-acl.js
  // makePrivateDirs): a folder made under C:\ would otherwise inherit
  // Authenticated Users' Modify (the reviewer's pre-work high, A-home-check, 4)
  if (platform !== 'win32') require('./own-tree').chmodNoFollow(dir, 0o700);
  // (its own ACL read back in the same run: an empty list is refused, the
  // medium on A-home-check, 1)
  else {
    const acls = (makePrivateDirs || require('./win-acl').makePrivateDirs)([dir], [dir]);
    // (the DACL read back must be private, or the home is refused: the
    // reviewer's high on #126, L5)
    const why = require('./win-acl').privateProblem('it', Array.isArray(acls) ? acls[0] : null, {directory: true});
    if (why != null) throw Object.assign(new Error(`the new home ${dir} could not be made private: ${why}`), {code: 'HOME_NOT_PRIVATE'});
    // (made a moment before its DACL: anything in it now was put there by
    // another, F4)
    if (fs.readdirSync(dir).length > 0) throw Object.assign(new Error(`the new home ${dir} is not empty once made private: something was put in it before`), {code: 'HOME_NOT_PRIVATE'});
  }
  return true;
}

// The folders above a home (POSIX; the reviewer on #126 (a)), by countinghouse
// #520's rule for its sqlite store's: along the path as given and its real
// path, each this user's or root's, writable by no other unless sticky (as
// /tmp: no one else can rename what this user owns there), nor by a group
// other than this user's own primary group (a user-private group, as a umask
// of 0002 leaves a home's folders). Otherwise another user could move the
// home away and put one of theirs in its place. Windows: the ancestors' DACLs
// are not checked. -> {why, fix} | null
function aboveProblemWith(home, QUOTE) {
  const given = path.resolve(home);
  // (a home not made yet: the path as given, its folders that are there)
  let real = null;
  try { real = fs.realpathSync.native(given); } catch (e) { if (e.code !== 'ENOENT') return {why: `it could not be read (${e.code || e.message})`, fix: null}; }
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  const gid = typeof process.getegid === 'function' ? process.getegid() : null;
  for (const start of real != null ? [given, real] : [given]) {
    for (let at = path.dirname(start); ; at = path.dirname(at)) {
      let st;
      try { st = fs.statSync(at); } catch (e) {
        if (real == null && e.code === 'ENOENT' && path.dirname(at) !== at) continue;
        return {why: `it is under ${at}, which could not be checked (${e.code || e.message})`, fix: null};
      }
      if (uid != null && st.uid !== uid && st.uid !== 0) return {why: `it is under ${at}, which is not yours (nor root's); another user could move the home away and put theirs in its place`, fix: null};
      const sticky = (st.mode & 0o1000) !== 0;
      const others = (st.mode & 0o002) !== 0 && !sticky;
      const group = (st.mode & 0o020) !== 0 && !sticky && st.gid !== gid;
      if (others || group) {
        const mine = uid != null && st.uid === uid;
        const q = QUOTE(at);
        return {why: `it is under ${at}, and group or others can write in it (mode ${(st.mode & 0o7777).toString(8)}); another user could move the home away and put theirs in its place`, fix: mine && q !== '"<its folder>"' ? `run \`chmod go-w ${q}\`` : null};
      }
      if (path.dirname(at) === at) break;
    }
  }
  return null;
}
function aboveProblem(home) {
  return aboveProblemWith(home, (p) => require('./command-line').folderArg(p));
}

// What install, session and start say of a home another user could change
// (the reviewer's pre-work high, A-home-check): what runs from it is the
// runtime given every stored key.
const HOME_OPEN = 'so another user could change what runs from it';

// An existing home another user could change -> {why, fix} | null (null for
// a home that is fine, or not there yet: nothing would be loaded from it).
// POSIX: homeOwnershipProblem; fix, the chmod line when the mode is the cause,
// the home is this user's and its path quotes safely, else null. Windows: its
// DACL (lib/win-acl.js privateProblem), fix, the icacls lines that make it
// private. fileAcl: a test's.
// principalNames: a caller's name lookup ({names: {sid: name}, machine, localAppData}), else Windows' own (lib/win-acl.js).
// localAppData: the folder(s) %LOCALAPPDATA% names, a test's (else Windows' known folder, the lookup's, else env's LOCALAPPDATA when
// a full path).
function homeOpenProblem(home, {platform = process.platform, fileAcl = null, env = process.env, principalNames = null, localAppData} = {}) {
  const fs = require('node:fs');
  // (only a home not there yet is no home: anything else that can't be read
  // is refused: the reviewer's high on #126, L4)
  try { fs.lstatSync(home); } catch (err) {
    // (a home install will make: the folders it will be made under, so a
    // first install is held to them too: the medium on #126's round, 1)
    if (err.code === 'ENOENT') return platform === 'win32' ? null : aboveProblem(home);
    return {why: `it could not be read (${err.code || err.message})`, fix: null};
  }
  let real;
  try { real = fs.realpathSync.native(home); } catch (err) { return {why: `it could not be read (${err.code || err.message})`, fix: null}; }
  if (platform === 'win32') {
    // (a directory, as the daemon's check wants it: the medium, 4)
    let st;
    try { st = fs.statSync(real); } catch (err) { return {why: `it could not be read (${err.code || err.message})`, fix: null}; }
    if (!st.isDirectory()) return {why: 'it is not a directory', fix: null};
    const winAcl = require('./win-acl');
    let acl;
    try { acl = (fileAcl || winAcl.fileAcl)(real); } catch (err) { return {why: `its ACL could not be read (${err.code || err.message})`, fix: null}; }
    const why = winAcl.privateProblem('it', acl, {directory: true});
    if (why == null) return null;
    const hint = winAcl.fixHint(real, acl, {directory: true});
    const lines = hint != null ? `, in Windows PowerShell (powershell.exe): ${hint.split('\n').map((l) => l.trim()).join(', then ')}` : '';
    // another account holding more than it may (privateProblem's "accessible by"): who, and the strongest right any of them holds
    const open = (why === 'it is accessible by ' + firstOpenSid(winAcl, acl)) ? winAcl.openPrincipals(acl) : [];
    if (open.length > 0) {
      // (their names, and this machine's, looked up only now, for the words: a lookup that fails says the SIDs, and the home is
      // refused the same; a name that is not plain text is said by its SID)
      let looked = null;
      try { looked = (principalNames || winAcl.principalNames)(open.map((o) => o.sid)); } catch (err) { looked = null; }
      const names = {};
      // (a name hidden for being unsafe: an account Windows names all the same, never one that names no account)
      const hidden = new Set();
      if (looked != null && looked.names != null && typeof looked.names === 'object') {
        for (const [sid, n] of Object.entries(looked.names)) {
          const shown = typeof n === 'string' && !UNSHOWN_NAME.test(n);
          names[sid] = shown ? n : '';
          // (and an entry that is not a string: an account the lookup could not say, never one that names no account)
          if (n !== '' && !shown) hidden.add(sid);
        }
      }
      const machine = (looked != null && typeof looked.machine === 'string' && looked.machine !== '') ? looked.machine : null;
      // (Windows' own known folder, the lookup's; the environment's only when that is unknown, and a full path: one the environment
      // points elsewhere, into the profile say, is no folder Codex leaves alone)
      const known = looked != null && typeof looked.localAppData === 'string' && looked.localAppData !== '' ? looked.localAppData : null;
      const fromEnv = typeof env.LOCALAPPDATA === 'string' && isFullPath(env.LOCALAPPDATA, 'win32') ? env.LOCALAPPDATA : null;
      const locals = localAppData !== undefined ? [].concat(localAppData) : [known || fromEnv];
      return windowsOpen(winAcl.openPrincipals(acl, names), lines, machine, winAcl.foreignChange(acl), locals.some((d) => inside(real, d)), hidden);
    }
    // (anyone else able to change it, or what was made in it: moved aside, never repaired)
    if (winAcl.foreignChange(acl)) return {why, final: true, fix: MAY_BE_CHANGED};
    return {why, fix: `make it a folder only you can change${lines}`};
  }
  const st = fs.statSync(real);
  // (a file: no fix that fits a folder: the medium on #126's round 2, 8)
  if (!st.isDirectory()) return {why: 'it is not a directory', fix: null};
  const mine = typeof process.geteuid !== 'function' || st.uid === process.geteuid();
  const arg = require('./command-line').folderArg(real);
  const fix = mine && (st.mode & 0o077) !== 0 && arg !== '"<its folder>"' ? `run \`chmod 700 ${arg}\`` : null;
  const why = homeOwnershipProblem(real, platform);
  // (one that was writable by others may already have been changed: its
  // app, module store and records are not re-checked by a chmod, so it is
  // moved aside and installed again, never trusted after one: the
  // reviewer's Fable high on #126, F2; final: no "then ... again" after it)
  if (why != null && (st.mode & 0o022) !== 0) {
    const aside = require('./command-line').folderArg(`${real}.suspect`);
    return {why, final: true, fix: mine && arg !== '"<its folder>"' && aside !== '"<its folder>"' ? `it may already have been changed: move it aside (\`mv ${arg} ${aside}\`) and install again` : 'it may already have been changed: move it aside and install again'};
  }
  if (why != null) return {why, fix};
  // private, as install makes it: its app and module store are the code
  // that runs with the keys, and install makes them with the umask's modes
  // (the reviewer's high on #126, M2)
  if ((st.mode & 0o077) !== 0) return {why: `it is open to group or others (mode ${(st.mode & 0o777).toString(8).padStart(4, '0')}), and its folders may be too`, fix};
  return aboveProblem(home);
}

// the first other account privateProblem found: the same rule it judged (lib/win-acl.js openPrincipals, in its order)
function firstOpenSid(winAcl, acl) {
  const open = winAcl.openPrincipals(acl);
  return open.length > 0 ? open[0].sid : null;
}
// The Windows refusal for other accounts: every one holding the strongest right any of them holds, by name (a SID Windows can't
// name, by its SID). Read only: readable, its credentials named; any change right: changeable. This machine's CodexSandboxUsers
// among them: the Codex form, a SID that names no account beside it called a Codex sandbox identity, and no icacls lines, since
// Codex puts its grant back each time it runs a command: the home moved under %LOCALAPPDATA% instead (final: nothing to retry).
const CODEX_GROUP = 'CodexSandboxUsers';
// Anyone else able to change it (any change right, explicit or inherited by what was made in it): it may already have been changed,
// as POSIX's group- or world-writable home: moved aside and installed again, no lines that set its access (setting it right undoes
// no change already made to bin\ch-local.js or the stored modules: the reviewer's ruling on Matt's cleanup). Read only: the lines.
const MAY_BE_CHANGED = 'it may already have been changed: move it aside and install again';
// a name with a control, format, surrogate, private-use or unassigned character, or an invisible filler: never printed (said by its
// SID)
// (line and paragraph separators, and every space but U+0020, too)
// (variation selectors and the Braille blank as well)
const UNSHOWN_NAME = /[\p{C}\p{Zl}\p{Zp}\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u034f\u115f\u1160\u3164\uffa0\ufe00-\ufe0f\u{e0100}-\u{e01ef}\u2800]/u;
// whether real (a real path) is in dir (not dir itself), on Windows' paths, case aside: dir as the kernel resolves it, where it can
const inside = (real, dir) => {
  if (typeof dir !== 'string' || dir === '') return false;
  let d = dir;
  try { d = fs.realpathSync.native(dir); } catch (err) { /* as given */ }
  const r = path.win32.relative(path.win32.resolve(d).toLowerCase(), path.win32.resolve(real).toLowerCase());
  return r !== '' && r !== '..' && !r.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(r);
};
// machine: this machine's name as Windows gives it (the lookup's), or null. inLocal: the home is under %LOCALAPPDATA%, where Codex
// grants nothing itself: a grant of its there came from a folder above (AppData's, into a home install didn't make), so moved aside
// and installed again.
// hidden: the SIDs whose names are not shown for being unsafe (accounts Windows names).
function windowsOpen(open, lines, machine, anyChange, inLocal, hidden = new Set()) {
  const change = open.some((p) => p.change);
  const strongest = open.filter((p) => p.change === change);
  const m = machine != null ? machine.toLowerCase() : null;
  const isCodex = (p) => m != null && typeof p.name === 'string' && p.name.toLowerCase() === `${m}\\${CODEX_GROUP.toLowerCase()}`;
  // (the group anywhere among them, a Codex sandbox identity perhaps holding more; only when every holder of the strongest right is
  // the group or a SID that names no account: an account Windows names, able to do more, is the refusal, as any other account's)
  const nameless = (p) => !p.name && !hidden.has(p.sid);
  const codex = open.some(isCodex) && strongest.every((p) => isCodex(p) || nameless(p));
  const named = strongest.map((p) => (p.name ? p.name : (codex && nameless(p) ? `a Codex sandbox identity (${p.sid})` : p.sid)));
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  const why = change ? `it can be changed by ${list}` : `it is readable by ${list}`;
  if (codex) {
    const whom = strongest.length > 1 ? 'these' : isCodex(strongest[0]) ? 'that group' : 'that identity';
    const what = `${change ? 'so another account could change what runs from it and read its credentials' : 'so another account could read what is stored in it, its credentials included'}. Codex's Windows sandbox gives ${whom} ${change ? '' : 'read '}access to each folder directly in your profile every time it runs a command`;
    return {why, final: true, fix: null,
      consequence: inLocal
        ? `${what}, which a folder in it takes unless install made it: move it aside and install again, which makes it a folder that takes nothing from the folders above it, then delete the old home (it still holds the stored credentials)`
        : `${what}, so removing it by hand does not last: unset COUNTINGHOUSE_HOME, or point it under %LOCALAPPDATA%, then install again and delete the old home (it still holds the stored credentials)`};
  }
  if (change) return {why, final: true, consequence: 'so another account could change what runs from it', fix: MAY_BE_CHANGED};
  // (read only by those named; an inherit-only change right for someone else too: still moved aside)
  if (anyChange) return {why, final: true, consequence: 'so another account could read what is stored in it, its credentials included', fix: MAY_BE_CHANGED};
  return {why, consequence: 'so another account could read what is stored in it, its credentials included', fix: `make it a folder only you can read${lines}`};
}

// homeOpenProblem's answer as one line: `<home> <why>, so another user could
// change what runs from it[; <fix>]`, or null. Every place that loads code
// from <home>/app says it before it loads anything (the reviewer's high on
// #126, H1: lib/ceiling.js, lib/module-values.js).
// (Windows: each answer a PowerShell read of the home's DACL, 1 to 10 s, so
// one is kept for a minute per home, as the ceiling's own read is kept: the
// medium on #126's round, 6)
const openSeen = new Map();
function openHomeLine(home, opts = {}) {
  const win = (opts.platform || process.platform) === 'win32' && opts.fileAcl == null;
  const key = path.resolve(home).toLowerCase();
  const seen = win ? openSeen.get(key) : undefined;
  if (seen != null && Date.now() - seen.at < 60 * 1000) return seen.line;
  const line = openHomeLineNow(home, opts);
  if (win) openSeen.set(key, {at: Date.now(), line});
  return line;
}
function openHomeLineNow(home, opts) {
  const p = homeOpenProblem(home, opts);
  return p == null ? null : `${home} ${p.why.replace(/^it /, '')}, ${p.consequence || HOME_OPEN}${p.fix != null ? `; ${p.fix}` : ''}`;
}

module.exports = {home, defaultHome, launcherPath, layout, isFullPath, homeOwnershipProblem, homeOpenProblem, openHomeLine, aboveProblem, HOME_OPEN, ensureHome, safeLauncher, UNSAFE_IN_COMMAND};
