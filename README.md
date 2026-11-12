# @countinghouse/ch-local

The countinghouse client-pack launcher: installs pinned packs into ~/.countinghouse, starts the runtime over stdio for Claude Code, Cursor, VS Code and Codex, prints each client's config entry, upgrades on request and never silently.

**Status: preview.** `ch-local snippet <client>` and the Claude Code plugin
are here. `install`, `start`, `uninstall` and `upgrade` land next (Tasks 11
and 12 of the pack family's plan in [ch-packs](https://github.com/mchen6/ch-packs)).

## What it does

`ch-local snippet <claude-code|cursor|vscode|codex|claude-desktop>` prints
the client's config entry for the installed launcher on stdout, alone, so it
can be piped. On stderr it names the Node it pinned and how to reprint the
entry after a Node upgrade. Every entry runs `<absolute node>
<home>/bin/ch-local.js start --pack ci-failure-triage --stdio`, where
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

Part of the countinghouse client packs. The design, the plan and the
acceptance tests live in [ch-packs](https://github.com/mchen6/ch-packs);
each package has its own repository (maintainer's decision, 2026-11-11).

## Development

```
npm ci
npm test
```

Pure JavaScript, Node 22.16 or later, no native module. CI runs on
Linux, macOS and Windows.

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
