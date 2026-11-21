'use strict';
// The dev server's runtime entry (ch-local dev-server; A-ownuse): the home's
// own countinghouse framework.js, run as an HTTP server, ended when the
// dev-server that started it is gone, and saying when it listens.
//
//   node dev-runtime.js <framework.js> [countinghouse options]
//
// - countinghouse ends an HTTP-mode runtime only on a signal, so a dev-server
//   that is SIGKILLed or crashes would leave it holding the port and the
//   key's server. dev-server starts this over an IPC channel; when the
//   channel closes (dev-server gone, on any platform), the runtime exits
//   (the reviewer's high on ch-local#108, 6).
// - Its own server's 'listening' on the --port asked is sent to dev-server
//   ({type: 'dev-runtime-listening', port}), so dev-server knows it is this
//   runtime that holds the port, never another process that took it
//   meanwhile (the medium on round 1, 1).
const net = require('node:net');

const framework = process.argv[2];
// (framework.js reads its options from process.argv: this entry's own
// argument is taken out first)
process.argv.splice(2, 1);
const at = process.argv.indexOf('--port');
const port = at > 0 ? Number(process.argv[at + 1]) : null;

if (typeof process.send === 'function') {
  const gone = () => process.exit(0);
  process.once('disconnect', gone);
  if (process.connected === false) gone();
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function(...args) {
    this.once('listening', () => {
      const a = this.address();
      if (a != null && typeof a === 'object' && a.port === port && process.connected) {
        try { process.send({type: 'dev-runtime-listening', port}); } catch (e) { /* dev-server gone */ }
      }
    });
    return listen.apply(this, args);
  };
}
require(framework);
