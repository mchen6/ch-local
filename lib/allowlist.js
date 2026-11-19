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
// allowedOrigins: the origins this release knows (spec §1), written by
// hand, never from a pack. Since L5a a credential is bound at add to the
// origin its module declares, and the runtime attaches it only there (#413
// section 6; lib/module-credentials.js); this list is read by
// CH_LOCAL_REMOTE_MAP (start: only an origin listed here may be mapped) and
// by a release's checks. L5b's pins v2 brings the description check.
const parsed = require('./release-pins').parseReleasePins(require('./release-pins.json'));
if (parsed.problem != null) throw new Error(`ch-local's own ${parsed.problem}`);
const data = parsed.pins;

const ALLOWLIST = Object.freeze({
  // this release: its version (the package's), and whether it is a security
  // fix ({fixes: what it fixed}); rollback asks before undoing one
  release: Object.freeze({version: require('../package.json').version, security: data.release.security}),
  // ch-local's own identity: from npm, its pin is the digest its provenance
  // verifies against this (a release can't pin its own digest)
  self: data.self,
  runtime: data.runtime,
  packs: data.packs,
  pins: data.pins
});
const ALLOWED_ORIGINS = data.allowedOrigins;

module.exports = {ALLOWLIST, ALLOWED_ORIGINS};
