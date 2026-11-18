'use strict';
// Names and versions as a release writes them. They become directory names
// (the pack trees, the module store), so nothing else passes: one copy, read
// by both records (lib/record.js, lib/module-record.js) and the store.
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,64})?$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
// a package's scope directory: PACKAGE's part before the slash
const SCOPE = /^@[a-z0-9][a-z0-9._-]{0,63}$/;
const PACK = /^[a-z0-9][a-z0-9-]{0,63}$/;

module.exports = {VERSION, PACKAGE, SCOPE, PACK};
