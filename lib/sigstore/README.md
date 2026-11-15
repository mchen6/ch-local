# The trust ch-local ships for upgrades from npm

`lib/provenance.js` verifies a version's attestations against these two
files and nothing else (docs/development/auto-upgrade.md, "The trusted root,
and its rotation"). No variable, argument or file replaces them. Only a
test's own code passes another root, as a function argument.

## `trusted-root.json`: Sigstore's public-good trusted root

It holds the Fulcio CAs, the Rekor and CT log keys, and a timestamp
authority, each with its validity window.

**This copy is a bootstrap.** It is `targets/trusted_root.json` from
`sigstore/root-signing`'s `main` branch:
- git blob `effb0a19e6a0b3f69b3f0a2c72b5c2a02a0ddeea`, equal to upstream's;
- its sha256 matches the one Sigstore's `targets.json` (version 14) publishes
  for it.

**What the release step's refresh must do**, before a release ships a new
copy:
1. Use a maintained TUF client, starting from a `root.json` checked into this
   repository.
2. Walk the root chain version by version. Each new root must be signed at
   threshold under both the old keys and the new ones.
3. Accept no role version below the last one recorded. Record each role's
   version here at every refresh.
4. Require every role (root, timestamp, snapshot, targets) to be unexpired.
5. Check the target's length and hash against `targets.json`.
6. Show the diff in the release's pull request, reviewed: no key dropped, and
   no validity window shortened.

## `npm-keys.json`: npm's registry signing keys

It's the form `https://registry.npmjs.org/-/npm/v1/keys` serves. Each key is
valid until its `expires`, so older attestations still verify under the key
they were made with.

**At each release**, take the keys from Sigstore's TUF repository's
`registry.npmjs.org/keys.json` target, not the registry's own endpoint. That
target carries real validity windows and the `npm:attestations` usage, and
TUF verifies it as above.

**Residual:** today's current key has `expires: null`, an open window. A key
npm retires stays valid here until a release ships the window that ends it.
