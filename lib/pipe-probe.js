'use strict';
// Whether a named pipe read from daemon.json is this user's shared runtime
// (C4c; the review of ch-local #39, F1). daemon.json can be stale (a crashed
// daemon's, its pid reused; a restart that never listened), pipe names can
// be listed, so a freed name can be taken, and Node's own connect opens a
// pipe allowing impersonation, checking no owner. So on Windows this probe
// runs in PowerShell, as the native shim opens a pipe (shim/src/win_ffi.rs
// Pipe::open):
// - connected at TokenImpersonationLevel.Identification
//   (SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION), so the server can
//   learn who connects but never act as them;
// - the pipe's owner, read on the open handle, must be this user, SYSTEM
//   (S-1-5-18) or Administrators (S-1-5-32-544), or nothing is sent;
// - then contract 2's HELLO, and the PROVE checked under the secret, on
//   that same connection (the HMAC has no channel binding, so the owner
//   check is what stops a relay). AUTH is never sent.
// The secret reaches PowerShell on its stdin, never in argv or env. Pure
// .NET, no cmdlet, as lib/win-acl.js's scripts. It runs only when a daemon
// starts and finds a daemon.json, so PowerShell's start-up cost is paid
// once. Anything unexpected is a no.
const winAcl = require('./win-acl');
const {isPipeName} = require('./session-socket');

const PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$sidType = [System.Security.Principal.SecurityIdentifier]',
  '$hex = [Console]::In.ReadToEnd().Trim()',
  "if ($hex.Length -ne 64) { 'no secret'; return }",
  '$secret = [byte[]]::new(32)',
  'for ($i = 0; $i -lt 32; $i++) { $secret[$i] = [System.Convert]::ToByte($hex.Substring($i * 2, 2), 16) }',
  '$c = [System.IO.Pipes.NamedPipeClientStream]::new(\'.\', $env:CH_PIPE, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::Identification)',
  // a name no alias shadows (PowerShell resolves an alias before a
  // function, and its names ignore case: `r` is Invoke-History's)
  'function ReadPipeExact($n) { $b = [byte[]]::new($n); $o = 0; while ($o -lt $n) { $k = $c.Read($b, $o, $n - $o); if ($k -le 0) { throw \'closed\' }; $o += $k }; return ,$b }',
  'try {',
  '  $c.Connect([int]$env:CH_PROBE_MS)',
  '  $owner = $c.GetAccessControl().GetOwner($sidType).Value',
  '  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
  "  if ($owner -ne $me -and $owner -ne 'S-1-5-18' -and $owner -ne 'S-1-5-32-544') { 'owner ' + $owner; return }",
  '  $nc = [byte[]]::new(32)',
  '  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($nc)',
  "  $body = [System.Text.Encoding]::ASCII.GetBytes('{\"protocol\":1,\"nc\":\"' + [System.Convert]::ToBase64String($nc) + '\"}')",
  '  $head = [byte[]]::new(5)',
  '  $head[0] = 72',
  '  $head[1] = ($body.Length -shr 24) -band 255; $head[2] = ($body.Length -shr 16) -band 255; $head[3] = ($body.Length -shr 8) -band 255; $head[4] = $body.Length -band 255',
  '  $c.Write($head, 0, 5); $c.Write($body, 0, $body.Length); $c.Flush()',
  '  $h = ReadPipeExact 5',
  "  if ($h[0] -ne 80) { 'not a prove'; return }",
  '  $n = ([int]$h[1] -shl 24) -bor ([int]$h[2] -shl 16) -bor ([int]$h[3] -shl 8) -bor [int]$h[4]',
  "  if ($n -le 0 -or $n -gt 4096) { 'bad length'; return }",
  '  $text = [System.Text.Encoding]::ASCII.GetString((ReadPipeExact $n))',
  "  $mns = [regex]::Match($text, '\"ns\"\\s*:\\s*\"([A-Za-z0-9+/=]+)\"')",
  "  $mms = [regex]::Match($text, '\"ms\"\\s*:\\s*\"([A-Za-z0-9+/=]+)\"')",
  "  if (-not $mns.Success -or -not $mms.Success) { 'bad prove'; return }",
  '  $ns = [System.Convert]::FromBase64String($mns.Groups[1].Value)',
  '  $ms = [System.Convert]::FromBase64String($mms.Groups[1].Value)',
  "  if ($ns.Length -ne 32 -or $ms.Length -ne 32) { 'bad prove'; return }",
  '  $buf = [System.IO.MemoryStream]::new()',
  "  $label = [System.Text.Encoding]::ASCII.GetBytes('ch-server')",
  '  $buf.Write($label, 0, $label.Length); $buf.WriteByte(1); $buf.Write($nc, 0, 32); $buf.Write($ns, 0, 32)',
  '  $want = [System.Security.Cryptography.HMACSHA256]::new($secret).ComputeHash($buf.ToArray())',
  '  $diff = 0',
  '  for ($i = 0; $i -lt 32; $i++) { $diff = $diff -bor ($want[$i] -bxor $ms[$i]) }',
  "  if ($diff -eq 0) { 'ok' } else { 'wrong proof' }",
  '} finally { $c.Dispose() }'
].join('\n');

// socket (a pipe name), secret (32 bytes) -> Promise<boolean>. powershell:
// for the tests (script, env, stdin) -> stdout, or a Promise of it. Run
// without blocking: the pipe's server may be in this same process (a test's),
// and a synchronous child would keep it from ever answering.
async function probePipe(socket, secret, ms = 2000, {powershell = winAcl.runPowershellAsync} = {}) {
  if (!isPipeName(socket) || !Buffer.isBuffer(secret) || secret.length !== 32) return false;
  try {
    const out = await powershell(PROBE_SCRIPT, {CH_PIPE: socket.slice('\\\\.\\pipe\\'.length), CH_PROBE_MS: String(ms)}, secret.toString('hex'));
    return String(out).trim() === 'ok';
  } catch (e) {
    return false;
  }
}

module.exports = {probePipe, PROBE_SCRIPT};
