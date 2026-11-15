# Upgrades from npm: `ch-local upgrade` and automatic upgrades

A design note, for review before the build. Today `ch-local upgrade` shows
the versions and asks, and the automatic check only announces; neither
installs anything. This note covers the install step both will share.

## What the maintainer decided

- `ch-local upgrade` and automatic upgrades really install from npm, through
  one shared install step.
- `ch-local install` asks once whether to turn automatic upgrades on.
  - Only the user's own yes at a terminal turns them on. They're never on by
    default.
  - With no terminal to ask, they stay off.
- When on, only allowlisted, integrity-pinned, provenance-checked versions
  are installed. Each one is announced to the session and written to
  history, and `ch-local rollback` undoes it.
- **An automatic upgrade installs a version only 72 hours after its verified
  transparency-log time** (below). A manual `ch-local upgrade` is immediate.
- A major version is never installed automatically. It's announced and left
  to `ch-local upgrade`.
- The pins are data, never code (`lib/release-pins.json`, below).
- Under the shared runtime, an upgrade goes through the daemon's upgrade
  requests.
- Provenance is verified inside ch-local with the Sigstore verifier
  libraries. Those are ch-local's first runtime dependencies, pinned and
  integrity-locked. Each release ships Sigstore's public-good trusted root,
  and the tests use a root of their own, so the real chain check runs
  offline.
- Release gating holds: tests use a local fake registry, with no publish and
  no tags.

## Preconditions (the maintainer's release gating)

These checks bind a version to a tag, and a tag to a workflow. They don't
bind the tag to `main`, because the "on main" step lives in the tagged
commit's own `publish.yml`. So, for every repository a pin names:

- **A tag ruleset:** a `v*` tag may be created only on a commit reachable
  from `main`, only by the maintainer, and never moved or deleted. The
  rulesets are empty today, as expected. Setting them is a step on the
  maintainer's gating checklist, before the first release this note's code
  checks.
- **Every pinned version was published by its repository's workflow,**
  under npm trusted publishing, which attaches provenance.
  - A package without a publish workflow can't be pinned.
  - Neither can a version published by hand, such as a package's first
    version, which has no provenance.
  - Every package the release pins must be published from a public
    repository with a publish workflow. npm provenance needs both.

## The trust chain

Nothing is installed that a verified ch-local release doesn't pin. Nothing is
fetched from anywhere but `https://registry.npmjs.org/`. TLS is not an
anchor: what's trusted comes from the provenance checks and the pins, never
from the connection. A proxy or a CA variable could redirect traffic, and
those are dropped anyway (below).

1. **The newer ch-local.** Its version comes from the `latest` dist-tag of
   `@countinghouse/ch-local`. It's considered only if:
   - it's strict semver (`MAJOR.MINOR.PATCH`, digits only, no prerelease
     or build part);
   - it's greater than the installed version by semver precedence;
   - its major version is the installed one's.
2. **Its tarball is fetched and checked**, as every tarball below is
   (`lib/npm-fetch.js`):
   - `dist.tarball` must be the registry's own path for that name and
     version;
   - no redirects;
   - at most 50 MB;
   - its sha512 must equal `dist.integrity`.
3. **Its provenance is verified** (below). For an automatic upgrade, its log
   time must also be 72 hours old. A release that fails is never installed.
4. **ch-local's own pin is that digest.** A release can't pin its own
   sha512. So ch-local's pin is the digest just verified in steps 2 and 3,
   held in memory, and provenance is its only anchor.
5. **Its pins are read as data, from the verified bytes in memory.** The
   tarball is unpacked in memory (`lib/tar.js`), and its
   `lib/release-pins.json` is parsed from those bytes. Nothing from the new
   release is written to disk or run before it's installed. The file holds:
   - every pin, `{version, integrity, repository, repositoryId, ownerId,
     workflow, tag}`;
   - the runtime lockfile;
   - the packs' composition (today's `ALLOWLIST.packs`: each pack's
     packages and credentials);
   - the allowed origins (today's `ALLOWED_ORIGINS`: which origin may
     receive which variable).

   **A release that adds a package to a pack, a credential, or an origin**
   (or a pack the user hasn't installed) isn't installed automatically. It's
   announced and left to `ch-local upgrade`, which shows what's new and
   asks.
6. **Every package the new pins name**, the runtime and each installed pack's
   packages, is fetched as in step 2.
   - Its sha512 must equal its pin.
   - Its own provenance is verified against its own pinned repository,
     workflow and tag.
   - Every entry of the runtime lockfile must carry a sha512 integrity, the
     runtime's own included. One without it fails the release.
7. **Installed through today's install step.** The checked tarballs are
   written to a release directory. `loadTarballs` re-reads them, and each
   re-read must match the in-memory digest (the bytes can't change between
   check and use). Then `installLocked` installs them as `--from` does now:
   - `npm ci --ignore-scripts --omit=optional --no-audit --no-fund` against
     the pinned lockfile;
   - the replaced release kept in `<home>/previous`;
   - a pack the new release doesn't list kept under `held`.

`ch-local install` with no `--from` uses steps 6 and 7 with the running
release's own pins. `ch-local upgrade` (after its yes) and the automatic
upgrade use all seven.

## Provenance: exactly what is checked

For each package version, ch-local fetches
`https://registry.npmjs.org/-/npm/v1/attestations/<name>@<version>` (at most
1 MB). It must hold the two attestations npm makes under trusted publishing.
Any check that fails means that version isn't installed.

**The SLSA provenance** (`predicateType` `https://slsa.dev/provenance/v1`):
a Sigstore bundle, verified with `@sigstore/verify` against the bundled
trusted root. All of these must hold:
- **The signature chain:**
  - the signing certificate chains to one of the root's Fulcio CAs;
  - the DSSE envelope's signature verifies under the certificate;
  - **the transparency log:** threshold 1. The bundle's Rekor entry must
    verify against a Rekor key in the root, with its inclusion proof and
    signed checkpoint;
  - **certificate transparency:** threshold 1. The certificate must carry
    an SCT from a CT log in the root;
  - **the time source** is the Rekor entry's integrated time, from the
    verified entry. The certificate must be valid at that time. The local
    clock is used only for the 72-hour wait and the root's expiry, never to
    decide whether a signature was valid.
- **The certificate's identity** (its Fulcio extensions), which is what the
  signature vouches for. The predicate's text isn't trusted on its own:
  - the issuer (OID 1.3.6.1.4.1.57264.1.8) is
    `https://token.actions.githubusercontent.com`;
  - the SAN (the Build Signer URI) is
    `https://github.com/<repository>/<workflow>@refs/tags/<tag>`, from the
    pin;
  - the Source Repository URI (.12) is `https://github.com/<repository>`;
  - the **Source Repository Identifier (.15)** is the pin's numeric
    `repositoryId`, and the **Source Repository Owner Identifier (.17)** is
    its numeric `ownerId`. So a repository deleted and recreated under the
    same name, or an owner renamed, doesn't pass;
  - the Source Repository Ref (.14) is `refs/tags/<tag>`;
  - the Runner Environment (.11) is `github-hosted`.
- **The predicate agrees with the certificate:**
  - `buildDefinition.buildType` is the GitHub Actions workflow build type;
  - `externalParameters.workflow` is `{repository: "https://github.com/<repository>",
    path: "<workflow>", ref: "refs/tags/<tag>"}`;
  - `internalParameters.github.event_name` is `push`, a tag push, not a
    workflow run by hand.
- **The subject:**
  - its name is `pkg:npm/<name>@<version>`;
  - its `digest.sha512` is the fetched tarball's.

**The npm publish attestation** (`predicateType`
`https://github.com/npm/attestation/tree/main/specs/publish/v0.1`):
- it's signed by npm's registry key, whose public key and key id ship in
  the release beside the trusted root;
- its subject digest is the same tarball's;
- its predicate is `{name, version, registry: "https://registry.npmjs.org"}`.

**Each pin carries its expected identity:** `{repository, repositoryId,
ownerId, workflow, tag}`. For example:
`{"repository": "mchen6/ch-local", "repositoryId": <n>, "ownerId": <n>,
"workflow": ".github/workflows/publish.yml", "tag": "v0.3.0"}`.
A pin without all five is refused.

## The 72-hour wait (automatic only)

- An automatic upgrade installs a version only once
  `now - integratedTime >= 72 h`, where `integratedTime` is the Rekor
  integrated time from the verified bundle, never the registry's publish
  time.
- A younger version is announced once ("<v> is available; it installs
  automatically after <time>"), and checked again later.
- It's a soak against a compromised account. A bad release published in an
  attack has three days to be found and pulled before any automatic upgrade
  installs it.
- `ch-local upgrade` doesn't wait.

## The trusted root, and its rotation

- **What ships:** each release carries `lib/sigstore/trusted-root.json`
  (Sigstore's public-good root: the Fulcio CAs, the Rekor and CT log keys,
  each with its validity window) and npm's registry keys. Both are data in
  the release, checked into the repository and covered by the release's own
  integrity. There's no TUF fetch at upgrade time.
- **Updated at each release** from Sigstore's TUF repository by the release
  step, with the change shown in the release's pull request.
- **A rotation:** Sigstore publishes a new key before signing with it, and
  keys keep validity windows, so old entries still verify.
  - A newer release signed under a key the installed root lacks fails the
    chain check. It's announced as "can't verify yet", never installed.
  - The way forward is a bridge release, made before the rotation takes
    effect, carrying the new root.
  - **A bridge release that's already superseded can't be reached:** the
    upgrade looks only at `latest`. So a user who missed the bridge needs a
    manual upgrade (a fresh `ch-local install` from the published release).
    That's a residual, announced as such.
  - The automatic upgrade never falls back to an unverified install.
- **Expiry:** a root whose newest Fulcio CA has ended its window is
  announced at every start ("this ch-local's signing root is out of date:
  upgrade by hand"), not just once. The automatic check then stops until an
  upgrade.

## Announcements: every outcome

Each outcome is one line on the session's stderr (start's notice, which the
runtime shows the session once), and one `history.jsonl` record:
`{kind: "upgrade", how: "auto" | "cli", outcome, from, to, reason}`. A
failure changes nothing that's installed.

| Outcome | Announced as |
|---|---|
| installed | `upgraded ch-local <a> -> <b> (<the packages that changed>); ch-local rollback undoes it` |
| nothing newer | nothing for `auto`; `everything is up to date` for `upgrade` |
| a major version | `ch-local <b> is a major upgrade: run ch-local upgrade to install it` |
| something new to agree to | `ch-local <b> adds <a package, credential or origin>: run ch-local upgrade to see it and install` |
| younger than 72 hours (auto) | `ch-local <b> is available; it installs automatically after <time>` |
| fetch failed or timed out | `could not reach the npm registry (<reason>); trying again in an hour` |
| no successful check for 7 days | `no upgrade check has succeeded for 7 days (<last reason>)` |
| not the registry's own tarball path | `<name>@<v> is not served from registry.npmjs.org: not installed` |
| integrity mismatch | `<name>@<v> did not match its pinned integrity: not installed` |
| no attestation | `<name>@<v> has no provenance: not installed` |
| chain failure | `<name>@<v>'s provenance did not verify (<which check>): not installed` |
| identity mismatch | `<name>@<v> was not built by <repository>'s <workflow> at <tag> (it was <what the certificate says>): not installed` |
| can't verify yet | `<name>@<v> is signed under a key this ch-local does not know yet: not installed; a later release, or ch-local install by hand` |
| root expired | `this ch-local's signing root is out of date: upgrade by hand` (at every start) |
| a development override is set | `automatic upgrades are off while a development override is set (<which>)` |
| install failed | `the upgrade to <b> failed (<npm's last line>); nothing changed` |
| the ceiling forbids it | nothing; the check doesn't run (as today) |

**No silent freeze:**
- Only a verification failure is remembered in `upgrade-check.json`. It's
  keyed by `(version, the trusted root's digest)`, so that version isn't
  fetched or announced again under the same root, and an upgraded root
  checks it afresh.
- A transport failure (a timeout, a connection, an error status) is never
  remembered. It's retried an hour later, as today.
- Seven days with no successful check are announced, as is an expired root
  at every start.

## Development overrides never reach a real upgrade

A client's config can set any environment variable, `CH_LOCAL_DEV=1`
included (as the acceptance run's security review showed). So:

- **No variable, argument or file selects the trusted root, or the
  registry.** The bundled root, npm's keys and `registry.npmjs.org` are the
  only ones used outside a test.
  - A test root and a fake registry reach the code only as function
    arguments passed by the test's own code. That parameter can't be reached
    from the environment, argv, `settings.json` or any other file.
  - (`lib/npm-fetch.js`'s `registryFor` will lose its `CH_LOCAL_DEV` path
    for this.)
- **Neither the automatic upgrade nor `ch-local upgrade` runs while a
  development override is in force.** Each says which:
  - `CH_LOCAL_DEV` set;
  - `CH_LOCAL_REMOTE_MAP` set;
  - a home whose record is `unreleased` (installed with `--unreleased-pins`).

  The automatic check doesn't test the last one today; it will.

## The child that applies it, and its environment

- **The child:** start's background check runs the upgrade in a child,
  `ch-local upgrade --apply-auto`, so the session's start isn't held.
- **It re-checks everything itself.** Any process of this user can run that
  child, so it trusts nothing its parent decided. It re-reads `autoUpgrade`
  and the operator's ceiling, the overrides above, and the 72-hour wait, and
  stops if any says no.
- **Its environment is `shim.json`'s allowlist** (`PATH`, `HOME`, `LANG`,
  `TMPDIR`; on Windows `USERPROFILE`, `SystemRoot`, `TEMP`, `TMP`, `APPDATA`,
  `LOCALAPPDATA`), whether or not the shared runtime is in use. That drops:
  - `npm_execpath`: `lib/npm.js` runs whatever it names, so the child finds
    npm beside `node` only;
  - `NODE_OPTIONS`;
  - every `npm_config_*`;
  - the proxy and CA variables: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and
    their lowercase forms, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
    `SSL_CERT_DIR`, `NODE_TLS_REJECT_UNAUTHORIZED`.
- **The Windows ceiling path reads the environment today.** `lib/ceiling.js`
  looks for the fallback ceiling under `env.ProgramData` and
  `env.SystemDrive`, which a client's config can set.
  - Neither is on the allowlist, so the child falls back to
    `C:\ProgramData` alone.
  - The build goes further, for the child and for start alike: the ceiling
    is looked up in the Windows known folder
    (`[Environment]::GetFolderPath('CommonApplicationData')`, read through
    `lib/win-acl.js`'s PowerShell), never from the environment.

## Turning it on

- `ch-local install` asks once, after a successful install, at a terminal
  only (stdin and stdout both TTYs): `Turn on automatic upgrades? They
  install new versions of ch-local and its packs, checked as above, 72 hours
  after each is published. (yes/no)`.
  - Only `yes` turns them on, through `cliSet`, under the operator's
    ceiling.
  - Anything else, or no terminal, leaves them off. With no terminal, the
    install says: `automatic upgrades are off (no terminal to ask); ch-local
    upgrade --auto on turns them on`.
- It's asked again only after an install that found the setting unset, never
  after an answer.
- `ch-local upgrade --auto on|off` stays as it is.

## Rollback

- An upgrade is an install, so the replaced release is in `<home>/previous`,
  and `ch-local rollback` swaps it back, journaled, as today.
- After a rollback, the version rolled back from is recorded in
  `upgrade-check.json` as declined. The automatic upgrade doesn't install it
  again; only a newer version, or `ch-local upgrade`, does.
- A release marked as a security fix keeps rollback's existing question.

## Where it runs

- **One session's own runtime:** start's check runs the child under
  `packs.lock`.
  - The running runtime keeps the release it started with.
  - Packs that changed are reloaded in place, as an install does now.
  - A runtime or ch-local change applies at the session's next start,
    announced as such.
- **Under the shared runtime:** the daemon's check runs the same child.
  After a successful install, the child leaves an upgrade request
  (`{op, at}`, nothing more) in `<home>/run/daemon/requests`, as install does
  today.
  - The daemon drains, then restarts the runtime on the new release, or
    re-execs itself when ch-local changed, handing over the session table.
  - Loosenings don't survive the hand-over, and each session is told.
- **One check at a time:** `upgrade-check.lock` as today. The install itself
  holds `packs.lock`.

## Dependencies, and how they reach users

- **Runtime dependencies:** `@sigstore/verify` 3.1.1 and only what it needs:
  `@sigstore/core` 3.2.1, `@sigstore/bundle` 4.0.0 and
  `@sigstore/protobuf-specs` 0.5.2.
  - All four support Node `^20.17.0 || >=22.9.0`, so ch-local's 22.16 floor
    stands. 4.x needs `^22.22.2 || ^24.15.0 || >=26` and isn't used.
  - No `@sigstore/tuf`, `@sigstore/sign` or `sigstore` meta-package.
- **They ship inside ch-local's own tarball, as `bundleDependencies`.**
  `package-lock.json` isn't published, so without this `npx
  @countinghouse/ch-local install` would resolve their caret ranges afresh,
  with scripts on. Bundled, they come from ch-local's verified tarball and
  are covered by its integrity and provenance, with no registry lookup of
  their own.
- In development and CI, `npm ci --ignore-scripts` installs them from the
  lockfile, with exact versions and integrities.

## Residuals

- **An older signed version can be served as `latest`.** If the registry
  serves, as `latest`, a version above the installed one but below the
  newest, the upgrade can't tell. It's signed, pinned and provenance-checked,
  just not the newest. A freeze below the newest is announced only through
  the seven-day notice when checks fail, not when they "succeed" on an old
  version.
- **A superseded bridge release can't be reached** from `latest` (above), so
  a root rotation can mean a manual upgrade.
- **A compromised maintainer account** that tags on `main` and publishes
  through the workflow passes every check. The tag ruleset narrows who can
  tag, and the 72-hour wait gives time to notice. Neither removes it.

## Tests (no network)

- **A fake registry:** an HTTP server on `127.0.0.1` serving packuments,
  tarballs and attestations (`test/fake-registry.js`).
  - The registry reaches the code under test only as a function argument.
  - `registry.npmjs.org` is named in tests only where nothing is called.
- **A test trusted root**, generated per run by a test helper:
  - a self-signed CA in Fulcio's place, issuing leaf certificates with the
    GitHub OIDC extensions, numeric IDs included, and an SCT from a test CT
    log;
  - a Rekor key whose log holds the test's entries, with real inclusion
    proofs (a small Merkle tree), signed checkpoints and an integrated time
    the test chooses;
  - an npm-registry key pair for the publish attestation.
  - It reaches the verifier only as a function argument from the test. It's
    the same `@sigstore/verify` code path, run for real, offline.
- **Cases:**
  - a good upgrade, installed and announced, and `rollback` undoing it;
  - each table row above;
  - a bundle for another digest, repository, repository ID, owner ID,
    workflow, tag, event or issuer;
  - a valid signature whose predicate disagrees with its certificate;
  - no SCT, or no log entry;
  - a publish attestation under an unknown key;
  - a pin missing any of its five identity fields;
  - a lockfile entry without integrity;
  - a release directory changed between the check and `loadTarballs`;
  - a release adding a credential, an origin, or a package to a pack: not
    installed automatically, announced;
  - a version not strict semver, a lower one, a prerelease, a major;
  - **the wait:** with the integrated time 71 hours ago, the automatic
    upgrade doesn't install; at 73 hours it does; `ch-local upgrade`
    installs at 1 hour;
  - no TTY at install;
  - a declined version not retried, and retried under a new root;
  - a transport failure never remembered, and the seven-day notice;
  - the expired-root notice at every start;
  - `--apply-auto` run by hand with `autoUpgrade` off, or under a ceiling
    that forbids it: nothing done;
  - the child's environment: none of `npm_execpath`, `NODE_OPTIONS`,
    `npm_config_*` or the proxy and CA variables reach it;
  - the daemon path: the request written, and the fake daemon's restart;
  - a root rotation: a bundle signed by a CA the root lacks is "can't verify
    yet";
  - `CH_LOCAL_DEV=1`, a fake registry, and a bundle validly signed under the
    test root, with the bundled root in force (no test argument): refused,
    as a chain failure;
  - each development override: neither the automatic upgrade nor
    `ch-local upgrade` runs, the announcement names it, and nothing is
    fetched.

## The pieces

1. The registry fetch, bounded and host-checked (on the
   `auto-upgrade-build` branch; `registryFor` loses its env path).
2. Provenance: the verifier with the bundled root, the identity (numeric
   IDs included), the predicate, the publish attestation, the log and CT
   thresholds, and the test root as an argument.
3. `lib/release-pins.json` (pins with their identity, the packs and the
   origins), parsed from the verified bytes; the shared install step from
   npm, with the re-read check.
4. `ch-local upgrade` installing after its yes; `--apply-auto` with its own
   re-checks, its allowlisted environment and the 72-hour wait; the
   announcements and history; the memo and the seven-day notice.
5. The install-time question, and the declined-version record.
6. The fake registry, the test root, and the cases above.
