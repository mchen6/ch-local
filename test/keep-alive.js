'use strict';
// Holds the event loop for one test file's run, as Node 24's test runner
// does by itself. Node 22.16's node:test ends a test whose promise is still
// pending once nothing else keeps the loop alive ("Promise resolution is
// still pending but the event loop has already resolved"), and these files
// await lib timers that are unref'd on purpose (lib/control.js's ready and
// request timers, client-conditions' and start's waits): in real use the
// runtime child and its IPC keep the loop alive, and a plain script behaves
// the same on 22.16 and 24. So the fix is here, in the tests -- never make
// lib's timers ref'd for it. Required by a file before its tests; the after
// hook clears it whether the file passed or failed.
const {after} = require('node:test');

const hold = setInterval(() => {}, 2 ** 30);
after(() => clearInterval(hold));
