'use strict';
// How long ch-local's PowerShell calls take on this machine, cold and warm
// (the reviewer's register row, 2026-11-17: on GitHub's Windows runners the
// client-ancestry read has passed conditionsService's 3 s wait, and a
// win-acl check its 10 s timeout). A measurement, never a check: it prints
// one JSON line and exits 0 whatever it saw.
//
//   node tools/measure/powershell.js [--rounds N]
//
// Each round runs in a fresh node process (a first call there is "cold" as
// a user's first start is: no PowerShell of this process has run yet), then
// the same calls twice more in that process ("warm"). Three calls:
//   start     a bare PowerShell that does nothing: the start-up alone
//   ancestry  client-conditions' readClientContext for this process (one
//             Win32_Process query per ancestor; conditionsService waits 3 s)
//   acl       win-acl's fileAcl of a directory (its timeout: 10 s)
const {spawnSync} = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

async function one() {
  const winAcl = require(path.join(ROOT, 'lib', 'win-acl'));
  const {readClientContext} = require(path.join(ROOT, 'lib', 'client-conditions'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-measure-'));
  const time = async (fn) => {
    const t = process.hrtime.bigint();
    let ok = true;
    try { await fn(); } catch (e) { ok = false; }
    return {ms: Number(process.hrtime.bigint() - t) / 1e6, ok};
  };
  const out = {};
  for (const pass of ['cold', 'warm1', 'warm2']) {
    out[pass] = {
      start: await time(() => winAcl.runPowershellAsync('exit 0')),
      ancestry: await time(() => readClientContext(process.pid, 8)),
      acl: await time(() => winAcl.fileAcl(dir))
    };
  }
  fs.rmSync(dir, {recursive: true, force: true});
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  if (process.argv.includes('--one')) return one();
  if (process.platform !== 'win32') {
    process.stdout.write(`${JSON.stringify({skipped: 'not Windows'})}\n`);
    return undefined;
  }
  const at = process.argv.indexOf('--rounds');
  const rounds = at > 0 ? Math.max(1, Math.min(20, Number(process.argv[at + 1]) || 5)) : 5;
  const runs = [];
  for (let i = 0; i < rounds; i++) {
    const r = spawnSync(process.execPath, [__filename, '--one'], {encoding: 'utf8', timeout: 120000});
    try { runs.push(JSON.parse(r.stdout.trim().split('\n').pop())); } catch (e) { runs.push({error: String(r.stderr || r.error).slice(0, 200)}); }
  }
  const stat = (pass, call) => {
    const ms = runs.filter((r) => r[pass] != null).map((r) => r[pass][call].ms).sort((a, b) => a - b);
    if (ms.length === 0) return null;
    return {min: Math.round(ms[0]), median: Math.round(ms[Math.floor(ms.length / 2)]), max: Math.round(ms[ms.length - 1]), failed: runs.filter((r) => r[pass] != null && !r[pass][call].ok).length};
  };
  const summary = {rounds, node: process.version};
  for (const pass of ['cold', 'warm1', 'warm2']) summary[pass] = {start: stat(pass, 'start'), ancestry: stat(pass, 'ancestry'), acl: stat(pass, 'acl')};
  summary.bounds = {ancestryWaitMs: 3000, aclTimeoutMs: 10000};
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return undefined;
}

Promise.resolve(main()).catch((e) => { process.stdout.write(`${JSON.stringify({error: String(e && e.message).slice(0, 200)})}\n`); });
