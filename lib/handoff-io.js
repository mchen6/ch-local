'use strict';
// The re-exec handoff's two ends (C3b; #236 section 6, "Upgrade"). The table
// goes on the new daemon's fd 3, never in its argv or environment, and the
// secret is never in it (lib/daemon.js encodeHandoff).
//
// spawnDaemon(home, args, {handoff, env, node}): runs `<node>
// <home>/bin/ch-local.js <args>` with its cwd the home, in its own process
// group (detached), stdio on null, and fd 3 a pipe that carries the bytes
// and then closes. Its environment is shim.json's allowlist of `env`, as the
// shim gives a daemon. -> whether it started.
//
// readHandoff(fd = 3, {max, ms}): fd 3 read whole -> a Buffer, or null for no
// pipe, an error, more than `max` bytes, or nothing whole within `ms`.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {allowedEnv} = require('./shim-config');

const MAX = 32 * 1024 * 1024 + 4;
const READ_MS = 5000;

function spawnDaemon(home, args, {handoff, env = process.env, node = process.execPath} = {}) {
  try {
    const child = spawn(node, [path.join(home, 'bin', 'ch-local.js'), ...args], {
      cwd: home, detached: true, env: allowedEnv(env), stdio: ['ignore', 'ignore', 'ignore', 'pipe']
    });
    child.on('error', () => {});
    child.stdio[3].on('error', () => {});
    child.stdio[3].end(handoff);
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

function readHandoff(fd = 3, {max = MAX, ms = READ_MS} = {}) {
  return new Promise((resolve) => {
    let done = false;
    const chunks = [];
    let size = 0;
    let stream = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (stream != null) stream.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), ms);
    try {
      fs.fstatSync(fd);
      stream = fs.createReadStream(null, {fd, autoClose: true});
    } catch (e) {
      return finish(null);
    }
    stream.on('data', (d) => {
      size += d.length;
      if (size > max) return finish(null);
      chunks.push(d);
      return undefined;
    });
    stream.on('end', () => finish(Buffer.concat(chunks)));
    stream.on('error', () => finish(null));
    return undefined;
  });
}

module.exports = {spawnDaemon, readHandoff, MAX};
