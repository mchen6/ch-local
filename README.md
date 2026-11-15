# @countinghouse/ch-local

The countinghouse client-pack launcher: installs pinned packs into ~/.countinghouse, starts the runtime over stdio for Claude Code, Cursor, VS Code and Codex, prints each client's config entry, upgrades on request and never silently.

**Status: preview.** `ch-local snippet`, `install` (from local tarballs), `add`,
`uninstall` and `upgrade` are here, with the Claude Code plugin. `start`, which
runs the runtime in local mode, lands with countinghouse's local mode (LM1),
and installing straight from npm with the first release.

## What it does

`ch-local snippet <claude-code|cursor|vscode|codex|claude-desktop>` prints
the client's config entry for the installed launcher on stdout, alone, so it
can be piped. On stderr it names the Node it pinned and how to reprint the
entry after a Node upgrade. Every entry runs `<absolute node>
<home>/bin/ch-local.js start --stdio`, where
`<home>` is `$COUNTINGHOUSE_HOME` (absolute) or `~/.countinghouse`.

No entry sets the GitHub token. The server inherits it from the environment
the client is started from. Only Codex's entry names the two variables, in
`env_vars`, because Codex does not pass its environment on by default.
Claude Desktop gets a note instead of an entry: its route is a `.mcpb` bundle
that keeps the token in the OS keychain, not built yet.

**The Claude Code plugin.** This repository is also the plugin's marketplace:

    claude plugin marketplace add mchen6/ch-local
    claude plugin install ch-packs@ch-packs

The plugin (`clients/claude-code`) runs `bin/launch.js` with `node`, which
starts the installed launcher, passes it a stop, and fetches nothing. Its skill
tells Claude to call `ci_failure_triage` first when a CI run failed.

One install page per client is in [docs/install](docs/install/README.md).

## Commands

| Command | What it does |
|---|---|
| `ch-local install --pack ci-failure-triage --from <dir>` | checks each tarball in `<dir>` against the version and sha512 integrity this launcher pins (a tarball not on the list, a wrong hash or a missing one stops it before anything runs). It builds `<home>/app` with the runtime (this launcher and countinghouse) as an npm project with its lockfile, pinned at release so every dependency's version and integrity is fixed too, by `npm ci --omit=optional --ignore-scripts`. The pack's own packages have no npm dependencies and are unpacked beside it by a strict tar reader (files and directories only, no links, size-capped); one that declares dependencies is refused. The new app is swapped in only when complete (the old one goes back if it cannot), and install writes `<home>/bin/ch-local.js` and `<home>/packs.json`. An install replaces the app: other packs are dropped, and named |
| `ch-local add-pack <name> --from <dir>` | adds another pack this release pins beside the installed ones, checked the same way; a part another pack already uses is shared at its pinned version, and one installed at another version stops it (run `upgrade` first). No client file changes: the entry runs `start`, which loads every pack |
| `ch-local remove-pack <name>` | removes the pack and each of its parts no other installed pack uses |
| `ch-local status` | lists each installed pack, its version and tools, and the credential variable it uses or, by name, the ones it is missing |
| `ch-local snippet <client>` | the client's config entry, on stdout alone |
| `ch-local add <cursor\|vscode\|codex>` | writes that entry into the client's file and records it in `<home>/installed-clients.json`; run again after a Node upgrade, it rewrites its own entry. It never writes over, or claims, an entry it did not write, and keeps a file's permissions and symlink |
| `ch-local uninstall [--keep-data]` | takes back exactly the recorded entries, lists `<home>` and asks once, and removes only the names ch-local owns there; `--keep-data` keeps the store, module data, usage and caches but removes the program, the identity secret and `auth.json`; ends by naming the credentials to revoke |
| `ch-local start --stdio [options]` | what a client's entry runs: the installed runtime over stdio with every installed pack whose credential is set (it names the variable, never the value), in one per-user store under `<home>/store`, the sandbox enforced (on Windows too, with a runtime that has [countinghouse#195](https://github.com/mchen6/countinghouse/issues/195); with an older one, `audit`, said, until `ch-local upgrade`), no port. Only `--moduleSandbox enforce` or `audit` (to diagnose) and `--locale` may be passed; every other option is refused. It refuses to start if a pack declares a remote at an origin, or a variable for it, that the launcher does not allow, and sends each allowed origin one variable, the first one set, which it names. A pack gets the GitHub `origin` of the repository it runs in as its default repository, read from the repository's config (no git process runs). What one start writes is in `<home>/run/`, removed when it ends |
| `ch-local rollback [--yes]` | returns, in one step, to the release the last install replaced, which install keeps in `<home>/previous`: the runtime, packs and parts only; caches, usage records, settings, the identity secret and client entries are untouched. Running it again returns to the newer release. A pack the older release lacks stays recorded but is not loaded, and `status` says it needs the newer release. Undoing a release marked as a security fix names it, says what it fixed and asks, and without a terminal needs `--yes`. If one pack got worse, `remove-pack` it on the current release instead |
| `ch-local upgrade [--auto on\|off]` | shows installed and available versions from the npm registry, the only network call besides install, and asks once; `--auto` stores the opt-in automatic-upgrade setting, off by default |

`<home>` is `$COUNTINGHOUSE_HOME` (an absolute path) or `~/.countinghouse`. Every
command first checks Node: below 22.16 it says so and offers two ways on, to
install Node 24 yourself or to let ch-local fetch its own; that fetch is not
built yet, so a yes is refused and nothing is downloaded.

Part of the countinghouse client packs. Each package has its own repository; the family's design, plan and acceptance
tests are in [ch-packs](https://github.com/mchen6/ch-packs) (public).

## Development

```
npm ci
npm test
```

Pure JavaScript, no native module. Node 24 or later today (the runtime's
floor); 22.16 once countinghouse's floor shim lands (design). CI runs on
Linux, macOS and Windows.

**Unreleased installs.** Until the first release this launcher pins nothing,
so `install` and `add-pack` take `--unreleased-pins <file>`, a JSON file of
`{"pins": {<package>: {"version", "integrity"}}, "runtimeLockfile": {...}}`
written from the tarballs you built. The home is recorded as unreleased:
`status` and every `start` say so on one line, and `upgrade` refuses until a
clean install from a release. It is for development only.

**Dogfood.** `node scripts/dogfood.js` builds pack 1 from the current mains
and installs it that way, then prints the line to add it to Claude Code; see
[docs/development/dogfood.md](docs/development/dogfood.md).

**The smoke test.** `test/smoke.test.js` installs a fixture pack with no
remotes (`test/fixtures/smoke`) that way and speaks MCP to it through
`ch-local start --stdio`. It needs a countinghouse tarball
(`CH_SMOKE_RUNTIME_TGZ=<path to countinghouse-<version>.tgz>`) and is skipped
without one; CI's smoke job packs countinghouse master.

## Publishing

Releases are published by `.github/workflows/publish.yml` under npm
trusted publishing: a `v<version>` tag on a `main` commit whose
package.json carries that version. No npm token exists anywhere and no 2FA
code is typed for a release. One-time setup on npmjs.com, by the
maintainer: the package's first version is published by hand (`npm publish
--access public`, with 2FA); then **Settings → Trusted publishing → GitHub
Actions** with owner `mchen6`, repository `ch-local`, workflow
`publish.yml`, allowing `npm publish` as well as `npm stage publish`;
then **Settings → Publishing access → Require two-factor authentication
and disallow tokens**. A new trusted-publisher configuration must publish
once within two days or it expires.

## The shim (ch-shim)

`shim/` is ch-shim, the native program each client session runs when
countinghouse's shared runtime is in use. It relays the client's stdio to the
runtime, makes the handshake, reconnects, and replays its session's
tightenings (countinghouse's
`docs/superpowers/specs/2026-11-15-shared-runtime-design.md`). It is Rust,
with no async runtime and a few widely used crates. `cargo audit` and `cargo
deny` check it in CI. **It is a scaffold**: it follows contract 2 of that
spec, which is still under review, and is not yet wired to a runtime.

- **Build and test:** `cd shim && cargo test`. The toolchain is pinned in
  `shim/rust-toolchain.toml`; the conformance vectors are
  `shim/tests/vectors/contract-2.json`, copied from countinghouse.
- **CI:** `.github/workflows/shim.yml` tests and builds the six targets on
  their own architectures: Linux, macOS and Windows, each on x64 and arm64.
  Release 1 ships unsigned. The workflow's signing job is a disabled
  placeholder for macOS notarization and Windows signing, due in a later
  point release.
- **Packages:** `@countinghouse/ch-shim-<os>-<arch>`, one per target, each
  holding its binary, and `@countinghouse/ch-shim`, which has an exact
  optionalDependency on each, so npm installs only the matching one. The
  wrapper has no `bin`: a JS launcher would put Node back in every session's
  process tree. Its `locate()` gives the binary's path, and ch-local
  writes that path into each client's config. It also says when a
  supported platform's package is missing (an install with
  `--omit=optional`, or a lockfile made on another platform), so that is
  reported, never silently run in the per-session mode. A platform with no
  ch-shim at all runs the per-session mode. The Linux builds are static
  (musl), so they need no particular glibc.

### The daemon (`ch-local daemon`)

The shim starts `ch-local daemon --home <home>` when no shared runtime is
running. The daemon holds the runtime for every session of this user.
- **Its home and environment are fixed.** `--home` must be absolute, be
  the daemon's working directory, and be owned by this user with no group or
  world write. Its environment is `shim.json`'s allowlist (`PATH`, `HOME`,
  `LANG`, `TMPDIR`; on Windows their equivalents), never a client's.
- **Its GitHub token comes from `gh auth token` only**, held in memory as
  `COUNTINGHOUSE_GITHUB_TOKEN`. A `GITHUB_TOKEN` in a shell doesn't reach
  it. With no `gh` login, the shared runtime has no token, so a pack that
  needs one isn't loaded there. A session whose client chooses a token of
  its own (`COUNTINGHOUSE_GITHUB_TOKEN`, or `GITHUB_TOKEN` with no `gh`
  login) then differs from the daemon's, and runs its own runtime. That
  fails safe: no session gets another's token, or none silently.
- **On Windows it doesn't run yet.** Each session runs its own runtime there
  until the Windows daemon lands.

### Publishing the shim

A tag `shim-v<version>` on a `main` commit, where `<version>` is
`shim/Cargo.toml`'s, makes shim.yml publish all seven packages under npm
trusted publishing: the six platform packages first, then the wrapper. The
repository holds no token.

**One-time setup, by the maintainer, in one sitting.** npm configures a
trusted publisher only on a package that already exists, so each of the
seven names is first published by hand:

1. From a `shim-v<version>` CI run, download the six `ch-shim-<os>-<arch>`
   artifacts into `artifacts/`, keeping their directory names.
2. `node npm-shim/assemble.js --version <version> --artifacts artifacts --out dist/npm-shim`
3. `npm login`, with 2FA. Then, in each of `dist/npm-shim/ch-shim-*/`,
   followed last by `dist/npm-shim/ch-shim/`, run `npm publish --access public`.
4. On npmjs.com, for each of the seven packages: **Settings → Trusted
   publishing → GitHub Actions**, with owner `mchen6`, repository
   `ch-local` and workflow `shim.yml`. Then **Settings → Publishing access
   → Require two-factor authentication and disallow tokens**.
5. Tag the next version within two days, so each new trusted-publisher
   configuration publishes once before it expires.

## License

Apache-2.0.
