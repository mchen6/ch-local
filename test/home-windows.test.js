'use strict';
// The home on Windows (R-win-codex-sandbox-acl): its default is %LOCALAPPDATA%\countinghouse, never a folder directly in the profile,
// where Codex's elevated Windows sandbox gives its CodexSandboxUsers group read access to every folder each time it runs a command.
// And a home another account can read or change is refused naming who, and whether it can read or change it. Unit-level, by
// platform: the default from an environment a case gives; the refusal from an ACL a case gives (lib/win-acl.js's shape), on a real
// folder. The real ACLs, on the Windows legs: test/home-windows-acl.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {home, defaultHome, homeOpenProblem, openHomeLine} = require('../lib/home');

const homedir = () => 'C:\\Users\\dev';

test('on Windows the default home is %LOCALAPPDATA%\\countinghouse, from the environment', () => {
  assert.strictEqual(defaultHome({LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local'}, homedir, 'win32'), 'C:\\Users\\dev\\AppData\\Local\\countinghouse');
  assert.strictEqual(home({LOCALAPPDATA: 'D:\\Profiles\\dev\\Local'}, homedir, 'win32'), 'D:\\Profiles\\dev\\Local\\countinghouse');
  // (COUNTINGHOUSE_HOME still wins)
  assert.strictEqual(home({LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', COUNTINGHOUSE_HOME: 'E:\\ch'}, homedir, 'win32'), 'E:\\ch');
});

test('on Windows a LOCALAPPDATA missing or not absolute is refused, never guessed', () => {
  for (const env of [{}, {LOCALAPPDATA: ''}, {LOCALAPPDATA: 'AppData\\Local'}, {LOCALAPPDATA: '\\AppData\\Local'}]) {
    assert.throws(() => defaultHome(env, homedir, 'win32'), (e) => e.code === 'HOME_NO_LOCALAPPDATA' && /COUNTINGHOUSE_HOME/.test(e.message), JSON.stringify(env));
    assert.throws(() => home(env, homedir, 'win32'), (e) => e.code === 'HOME_NO_LOCALAPPDATA', JSON.stringify(env));
  }
});

test('elsewhere the default home is ~/.countinghouse, LOCALAPPDATA or not', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.strictEqual(defaultHome({LOCALAPPDATA: '/x'}, () => '/home/dev', platform), path.join('/home/dev', '.countinghouse'));
  }
});

test('"is this the default home" follows the default, on Windows too', () => {
  const {isDefaultHome} = require('../lib/command-line');
  const env = {LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local'};
  assert.strictEqual(isDefaultHome({home: 'C:\\Users\\dev\\AppData\\Local\\countinghouse'}, env, 'win32', homedir), true);
  assert.strictEqual(isDefaultHome({home: 'C:\\Users\\dev\\.countinghouse'}, env, 'win32', homedir), false);
  assert.strictEqual(isDefaultHome({home: 'C:\\Users\\dev\\AppData\\Local\\countinghouse'}, {}, 'win32', homedir), false, 'no LOCALAPPDATA: no default');
});

// an ACL as lib/win-acl.js fileAcl reads it: the current user owns it; more allow rules, named as Windows resolves them
const USER = 'S-1-5-21-1-2-3-1001';
const aclWith = (...more) => ({user: USER, owner: USER, otherAces: false, rules: [{sid: USER, name: 'MACHINE\\dev', rights: 0x1f01ff, type: 'Allow', inheritOnly: false}, ...more]});
const READ = 0x1200a9;     // ReadAndExecute, (RX)
const MODIFY = 0x1301bf;   // Modify, (M)
const rule = (sid, name, rights) => ({sid, name, rights, type: 'Allow', inheritOnly: false});
const WORKSPACE = 'S-1-5-21-4120530105-1957468829-3093447216-2384341216';   // as Codex's workspace SID: names no account
const BOB = rule('S-1-5-21-1-2-3-1002', 'MACHINE\\bob', MODIFY);
const withHome = (fn) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-winhome-'));
  try { return fn(h); } finally { fs.rmSync(h, {recursive: true, force: true}); }
};
const ENV = {LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local'};
// (each rule's name as Windows would resolve it, and this machine's name as Windows gives it, from homeOpenProblem's lookup, which it
// makes only for a refusal's words)
const namesOf = (rules, machine = 'MACHINE') => (sids) => ({names: Object.fromEntries(sids.map((s) => [s, (rules.find((r) => r.sid === s) || {}).name || ''])), machine});
const problem = (h, rules, env = ENV) => homeOpenProblem(h, {platform: 'win32', fileAcl: () => aclWith(...rules), env, principalNames: namesOf(rules)});
const line = (h, rules) => openHomeLine(h, {platform: 'win32', fileAcl: () => aclWith(...rules), env: ENV, principalNames: namesOf(rules)});

// what the refusal says, for a home only too open to read, and what it leaves out: the lines that make it private, for Windows PowerShell
const MOVE = 'it may already have been changed: move it aside and install again';

test('a home another account can change is refused naming who: it may already have been changed, so moved aside, no lines', () => withHome((h) => {
  const p = problem(h, [BOB]);
  assert.strictEqual(p.why, 'it can be changed by MACHINE\\bob');
  assert.strictEqual(p.consequence, 'so another account could change what runs from it');
  assert.strictEqual(p.fix, MOVE);
  assert.strictEqual(p.final, true);
  assert.strictEqual(line(h, [BOB]), `${h} can be changed by MACHINE\\bob, so another account could change what runs from it; ${MOVE}`);
}));

test('a home another account can only read is refused as readable, its credentials named, with the lines that make it a folder only you can read', () => withHome((h) => {
  const p = problem(h, [rule('S-1-5-21-1-2-3-1002', 'MACHINE\\bob', READ)]);
  assert.strictEqual(p.why, 'it is readable by MACHINE\\bob');
  assert.strictEqual(p.consequence, 'so another account could read what is stored in it, its credentials included');
  assert.match(p.fix, /^make it a folder only you can read, in Windows PowerShell \(powershell\.exe\): icacls '/);
  assert.notStrictEqual(p.final, true);
}));

test('the lines: icacls for inheritance, the grants and the owner; each other SID purged by .NET, one to a line; a path in single quotes', () => withHome((h) => {
  const {fixHint} = require('../lib/win-acl');
  const two = aclWith(rule('S-1-5-32-545', 'BUILTIN\\Users', READ), rule(WORKSPACE, '', READ));
  const lines = fixHint("C:\\Users\\o'brien\\$x", two, {directory: true}).split('\n').map((l) => l.trim());
  assert.deepStrictEqual(lines, [
    `icacls 'C:\\Users\\o''brien\\$x' /inheritance:r /grant:r *${USER}:(OI)(CI)F *S-1-5-18:(OI)(CI)F`,
    "$i = Get-Item -LiteralPath 'C:\\Users\\o''brien\\$x' -Force; $a = $i.GetAccessControl('Access'); $a.PurgeAccessRules([System.Security.Principal.SecurityIdentifier]'S-1-5-32-545'); $i.SetAccessControl($a)",
    `$i = Get-Item -LiteralPath 'C:\\Users\\o''brien\\$x' -Force; $a = $i.GetAccessControl('Access'); $a.PurgeAccessRules([System.Security.Principal.SecurityIdentifier]'${WORKSPACE}'); $i.SetAccessControl($a)`,
    `icacls 'C:\\Users\\o''brien\\$x' /setowner *${USER}`]);
  // (a SID that is not plainly one: no lines, never a command built from it)
  assert.strictEqual(fixHint('C:\\h', aclWith(rule("S-1-5'; calc #", '', READ)), {directory: true}), null);
}));

test('the strongest right any of them holds is said, and every one that holds it is named', () => withHome((h) => {
  const reader = rule('S-1-5-21-1-2-3-1003', 'MACHINE\\carol', READ);
  assert.strictEqual(problem(h, [reader, BOB]).why, 'it can be changed by MACHINE\\bob');
  const dave = rule('S-1-5-21-1-2-3-1004', 'MACHINE\\dave', MODIFY);
  assert.strictEqual(problem(h, [BOB, reader, dave]).why, 'it can be changed by MACHINE\\bob and MACHINE\\dave');
}));

test('read only by those named, but an inherit-only change right for another: what was made in it could be changed, so moved aside', () => withHome((h) => {
  const p = problem(h, [rule('S-1-5-21-1-2-3-1002', 'MACHINE\\bob', READ), Object.assign(rule('S-1-5-21-1-2-3-1005', 'MACHINE\\erin', MODIFY), {inheritOnly: true})]);
  assert.strictEqual(p.why, 'it is readable by MACHINE\\bob');
  assert.strictEqual(p.fix, MOVE);
}));

// Codex, its workspace the profile (Matt's box, Codex 0.172.0): CodexSandboxUsers and a workspace SID that names no account, each
// (OI)(CI)(M) on every folder directly in the profile; read only (RX) where it isn't the workspace
const CODEX = 'MACHINE\\CodexSandboxUsers';
const CODEX_SID = 'S-1-5-21-9-9-9-1010';
test('changeable by this machine\'s CodexSandboxUsers and a Codex sandbox identity: the Codex line, no icacls (Codex puts the grant back)', () => withHome((h) => {
  const rules = [rule(CODEX_SID, CODEX, MODIFY), rule(WORKSPACE, '', MODIFY)];
  const p = problem(h, rules);
  assert.strictEqual(p.fix, null);
  assert.strictEqual(p.final, true);
  assert.strictEqual(line(h, rules), `${h} can be changed by MACHINE\\CodexSandboxUsers and a Codex sandbox identity (${WORKSPACE}), so another account could change what runs from it and read its credentials. Codex's Windows sandbox gives these access to each folder directly in your profile every time it runs a command, so removing it by hand does not last: unset COUNTINGHOUSE_HOME, or point it under %LOCALAPPDATA%, then install again and delete the old home (it still holds the stored credentials)`);
}));

test('readable by this machine\'s CodexSandboxUsers alone: the Codex line, read', () => withHome((h) => {
  const rules = [rule(CODEX_SID, CODEX, READ)];
  assert.strictEqual(line(h, rules), `${h} is readable by MACHINE\\CodexSandboxUsers, so another account could read what is stored in it, its credentials included. Codex's Windows sandbox gives that group read access to each folder directly in your profile every time it runs a command, so removing it by hand does not last: unset COUNTINGHOUSE_HOME, or point it under %LOCALAPPDATA%, then install again and delete the old home (it still holds the stored credentials)`);
}));

test('by the name on this machine: a domain\'s group called CodexSandboxUsers is any other account, and its SID is no Codex identity', () => withHome((h) => {
  const p = problem(h, [rule(CODEX_SID, 'CORP\\CodexSandboxUsers', MODIFY), rule(WORKSPACE, '', MODIFY)]);
  assert.strictEqual(p.why, `it can be changed by CORP\\CodexSandboxUsers and ${WORKSPACE}`);
  assert.strictEqual(p.fix, MOVE);
}));

// this machine's name from Windows itself (the lookup's), never from COMPUTERNAME: a session the shim or Codex starts has none
test('this machine\'s CodexSandboxUsers known with no COMPUTERNAME in the environment: the Codex line', () => withHome((h) => {
  const rules = [rule(CODEX_SID, CODEX, MODIFY), rule(WORKSPACE, '', MODIFY)];
  const p = problem(h, rules, {});
  assert.strictEqual(p.fix, null);
  assert.strictEqual(p.why, `it can be changed by MACHINE\\CodexSandboxUsers and a Codex sandbox identity (${WORKSPACE})`);
  // (another machine's name for this one: the group is not this machine's)
  const q = homeOpenProblem(h, {platform: 'win32', fileAcl: () => aclWith(...rules), env: {COMPUTERNAME: 'MACHINE'}, principalNames: namesOf(rules, 'OTHER')});
  assert.strictEqual(q.fix, MOVE);
}));

// the group anywhere among them, not only among the strongest: Codex's read grant beside a workspace identity's change right
test('CodexSandboxUsers able to read, a Codex sandbox identity able to change: the Codex line, the identity named as one', () => withHome((h) => {
  const rules = [rule(CODEX_SID, CODEX, READ), rule(WORKSPACE, '', MODIFY)];
  const p = problem(h, rules);
  assert.strictEqual(p.why, `it can be changed by a Codex sandbox identity (${WORKSPACE})`);
  assert.strictEqual(p.fix, null);
  assert.match(p.consequence, /Codex's Windows sandbox gives that identity access to each folder directly in your profile/);
}));

// a home under %LOCALAPPDATA% (the default, or any other) not made by install, unprotected, takes Codex's read grant on AppData: moving
// it under %LOCALAPPDATA% says nothing; install makes a new one that takes nothing from the folders above it
test('a home under %LOCALAPPDATA% open to Codex (taking it from AppData): moved aside and installed again, never "point it under %LOCALAPPDATA%"', () => withHome((h) => {
  const rules = [rule(CODEX_SID, CODEX, READ)];
  for (const local of [path.dirname(h), path.dirname(path.dirname(h))]) {
    const p = homeOpenProblem(h, {platform: 'win32', fileAcl: () => aclWith(...rules), env: ENV, principalNames: namesOf(rules), localAppData: local});
    assert.strictEqual(p.why, 'it is readable by MACHINE\\CodexSandboxUsers');
    assert.strictEqual(p.final, true);
    assert.strictEqual(p.fix, null);
    assert.ok(!/COUNTINGHOUSE_HOME|point it under/.test(p.consequence), p.consequence);
    assert.match(p.consequence, /, which a folder in it takes unless install made it: move it aside and install again, which makes it a folder that takes nothing from the folders above it, then delete the old home \(it still holds the stored credentials\)$/);
  }
  // (a home elsewhere: the Codex line that sends it under %LOCALAPPDATA%)
  const q = homeOpenProblem(h, {platform: 'win32', fileAcl: () => aclWith(...rules), env: ENV, principalNames: namesOf(rules), localAppData: path.join(h, 'elsewhere')});
  assert.match(q.consequence, /point it under %LOCALAPPDATA%/);
}));

// Codex's group able to read, and an account Windows names able to change: that account's change right is the refusal, not Codex's
test('CodexSandboxUsers able to read, a named account able to change: moved aside as any change, never the Codex line', () => withHome((h) => {
  const p = problem(h, [rule(CODEX_SID, CODEX, READ), BOB]);
  assert.strictEqual(p.why, 'it can be changed by MACHINE\\bob');
  assert.strictEqual(p.fix, MOVE);
  assert.ok(!/Codex/.test(p.consequence), p.consequence);
}));

// a name is printed only as plain text: one with a control or direction-changing character is said by its SID
test('a name with a control or direction-changing character is said by its SID', () => withHome((h) => {
  for (const bad of ['MACHINE\\b\u202eob', 'MACHINE\\b\u0007ob', 'MACHINE\\b\u2066ob', 'MACHINE\\admin\u3164', 'MACHINE\\b\ud800ob', 'MACHINE\\bob\udb40\udc41']) {
    const r = rule('S-1-5-21-1-2-3-1002', bad, MODIFY);
    assert.strictEqual(problem(h, [r]).why, 'it can be changed by S-1-5-21-1-2-3-1002', JSON.stringify(bad));
  }
}));

// an ACL reader a caller gave (session's and start's cached one) and no lookup: Windows' own lookup still names them
test('an ACL reader given and no lookup: the names still looked up, by Windows\' own lookup', () => withHome((h) => {
  const winAcl = require('../lib/win-acl');
  const saved = winAcl.principalNames;
  let asked = 0;
  winAcl.principalNames = (sids) => { asked += 1; return {names: Object.fromEntries(sids.map((x) => [x, 'MACHINE\\bob'])), machine: 'MACHINE'}; };
  try {
    assert.strictEqual(homeOpenProblem(h, {platform: 'win32', fileAcl: () => aclWith(BOB), env: ENV}).why, 'it can be changed by MACHINE\\bob');
  } finally {
    winAcl.principalNames = saved;
  }
  assert.strictEqual(asked, 1);
}));

// PowerShell takes U+2018-U+201B as single quotes too: each doubled, as an ASCII one is, so a path never ends its string early
test('the lines: a path with a curly single quote has it doubled, as a plain one', () => {
  const {fixHint} = require('../lib/win-acl');
  for (const q of ['\u2018', '\u2019', '\u201a', '\u201b']) {
    const first = fixHint(`C:\\Users\\O${q}Brien\\h`, aclWith(rule('S-1-5-32-545', 'BUILTIN\\Users', READ)), {directory: true}).split('\n')[0];
    assert.ok(first.startsWith(`icacls 'C:\\Users\\O${q}${q}Brien\\h' `), JSON.stringify(first));
  }
});

test('names are looked up only for a refusal: none for a private home; a lookup that fails says the SIDs, refused the same', () => withHome((h) => {
  let asked = 0;
  const count = () => { asked += 1; return {}; };
  assert.strictEqual(homeOpenProblem(h, {platform: 'win32', fileAcl: () => aclWith(), env: ENV, principalNames: count}), null);
  assert.strictEqual(asked, 0, 'looked up for a private home');
  const p = homeOpenProblem(h, {platform: 'win32', fileAcl: () => aclWith(BOB), env: ENV, principalNames: () => { throw new Error('powershell failed'); }});
  assert.strictEqual(p.why, 'it can be changed by S-1-5-21-1-2-3-1002');
  assert.strictEqual(p.fix, MOVE);
}));

test('Codex\'s grants with the name lookup failing: no Codex form (it goes by name), the generic one, raw SIDs, still changeable', () => withHome((h) => {
  const rules = [rule(CODEX_SID, CODEX, MODIFY), rule(WORKSPACE, '', MODIFY)];
  const p = homeOpenProblem(h, {platform: 'win32', fileAcl: () => aclWith(...rules), env: ENV, principalNames: () => { throw new Error('powershell failed'); }});
  assert.strictEqual(p.why, `it can be changed by ${CODEX_SID} and ${WORKSPACE}`);
  assert.strictEqual(p.consequence, 'so another account could change what runs from it');
  assert.strictEqual(p.fix, MOVE);
}));

test('a principal Windows cannot name is said by its SID', () => withHome((h) => {
  assert.strictEqual(problem(h, [rule('S-1-5-21-1-2-3-1099', '', MODIFY)]).why, 'it can be changed by S-1-5-21-1-2-3-1099');
}));

test('the other refusals keep their words (an owner, an inherit-only rule)', () => withHome((h) => {
  const acl = {user: USER, owner: 'S-1-5-21-1-2-3-1002', otherAces: false, rules: []};
  const p = homeOpenProblem(h, {platform: 'win32', fileAcl: () => acl, env: ENV});
  assert.match(p.why, /^it is owned by S-1-5-21-1-2-3-1002/);
  assert.strictEqual(p.consequence, undefined);
}));
