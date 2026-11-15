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

// -> {shim: absolute path | null, note: a line for the user | null}
function shimFor({locate = defaultLocate} = {}) {
  const r = locate();
  if (r != null && r.status === 'found') return {shim: r.path, note: null};
  if (r != null && r.status === 'missing') {
    return {shim: null, note: `ch-local: the shared runtime's shim for this platform (${r.package}) is not installed or holds no binary; reinstall ch-local. Until then each session runs its own runtime.\n`};
  }
  return {shim: null, note: 'ch-local: there is no shared-runtime shim for this platform, so it runs one runtime per session.\n'};
}

module.exports = {shimFor, defaultLocate};
