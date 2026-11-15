'use strict';
// @countinghouse/ch-shim: finds this platform's ch-shim binary. There is
// deliberately no bin here: a JS launcher would put Node back in every
// session's process tree, which the native shim exists to avoid. ch-local
// writes the path locate() gives into each client's config instead.
const fs = require('fs');
const path = require('path');
// beside this file in the published package; one level up in the source tree
const targets = (() => { try { return require('./targets'); } catch (e) { return require('../targets'); } })();

const exe = (platform) => (platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');

// -> {status: 'found', path} -- this platform's binary, there;
//    {status: 'missing', package} -- a platform ch-shim is built for, but its
//      package is not installed (an install with --omit=optional, a lockfile
//      made on another platform, node_modules copied across platforms) or
//      holds no binary: reinstall, never fall back without saying so;
//    {status: 'unsupported'} -- no ch-shim for this platform: it runs the
//      per-session mode.
function locate(platform = process.platform, arch = process.arch) {
  const target = targets.find((t) => t.os === platform && t.cpu === arch);
  if (target == null) return {status: 'unsupported'};
  const name = `@countinghouse/ch-shim-${target.key}`;
  let dir = null;
  try {
    dir = path.dirname(require.resolve(`${name}/package.json`));
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') return {status: 'missing', package: name};
    throw e;
  }
  const file = path.join(dir, 'bin', exe(platform));
  return fs.existsSync(file) ? {status: 'found', path: file} : {status: 'missing', package: name};
}

module.exports = {locate};
