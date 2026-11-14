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
| `ch-local start --stdio [options]` | what a client's entry runs: the installed runtime over stdio with every installed pack whose credential is set (it names the variable, never the value), in one per-user store under `<home>/store`, the sandbox enforced (on Windows `audit`, until the runtime's enforce holds there: [countinghouse#195](https://github.com/mchen6/countinghouse/issues/195)), no port. Only `--moduleSandbox audit` (to diagnose) and `--locale` may be passed; every other option is refused. It refuses to start if a pack declares a remote at an origin, or a variable for it, that the launcher does not allow, and sends each allowed origin one variable, the first one set, which it names. A pack gets the GitHub `origin` of the repository it runs in as its default repository, read from the repository's config (no git process runs). What one start writes is in `<home>/run/`, removed when it ends |
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

## License

Apache-2.0.
