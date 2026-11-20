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
   - for the automatic upgrade, its major version is the installed one's.
     Another major is announced and nothing more of it is fetched.
     `ch-local upgrade` takes it through every step below, exactly as any
     other version, shows it as a major ("a major upgrade: it may change how
     things work"), and installs it only on a yes at a terminal.

   A 0.x minor change (0.1 to 0.2) or a 0.0.x patch change is treated as a
   major by the automatic upgrade, since under semver either may break. It's
   announced and never installed automatically. `ch-local upgrade` shows it
   as one that may break, and asks.
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
   - the packs' composition (`packs.<p>.modules`: each pack's modules);
   - each pack module's description (`modules.<package>`: the variable it
     sends and the origin it sends it to, the modules it calls, its settings
     marked confirm), written from the release's own tarballs by
     `scripts/describe-release.js`, never by hand. The allowed origins
     (`ALLOWED_ORIGINS`) are derived from these; install refuses a package
     that differs from its description.

   **What an automatic upgrade won't take.** Each of these is announced and
   left to `ch-local upgrade`, which shows what's new and asks:
   - a release that adds a module to an installed pack; sends a key to an
     origin, or under a variable, its module didn't before; makes a module
     newly call one that holds a key; or drops a setting's confirm mark or
     changes its default (`additions` in `lib/release-pins.js`);
   - a release that changes an identity: self's, or an existing pin's
     repository, repository or owner ID, or workflow. This covers the
     runtime, an installed pack's packages and the shim;
   - a release that pins, for the first time, a package this install uses:
     the runtime's, an installed pack's or the shim's. Who builds it is new,
     so it counts as an identity change.

   What a release adds is judged against what this home has installed
   (`lib/installed-description.js`). A module counts as known only when it is
   verifiably the running release's pin: the record has it at that pin's
   version, and the store's marker names the pin's integrity. Its
   description is then the running release's. Anything else counts as
   unknown, and the store's files are never read in its place: a module the
   version table keeps off its pin, or a marker naming other bytes. An
   unknown module holds the upgrade back, and everything the release has it
   send or call is listed, as for a new module.

   What runs is start's own rule (`withdrawnNames`): a pack the running
   release doesn't list, or one the record has withdrawn, is not running, and
   neither is a module only such a pack lists. A module is verified by the
   store holding it whole at the pin, its directory and its marker.

   A pack that isn't running and that the release lists is served
   again ("<pack> is served again"). Its modules are new to the running set,
   so it holds an automatic upgrade back. `ch-local upgrade` installs it and
   asks for its credentials.

   A release held back is announced once per version (`announced` in
   `upgrade-check.json`), and said no more until a newer one.

   **A release is installed as one** (#413 rev 3 section 9.6), as `ch-local
   upgrade` installs it: every installed pack the release lists moves to its
   pins, whichever way each module's version moves. A module moving, forward
   or back, never holds an automatic upgrade back, but none is silent:
   - the session line names each module moved back and each a pack no longer
     lists (one another pack keeps "stays running through" it);
   - history records the moves and the drops.

   A home whose record can't be read is never upgraded automatically. It
   says so without naming a path, and records it in history. A home an
   earlier ch-local made is told to run `ch-local install` again. Every
   pack an install moves is held to the operator's allowlist, again under
   the lock.

   **The install acts only on the record that was judged.** `ch-local upgrade`
   and the automatic upgrade pass install a digest of the record they judged:
   its packs with their versions, and its withdrawn list. Under the lock,
   install refuses a record that differs ("this home changed while the
   upgrade was prepared; run it again"). That covers a pack added during
   the question, or one removed, or a rollback, during the fetch, and it
   writes nothing back. The automatic upgrade says it once, and the next
   check judges the home as it is then.

   **A pack the user hasn't installed** is never installed by an automatic
   upgrade. So a change to it, an identity change included, never blocks
   one: it's named in the announcement, nothing more.
6. **Every package the new pins name**, the runtime and each installed pack's
   packages, is fetched as in step 2.
   - Its sha512 must equal its pin.
   - Its own provenance is verified against its own pinned repository,
     workflow and tag.
   - **The runtime lockfile:**
     - ch-local's own entry can't carry its digest, since the lockfile is
       inside its tarball. It's filled in from the in-memory verified digest
       (step 4) before `npm ci`.
     - Every other entry must carry a sha512 integrity. One without it
       fails the release.
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
  - **the transparency log:** exactly **one** Rekor entry per attestation,
    verifying against a Rekor key in the root, and carrying an **inclusion
    promise** (the signed entry timestamp). The promise is what covers the
    integrated time; an inclusion proof alone doesn't, so a bundle with only
    a proof is refused, and so is one with two entries;
  - **certificate transparency:** threshold 1. The certificate must carry
    an SCT from a CT log in the root;
  - **the time source** is the Rekor entry's integrated time. The
    certificate must be valid at that time.
    - The time is read from the bundle **only after `verify()` has passed**.
      `@sigstore/verify` 3.1.1's `verify()` returns the signer, not the
      time.
    - The local clock is used only for the 72-hour wait and the root's
      expiry, never to decide whether a signature was valid.
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

- An automatic upgrade installs a version only 72 hours after the **later**
  of two times:
  - **its publish time:** the integrated time of npm's publish attestation's
    Rekor entry, read from the verified bundle. npm signs that attestation
    at publish, never the registry's own `time` field. The build confirms
    that this bundle carries a Rekor entry with an inclusion promise;
  - **when this install first saw the version:** recorded locally in
    `upgrade-check.json` at the first check that found it.
- **Why both:** an attacker can sign early and publish late, pre-ageing the
  log time. The first-seen floor still gives 72 hours from when users could
  see the version.
- A younger version is announced once ("<v> is available; it installs
  automatically after <time>"), and checked again later.
- **It fails closed.** Both times must be known: a first-seen time that isn't
  a finite number no later than now is reset to now, and the version waits.
- **`upgrade-check.json` is this user's alone.** It must be a regular file,
  not a link, owned by the user, with no access for group or others (on
  Windows, an owner-only DACL). One that isn't is not read, so the wait
  starts again, and it's written back as such: a temp file created
  exclusively, mode 0600, renamed into place.
- It's a soak against a compromised account. A bad release published in an
  attack has three days to be found and pulled before any automatic upgrade
  installs it.
- `ch-local upgrade` doesn't wait. Its yes is a person's at a terminal, as
  for any loosening: with no terminal (a piped answer), it installs nothing.

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

  Start's check tests these before it runs the child. The child's
  environment allowlist drops the two variables, so the child can't see
  them. An override is announced and recorded, and no child runs. The child
  tests them again itself.

## The child that applies it, and its environment

- **The child:** start's background check runs the upgrade in a child,
  `ch-local upgrade --apply-auto`, so the session's start isn't held.
- **It re-checks everything itself.** Any process of this user can run that
  child, so it trusts nothing its parent decided. It re-reads `autoUpgrade`
  and the operator's ceiling, the overrides above, and the 72-hour wait, and
  stops if any says no.
- **It prints one line**, the outcome's announcement. The install it runs
  says nothing of its own: its lines name paths and credentials.
- **It never writes `shim.json`.** Its environment is the session's (a
  client config's `PATH`, `HOME`, `TMPDIR`), which the shared daemon would
  give every client. Only an install from the command writes `shim.json`.
  If it's missing or invalid, the automatic upgrade leaves it, records
  that, and its line says: run ch-local install to repair the relay's
  settings.
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
- **The Windows ceiling path never reads the environment.** A client's
  config can set `ProgramData` and `SystemDrive`, so `lib/ceiling.js` looks
  for the fallback ceiling in the Windows known folder instead
  (`[Environment]::GetFolderPath('CommonApplicationData')`, read once
  through `lib/win-acl.js`'s PowerShell), and in `C:\ProgramData` as well,
  for the child and for start alike.
  - That lookup's `powershell.exe` is found under `SystemRoot`, which is on
    the allowlist and a client's config can set. That's a residual, below.

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
- **The Windows ceiling lookup trusts `SystemRoot`.** It's on the allowlist,
  and a same-user client config could set it, pointing the known-folder
  lookup's `powershell.exe` elsewhere. That's within the local same-user
  residual already recorded for the ACL checks (#169 section 3), and
  accepted.
- **A stamp reset drops `declined`.** An `upgrade-check.json` that isn't
  this user's alone is not read, so its record starts again. That also
  drops the declined versions, and a version rolled back from can return
  after a fresh 72 hours. Only a same-user act can make the file fail the
  check, and the reset is recorded. Accepted.
- **The verifier is the last of its majors.** `@sigstore/verify` 3.1.1 and
  `@sigstore/core` 3.2.1 end their major lines, with no advisories today. A
  future fix may land only on 4.x, which needs Node `^22.22.2 || ^24.15.0
  || >=26`. Raising ch-local's Node floor then is the maintainer's call.

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
  - a version not strict semver, a lower one, a prerelease: refused on both
    paths;
  - a major: announced and never fetched by the automatic upgrade; checked
    in full, shown as a major and installed on a yes by `ch-local upgrade`;
  - **the wait:**
    - with the publish attestation's time 71 hours ago, the automatic
      upgrade doesn't install; at 73 hours it does; `ch-local upgrade`
      installs at 1 hour;
    - a version signed 100 hours ago but first seen 1 hour ago isn't
      installed automatically until 72 hours after it was first seen;
  - **backdating:** a bundle with an inclusion proof but no promise, with no
    entry, or with two entries, is refused;
  - a lockfile whose ch-local entry is filled from the verified digest, and
    one whose other entry lacks integrity;
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
3. `lib/release-pins.json` (pins with their identity, the packs and their
   modules' descriptions), parsed from the verified bytes; the shared install step from
   npm, with the re-read check.
4. `ch-local upgrade` installing after its yes; `--apply-auto` with its own
   re-checks, its allowlisted environment and the 72-hour wait; the
   announcements and history; the memo and the seven-day notice.
5. The install-time question, and the declined-version record.
6. The fake registry, the test root, and the cases above.
