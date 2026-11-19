'use strict';
// A node:test reporter beside the spec one (scripts/test.js): it prints
// nothing, and keeps the names of the tests running now, by nesting, where
// test/tmp-dirs.js's SIGUSR2 handler reads them, so a file the runner ends
// past its time names the test it hung in (the Reviewer's second high
// review of #97, 8).
const KEY = Symbol.for('ch-local.test.running');
module.exports = async function* running(source) {
  const now = new Map();   // nesting + name -> name (siblings run at once: each its own)
  global[KEY] = now;
  for await (const event of source) {
    const d = event.data || {};
    // (test:dequeue: as a test begins; a file run as `node file` reports
    // test:start only when the test is done)
    const key = `${d.nesting}\0${d.name}`;
    if (event.type === 'test:dequeue') now.set(key, d.name);
    else if (event.type === 'test:pass' || event.type === 'test:fail') now.delete(key);
  }
};
