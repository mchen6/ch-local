'use strict';
// This platform's native shim, for the client's config entry (countinghouse's
// shared-runtime design, #236, section 10): @countinghouse/ch-shim's
// locate(). Until that package is published (release gating: no npm
// publish before Matt's), a source checkout finds it beside this file
// (npm-shim/ch-shim). No binary for the platform runs the per-session mode,
// and says so; a missing one is said as a reinstall, never fallen back on
// silently.
function defaultLocate() {
  for (const id of ['@countinghouse/ch-shim', '../npm-shim/ch-shim']) {
    let mod = null;
    try {
      mod = require(id);
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') throw e;
    }
    if (mod != null && typeof mod.locate === 'function') return mod.locate();
  }
  return {status: 'unsupported'};
}

// The binary install puts beside the app (<home>/shim/ch-shim, by its pin;
// the install step is on top of the auto-upgrade build): a regular file, not
// a link, wins over any other lookup.
function installed(home) {
  if (home == null) return null;
  const file = require('path').join(home, 'shim', process.platform === 'win32' ? 'ch-shim.exe' : 'ch-shim');
  try {
    return require('fs').lstatSync(file).isFile() ? file : null;
  } catch (e) {
    return null;
  }
}

// {home?, locate?} -> {shim: absolute path | null, note: a line for the user | null}
function shimFor({home = null, locate = defaultLocate} = {}) {
  const here = installed(home);
  if (here != null) return {shim: here, note: null};
  const r = locate();
  if (r != null && r.status === 'found') return {shim: r.path, note: null};
  if (r != null && r.status === 'missing') {
    return {shim: null, note: `ch-local: the shared runtime's shim for this platform (${r.package}) is not installed or holds no binary; reinstall ch-local. Until then each session runs its own runtime.\n`};
  }
  return {shim: null, note: 'ch-local: there is no shared-runtime shim for this platform, so it runs one runtime per session.\n'};
}

module.exports = {shimFor, defaultLocate};
