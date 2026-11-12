'use strict';
// A fake io for the launcher's commands: captured output, scripted answers, a
// stubbed npm (exec) and no network (fetch throws unless a test gives one).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fakeIo({env = {}, answers = [], exec, fetch, version = 'v24.21.0', homedir} = {}) {
  const io = {
    out: '',
    err: '',
    asked: [],
    execs: [],
    fetches: [],
    env,
    node: '/usr/local/bin/node',
    version,
    platform: process.platform,
    homedir: () => homedir,
    stdout: {write: (s) => { io.out += s; }},
    stderr: {write: (s) => { io.err += s; }},
    ask: async (q) => { io.asked.push(q); return answers.length > 0 ? answers.shift() : ''; },
    exec: async (cmd, args, opts) => {
      io.execs.push({cmd, args, cwd: opts && opts.cwd});
      return exec != null ? exec(cmd, args, opts) : {status: 0, stdout: '', stderr: ''};
    },
    fetch: async (url, opts) => {
      io.fetches.push(url);
      if (fetch == null) throw new Error(`no network in tests: ${url}`);
      return fetch(url, opts);
    }
  };
  return io;
}

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

module.exports = {fakeIo, tmp};
