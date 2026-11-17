'use strict';
// ch-local conditions --for <client pid> --home <absolute home>
// (countinghouse's shared-runtime design, #236, section 5): the client's own
// inputs, for the native shim, which runs this once per connection and
// before each form, and carries the line as its `client` frame. It runs with
// the client's environment (less NODE_* and npm_config_*) in the client's
// working directory. It prints one JSON line and exits 0:
//
//   {"status": "ok", "conditions": "yes" | "no", "repo": "owner/name" | null,
//    "token": <base64 HMAC-SHA256(secret, "ch-token" || token)> | null,
//    "credentials"?: {<NAME>: <base64 HMAC-SHA256(secret, "ch-cred" || NAME
//                     || 0x00 || value)>}}
//
// - conditions: the existing scan of the client (lib/client-conditions.js),
//   the process <pid> and its ancestors, its configuration and its project;
// - repo: cwd's GitHub origin (start's own reading);
// - token: the keyed hash of the token this environment CHOOSES, by start's
//   precedence. COUNTINGHOUSE_GITHUB_TOKEN; else the token stored with
//   `ch-local credentials add github`; else, when GITHUB_TOKEN is set, gh
//   decides: a gh login means none is chosen (null: the daemon's), and no
//   login means GITHUB_TOKEN. gh is asked only then, at most GH_MS. null:
//   none chosen. The token itself is never printed.
// - credentials: the same for each other pack credential this environment
//   chooses, named only by the installed packs (packs.json); absent when none
//   is. A session that chooses one the shared runtime lacks runs its own.
// - why, when conditions is "no": {reason, at?}, the scan's closed reason and
//   where it saw it, under the home only ("~/..."), for the runtime's latch.
//
// Anything that keeps the answer from being known (a bad argument, a gh
// that times out or can't run, a secret that can't be read when a token is
// chosen) exits non-zero with no line: the shim counts it as failed, never as
// "none chosen".
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {clientConditions, readClientContext, clientLines, CLAUDE_CODE, REASONS} = require('./client-conditions');
const {cleanText} = require('./clean-text');
const {repoFromRemote, readOrigin} = require('./start');
const {GH_ENV_TOKENS} = require('./github-token');

const GH_MS = 5000;
// the most pack credentials one line names (the runtime refuses more)
const MAX_CREDENTIALS = 32;
// the most the shim reads of the line (shim/src/child.rs)
const MAX_LINE_BYTES = 4096;
// a credential's name, as the runtime's listener takes it
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_FORM = /^[0-9a-f]{64}\n?$/;
const TOKEN = /^[A-Za-z0-9_]{8,255}$/;

class Unknown extends Error {}

// the runtime's secret, read exactly as the shim reads it
// (lib/private-file.js): a private file in a private directory, 64 lowercase
// hex characters
function readSecret(home, platform) {
  let bytes;
  try {
    bytes = require('./private-file').readPrivateIn(path.join(home, 'run', 'daemon'), 'secret', 80, platform);
  } catch (e) {
    throw new Unknown(`the runtime's secret could not be read (${e.code === 'NOT_PRIVATE' ? e.message : (e.code || e.message)})`);
  }
  const text = bytes.toString('utf8');
  if (!SECRET_FORM.test(text)) throw new Unknown('the runtime\'s secret is not in its form');
  return Buffer.from(text.slice(0, 64), 'hex');
}

// gh's answer, at most GH_MS: 'login' | 'none'; throws Unknown on a timeout
// or a gh that can't run
// gh runs in the home, never the client's directory: on Windows the search
// for a program looks in the current directory first, and a client's
// directory is often a cloned repository
async function ghLogin(io, home) {
  const env = {...io.env};
  for (const v of GH_ENV_TOKENS) delete env[v];
  const ms = Number.isInteger(io.ghTimeoutMs) ? io.ghTimeoutMs : GH_MS;
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms + 500); });
  let r;
  try {
    r = await Promise.race([io.exec('gh', ['auth', 'token', '--hostname', 'github.com'], {env, timeout: ms, cwd: home}), late]);
  } finally {
    clearTimeout(timer);
  }
  if (r === 'timeout') throw new Unknown(`gh did not answer within ${ms / 1000} s`);
  if (r == null || r.status === null) throw new Unknown('gh could not be run');
  return (r.status === 0 && TOKEN.test(String(r.stdout || '').trim())) ? 'login' : 'none';
}

// the token this environment chooses -> a string or null (the daemon's),
// by start's one order (lib/github-token.js chooseGitHubToken): the
// client's COUNTINGHOUSE_GITHUB_TOKEN; else the stored one (its hash is
// sent, so a daemon not yet restarted on it runs this session on its own
// runtime rather than share another token); else gh's login, which the
// daemon has too (null); else GITHUB_TOKEN. A stored token whose file fails
// its checks is passed over, as the daemon passes it over.
async function chosenToken(io, home) {
  // a value as start takes it (lib/credential.js): an empty or blank one, or
  // an unresolved ${...} placeholder, is not set
  const {pickCredential} = require('./credential');
  const explicit = pickCredential(io.env, ['COUNTINGHOUSE_GITHUB_TOKEN']);
  if (explicit != null) return explicit.value;
  let stored = null;
  try { stored = require('./credential-store').get(home, 'COUNTINGHOUSE_GITHUB_TOKEN', {platform: io.platform}); } catch (e) { stored = null; }
  if (stored != null) return stored;
  const plain = pickCredential(io.env, ['GITHUB_TOKEN']);
  if (plain == null) return null;
  return (await ghLogin(io, home)) === 'login' ? null : plain.value;
}

// The pack credentials this environment chooses, by the names the installed
// packs declare (packs.json) and start's precedence (lib/credential.js), never
// by any name the environment itself offers. A pack whose choice is a GitHub
// variable is `token`'s, as start would load it. A name the runtime would
// refuse (its pattern) fails the check rather than send it. Values are never
// printed. -> {NAME: base64 mac}, {} when none is chosen.
function chosenCredentials(io, home, secret) {
  const {layout} = require('./home');
  const {installedPacks} = require('./packs');
  const {pickCredential} = require('./credential');
  const {ALLOWED_ORIGINS} = require('./allowlist');
  const github = new Set(ALLOWED_ORIGINS['https://api.githubcopilot.com'] || []);
  let packs;
  try {
    packs = installedPacks(layout({COUNTINGHOUSE_HOME: home}));
  } catch (e) {
    throw new Unknown('the installed packs could not be read');
  }
  const chosen = new Map();
  for (const p of packs) {
    const pick = pickCredential(io.env, p.credentials.filter((v) => typeof v === 'string'));
    if (pick == null || github.has(pick.name)) continue;
    if (!VARIABLE.test(pick.name)) throw new Unknown('an installed pack names a credential that is not a variable name');
    chosen.set(pick.name, pick.value);
  }
  if (chosen.size > MAX_CREDENTIALS) throw new Unknown(`the installed packs name more than ${MAX_CREDENTIALS} credentials`);
  const out = {};
  for (const [name, value] of [...chosen].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out[name] = crypto.createHmac('sha256', secret()).update(Buffer.concat([Buffer.from('ch-cred'), Buffer.from(name, 'utf8'), Buffer.from([0]), Buffer.from(value, 'utf8')])).digest('base64');
  }
  return out;
}

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
  if (home.slice(path.parse(home).root.length).split(path.sep).filter(Boolean).length < 2) return out;
  const rel = path.relative(home, real(verdict.at));
  const parts = rel.split(path.sep);
  if (rel === '' || path.isAbsolute(rel) || parts.includes('..')) return out;
  out.at = cleanText(`~/${parts.join('/')}`, 200);
  return out;
}

// {pid, home} -> exit code
async function conditions({pid, home}, io) {
  try {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) throw new Unknown('--for needs a process id');
    const token = await chosenToken(io, home);
    // the secret, read once and only when something is to be hashed
    let secretBytes = null;
    const secret = () => { if (secretBytes == null) secretBytes = readSecret(home, io.platform); return secretBytes; };
    const mac = token == null ? null
      : crypto.createHmac('sha256', secret()).update(Buffer.concat([Buffer.from('ch-token'), Buffer.from(token, 'utf8')])).digest('base64');
    const credentials = chosenCredentials(io, home, secret);
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
    const lineWith = (w) => JSON.stringify({status: 'ok', conditions: verdict.mayElicit === true ? 'yes' : 'no', repo, token: mac,
      ...(Object.keys(credentials).length > 0 ? {credentials} : {}), ...(w != null ? {why: w} : {})});
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

module.exports = {conditions, whyOf, GH_MS, MAX_CREDENTIALS, MAX_LINE_BYTES};
