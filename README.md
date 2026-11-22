# @countinghouse/ch-local

The countinghouse client-pack launcher: installs pinned packs into ~/.countinghouse, starts the runtime over stdio for Claude Code, Cursor, VS Code and Codex, prints each client's config entry, upgrades on request and never silently.

**Status: preview.** Every command below is built, with the Claude Code
plugin: `start`, `session` and the shared runtime, and installing from npm
(`install --pack <name>` with no `--from`). Installing from npm works once a
release pins the packages; until then, install from tarballs with `--from`.

## What it does

`ch-local snippet <claude-code|cursor|vscode|codex|claude-desktop>` prints
the client's config entry for the installed launcher on stdout, alone, so it
can be piped. On stderr it names the Node it pinned and how to reprint the
entry after a Node upgrade. Every entry runs `<absolute node>
<home>/bin/ch-local.js session --home <home>`, where
`<home>` is `$COUNTINGHOUSE_HOME` (absolute) or `~/.countinghouse`.
At each session start, `session` runs the shared runtime through the native
shim install placed and recorded (`<home>/shim/ch-shim`), once it passes its
ownership and mode checks; otherwise (no shim for this platform, or one set
aside because a session still used the old one) the session runs its own
runtime, as `start --stdio`. The entry never names the shim, so it stays
right whichever way that goes.
A home must be yours alone, because what runs from it is given every stored
key. On Linux and macOS it must be yours and private (`0700`, as install makes
it); on Windows its DACL must be private. `install` refuses any other home
(exit 1), and `session`, `start` and the Claude Code plugin's launcher refuse
it with exit 2. Each names the fix. For a home only too open to read (`0755`)
that is the `chmod 700` line, and on Windows the `icacls` lines. On Linux and
macOS, a home that others could write in may already have been changed, so the
fix is to move it aside and install again, never a `chmod` that would trust
what is in it. The plugin's launcher, and a ch-local run
from outside the home (npx, a checkout), check the home before running any of
its code. An entry that runs the home's own launcher (`node <home>/bin/ch-local.js
session …`, as the other clients' snippets do) runs the home's code first, and
that code makes the same check, so it protects a home only while the home is
still yours. Keep it private from the start, as install makes it.
The folders above the home are checked too, along its path and
its real path. On Linux and macOS each must be yours or root's, and writable
by no one else, except a sticky one such as `/tmp` or your own primary
group's. Otherwise another user could move the home away and put theirs in
its place. Your primary group is accepted because most Linux systems give each
user a private group of their own, and a umask of `0002` leaves the folders in
a home group-writable with no one else in that group. If your primary group
is shared with other users, keep the home under folders that group can't
write in. On Windows the folders above the home are not checked: keep it under
your own profile.

No entry sets or forwards a credential: a module's credential is stored
with `ch-local credentials add <module>`, bound to the one address the
module declares, and a client's environment never supplies one.
A session's own runtime starts from an allowlisted environment, never the
client's whole one: `PATH`, the home and temporary directories, the locale
and time zone, `NODE_EXTRA_CA_CERTS`, and each module's key in a slot of
its own. Networks that reach the internet only through an HTTP proxy are
not supported yet: countinghouse makes no call through a proxy, so no
proxy variable is passed.
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

`ch-local` here is `node ~/.countinghouse/bin/ch-local.js` (or `npx @countinghouse/ch-local`) unless you installed it globally. On Windows, `node "%USERPROFILE%\.countinghouse\bin\ch-local.js"`.

| Command | What it does |
|---|---|
| `ch-local install --pack ci-failure-triage --from <dir>` | checks each tarball in `<dir>` against the version and sha512 integrity this launcher pins (a tarball not on the list, a wrong hash or a missing one stops it before anything runs). It builds `<home>/app` with the runtime (this launcher and countinghouse) as an npm project with its lockfile, pinned at release so every dependency's version and integrity is fixed too, by `npm ci --omit=optional --ignore-scripts`. The pack's own packages have no npm dependencies and are unpacked beside it by a strict tar reader (files and directories only, no links, size-capped); one that declares dependencies is refused. The new app is swapped in only when complete (the old one goes back if it cannot, and the one replaced is kept in `<home>/previous` for `rollback`). Install writes `<home>/bin/ch-local.js`, `<home>/modules.json` and `<home>/shim.json`, and places each module in `<home>/module-store/<package>/<version>/` (one already there at its pin is not placed again). Every other installed pack this release lists moves to its pins; one it no longer lists stays recorded, as withdrawn. From npm it also places this platform's shim (below) |
| `ch-local install [--from <dir>]` | with no `--pack`: installs again exactly what the home's record lists, at this ch-local's own release; it never adds a pack and never changes the release |
| `ch-local add-pack <name> --from <dir>` | adds another pack this release pins beside the installed ones, checked the same way; a part another pack already uses is shared at its pinned version, and one installed at another version stops it (run `upgrade` first). No client file changes: the entry runs `start`, which loads every pack |
| `ch-local remove-pack <name>` | removes the pack and each of its parts no other installed pack uses |
| `ch-local status` | lists each installed module, its version and what it is: on with its tools, a part, or why it is not loaded (with the command that fixes it), and the credential it uses; then each pack and its module count, and a running client still on another ch-local |
| `ch-local snippet <client>` | the client's config entry, on stdout alone |
| `ch-local add <cursor\|vscode\|codex>` | writes that entry into the client's file and records it in `<home>/installed-clients.json`; run again after a Node upgrade, it rewrites its own entry. It never writes over, or claims, an entry it did not write, and keeps a file's permissions and symlink |
| `ch-local uninstall [--keep-data]` | takes back exactly the recorded entries, lists `<home>` and asks once, and removes only the names ch-local owns there. While the shared runtime still serves, it removes nothing and says so: the runtime stops 10 minutes after the last client closes; `--keep-data` keeps the store, module data, usage and caches but removes the program, the identity secret and `auth.json`; ends by naming the credentials to revoke |
| `ch-local session [--home <abs>]` | what a client's entry runs: the shared runtime through the installed shim, or else `start --stdio` (below) |
| `ch-local start --stdio [options]` | a session's own runtime: the installed runtime over stdio, in one per-user store under `<home>/store`, the sandbox enforced (on Windows too, with a runtime that has [countinghouse#195](https://github.com/mchen6/countinghouse/issues/195); with an older one, `audit`, said, until `ch-local upgrade`), no port. It loads each installed module that is on, allowed by the operator's ceiling, at its pins and with its credential in ch-local's store (never the environment), and your own modules under `enforce`; each one it doesn't load is said, with why. Each module's credential goes in a slot of its own, for its declared address only, and start names the variable it sends, never the value. Only `--moduleSandbox enforce` or `audit` (to diagnose: audit watches what a pack reads and refuses its file writes outside its own area, but only reports, and does not stop, a process, a thread or native code it starts; only enforce confines it; start says so) and `--locale` may be passed; every other option is refused. What one start writes is in `<home>/run/<host>-<pid>-<random>/`, removed when it ends |
| `ch-local rollback [--yes]` | returns, in one step, to the release the last install replaced, which install keeps in `<home>/previous`: the runtime, packs and parts only; caches, usage records, settings, the identity secret and client entries are untouched. Running it again returns to the newer release. A pack the older release lacks stays recorded but is not loaded, and `status` says it needs the newer release. Undoing a release marked as a security fix names it, says what it fixed and asks, and without a terminal needs `--yes`. If one pack got worse, `remove-pack` it on the current release instead |
| `ch-local credentials [list \| add <module> [--to <origin>] \| remove <module>]` | a module's key, in ch-local's store: `add` asks for it at a terminal without showing it, after saying where it will be sent (for GitHub it can offer your `gh` login); with `--to <origin>` it reads the key from stdin, and the origin must be the one the module declares. `list` shows each variable, its origin and its source, never a value; `remove` deletes one. A running shared runtime restarts to use the change |
| `ch-local settings [get \| set <name> <value> \| reset]` | ch-local's settings; `settings modules [<module>]`, `settings set <module>.<setting> [<value>]` and `settings reset <module>[.<setting>]` for each module's own. A loosening is confirmed at a terminal, and every change is written to `<home>/history.jsonl` |
| `ch-local add-module <dir>` | adds a module of your own, after showing what it declares and the modules it calls and asking at a terminal; copied into the home under its code's hash |
| `ch-local remove-module <name>` | removes one of your own modules; its data and its key are kept |
| `ch-local upgrade --check` | shows what `upgrade` would show up to its question, then the line to run in your own terminal; it asks nothing, installs nothing and needs no terminal |
| `ch-local upgrade [--auto on\|off]` | shows installed and available versions from the npm registry (ch-local's only network call besides install and the opt-in automatic check; a running module reaches its own declared server), the release's security marking and its own change notes, and asks once. A release is installed as one: every installed pack it lists moves to its pins, whichever way each module's version moves, with no version asked; it shows each module that moves (saying when one moves back), each it no longer lists, and what it adds, judged against the modules this home has installed. `--auto` stores the opt-in automatic-upgrade setting, off by default |

A module that calls a module of another pack needs that pack installed
first. `install` and `add-pack` check each module against this release's
description of it, reading only what they place and what the home already
holds, so a call into a pack not installed is refused, naming the pack to
install first; a module of a withdrawn or held pack does not count. Two
packs whose modules call each other cannot be installed in release 1 (each
needs the other first). No pack in this release calls outside itself.

## Verify it yourself

Three facts you can check on your own machine, with your home as `<home>`:

- **The packs' only remote host is `https://api.githubcopilot.com`**, GitHub's MCP server, reached by ch-access-github. `node <home>/bin/ch-local.js credentials list` shows each stored key's origin.
- **The triage cache holds no log text**: one `fingerprints.json` per repository (`/data/<owner>__<name>/fingerprints.json` inside the pack), with run and job ids, commit SHAs, times, the algorithm that signed each entry, GitHub's conclusion word for a run with no job, and hashes (the failure's signature, the step's name and the error lines, each hashed). `find <home>/module_data -name fingerprints.json` lists them.
- **Usage is recorded on this machine**, in `<home>/store/usage`. `node <home>/app/node_modules/countinghouse/bin/countinghouse-usage.js --usageDir <home>/store/usage` prints the report outside any conversation (`--since 7d`, `--groupBy tool`, `--json` or `--csv`).

`<home>` is `$COUNTINGHOUSE_HOME` (an absolute path) or `~/.countinghouse`. Every
command first checks Node: below 22.16 it says so and offers two ways on, to
install Node 24 yourself or to let ch-local fetch its own; that fetch is not
built yet, so a yes is refused and nothing is downloaded.

Part of the countinghouse client packs. Each package has its own repository. The family's design and plan are in
[ch-packs](https://github.com/mchen6/ch-packs) (public); the end-to-end acceptance test, which installs every package and calls the
tool, runs in this repository's CI.

## Development

```
npm ci
npm test
```

Pure JavaScript, no native module. Node 22.16 or later, as countinghouse; CI
tests Node 24 on Linux, macOS and Windows, and the 22.16 floor on Linux. The one native program is the shim (below), and
it is never part of `<home>/app`: that tree is built with `npm ci
--omit=optional --ignore-scripts`, so no optional or native package enters
it.

**Unreleased installs.** Until the first release this launcher pins nothing,
so `install` and `add-pack` take `--unreleased-pins <file>`, a JSON file of
`{"pins": {<package>: {"version", "integrity"}}, "runtimeLockfile": {...}, "modules": {...}}`
written from the tarballs you built (`node scripts/describe-release.js <tarballs>
--unreleased-pins <file>` writes `modules`, each pack module's description,
checked at install as a release's are). The home is recorded as unreleased:
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
`docs/superpowers/specs/2026-11-15-shared-runtime-design.md`). It follows
contract 2 of that spec: it attaches to the daemon's runtime and proves the
secret, relays every message, reattaches and resumes after a loss, and hands
the session to a runtime of its own when the shared one asks. It is Rust,
with no async runtime and a few widely used crates. `cargo audit` and `cargo
deny` check it in CI.

### Why Rust

Every client session runs one shim for as long as the session lasts, so its
footprint is paid once per session. Measured on Linux x64
(`shim/bench/memory.py`, which runs the shim against a runtime written from
contract 2; 2026-11-15, the main branch's release build):

| | RSS | PSS |
|---|---|---|
| ch-shim, idle | 3.1 MB | 1.1 MB |
| ch-shim, after relaying 20 answers of 1 MiB each | 3.1 MB | 1.1 MB |

- What it replaces: the per-session Node relay of the design's revision 3,
  measured then at 13 MB PSS each (countinghouse's
  `docs/superpowers/specs/2026-11-15-shared-runtime-design.md`). The shim
  is about a twelfth of that, per session.
- The shim streams each answer through without holding it, so its memory
  stays flat however large the answers are.
- The binary is 0.7 MB (693,168 bytes on that build).
- A JS launcher would also put Node back in every session's process tree,
  which is why the wrapper package below has no `bin`.

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
  optionalDependency on each, so npm installs only the matching one. That
  wrapper is for installing the shim with npm directly. The wrapper has no
  `bin`: a JS launcher would put Node back in every session's process tree.
  Its `locate()` gives the binary's path. It also says when a supported
  platform's package is missing (an install with `--omit=optional`, or a
  lockfile made on another platform), so that is reported, never silently
  run in the per-session mode. A platform with no ch-shim at all runs the
  per-session mode. The Linux builds are static (musl), so they need no
  particular glibc.
- **How ch-local installs it:** not through `<home>/app`'s optional
  dependencies, which `--omit=optional` drops by design. An install from
  npm fetches only this platform's `@countinghouse/ch-shim-<os>-<arch>`, at
  the version this launcher pins, checked by its integrity and provenance as
  each pack's tarballs are, and places it at `<home>/shim/ch-shim`. An
  install with `--from` sets the shim aside. Client entries never name it:
  `session` runs it. A source checkout uses `shim/target/release/ch-shim`
  (cargo's build), else the platform package in its own `node_modules`
  (`lib/shim-binary.js`).

### The daemon (`ch-local daemon`)

The shim starts `ch-local daemon --home <home>` when no shared runtime is
running. The daemon holds the runtime for every session of this user.
- **Its home and environment are fixed.** `--home` must be absolute, be
  the daemon's working directory, and be owned by this user with no group or
  world write. Its environment is `shim.json`'s allowlist (`PATH`, `HOME`,
  `LANG`, `TMPDIR`; on Windows their equivalents), never a client's.
- **Its credentials are the store's.** Each module's key, stored with
  `ch-local credentials add <module>` (or the gh login it was told to use,
  asked with `gh auth token` at each start), goes to the runtime in a slot
  of its own, `COUNTINGHOUSE_CREDENTIAL_<n>`, for that module and its
  declared address only. A key added or removed while it runs restarts its
  runtime once the calls in flight finish, waiting at most as long as a
  call may take (the `requestTimeout` setting, 30 seconds by default) and
  2 seconds more. A
  module without one isn't loaded; the runtime still starts, with
  ch-local's own tools, and `countinghouse_overview` lists the module as
  held back for a missing credential, with the command that adds it. No session's environment gives a credential, so no
  session runs its own runtime for one.
- **Installs and rollbacks are picked up while it runs.** `ch-local install`
  and `ch-local rollback` leave an upgrade request in
  `<home>/run/daemon/requests`. A daemon that's running then drains its
  runtime (waiting for the calls in flight, at most `requestTimeout` and
  2 seconds) and restarts
  it on the release now in place. If ch-local itself
  changed, it hands over to a new daemon. Confirmed loosenings don't survive
  a hand-over (each session is told), and tightenings do.
- **Where the runtime listens.**
  - On Linux and macOS it's `<home>/run/daemon/sessions.sock`. When the home's path makes that too long for a socket (over 107 bytes on Linux, 103 on macOS), it's `$TMPDIR/ch-<uid>/sessions.sock` instead, a directory made 0700 and checked, where `TMPDIR` is `shim.json`'s (the one install recorded), else the system's temporary directory.
  - On Windows it's a named pipe, `\\.\pipe\countinghouse-<32 hex>`, with a new random name at each runtime start, recorded in `daemon.json`.
  - The secret always stays in `<home>/run/daemon`.
- **On Windows its files are owner-only by DACL.**
  - `<home>\run` and `<home>\run\daemon` get a protected DACL: this user and SYSTEM only, inherited by what's made in them.
  - The daemon refuses to start, naming what's wrong, unless the home, `<home>\run` and `<home>\run\daemon` each pass the private-DACL rule the shim applies to `<home>\run\daemon`.
  - `daemon.json` and `failed.json` are created with an owner-only DACL.

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
