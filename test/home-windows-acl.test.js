'use strict';
// The Windows home against what Codex's elevated Windows sandbox does, on a real DACL: the Windows legs only. Codex gives its
// CodexSandboxUsers group (OI)(CI)(RX), and where the profile is its workspace the group and a workspace SID that names no account
// (OI)(CI)(M), as explicit entries on every folder directly in %USERPROFILE%, AppData among them (codex-rs/windows-sandbox-rs
// setup.rs profile_read_roots and expand_user_profile_root_for). Imitated with icacls /grant (it propagates as SetSecurityInfo
// does), on a tree of this test's own:
// - a home where the default puts it, under a LOCALAPPDATA, stays private through both grants on AppData and LOCALAPPDATA;
// - a home directly in a profile, given read, is refused, and the lines the refusal prints, run in Windows PowerShell exactly as
//   printed, make it private (a group and a SID that names no account: the two a cleanup on the owner's machine found icacls /remove can't clear);
// - given change, it is refused as one that may already have been changed, with no lines.
// Each grant is to BUILTIN\Users and to a made-up SID that names no account, never to a real account; the CodexSandboxUsers form
// only under CI, with a local group made and removed here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');

const WIN = process.platform === 'win32';
const SYS32 = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const USERS = 'S-1-5-32-545';   // BUILTIN\Users: a group, standing in for CodexSandboxUsers
// a SID that names no account, as Codex's workspace SID: S-1-5-21 and four random parts
const part = () => String(crypto.randomInt(1, 2 ** 31));
const UNNAMED = `S-1-5-21-${part()}-${part()}-${part()}-${part()}`;
const icacls = (...a) => execFileSync(path.win32.join(SYS32, 'icacls.exe'), a, {encoding: 'utf8'});
// the two grants Codex makes, on one folder
const readGrant = (dir) => { icacls(dir, '/grant', `*${USERS}:(OI)(CI)(RX)`); icacls(dir, '/grant', `*${UNNAMED}:(OI)(CI)(RX)`); };
const changeGrant = (dir) => { icacls(dir, '/grant', `*${USERS}:(OI)(CI)(M)`); icacls(dir, '/grant', `*${UNNAMED}:(OI)(CI)(M)`); };
// a printed line, run as a person pasting it into Windows PowerShell would: verbatim (encoded, so nothing is quoted on the way)
const powershell = (line) => execFileSync(path.win32.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(line, 'utf16le').toString('base64')], {encoding: 'utf8'});

const tree = (fn) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-winacl-'));
  try { return fn(root); } finally {
    try { icacls(root, '/reset', '/T', '/C', '/Q'); } catch (e) { /* removed below as it can be */ }
    fs.rmSync(root, {recursive: true, force: true});
  }
};

for (const [what, grant] of [['read (RX)', readGrant], ['change (M)', changeGrant]]) {
  test(`a home where the default puts it, under LOCALAPPDATA, stays private when AppData and LOCALAPPDATA are given ${what}`, {skip: !WIN}, () => tree((root) => {
    const {defaultHome, ensureHome, homeOpenProblem} = require('../lib/home');
    const appData = path.join(root, 'AppData');
    const local = path.join(appData, 'Local');
    fs.mkdirSync(local, {recursive: true});
    const home = defaultHome({LOCALAPPDATA: local}, os.homedir, 'win32');
    assert.strictEqual(home, path.join(local, 'countinghouse'));
    ensureHome(home, 'win32');
    grant(appData);
    grant(local);
    assert.strictEqual(homeOpenProblem(home, {platform: 'win32'}), null);
  }));
}

test('a home directly in a profile, given read: refused naming who; the printed lines, run as printed in Windows PowerShell, make it private', {skip: !WIN}, () => tree((root) => {
  const {ensureHome, homeOpenProblem} = require('../lib/home');
  const home = path.join(root, 'profile', '.countinghouse');
  ensureHome(home, 'win32');
  readGrant(home);
  const p = homeOpenProblem(home, {platform: 'win32', env: {COMPUTERNAME: 'no-such-machine'}});
  assert.ok(p != null, 'not refused');
  assert.ok([`it is readable by BUILTIN\\Users and ${UNNAMED}`, `it is readable by ${UNNAMED} and BUILTIN\\Users`].includes(p.why), p.why);
  const prefix = 'make it a folder only you can read, in Windows PowerShell (powershell.exe): ';
  assert.ok(p.fix.startsWith(prefix), p.fix);
  const lines = p.fix.slice(prefix.length).split(', then ');
  assert.strictEqual(lines.length, 4, `one line per operation, one per SID: ${p.fix}`);
  for (const line of lines) powershell(line);
  assert.strictEqual(homeOpenProblem(home, {platform: 'win32'}), null, `the printed lines left it open: ${p.fix}`);
}));

test('a home directly in a profile, given change: refused as one that may already have been changed, no lines', {skip: !WIN}, () => tree((root) => {
  const {ensureHome, homeOpenProblem} = require('../lib/home');
  const home = path.join(root, 'profile', '.countinghouse');
  ensureHome(home, 'win32');
  changeGrant(home);
  const p = homeOpenProblem(home, {platform: 'win32', env: {COMPUTERNAME: 'no-such-machine'}});
  assert.ok([`it can be changed by BUILTIN\\Users and ${UNNAMED}`, `it can be changed by ${UNNAMED} and BUILTIN\\Users`].includes(p.why), p.why);
  assert.strictEqual(p.fix, 'it may already have been changed: move it aside and install again');
}));

test('this machine\'s CodexSandboxUsers on a home directly in a profile: the Codex line, no lines; on one under %LOCALAPPDATA% taking it from above: moved aside', {skip: !WIN || process.env.CI !== 'true'}, () => tree((root) => {
  const {ensureHome, homeOpenProblem, openHomeLine} = require('../lib/home');
  const net = (...a) => execFileSync(path.win32.join(SYS32, 'net.exe'), a, {encoding: 'utf8'});
  let made = false;
  try {
    try { net('localgroup', 'CodexSandboxUsers', '/add'); made = true; } catch (e) { /* already there */ }
    const home = path.join(root, 'profile', '.countinghouse');
    ensureHome(home, 'win32');
    icacls(home, '/grant', 'CodexSandboxUsers:(OI)(CI)(M)');
    icacls(home, '/grant', `*${UNNAMED}:(OI)(CI)(M)`);
    // (the runner's temp folder is under its %LOCALAPPDATA%: this tree's own stands in for it, outside the profile home)
    const local = path.join(root, 'local');
    const p = homeOpenProblem(home, {platform: 'win32', localAppData: local});
    assert.strictEqual(p.fix, null);
    const said = openHomeLine(home, {platform: 'win32', localAppData: local});
    assert.ok(said.includes(`\\CodexSandboxUsers and a Codex sandbox identity (${UNNAMED}), so another account could change what runs from it and read its credentials. Codex's Windows sandbox gives these access`), said);
    assert.ok(said.endsWith('so removing it by hand does not last: unset COUNTINGHOUSE_HOME, or point it under %LOCALAPPDATA%, then install again and delete the old home (it still holds the stored credentials)'), said);
    // a home under %LOCALAPPDATA% not made by install, taking the group's grant from the folder above: moved aside and installed again
    fs.mkdirSync(local);
    icacls(local, '/grant', 'CodexSandboxUsers:(OI)(CI)(RX)');
    const under = path.join(local, 'countinghouse');
    fs.mkdirSync(under);
    const q = homeOpenProblem(under, {platform: 'win32', localAppData: local});
    assert.match(q.why, /^it is readable by [^ ]+\\CodexSandboxUsers$/);
    assert.match(q.consequence, /move it aside and install again, which makes it a folder that takes nothing from the folders above it, then delete the old home/);
  } finally {
    if (made) { try { net('localgroup', 'CodexSandboxUsers', '/delete'); } catch (e) { /* left for the runner's teardown */ } }
  }
}));

// the one lookup a refusal makes: the names, this machine's name and the known local application data folder, from Windows itself
test('Windows\' name lookup: a name for BUILTIN\\Users, this machine\'s name, and %LOCALAPPDATA%\'s known folder', {skip: !WIN}, () => {
  const {principalNames} = require('../lib/win-acl');
  const r = principalNames([USERS]);
  assert.ok(typeof r.names[USERS] === 'string' && r.names[USERS].includes('\\'), JSON.stringify(r));
  assert.strictEqual(String(r.machine).toUpperCase(), String(process.env.COMPUTERNAME).toUpperCase(), JSON.stringify(r));
  assert.strictEqual(path.win32.resolve(String(r.localAppData)).toLowerCase(), path.win32.resolve(process.env.LOCALAPPDATA).toLowerCase(), JSON.stringify(r));
});

test('on Windows with no LOCALAPPDATA and no COUNTINGHOUSE_HOME, ch-local refuses in one line naming COUNTINGHOUSE_HOME, exit 2', {skip: !WIN}, () => {
  const {spawnSync} = require('node:child_process');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LOCALAPPDATA|COUNTINGHOUSE_HOME)$/i.test(k)));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'ch-local.js'), 'status'], {encoding: 'utf8', env});
  assert.strictEqual(r.status, 2, r.stderr);
  assert.strictEqual(r.stderr.trim().split('\n').length, 1, r.stderr);
  assert.match(r.stderr, /^ch-local: LOCALAPPDATA is not set, .*set COUNTINGHOUSE_HOME to an absolute path/);
});
