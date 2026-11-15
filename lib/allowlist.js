'use strict';
// What `ch-local install` and `add-pack` may put into <home>/app: the runtime
// and each pack's packages, every package pinned to one exact version and its
// tarball's sha512 integrity, and the runtime's lockfile, which pins every
// dependency's version and integrity too (npm ci checks them all). Pins and
// the lockfile are written at each release from the released tarballs; until
// the first there are none, and install says so.
//
// `countinghouse` in the runtime's list is its own tarball. The usage
// report is the runtime's built-in countinghouse_usage_report tool, so no pack
// installs a report package.
// All of it is data, in lib/release-pins.json (docs/development/
// auto-upgrade.md, "The trust chain", step 5), checked by lib/release-pins.js
// as a new release's is: what this release pins, never code. A file that
// fails its check stops ch-local here, before anything is installed.
//
// The runtime (this launcher and countinghouse) is installed by npm ci from
// its pinned lockfile. A pack's packages (its scenario first, then each part
// it calls) have no npm dependencies (#43) and are unpacked from their
// tarballs beside it, so packs can be added and removed in one home.
//
// allowedOrigins: where a credential may go, and which ones (spec §1,
// consent): written by hand, never from a pack. `start` writes the
// runtime's --remoteCredentials file from the loaded packs' own declared
// remotes, and refuses to start if any declares an origin not listed here or
// a variable its origin is not pinned to receive. A release checks the same.
const parsed = require('./release-pins').parseReleasePins(require('./release-pins.json'));
if (parsed.problem != null) throw new Error(`ch-local's own ${parsed.problem}`);
const data = parsed.pins;

const ALLOWLIST = Object.freeze({
  // this release: its version (the package's), and whether it is a security
  // fix ({fixes: what it fixed}); rollback asks before undoing one
  release: Object.freeze({version: require('../package.json').version, security: data.release.security}),
  runtime: data.runtime,
  packs: data.packs,
  pins: data.pins
});
const ALLOWED_ORIGINS = data.allowedOrigins;

module.exports = {ALLOWLIST, ALLOWED_ORIGINS};
