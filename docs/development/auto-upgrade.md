# Upgrades from npm: `ch-local upgrade` and automatic upgrades

A design note, for review before the build. Today `ch-local upgrade` shows
the versions and asks, and the automatic check only announces; neither
installs anything. This note covers the install step both will share.

## What the maintainer decided

- `ch-local upgrade` and automatic upgrades really install from npm, through
  one shared install step.
- `ch-local install` asks once whether to turn automatic upgrades on.
  - Only the user's own yes at a terminal turns them on. They're never on
    by default.
  - With no terminal to ask, they stay off.
- When on, only allowlisted, integrity-pinned, provenance-checked versions
  are installed. Each one is announced to the session and written to
  history, and `ch-local rollback` undoes it.
- Under the shared runtime, an upgrade goes through the daemon's upgrade
  requests.
- Provenance is verified inside ch-local with the Sigstore verifier
  libraries. Those are ch-local's first runtime dependencies, pinned and
  integrity-locked. Each release ships Sigstore's public-good trusted root,
  and the tests use a root of their own, so the real chain check runs
  offline.
- Release gating holds: tests use a local fake registry, with no publish
  and no tags.

## The trust chain

Nothing is installed that a newer ch-local release doesn't pin, and nothing
is fetched from anywhere but `https://registry.npmjs.org/`.

1. **The newer ch-local.** Its version comes from the `latest` dist-tag of
   `@countinghouse/ch-local`. It is considered only if:
   - it's newer than the installed one;
   - it's not a prerelease;
   - it's the same major version. A major bump is announced and left to
     `ch-local upgrade`, which asks. That's my proposal; the decision is the
     maintainer's.
2. **Its tarball is fetched and checked**, as every tarball below is:
   - `dist.tarball` must be on `https://registry.npmjs.org/`;
   - the tarball is at most 50 MB;
   - its sha512 must equal `dist.integrity`.
3. **Its provenance is verified** (below). A release that fails is never
   installed.
4. **Its pins are read as data, never run.** Each release ships its pins and
   the runtime lockfile in `lib/release-pins.json` (today's `ALLOWLIST.pins`
   and `runtime.lockfile`, moved out of code), read from the verified
   tarball. No code from the new release runs before it's installed.
5. **Every package the new pins name** (the runtime and each installed
   pack's packages) is fetched as in step 2. Its sha512 must equal its pin,
   and its own provenance is verified against its own repository. Pinned
   integrity is enough for the chain; the per-package provenance check is
   defence in depth, and the maintainer's "provenance-checked" rule.
6. **Installed through today's install step.** The checked tarballs go into
   a release directory, and `loadTarballs` and `installLocked` install them
   exactly as `--from` does now:
   - `npm ci --ignore-scripts --omit=optional --no-audit --no-fund` against
     the pinned lockfile, so every third-party dependency is checked by its
     lockfile integrity;
   - the replaced release kept in `<home>/previous`;
   - a pack the new release doesn't list kept under `held`.

`ch-local install` with no `--from` uses steps 5 and 6 with the running
release's own pins. `ch-local upgrade` (after its yes) and the automatic
upgrade use steps 1 to 6.

## Provenance: exactly what is checked

For each package version, ch-local fetches
`https://registry.npmjs.org/-/npm/v1/attestations/<name>@<version>` (at most
1 MB). It must hold exactly the two attestations npm makes under trusted
publishing. Any check that fails means that version is not installed.

**The SLSA provenance** (`predicateType` `https://slsa.dev/provenance/v1`), a
Sigstore bundle verified with `@sigstore/verify` against the bundled trusted
root. All of these must hold:
- **The signature chain:**
  - the signing certificate chains to the root's Fulcio CA;
  - the DSSE envelope's signature verifies under it;
  - the transparency-log entry's inclusion proof verifies against the root's
    Rekor key, at a time within the certificate's validity.
- **The certificate's identity** (its Fulcio extensions), which is what the
  signature vouches for. The predicate's own text is not trusted on its own:
  - the issuer is `https://token.actions.githubusercontent.com`;
  - the SAN (Build Signer URI) is
    `https://github.com/<owner>/<repo>/.github/workflows/publish.yml@refs/tags/v<version>`;
  - the Source Repository URI is `https://github.com/<owner>/<repo>`;
  - the Source Repository Ref is `refs/tags/v<version>`;
  - the Runner Environment is `github-hosted`.
- **The predicate agrees with the certificate:**
  - `buildDefinition.buildType` is the GitHub Actions workflow build type;
  - `externalParameters.workflow` is `{repository, path:
    ".github/workflows/publish.yml", ref: "refs/tags/v<version>"}`, the
    same as the certificate;
  - `internalParameters.github.event_name` is `push` (a tag push, not a
    hand-run workflow on a branch).
- **The subject:**
  - its name is `pkg:npm/<name>@<version>`;
  - its `digest.sha512` is the fetched tarball's sha512.

**The npm publish attestation** (`predicateType`
`https://github.com/npm/attestation/tree/main/specs/publish/v0.1`):
- it's signed by npm's registry key, whose public key and key id ship in the
  release beside the trusted root;
- its subject digest is the same tarball's sha512;
- its predicate is `{name, version, registry: "https://registry.npmjs.org"}`.

**The expected repository** for each package is part of the pins:
`{version, integrity, repository}`. For example `mchen6/ch-local`,
`mchen6/countinghouse`, and each pack's own repository. So a package can't
be republished from another repository and still pass.

## The trusted root, and its rotation

- **What ships:** each release carries `lib/sigstore/trusted-root.json`
  (Sigstore's public-good root: the Fulcio CAs, the Rekor and CT log keys,
  each with its validity window) and npm's registry signing keys. Both are
  pinned as data in the release, and checked into the repository. There's
  no TUF fetch at upgrade time.
- **Updated at each release** from Sigstore's TUF repository, by the release
  step, with the change shown in the release's pull request.
- **A rotation:** Sigstore publishes a new key before signing with it. Keys
  keep validity windows, so old entries still verify.
  - A newer release signed under a key the installed root doesn't have fails
    the chain check. It's announced as "can't verify yet" (below), never
    installed.
  - The way forward is a release made before the rotation takes effect,
    carrying the new root, which installs normally, and then the next.
  - With none, the user upgrades by hand: a fresh `ch-local install` from
    the published release.
  - The automatic upgrade never falls back to an unverified install.
- **Expiry:** a root whose newest Fulcio CA has ended its window gets one
  announcement ("this ch-local's signing root is out of date: upgrade by
  hand"). The automatic check then stops until an upgrade.

## Announcements: every outcome

Each outcome is one line on the session's stderr (start's notice, which the
runtime shows the session once), and one `history.jsonl` record:
`{kind: "upgrade", how: "auto" | "cli", outcome, from, to, reason}`. A failure
changes nothing that's installed.

| Outcome | Announced as |
|---|---|
| installed | `upgraded ch-local <a> -> <b> (<the packages that changed>); ch-local rollback undoes it` |
| nothing newer | nothing for `auto`; `everything is up to date` for `upgrade` |
| a major version | `ch-local <b> is a major upgrade: run ch-local upgrade to install it` |
| fetch failed or timed out | `could not reach the npm registry (<reason>); trying again in an hour` |
| a tarball host other than registry.npmjs.org | `<name>@<v> is not served from registry.npmjs.org: not installed` |
| integrity mismatch | `<name>@<v> did not match its pinned integrity: not installed` |
| no attestation | `<name>@<v> has no provenance: not installed` |
| chain failure | `<name>@<v>'s provenance did not verify (<which check>): not installed` |
| identity mismatch | `<name>@<v> was not built by <repo>'s publish workflow at v<v> (it was <what the certificate says>): not installed` |
| can't verify yet | `<name>@<v> is signed under a key this ch-local does not know yet: not installed; a later release, or ch-local install by hand` |
| install failed | `the upgrade to <b> failed (<npm's last line>); nothing changed` |
| the ceiling forbids it | nothing; the check doesn't run (as today) |

- A verification failure for a version is remembered in
  `upgrade-check.json`, so that version isn't fetched or announced again. A
  newer one is checked as usual.
- A fetch failure is retried an hour later, as today.

## Turning it on

- `ch-local install` asks once, after a successful install, at a terminal
  only (stdin and stdout both TTYs): `Turn on automatic upgrades? They
  install new versions of ch-local and its packs, checked as above, at
  most once a day. (yes/no)`.
  - Only `yes` turns them on, through `cliSet`, under the operator's
    ceiling.
  - Anything else, or no terminal, leaves them off. With no terminal, the
    install says: `automatic upgrades are off (no terminal to ask); ch-local
    upgrade --auto on turns them on`.
- It's asked again only after an install that found it unset, never after
  an answer.
- `ch-local upgrade --auto on|off` stays as it is.

## Rollback

- An upgrade is an install, so the replaced release is in `<home>/previous`,
  and `ch-local rollback` swaps it back, journaled, as today.
- After a rollback, the version rolled back from is recorded in
  `upgrade-check.json` as declined. The automatic upgrade doesn't install it
  again; only a newer version, or `ch-local upgrade`, does.
- A release marked as a security fix keeps rollback's existing question.

## Where it runs

- **One session's own runtime:** start's background check (as today) runs
  the upgrade in a child, `ch-local upgrade --apply-auto`, under
  `packs.lock`, so the session's start isn't held.
  - The running runtime keeps the release it started with.
  - Packs that changed are reloaded in place, as an install does now.
  - A runtime or ch-local change applies at the session's next start,
    announced as such.
- **Under the shared runtime:** the daemon's check runs the same child.
  After a successful install, the child leaves an upgrade request in
  `<home>/run/daemon/requests`, as install does today.
  - The daemon drains, then restarts the runtime on the new release, or
    re-execs itself when ch-local changed, handing over the session table.
  - Loosenings don't survive the hand-over, and each session is told.
- **One check at a time:** `upgrade-check.lock` as today, so two starts never
  upgrade at once. The install itself holds `packs.lock`.

## Development overrides never reach a real upgrade

A client's config can set any environment variable, `CH_LOCAL_DEV=1`
included (as the acceptance run's security review showed). So:

- **No variable, argument or file selects the trusted root.** The bundled
  root and npm's keys are the only ones the verifier ever uses, outside a
  test. A test root reaches it only as a function argument passed by the
  test's own code. That parameter isn't reachable from the environment,
  argv, `settings.json` or any other file.
- **While any development override is active, the automatic upgrade doesn't
  run at all**, and says why once per start: `automatic upgrades are off
  while a development override is set (<which>)`. The overrides are
  `CH_LOCAL_DEV=1`, a registry other than `registry.npmjs.org`, and
  `--unreleased-pins`, and the history record names the one in force.
- **Only `ch-local upgrade`, run at a terminal, may use a development
  registry**, and even then against the bundled root. So a fake registry's
  bundle signed under a test root is refused, as from anyone else.

## Dependencies

- Runtime dependencies:
  - `@sigstore/verify`, and only what it needs (`@sigstore/core`,
    `@sigstore/bundle`, `@sigstore/protobuf-specs`);
  - no `@sigstore/tuf`, `@sigstore/sign`, or `sigstore` meta-package.
- Each is pinned to an exact version in `package-lock.json` with its sha512.
- They're installed with `npm ci --ignore-scripts`, in development, in CI,
  and in the release's runtime lockfile, which the pins already check.

## Tests (no network)

- **A fake registry:** an HTTP server on `127.0.0.1` serving packuments,
  tarballs and attestations.
  - The registry URL can be pointed at it only under `CH_LOCAL_DEV=1`, and
    only at a loopback `http://127.0.0.1:<port>/` (`lib/npm-fetch.js`
    `registryFor`).
  - `registry.npmjs.org` is named in tests only where nothing is called.
  - Tarballs come from `npm pack` of fixture packages.
- **A test trusted root**, generated per run by a test helper:
  - a self-signed CA in Fulcio's place, issuing leaf certificates with the
    GitHub OIDC extensions;
  - a Rekor key whose log has the test's entries, with real inclusion proofs
    (a small Merkle tree) and a signed checkpoint;
  - an npm-registry key pair for the publish attestation.
  - The verifier takes this root in place of the bundled one only as a
    function argument from the test (above: never from the environment, argv
    or a file). It's the same `@sigstore/verify` code path, run for real,
    offline.
- **Cases:**
  - a good upgrade, installed and announced, and `rollback` undoing it;
  - each table row above;
  - a bundle for another digest, repository, workflow, ref, event, or
    issuer;
  - a valid signature with a predicate that disagrees with its certificate;
  - a publish attestation under an unknown key;
  - a pin without a repository;
  - a tarball over the bound;
  - no TTY at install;
  - a declined version not retried;
  - the daemon path: the request written, and the fake daemon's restart;
  - a root rotation: a bundle signed by a CA the root lacks is "can't verify
    yet";
  - `CH_LOCAL_DEV=1`, a fake registry, and a bundle validly signed under the
    test root, with the bundled root in force (no test argument): refused,
    as a chain failure;
  - the automatic upgrade under each development override: it doesn't run,
    the announcement names the override, and nothing is fetched.

## The pieces

1. The registry fetch, bounded and host-checked.
2. Provenance: the verifier with the bundled root, the identity and
   predicate checks, the publish attestation, and the gated test root.
3. `lib/release-pins.json` (the pins moved out of code, with `repository`),
   and the shared install step from npm.
4. `ch-local upgrade` installing after its yes; `--apply-auto` for the
   background check; the announcements and history.
5. The install-time question, and the declined-version record.
6. The fake registry, the test root, and the cases above.
