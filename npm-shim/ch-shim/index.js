'use strict';
// @countinghouse/ch-shim: finds this platform's ch-shim binary. There is
// deliberately no bin here: a JS launcher would put Node back in every
// session's process tree, which the native shim exists to avoid. ch-local
// writes the path binaryPath() gives into each client's config instead.
const path = require('path');

const exe = (platform) => (platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');

// The binary's path for this platform (or the one given), or null when no
// package for it is installed: that platform runs the per-session mode.
function binaryPath(platform = process.platform, arch = process.arch) {
  const name = `@countinghouse/ch-shim-${platform}-${arch}`;
  try {
    return path.join(path.dirname(require.resolve(`${name}/package.json`)), 'bin', exe(platform));
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') return null;
    throw e;
  }
}

module.exports = {binaryPath};
