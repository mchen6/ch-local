'use strict';
// What `ch-local install` may put into <home>/app: each pack's packages, every
// package pinned to one exact version and its tarball's sha512 integrity, and
// each pack's lockfile, which pins every dependency's version and integrity
// too (npm ci checks them all). Pins and lockfiles are written at each
// release from the released tarballs; until the first there are none, and
// install says so.
//
// `countinghouse` in a pack's list is the runtime's own tarball. The usage
// report is the runtime's built-in countinghouse_usage_report tool, so no pack
// installs a report package.
const STEPS = ['redact', 'log-clean', 'error-patterns', 'failure-signature', 'dedupe', 'owner-hint', 'report']
  .map((s) => `@countinghouse/ch-step-${s}`);

const ALLOWLIST = {
  packs: {
    'ci-failure-triage': {
      packages: ['@countinghouse/ch-local', '@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', ...STEPS, 'countinghouse'],
      credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN'],
      lockfile: null
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
