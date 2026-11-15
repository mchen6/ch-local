'use strict';
// This machine, for telling a run directory of this machine from another's on
// a home shared between machines (lib/gc.js): a hash of the system's machine
// id where it has one, the host name, and on Linux the boot id, so a cloned
// machine (the same machine-id) and a reboot (pids reused) each differ.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');

const read = (file) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch (err) { return ''; } };
let cached = null;
function machineId() {
  if (cached != null) return cached;
  const id = read('/etc/machine-id') || read('/var/lib/dbus/machine-id');
  const boot = process.platform === 'linux' ? read('/proc/sys/kernel/random/boot_id') : '';
  cached = 'm:' + crypto.createHash('sha256').update([id, os.hostname(), boot].join('\n')).digest('hex').slice(0, 24);
  return cached;
}

module.exports = {machineId};
