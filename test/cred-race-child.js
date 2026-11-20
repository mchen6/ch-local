'use strict';
// One ch-local credentials change in a process of its own, for
// test/credential-lock.test.js's races (post-rel cred-race). argv[2]: JSON
// {op: 'add' | 'remove' | 'uninstall', home, user, name, value, to,
//  slowMs, ready}. slowMs pauses the change between its read and its write
// (add and remove: before the store's file is written; uninstall: before
// its first removal under the store's lock), so a second change made
// meanwhile overlaps it; ready is a file written once the pause begins.
// Exits with the command's code; its standard error is printed to its own.
const fs = require('node:fs');
const path = require('node:path');
const {fakeIo} = require('./fake-io');

const args = JSON.parse(process.argv[2]);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const pause = () => {
  if (args.ready != null) fs.writeFileSync(args.ready, String(process.pid));
  if (args.slowMs > 0) sleep(args.slowMs);
};

const io = fakeIo({env: {COUNTINGHOUSE_HOME: args.home}, homedir: args.user, answers: ['yes']});
Object.assign(io, {terminal: false, stdinIsTTY: false, pid: process.pid, hostname: 'box-1', readStdin: async() => args.value});

(async() => {
  let code;
  if (args.op === 'uninstall') {
    const rmSync = fs.rmSync;
    let paused = false;
    // (its first removal under the store's lock: the lock file is there)
    fs.rmSync = function(...a) {
      if (!paused && fs.existsSync(path.join(args.home, 'credentials.lock'))) { paused = true; pause(); }
      return rmSync.apply(this, a);
    };
    code = await require('../lib/uninstall').uninstall({keepData: args.keepData === true}, io);
  } else {
    // (lib/credential-store.js writes through the own-file module object:
    // the seam its tests stub)
    const ownFile = require('../lib/own-file');
    const write = ownFile.writeOwnFile;
    ownFile.writeOwnFile = (...a) => { pause(); return write(...a); };
    const {credentials} = require('../lib/credentials-command');
    code = await credentials({action: args.op, name: args.name, to: args.to || null, restart: false}, io);
  }
  process.stderr.write(io.err);
  process.stdout.write(io.out);
  process.exitCode = code;
})();
