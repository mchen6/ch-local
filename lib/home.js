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

// Where everything goes under the home (spec §2, "Where files go"; the store
// and its identity secret are the runtime's, LM1 spec §4).
function layout(env = process.env, homedir = os.homedir) {
  const h = home(env, homedir);
  const at = (...p) => path.join(h, ...p);
  return {
    home: h,
    app: at('app'),
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
    run: at('run')
  };
}

module.exports = {home, launcherPath, layout, isFullPath};
