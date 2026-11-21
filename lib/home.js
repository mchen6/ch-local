'use strict';
// The launcher's home: $COUNTINGHOUSE_HOME, else ~/.countinghouse. A relative
// COUNTINGHOUSE_HOME is refused: a client starts its servers in whatever
// directory it likes, so it would name a different place each time.
const os = require('node:os');
const path = require('node:path');

// Absolute and anchored: on Windows a drive letter or a share, since
// \\countinghouse is rooted on whichever drive is current.
function isFullPath(p, platform = process.platform) {
  if (platform === 'win32') return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p);
  return path.posix.isAbsolute(p);
}

// homedir is the user's home directory, a function so a test can give its own.
function home(env = process.env, homedir = os.homedir) {
  const set = env.COUNTINGHOUSE_HOME;
  if (typeof set !== 'string' || set === '') return path.join(homedir(), '.countinghouse');
  if (!isFullPath(set)) {
    const err = new Error(`COUNTINGHOUSE_HOME must be an absolute path, not "${set}"`);
    err.code = 'HOME_RELATIVE';
    throw err;
  }
  return path.normalize(set);
}

// The installed launcher a client runs (reviewer, 2026-11-11: a .js file run
// by node, because Windows cannot execute an extensionless file). The plugin's
// bin/launch.js applies the same rule; test/plugin.test.js checks they agree.
const launcherPath = (env = process.env, homedir = os.homedir) => path.join(home(env, homedir), 'bin', 'ch-local.js');
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
// replay's prep, 2026-11-21). Missing parents are made too, as mkdir -p
// would, never wider than 0700. A home that exists is left as it is.
// -> true when it made the home
function ensureHome(dir, platform = process.platform) {
  const fs = require('node:fs');
  const made = fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  if (made == null) return false;
  // (mkdir's mode is masked by the umask: set it whole)
  if (platform !== 'win32') fs.chmodSync(dir, 0o700);
  return true;
}

module.exports = {home, launcherPath, layout, isFullPath, homeOwnershipProblem, ensureHome, safeLauncher, UNSAFE_IN_COMMAND};
