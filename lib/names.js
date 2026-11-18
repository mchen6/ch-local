'use strict';
// Names and versions as a release writes them. They become directory names
// (the pack trees, the module store), so nothing else passes: one copy, read
// by both records (lib/record.js, lib/module-record.js) and the store.
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,64})?$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
// a package's scope directory: PACKAGE's part before the slash
const SCOPE = /^@[a-z0-9][a-z0-9._-]{0,63}$/;
const PACK = /^[a-z0-9][a-z0-9-]{0,63}$/;

// A module version the store holds as a directory, beside its marker
// (<version>.json) and its staging and trash names (<version>.new-*,
// .trash-*). Refused (each could share another version's path):
// - one that ends in .json or holds .new- or .trash- (the medium review of
//   L1a-1, 4);
// - one with an upper-case letter: on a case-insensitive file system
//   (Windows, macOS by default) 1.0.0-RC.1 and 1.0.0-rc.1 share a directory
//   (#82's high review, 3);
// - one that ends in a dot, or holds an empty identifier (..): Windows drops
//   a trailing dot, so 1.0.0-a. is 1.0.0-a's directory (#82's medium, 4).
const storeVersion = (v) => typeof v === 'string' && VERSION.test(v) && !/[A-Z]/.test(v) && !/\.json$/.test(v) &&
  !/\.(?:new|trash)-/.test(v) && !/\.$/.test(v) && !/[.+-]{2}/.test(v.replace(/^\d+\.\d+\.\d+/, ''));

module.exports = {VERSION, PACKAGE, SCOPE, PACK, storeVersion};
