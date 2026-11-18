'use strict';
// A directory removed so that half of it is never seen under its name: it is
// renamed aside (<name>.trash-<random>) whole, then deleted. One already
// aside is deleted where it is. Used by collection (lib/gc.js) and the module
// store (lib/module-store.js). Throws as fs does.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function removeAside(at) {
  const aside = path.basename(at).includes('.trash-') ? at : `${at}.trash-${crypto.randomBytes(4).toString('hex')}`;
  if (aside !== at) fs.renameSync(at, aside);
  fs.rmSync(aside, {recursive: true, force: true});
}

module.exports = {removeAside};
