'use strict';
// What `ch-local install` may put into <home>/app: each pack's packages, and
// every package pinned to one exact version and its tarball's sha512
// integrity. The pins are written at each release, from the released
// tarballs; until the first release there are none, and install says so.
const STEPS = ['redact', 'log-clean', 'error-patterns', 'failure-signature', 'dedupe', 'owner-hint', 'report']
  .map((s) => `@countinghouse/ch-step-${s}`);

const ALLOWLIST = {
  packs: {
    'ci-failure-triage': {
      packages: ['@countinghouse/ch-local', '@countinghouse/ch-pack-ci-failure-triage', '@countinghouse/ch-access-github', ...STEPS, '@countinghouse/ch-report', 'countinghouse'],
      credentials: ['COUNTINGHOUSE_GITHUB_TOKEN', 'GITHUB_TOKEN']
    }
  },
  pins: {}
};

module.exports = {ALLOWLIST};
