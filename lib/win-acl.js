'use strict';
// Copied from countinghouse lib/win-acl.js at master c274f2f3 (2026-11-15),
// with countinghouse #275's fileAcls and privateProblem's directory option,
// unchanged but for powershellPath, which is exported here, and
// makePrivateDirs, which is ch-local's own; keep the two copies in step.
// (Apache-2.0, the same author.) For the private-file checks the native shim
// makes (lib/private-file.js): the
// owner and DACL of a file by well-known SID, read with the PowerShell in the
// Windows directory, and privateProblem's rule.
// Windows access control by well-known SID, read and set with the PowerShell
// in the Windows directory (no localized names, no icacls text). Shared by
// the operator's ceiling (lib/settings-ceiling.js) and the identity secret
// (lib/identity.js), where POSIX has mode bits and Windows has none (every
// file reports 0666 there).
//
// PowerShell is started by its absolute path under the Windows directory,
// never by name (Windows looks in the current directory first, where an
// agent could have put a powershell.exe), with its working directory there
// and a minimal environment: no PSModulePath, no profile; the security
// module is imported from beside that powershell.exe. Every caller fails
// closed on a throw.
const path = require('path');
const {execFileSync} = require('child_process');

const DRIVE_PATH = /^[A-Za-z]:\\[^"<>|?*\r\n]*$/;
const SYSTEM = 'S-1-5-18';
const ADMINISTRATORS = 'S-1-5-32-544';

// The process's SystemRoot (the user's own environment: spec #169 section 3),
// which a caller may check against the Windows known folder.
function windowsDir() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  if (!DRIVE_PATH.test(root)) throw new Error(`SystemRoot is not a drive path (${String(root).slice(0, 80)})`);
  return root.replace(/\\+$/, '');
}

// input: what the script reads from stdin ([Console]::In), never a variable
// or an argument (a secret is never in another process's environment or
// command line). Throws; e.code ETIMEDOUT when it took over 10 s.
// PowerShell in the Windows directory, by its absolute path
const powershellPath = () => path.win32.join(windowsDir(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function runPowershell(script, extraEnv = {}, input = '') {
  const root = windowsDir();
  const system32 = path.win32.join(root, 'System32');
  return execFileSync(powershellPath(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {cwd: system32, env: Object.assign({SystemRoot: root, windir: root}, extraEnv), input: input, timeout: 10000, encoding: 'utf8', windowsHide: true});
}

// runPowershell without blocking: for a script whose answer comes from this
// same process (the daemon's pipe probe, when a test serves the pipe in
// process), which a synchronous child would wait on for ever. The same
// arguments, environment and 10 s bound. -> Promise of stdout; rejects on a
// non-zero exit, the bound or a failed start.
function runPowershellAsync(script, extraEnv = {}, input = '') {
  const {spawn} = require('child_process');
  const root = windowsDir();
  const system32 = path.win32.join(root, 'System32');
  return new Promise((resolve, reject) => {
    let out = '';
    let settled = false;
    const done = (err) => { if (settled) return; settled = true; clearTimeout(timer); if (err != null) reject(err); else resolve(out); };
    let child;
    try {
      child = spawn(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        {cwd: system32, env: Object.assign({SystemRoot: root, windir: root}, extraEnv), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore']});
    } catch (e) {
      return done(e);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } done(new Error('powershell did not answer within 10 s')); }, 10000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', done);
    child.on('close', (code) => done(code === 0 ? null : new Error(`powershell exited ${code}`)));
    child.stdin.on('error', () => { /* it ended first: its exit says why */ });
    child.stdin.end(input);
    return undefined;
  });
}

// Pure .NET, and no cmdlet from a module (Get-Acl, ConvertTo-Json,
// Join-Path, New-Object ...): calling one makes PowerShell look commands up,
// which without the caller's PSModuleAnalysisCachePath rebuilds its module
// analysis cache, some 20 s a call on the CI runner, and would load code
// from whatever module path it has. test/stdio/17 and test/auth/51 check
// none is named. The JSON is built by hand: a SID, a rights number and
// Allow or Deny hold no quote.
const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  '$sid = [System.Security.Principal.SecurityIdentifier]',
  '$inheritOnly = [System.Security.AccessControl.PropagationFlags]::InheritOnly'
];
// A $p's ACL as JSON: {"owner", "rules": [{sid, rights, type, inheritOnly}]}
// (inherited rules included: they are evaluated like any other).
const ACL_FN = [
  'function A($p) {',
  '  if ([System.IO.Directory]::Exists($p)) { $a = [System.IO.Directory]::GetAccessControl($p) } else { $a = [System.IO.File]::GetAccessControl($p) }',
  '  $r = @()',
  '  foreach ($x in $a.GetAccessRules($true, $true, $sid)) {',
  '    $io = (($x.PropagationFlags -band $inheritOnly) -ne 0)',
  "    $r += ('{\"sid\":\"' + $x.IdentityReference.Value + '\",\"rights\":' + [int64]$x.FileSystemRights + ',\"type\":\"' + [string]$x.AccessControlType + '\",\"inheritOnly\":' + ([string]$io).ToLower() + '}')",
  '  }',
  '  $o = $a.GetOwner($sid)',
  "  $ov = ''",
  '  if ($o -ne $null) { $ov = $o.Value }',
  // Only plain allow (A) and deny (D) ACEs are understood: any other type
  // (OA, XA, ZA, XU, the object and callback types) is not, or not wholly,
  // among GetAccessRules' rules. Seen in the SDDL, given as a flag (the SDDL
  // itself, which may quote, is not).
  "  $sddl = $a.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)",
  '  $other = $false',
  "  foreach ($t in [regex]::Matches($sddl, '\\(([A-Z]+);')) { if ($t.Groups[1].Value -ne 'A' -and $t.Groups[1].Value -ne 'D') { $other = $true } }",
  "  '{\"owner\":\"' + $ov + '\",\"otherAces\":' + ([string]$other).ToLower() + ',\"rules\":[' + ($r -join ',') + ']}'",
  '}'
];

// file -> {user: the current user's SID, owner, rules}; throws on any failure.
const FILE_ACL_SCRIPT = PRELUDE.concat(ACL_FN, [
  '$u = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  "(A $env:CH_ACL_FILE).Replace('{\"owner\"', '{\"user\":\"' + $u + '\",\"owner\"')"
]).join('\n');
function fileAcl(file) {
  // absolute: PowerShell's working directory is System32
  return JSON.parse(runPowershell(FILE_ACL_SCRIPT, {CH_ACL_FILE: path.resolve(file)}));
}

// Several paths' ACLs in one PowerShell run (each run costs 1 to 10 s on a
// CI runner): files -> [{user, owner, otherAces, rules}], in order. The paths
// go in one variable, a newline between each (DRIVE_PATH has none, nor does
// path.resolve give one). Throws on any failure. (As countinghouse's, C2.)
const FILE_ACLS_SCRIPT = PRELUDE.concat(ACL_FN, [
  '$u = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  '$out = @()',
  "foreach ($f in ($env:CH_ACL_FILES -split \"`n\")) { $out += (A $f).Replace('{\"owner\"', '{\"user\":\"' + $u + '\",\"owner\"') }",
  "'[' + ($out -join ',') + ']'"
]).join('\n');
const pathList = (files) => {
  const list = files.map((f) => path.resolve(f));
  if (list.length === 0 || list.some((f) => /[\r\n]/.test(f))) throw new Error('one or more paths, none with a line break');
  return list;
};
function fileAcls(files) {
  const list = pathList(files);
  const acls = JSON.parse(runPowershell(FILE_ACLS_SCRIPT, {CH_ACL_FILES: list.join('\n')}));
  if (!Array.isArray(acls) || acls.length !== list.length) throw new Error('fileAcls: not one ACL per path');
  return acls;
}

// ch-local's own directories on Windows (the daemon's run directory, C4c):
// each of `dirs`, in order, created if missing and given a protected DACL
// (nothing inherited): full control for the current user and SYSTEM, to the
// directory and everything made in it; then the ACLs of `read`, as
// fileAcls, in the same run. Only the DACL is written, so no privilege to
// set an owner is needed. Throws on any failure.
const PRIVATE_DIRS_SCRIPT = PRELUDE.concat(ACL_FN, [
  '$full = [System.Security.AccessControl.FileSystemRights]::FullControl',
  '$allow = [System.Security.AccessControl.AccessControlType]::Allow',
  "$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
  '$none = [System.Security.AccessControl.PropagationFlags]::None',
  '$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
  `$system = [System.Security.Principal.SecurityIdentifier]::new('${SYSTEM}')`,
  "foreach ($d in ($env:CH_ACL_DIRS -split \"`n\")) {",
  '  $a = [System.Security.AccessControl.DirectorySecurity]::new()',
  '  $a.SetAccessRuleProtection($true, $false)',
  '  $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($me, $full, $inherit, $none, $allow))',
  '  $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($system, $full, $inherit, $none, $allow))',
  '  if ([System.IO.Directory]::Exists($d)) { [System.IO.Directory]::SetAccessControl($d, $a) } else { [void][System.IO.Directory]::CreateDirectory($d, $a) }',
  '}',
  '$u = $me.Value',
  '$out = @()',
  "foreach ($f in ($env:CH_ACL_FILES -split \"`n\")) { $out += (A $f).Replace('{\"owner\"', '{\"user\":\"' + $u + '\",\"owner\"') }",
  "'[' + ($out -join ',') + ']'"
]).join('\n');
// -> the ACLs of `read`, read after `dirs` were made private
function makePrivateDirs(dirs, read) {
  const d = pathList(dirs);
  const r = pathList(read);
  const acls = JSON.parse(runPowershell(PRIVATE_DIRS_SCRIPT, {CH_ACL_DIRS: d.join('\n'), CH_ACL_FILES: r.join('\n')}));
  if (!Array.isArray(acls) || acls.length !== r.length) throw new Error('makePrivateDirs: not one ACL per path');
  return acls;
}

// Gives file a protected DACL (nothing inherited): full control for the
// current user and SYSTEM, no one else. Only the DACL is written (a fresh
// FileSecurity), so no privilege to set an owner is needed. Throws on any
// failure.
// Creates file (which must not exist) with data from stdin, its DACL set in
// the same call that creates it: protected (nothing inherited), full control
// for the current user and SYSTEM, no one else. There is no instant at which
// it exists with the directory's inherited DACL, and FileShare.None lets no
// other handle open while it is written; CreateNew fails on a name that
// exists (one planted ahead, a link). Throws.
const CREATE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$a = [System.Security.AccessControl.FileSecurity]::new()',
  '$a.SetAccessRuleProtection($true, $false)',
  '$full = [System.Security.AccessControl.FileSystemRights]::FullControl',
  '$allow = [System.Security.AccessControl.AccessControlType]::Allow',
  '$u = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
  '$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($u, $full, $allow))',
  `$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('${SYSTEM}'), $full, $allow))`,
  '$bytes = [System.Text.Encoding]::ASCII.GetBytes([Console]::In.ReadToEnd())',
  '$fs = [System.IO.FileStream]::new($env:CH_ACL_FILE, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::Write, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $a)',
  'try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush() } finally { $fs.Dispose() }'
].join('\n');
function createPrivate(file, data) {
  runPowershell(CREATE_SCRIPT, {CH_ACL_FILE: path.resolve(file)}, data);
}

// Rights a rule may grant someone other than the file's people without
// letting them read or change it: Synchronize, ReadPermissions,
// ReadAttributes.
const HARMLESS = (0x100000 | 0x20000 | 0x80) >>> 0;
// CREATOR OWNER only (never CREATOR GROUP, S-1-3-1)
const CREATORS = new Set(['S-1-3-0']);

// A secret's ACL (fileAcl) -> a problem, or null. Owned by the current user,
// Administrators or SYSTEM; no allow rule grants anyone else more than
// HARMLESS; anything unrecognised fails closed. directory: the ACL is a
// directory's, whose inherit-only allow rules are not skipped: they flow into
// the files made there, so one granting anyone else more than HARMLESS fails.
// CREATOR OWNER's inherit-only rule is admitted: it grants nothing by
// itself, only to whoever makes a child there, which no one else can under a
// private DACL, and Windows profiles carry it. CREATOR GROUP's is not: it
// becomes a grant to the creator's primary group (None, every local user;
// or Domain Users).
function privateProblem(what, acl, {directory = false} = {}) {
  if (acl == null || typeof(acl) !== 'object' || typeof(acl.owner) !== 'string' || typeof(acl.user) !== 'string') return `${what}'s ACL could not be read`;
  if (acl.otherAces !== false) return `${what} has an access rule other than a plain allow or deny, or its rules could not all be read`;
  const own = new Set([acl.user, SYSTEM, ADMINISTRATORS]);
  if (!own.has(acl.owner)) return `${what} is owned by ${acl.owner}, not this user, Administrators or SYSTEM`;
  const rules = Array.isArray(acl.rules) ? acl.rules : (acl.rules != null ? [acl.rules] : []);
  for (const r of rules) {
    if (r == null || typeof(r.sid) !== 'string' || typeof(r.type) !== 'string' || !Number.isFinite(Number(r.rights))) return `${what} has an access rule that could not be read`;
    if (r.type === 'Deny') continue;
    if (r.inheritOnly === true) {
      if (!directory || CREATORS.has(r.sid)) continue;
      if (r.type === 'Allow' && !own.has(r.sid) && ((Number(r.rights) >>> 0) & ~HARMLESS) !== 0) return `${what} has an inherit-only rule for ${r.sid}, which the files made in it would take`;
      continue;
    }
    if (r.type !== 'Allow') return `${what} has an access rule of type ${r.type}`;
    if (!own.has(r.sid) && ((Number(r.rights) >>> 0) & ~HARMLESS) !== 0) return `${what} is accessible by ${r.sid}`;
  }
  return null;
}

// The icacls commands that make file private as privateProblem wants it, by
// SID (no names: they are localized, and a user name is never printed):
// nothing inherited, this user and SYSTEM, each other SID a rule names
// removed, and the user made the owner. One per line: valid in cmd and in
// PowerShell 5.1, which has no &&.
// directory: the grants inherit to what is made in it ((OI)(CI)), or
// /inheritance:r would leave its own files reachable by no one (the
// reviewer's Fable high on #126, F13)
function fixHint(file, acl, {directory = false} = {}) {
  const user = acl != null && typeof(acl.user) === 'string' ? acl.user : null;
  if (user == null) return null;
  const rules = Array.isArray(acl.rules) ? acl.rules : (acl.rules != null ? [acl.rules] : []);
  const others = [...new Set(rules.map((r) => r && r.sid).filter((s) => typeof(s) === 'string' && s !== user && s !== SYSTEM))];
  const removes = others.map((s) => ` /remove *${s}`).join('');
  const f = directory ? '(OI)(CI)F' : 'F';
  return `icacls "${file}" /inheritance:r /grant:r *${user}:${f} *${SYSTEM}:${f}${removes}\n  icacls "${file}" /setowner *${user}`;
}

module.exports = {windowsDir, powershellPath, runPowershell, runPowershellAsync, fileAcl, fileAcls, makePrivateDirs, createPrivate, privateProblem, fixHint, PRELUDE, ACL_FN, FILE_ACL_SCRIPT, FILE_ACLS_SCRIPT, PRIVATE_DIRS_SCRIPT, CREATE_SCRIPT, SYSTEM, ADMINISTRATORS, DRIVE_PATH};
