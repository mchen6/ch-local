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
const STEPS = ['redact', 'log-clean', 'error-patterns', 'failure-signature', 'dedupe', 'owner-hint', 'report']
  .map((s) => `@countinghouse/ch-step-${s}`);

// The runtime (this launcher and countinghouse) is installed by npm ci from
// its pinned lockfile. A pack's packages (its scenario first, then each part
// it calls) have no npm dependencies (#43) and are unpacked from their
// tarballs beside it, so packs can be added and removed in one home
// (reviewer, 2026-11-12).
const ALLOWLIST = {
  // This release: its version, and whether it is a security fix ({fixes: what
  // it fixed}); rollback asks before undoing one.
  release: {version: require('../package.json').version, security: null},
  runtime: {packages: ['@countinghouse/ch-local', 'countinghouse'], lockfile: null},
  packs: {
    'ci-failure-triage': {
      packages: ['@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', ...STEPS],
      credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']
    }
  },
  pins: {}
};

// Where a credential may go, and which ones (spec §1, consent; reviewer,
// 2026-11-12): written by hand, never from a pack. `start` writes the
// runtime's --remoteCredentials file from the loaded packs' own declared
// remotes, and refuses to start if any declares an origin not listed here or
// a variable its origin is not pinned to receive. A release checks the same.
const ALLOWED_ORIGINS = Object.freeze({
  'https://api.githubcopilot.com': Object.freeze(['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN'])
});

module.exports = {ALLOWLIST, ALLOWED_ORIGINS};
