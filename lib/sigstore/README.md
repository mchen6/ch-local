# The trust ch-local ships for upgrades from npm

`lib/provenance.js` verifies a version's attestations against these two files
and nothing else (docs/development/auto-upgrade.md, "The trusted root, and
its rotation"). No variable, argument or file replaces them; only a test's
own code passes another root, as a function argument.

- `trusted-root.json`: Sigstore's public-good trusted root (the Fulcio CAs,
  the Rekor and CT log keys, a timestamp authority, each with its validity
  window).
  - This copy is `targets/trusted_root.json` from `sigstore/root-signing`'s
    `main` branch, git blob `effb0a19e6a0b3f69b3f0a2c72b5c2a02a0ddeea`.
  - The release step refreshes it from Sigstore's TUF repository, verified
    there, with the change shown in the release's pull request.
- `npm-keys.json`: npm's registry signing keys, as
  `https://registry.npmjs.org/-/npm/v1/keys` serves them. Each is valid until
  its `expires`, so older attestations still verify under the key they were
  made with.
