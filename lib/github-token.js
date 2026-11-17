'use strict';
// The GitHub token a start gives its runtime (Matt, 2026-11-13): asked of the
// GitHub CLI (`gh auth token`) at start, held in memory, and handed to the
// runtime in its environment only, never written to a file, a client's
// config or a line of output. gh's own output is never repeated: on a failure
// it could carry anything.
//
// gh answers GH_TOKEN, GITHUB_TOKEN and the enterprise variables from its
// environment before its own login, so it runs without them: what it gives is
// its login's token, never a plaintext value passed off as gh's. A gh that
// does not answer within GH_TIMEOUT_MS is killed.
const GH_TIMEOUT_MS = 10000;
const GH_ENV_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
// A token as gh prints one: letters, digits and underscores.
const TOKEN = /^[A-Za-z0-9_]{8,255}$/;

// io -> {token} or {why}: why gh gave none, in words for the user.
// home: gh runs there, never in the client's directory (on Windows the
// search for a program looks in the current directory first)
async function ghToken(io, home) {
  const env = {...io.env};
  for (const v of GH_ENV_TOKENS) delete env[v];
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), GH_TIMEOUT_MS + 1000); });
  let r;
  try {
    r = await Promise.race([io.exec('gh', ['auth', 'token', '--hostname', 'github.com'], {env, timeout: GH_TIMEOUT_MS, ...(home != null ? {cwd: home} : {})}), late]);
  } catch (err) {
    r = {status: null};
  } finally {
    clearTimeout(timer);
  }
  if (r === 'timeout') return {why: `gh did not answer within ${GH_TIMEOUT_MS / 1000} s`};
  if (r == null || r.status === null) {
    return {why: 'gh, the GitHub CLI, was not found or did not answer (a client started from the dock or the Start menu may not see the PATH your shell sets)'};
  }
  const token = String(r.stdout || '').trim();
  if (r.status !== 0 || !TOKEN.test(token)) return {why: 'gh is not logged in to github.com'};
  return {token};
}

// The one order a GitHub token is chosen in (the shared runtime's daemon,
// start, and the conditions check alike):
//   1. COUNTINGHOUSE_GITHUB_TOKEN set in the client's environment;
//   2. else the token stored with `ch-local credentials add github`
//      (lib/credential-store.js);
//   3. else `gh auth token`;
//   4. else GITHUB_TOKEN from the client's environment.
// shared: the daemon's runtime, whose environment no client reaches: only
// 2 and 3. A stored token whose file or directory fails its checks is never
// used: its problem is said, and the choice goes on.
// -> {token, source: 'environment' | 'stored' | 'gh' | 'GITHUB_TOKEN' | null,
//     variable?, why?, storeProblem?}
async function chooseGitHubToken(io, home, {shared = false, env = io.env, platform = io.platform || process.platform} = {}) {
  const {pickCredential} = require('./credential');
  const STORED = 'COUNTINGHOUSE_GITHUB_TOKEN';
  if (!shared) {
    const explicit = pickCredential(env, [STORED]);
    if (explicit != null) return {token: explicit.value, source: 'environment', variable: explicit.name};
  }
  let storeProblem = null;
  try {
    const stored = require('./credential-store').get(home, STORED, {platform});
    if (stored != null) return {token: stored, source: 'stored'};
  } catch (e) {
    storeProblem = e.message;
  }
  const gh = await ghToken(Object.assign(Object.create(io), {env}), home);
  if (gh.token != null) return {token: gh.token, source: 'gh', ...(storeProblem != null ? {storeProblem} : {})};
  if (!shared) {
    const plain = pickCredential(env, ['GITHUB_TOKEN']);
    if (plain != null) return {token: plain.value, source: 'GITHUB_TOKEN', variable: plain.name, why: gh.why, ...(storeProblem != null ? {storeProblem} : {})};
  }
  return {token: null, source: null, why: gh.why, ...(storeProblem != null ? {storeProblem} : {})};
}

module.exports = {ghToken, chooseGitHubToken, GH_TIMEOUT_MS, GH_ENV_TOKENS};
