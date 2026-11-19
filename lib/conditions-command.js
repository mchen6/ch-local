'use strict';
// ch-local conditions --for <client pid> --home <absolute home>
// (countinghouse's shared-runtime design, #236, section 5): the client's own
// inputs, for the native shim, which runs this once per connection and
// before each form, and carries the line as its `client` frame. It runs with
// the client's environment (less NODE_* and npm_config_*) in the client's
// working directory. It prints one JSON line and exits 0:
//
//   {"status": "ok", "conditions": "yes" | "no", "repo": "owner/name" | null,
//    "token": null}
//
// - conditions: the existing scan of the client (lib/client-conditions.js),
//   the process <pid> and its ancestors, its configuration and its project;
// - repo: cwd's GitHub origin (start's own reading);
// - token: always null, and no `credentials`: a credential is a module's
//   own, in the store, and a client's environment never gives one (#413
//   section 6.9; L5a), so no session chooses one the shared runtime lacks.
//   The field stays for the shim, which reads null as the daemon's.
// - why, when conditions is "no": {reason, at?}, the scan's closed reason and
//   where it saw it, under the home only ("~/..."), for the runtime's latch.
//
// Anything that keeps the answer from being known (a bad argument) exits
// non-zero with no line: the shim counts it as failed.
const fs = require('node:fs');
const path = require('node:path');
const {clientConditions, readClientContext, clientLines, CLAUDE_CODE, REASONS} = require('./client-conditions');
const {cleanText} = require('./clean-text');
const {repoFromRemote, readOrigin} = require('./start');

// the most the shim reads of the line (shim/src/child.rs)
const MAX_LINE_BYTES = 4096;

class Unknown extends Error {}

// Why the client was judged able to answer forms by itself, or not
// interactive (the runtime's latch says so in its refusal, B2): the reason,
// one of client-conditions.js's closed REASONS, and where it was seen as a
// path under the user's home directory, "~/..." (cut and cleaned). A path
// outside the home is never sent: it may carry another name, and this text
// reaches the agent. -> {reason, at?} or null.
//
// Both are compared by real path (a home through a link, as cwd and the
// project usually are, keeps its project hits' place). A home that is a
// filesystem root or one level below it (HOME=/ or /home: a service, a
// container) is no boundary: every path would read as under it, others'
// homes too, so no place is sent.
// a path by its real path: its deepest part that exists resolved (a link,
// macOS's /var, a Windows short name), the rest re-appended
const real = (p) => {
  let at = path.resolve(p);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(at), ...rest); } catch (e) { /* not there: one up */ }
    const up = path.dirname(at);
    if (up === at) return path.resolve(p);
    rest.unshift(path.basename(at));
    at = up;
  }
};
function whyOf(verdict, homeDir) {
  if (verdict == null || !REASONS.includes(verdict.why)) return null;
  const out = {reason: verdict.why};
  if (typeof verdict.at !== 'string' || typeof homeDir !== 'string' || !path.isAbsolute(verdict.at) || !path.isAbsolute(homeDir)) return out;
  const home = real(homeDir);
  // a home at most one level below a root is no boundary (/home holds every
  // user's): judged on the path as given AND on its real path, since a link
  // can deepen it (macOS's /home is /System/Volumes/Data/home)
  const depth = (p) => p.slice(path.parse(p).root.length).split(path.sep).filter(Boolean).length;
  if (depth(path.resolve(homeDir)) < 2 || depth(home) < 2) return out;
  const rel = path.relative(home, real(verdict.at));
  const parts = rel.split(path.sep);
  // no "..", no empty segment, and no backslash in a name (a separator on
  // Windows, where the runtime reads this): the runtime refuses each, as
  // the shared vectors do (conditionsWhy)
  if (rel === '' || path.isAbsolute(rel) || parts.some((p) => p === '' || p === '..' || p.includes('\\'))) return out;
  out.at = cleanText(`~/${parts.join('/')}`, 200);
  return out;
}

// {pid, home} -> exit code
async function conditions({pid, home}, io) {
  try {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) throw new Unknown('--for needs a process id');
    const context = await (io.clientAncestry !== undefined ? io.clientAncestry : readClientContext(n, 8, io.platform, io.env));
    const lines = Array.isArray(context) ? context : clientLines(context != null ? context.lines : null);
    const policyPresent = context != null && !Array.isArray(context) && context.policyPresent === true;
    // the home, read once: the scan's and the why's
    const homeDir = typeof io.homedir === 'function' ? io.homedir() : io.homedir;
    const verdict = clientConditions({client: {name: CLAUDE_CODE, version: '0.0.0'}, home: homeDir,
      cwd: io.cwd, env: io.env, platform: io.platform, managedPresent: policyPresent, parentCommandLines: () => lines, withAt: true,
      // tests only: their world's root bounds the walk up (never set in use)
      ...(io.conditionsStopAt != null ? {stopAt: io.conditionsStopAt} : {})});
    const repo = repoFromRemote(readOrigin(io.cwd));
    const why = verdict.mayElicit === true ? null : whyOf(verdict, homeDir);
    const lineWith = (w) => JSON.stringify({status: 'ok', conditions: verdict.mayElicit === true ? 'yes' : 'no', repo, token: null,
      ...(w != null ? {why: w} : {})});
    const fits = (l) => Buffer.byteLength(l, 'utf8') + 1 <= MAX_LINE_BYTES;
    // the why is an extra: a line too long with it goes without it, and only
    // a line too long without it fails (the shim takes at most this much)
    let line = lineWith(why);
    if (!fits(line)) line = lineWith(null);
    if (!fits(line)) throw new Unknown(`the line would be over ${MAX_LINE_BYTES} bytes`);
    io.stdout.write(`${line}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Unknown) {
      io.stderr.write(`ch-local conditions: ${e.message}\n`);
      return 1;
    }
    io.stderr.write('ch-local conditions: the client checks could not run\n');
    return 1;
  }
}

module.exports = {conditions, whyOf, MAX_LINE_BYTES};
