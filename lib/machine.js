'use strict';
// This machine, for telling a run directory of this machine from another's on
// a home shared between machines (lib/gc.js): the system's machine id where
// it has one, else the host name.
const fs = require('node:fs');
const os = require('node:os');

let cached = null;
function machineId() {
  if (cached != null) return cached;
  for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const id = fs.readFileSync(file, 'utf8').trim();
      if (/^[0-9a-f]{16,64}$/i.test(id)) { cached = `id:${id}`; return cached; }
    } catch (err) { /* the next */ }
  }
  cached = `host:${os.hostname()}`;
  return cached;
}

module.exports = {machineId};
