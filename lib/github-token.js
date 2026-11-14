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
async function ghToken(io) {
  const env = {...io.env};
  for (const v of GH_ENV_TOKENS) delete env[v];
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), GH_TIMEOUT_MS + 1000); });
  let r;
  try {
    r = await Promise.race([io.exec('gh', ['auth', 'token', '--hostname', 'github.com'], {env, timeout: GH_TIMEOUT_MS}), late]);
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

module.exports = {ghToken, GH_TIMEOUT_MS, GH_ENV_TOKENS};
