'use strict';
// The tag a pinned version is released under, by the workflow that builds
// it, never free text (docs/development/auto-upgrade.md): v<version> from
// publish.yml (every npm package), shim-v<version> from shim.yml (the native
// shim's six packages). The release-gating tag ruleset covers both. Any
// other workflow builds no release. Shared by lib/release-pins.js and
// lib/provenance.js, and dependency-free, so reading the pins loads no
// verifier.
const TAG_PREFIX = Object.freeze({'.github/workflows/publish.yml': 'v', '.github/workflows/shim.yml': 'shim-v'});
const tagFor = (workflow, version) => (Object.prototype.hasOwnProperty.call(TAG_PREFIX, workflow) ? `${TAG_PREFIX[workflow]}${version}` : null);

module.exports = {TAG_PREFIX, tagFor};
