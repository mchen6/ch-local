'use strict';
// ch-local conditions --for <client pid> --home <absolute home>
// (countinghouse's shared-runtime design, #236, section 5): the client's own
// inputs, for the native shim, which runs this once per connection and
// before each form, and carries the line as its `client` frame. It runs with
// the client's environment (less NODE_* and npm_config_*) in the client's
// working directory. It prints one JSON line and exits 0:
//
//   {"status": "ok", "conditions": "yes" | "no", "repo": "owner/name" | null,
//    "token": <base64 HMAC-SHA256(secret, "ch-token" || token)> | null}
//
// - conditions: the existing scan of the client (lib/client-conditions.js),
//   the process <pid> and its ancestors, its configuration and its project;
// - repo: cwd's GitHub origin (start's own reading);
// - token: the keyed hash of the token this environment CHOOSES, by start's
//   precedence. COUNTINGHOUSE_GITHUB_TOKEN; else, when GITHUB_TOKEN is set,
//   gh decides: a gh login means none is chosen (null: the daemon's), and no
//   login means GITHUB_TOKEN. gh is asked only then, at most GH_MS. null:
//   none chosen. The token itself is never printed.
//
// Anything that keeps the answer from being known (a bad argument, a gh
// that times out or can't run, a secret that can't be read when a token is
// chosen) exits non-zero with no line: the shim counts it as failed, never as
// "none chosen".
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {clientConditions, readClientContext, clientLines, CLAUDE_CODE} = require('./client-conditions');
const {repoFromRemote, readOrigin} = require('./start');
const {GH_ENV_TOKENS} = require('./github-token');

const GH_MS = 5000;
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

// the token this environment chooses -> a string or null
async function chosenToken(io, home) {
  const set = (v) => typeof v === 'string' && v !== '';
  if (set(io.env.COUNTINGHOUSE_GITHUB_TOKEN)) return io.env.COUNTINGHOUSE_GITHUB_TOKEN;
  if (!set(io.env.GITHUB_TOKEN)) return null;
  return (await ghLogin(io, home)) === 'login' ? null : io.env.GITHUB_TOKEN;
}

// {pid, home} -> exit code
async function conditions({pid, home}, io) {
  try {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) throw new Unknown('--for needs a process id');
    const token = await chosenToken(io, home);
    const mac = token == null ? null
      : crypto.createHmac('sha256', readSecret(home, io.platform)).update(Buffer.concat([Buffer.from('ch-token'), Buffer.from(token, 'utf8')])).digest('base64');
    const context = await (io.clientAncestry !== undefined ? io.clientAncestry : readClientContext(n, 8, io.platform, io.env));
    const lines = Array.isArray(context) ? context : clientLines(context != null ? context.lines : null);
    const policyPresent = context != null && !Array.isArray(context) && context.policyPresent === true;
    const verdict = clientConditions({client: {name: CLAUDE_CODE, version: '0.0.0'}, home: typeof io.homedir === 'function' ? io.homedir() : io.homedir,
      cwd: io.cwd, env: io.env, platform: io.platform, managedPresent: policyPresent, parentCommandLines: () => lines});
    const repo = repoFromRemote(readOrigin(io.cwd));
    io.stdout.write(`${JSON.stringify({status: 'ok', conditions: verdict.mayElicit === true ? 'yes' : 'no', repo, token: mac})}\n`);
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

module.exports = {conditions, GH_MS};
