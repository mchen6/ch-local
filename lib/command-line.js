'use strict';
// A ch-local command as a printed hint names it (A-chhints; the reviewer's
// plan approval, 11-20): the home's own launcher, `node "<real path>" <args>`,
// which runs as printed (nothing puts ch-local on PATH after an npx or a
// folder install), by the rule the credential line already used (A-firstrun
// d1: lib/home.js safeLauncher, the runtime's own character check); with
// no safe launcher -- none installed yet, or a path a shell would read --
// the bare `ch-local <args>`, which still names the command.
//
// Every printed hint that names a ch-local command is made here; a lexical
// pin (test/command-line.test.js) fails on a bare one written anywhere else.
const {safeLauncher} = require('./home');

// where: the home's layout (lib/home.js layout), or null (none known: the
// bare form); args: the command after `ch-local`, e.g. 'install' or
// `credentials add ${m}`
// (a launcher found is kept per home layout and platform, not resolved per
// message; none found is asked again, since an install may write it while
// the same command goes on printing)
const resolved = new WeakMap();
function launcherOf(where, platform) {
  let byPlatform = resolved.get(where);
  if (byPlatform == null) { byPlatform = new Map(); resolved.set(where, byPlatform); }
  if (byPlatform.has(platform)) return byPlatform.get(platform);
  const found = safeLauncher(where, platform);
  if (found != null) byPlatform.set(platform, found);
  return found;
}
function chLocal(where, args, platform = process.platform) {
  const launcher = where != null && typeof where === 'object' && where.launcher != null ? launcherOf(where, platform) : null;
  return launcher != null ? `node "${launcher}" ${args}` : `ch-local ${args}`;
}

// a folder as a command's argument for the user to copy: quoted, or the
// placeholder where a shell would not read it plainly
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c"`$\\%!^\u2018-\u201f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/;
const folderArg = (p, platform = process.platform) => (typeof p === 'string' && p !== '' && !UNSAFE.test(platform === 'win32' ? p.replace(/\\/g, '/') : p) ? `"${p}"` : '"<its folder>"');

module.exports = {chLocal, folderArg};
