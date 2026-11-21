'use strict';
// The dev server's runtime entry (ch-local dev-server; A-ownuse): the home's
// own countinghouse framework.js, run as an HTTP server, ended when the
// dev-server that started it is gone.
//
//   node dev-runtime.js <framework.js> [countinghouse options]
//
// countinghouse ends an HTTP-mode runtime only on a signal, so a dev-server
// that is SIGKILLed or crashes would leave it holding the port and the key's
// server. dev-server starts this over an IPC channel; when the channel
// closes (dev-server gone, on any platform), the runtime is sent SIGTERM, its
// own way to stop (the reviewer's high on ch-local#108, 6).
const framework = process.argv[2];
// (framework.js reads its options from process.argv: this entry's own
// argument is taken out first)
process.argv.splice(2, 1);
if (typeof process.send === 'function') {
  const gone = () => process.kill(process.pid, 'SIGTERM');
  process.once('disconnect', gone);
  if (process.connected === false) gone();
}
require(framework);
