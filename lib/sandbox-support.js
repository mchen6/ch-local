'use strict';
// Whether the installed countinghouse runs --moduleSandbox enforce on this
// platform. Everywhere but Windows, always. On Windows, from countinghouse#195
// (#197: a module's files on a virtual drive), which brought
// lib/fs-broker/virtual-drive.js: a runtime without it refuses enforce there,
// so start runs audit, says so, and refuses an explicit enforce (ch-local
// #17), until `ch-local upgrade` installs one that can. Read from the files
// the runtime installed (what it has), not from a version number.
const fs = require('node:fs');
const path = require('node:path');

function enforceAvailable(where, platform = process.platform) {
  if (platform !== 'win32') return true;
  return fs.existsSync(path.join(where.app, 'node_modules', 'countinghouse', 'lib', 'fs-broker', 'virtual-drive.js'));
}

module.exports = {enforceAvailable};
