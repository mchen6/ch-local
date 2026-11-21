# Contributing to ch-local

## A home's formats: every change ships its older-version reader

From release 1 on, a user's home (`~/.countinghouse`, or `$COUNTINGHOUSE_HOME`)
outlives every ch-local that writes it. So every change to a format a home
holds -- `modules.json`, `settings.json`, the stored credentials, the module
store, and any file added later -- ships the reader for the format before it
(or a migration that runs on first use), in the same change.

Two tests pin this:

- `test/home-formats.test.js` runs on every `npm test`, offline. Each home
  under `test/fixtures/homes/` was built by an older ch-local's own code, and
  this tree's readers must read it as that release read it (its
  `expected.json`). A change that can't read a captured home fails here. A
  format may change what it holds on purpose: say so in that home's
  `expected.json`, in the same change -- never by deleting the fixture.
- `test/upgrade-path.test.js` runs in CI's smoke job, with the real runtime.
  A home built by each older release in its `FROM` list is upgraded to this
  tree, started, rolled back, and started again; every data file must
  survive byte for byte.

## Release gating

Before a release is published:

1. Capture its home: `CH_SMOKE_RUNTIME_TGZ=<countinghouse tarball> node
   scripts/capture-home.js --from <the release commit> --label <version>`,
   and commit `test/fixtures/homes/<version>/`, so the release's exact formats
   are read by every later tree.
2. Add the release commit to `FROM` in `test/upgrade-path.test.js`, so every
   later tree is upgraded from it. From release 1 on, a release has own
   modules, so its entry also adds one with its own `add-module` and checks
   the record and copies survive. Until then only the `self` entry (this
   tree under another version) runs that step.

`scripts/capture-home.js` refuses to capture a file that holds a path of the
machine it ran on (the temporary home, the user's home, the node binary):
fixtures are public.
