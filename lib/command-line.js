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
// (and the characters a terminal shows as nothing: fillers, variation
// selectors, tag characters -- the reviewer's high on #113)
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f"`$\\%!^\u2018-\u201f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb\u{e0000}-\u{e007f}]/u;
const folderArg = (p, platform = process.platform) => (typeof p === 'string' && p !== '' && !UNSAFE_ANY.test(platform === 'win32' ? p.replace(/\\/g, '/') : p) ? `"${p}"` : '"<its folder>"');

// text a module supplies, as a terminal shows it: every character UNSAFE
// names as "?" (a control, bidi or invisible one can move the cursor or hide
// a line), runs of white space as one space, cut at max characters
// (every control, format and line or paragraph separator character, by
// its Unicode category, beside the list above: the medium on #113's round 1)
const UNSAFE_ANY = new RegExp(`${UNSAFE.source}|[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]`, 'u');
const UNSAFE_ALL = new RegExp(`${UNSAFE.source}|[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]`, 'gu');
const terminalText = (s, max = 80) => {
  const t = [...String(s).replace(UNSAFE_ALL, '?').replace(/\s+/g, ' ')];
  // (cut by code points: a pair is never split)
  return t.length > max ? `${t.slice(0, max - 1).join('')}…` : t.join('');
};

// The ch-local that is running, as a command to print, for a hint that only
// this release can carry out (the reviewer on #124: "bring the home to
// <ours>" run by the home's own, older launcher would reinstall the older
// release): `node "<this ch-local's bin/ch-local.js>" <args>`, with the home
// it acts on named when it is not the default one (POSIX: as the variable
// before the command; Windows: in words, by homeNote). A path a shell would
// read otherwise gives the bare form.
function chLocalSelf(where, args, platform = process.platform) {
  const fs = require('node:fs');
  const path = require('node:path');
  let self;
  try { self = fs.realpathSync.native(path.join(__dirname, '..', 'bin', 'ch-local.js')); } catch (err) { return `ch-local ${args}`; }
  const plain = (p) => !UNSAFE_ANY.test(platform === 'win32' ? p.replace(/\\/g, '/') : p);
  if (!plain(self)) return `ch-local ${args}`;
  const homeVar = where != null && !isDefaultHome(where) && platform !== 'win32' && plain(where.home) ? `COUNTINGHOUSE_HOME="${where.home}" ` : '';
  return `${homeVar}node "${self}" ${args}`;
}
// (Windows: the home, when it is not the default, said beside the command)
const homeNote = (where, platform = process.platform) => (where != null && !isDefaultHome(where) && platform === 'win32' ? ` (with COUNTINGHOUSE_HOME set to ${folderArg(where.home, platform)})` : '');
function isDefaultHome(where) {
  const os = require('node:os');
  const path = require('node:path');
  return path.resolve(where.home) === path.resolve(path.join(os.homedir(), '.countinghouse'));
}

module.exports = {chLocal, chLocalSelf, homeNote, folderArg, terminalText};
