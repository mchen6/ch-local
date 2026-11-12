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

function home(env = process.env) {
  const set = env.COUNTINGHOUSE_HOME;
  if (typeof set !== 'string' || set === '') return path.join(os.homedir(), '.countinghouse');
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
const launcherPath = (env = process.env) => path.join(home(env), 'bin', 'ch-local.js');

module.exports = {home, launcherPath, isFullPath};
