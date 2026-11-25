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
// COUNTINGHOUSE_HOME before an npx command, for a home that isn't the
// default (POSIX): the home, quoted, or the placeholder where a shell would
// not read it plainly -- never left out, which would act on ~/.countinghouse
// (the medium on the follow-up to #129, 3). Windows: '' (A-chlocal-func).
// -> '' | 'COUNTINGHOUSE_HOME="<home>" '
function homePrefix(where, platform = process.platform) {
  if (where == null || typeof where !== 'object' || where.home == null || platform === 'win32' || isDefaultHome(where)) return '';
  return `COUNTINGHOUSE_HOME=${folderArg(String(where.home), platform)} `;
}

// (with no launcher yet, before any install, nothing puts ch-local on PATH:
// the npx form, which runs as printed: the final pass's ch-local part, A11)
const NPX = `npx ${require('../package.json').name}`;
function chLocal(where, args, platform = process.platform) {
  const launcher = where != null && typeof where === 'object' && where.launcher != null ? launcherOf(where, platform) : null;
  if (launcher != null) return `node "${launcher}" ${args}`;
  // (a home that isn't the default is named, or the command acts on
  // ~/.countinghouse when pasted into a new terminal: the reviewer on #129,
  // 5. POSIX: before the command. Windows: not yet, which needs words beside
  // each caller's command: A-chlocal-func)
  return `${homePrefix(where, platform)}${NPX} ${args}`;
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
  // (no plain path to this ch-local: the npx form of THIS release, on this
  // home: the medium on A11, 4)
  const pinned = () => `${homePrefix(where, platform)}${NPX}@${require('../package.json').version} ${args}`;
  try { self = fs.realpathSync.native(path.join(__dirname, '..', 'bin', 'ch-local.js')); } catch (err) { return pinned(); }
  const plain = (p) => !UNSAFE_ANY.test(platform === 'win32' ? p.replace(/\\/g, '/') : p);
  if (!plain(self)) return pinned();
  return `${homePrefix(where, platform)}node "${self}" ${args}`;
}
// (Windows: the home, when it is not the default, said beside the command)
const homeNote = (where, platform = process.platform) => (where != null && !isDefaultHome(where) && platform === 'win32' ? ` (with COUNTINGHOUSE_HOME set to ${folderArg(where.home, platform)})` : '');
function isDefaultHome(where) {
  const os = require('node:os');
  const path = require('node:path');
  return path.resolve(where.home) === path.resolve(path.join(os.homedir(), '.countinghouse'));
}

// The npx form of the latest release, for a release this ch-local can't read
// (a later pins format): `npx <package>@latest <args>`, on this home (POSIX:
// COUNTINGHOUSE_HOME before it when the home isn't the default; Windows: in
// words, homeNote). -> the command line
function npxLatest(where, args, platform = process.platform) {
  return `${homePrefix(where, platform)}npx ${require('../package.json').name}@latest ${args}`;
}

// The way to make a running runtime take a change, said where the mode
// isn't known (status, credentials, settings): a client's own runtime
// restarts with the client; the shared one, which a client's restart only
// attaches to again, with `ch-local restart` (A5)
const restartEither = (where, platform = process.platform) => `restart your client, or with the shared runtime run \`${chLocal(where, 'restart', platform)}\``;
// The way, one only where the mode is known (inside start: a notice is cut
// at 200 characters, so both don't fit -- the reviewer's high on #147, M3).
// shared: true (the shared runtime), false (the client's own), or unknown.
const restartOne = (where, shared, platform = process.platform) => (shared === true ? `run \`${chLocal(where, 'restart', platform)}\`` : shared === false ? 'restart your client' : restartEither(where, platform));

// A command for the user's own terminal as a hint prints it: in backticks,
// and when it is the npx form (no launcher yet: before any install) on
// Windows for a home that isn't the default, the home in words after them
// (homeNote), which POSIX puts before the command (homePrefix). The
// launcher's form names its home already. -> '`<command>`' + the words
const hintCommand = (where, args, platform = process.platform) => {
  const c = chLocal(where, args, platform);
  return `\`${c}\`${c.includes(NPX) ? homeNote(where, platform) : ''}`;
};

// A notice within the runtime's 200-character notice cut (code points, as
// the cut): head, cut before tail where both don't fit, so a command at the
// end of tail always arrives whole; a tail that leaves no room for a head
// goes alone (the final pass on #134; #147's M3)
const NOTICE_MAX = 200;
function fitNotice(head, tail, max = NOTICE_MAX) {
  const n = (x) => [...x].length;
  if (n(head) + n(tail) <= max) return `${head}${tail}`;
  const room = max - n(tail);
  if (room < 20) return tail.replace(/^[;:,]\s*/, '');
  // (terminalText makes every backtick in a cut explanation "?": no half
  // command survives there; the tail's command is the one to run)
  return `${terminalText(head, room)}${tail}`;
}

// Any notice within the cut: one whose last command (in backticks) would be
// cut is fitted around it, the explanation cut before it; one with none is
// cut at the end (the closing pass's pin on load and unload notices)
function fitAny(text, max = NOTICE_MAX) {
  if ([...text].length <= max) return text;
  const m = text.match(/`[^`]*`[^`]*$/);
  return m != null ? fitNotice(text.slice(0, m.index), text.slice(m.index), max) : terminalText(text, max);
}

// The line of a module held back ("not loading m: <reason>"), within the cut:
// its command whole (fitAny); one that its own folder takes past the cut names
// the folder in words instead. (A launcher path that leaves no room even so:
// the reason alone, with no command to run in part.)
function fitHeld(line, max = NOTICE_MAX) {
  const within = (t) => [...t].length <= max;
  const fitted = fitAny(line, max);
  if (within(fitted)) return fitted;
  const inWords = fitAny(line.replace(/ add-module "[^"`]*"/, ' add-module "<its folder>"'), max);
  return within(inWords) ? inWords : terminalText(line.replace(/[:;,]?( run)? ?`[^`]*`[^`]*$/, ''), max);
}

module.exports = {fitAny, fitHeld, fitNotice, NOTICE_MAX, chLocal, chLocalSelf, npxLatest, homePrefix, homeNote, folderArg, terminalText, UNSAFE_ANY, NPX, hintCommand, restartEither, restartOne};
