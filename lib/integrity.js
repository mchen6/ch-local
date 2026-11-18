'use strict';
// A tarball's integrity as a pin records it: sha512, base64 (npm's form).
const crypto = require('node:crypto');

const integrityOf = (buf) => 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');

module.exports = {integrityOf};
