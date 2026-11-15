# Installing a pack in your client

One page per client:

- [Claude Code](claude-code.md)
- [Cursor](cursor.md)
- [VS Code (Copilot)](vscode.md)
- [Codex CLI](codex.md)
- [Claude Desktop](claude-desktop.md)

Every client runs the same launcher: the Node you have, with
`~/.countinghouse/bin/ch-local.js start --stdio`
(`$COUNTINGHOUSE_HOME` instead of `~/.countinghouse` when it is set). The
launcher is installed once, with `ch-local install --pack ci-failure-triage
--from <directory of tarballs>`: every tarball is checked against the version
and integrity this launcher pins, then installed into `~/.countinghouse/app`
by `npm ci`. Installing straight from npm (`npx @countinghouse/ch-local install
--pack ci-failure-triage`) arrives with the first release. `ch-local add
<cursor|vscode|codex>` writes a client's entry for you, and `ch-local
uninstall` takes back exactly what install and add wrote.

`ch-local snippet <client>` prints the exact entry for this machine. The
entry names the absolute path of the Node that ran `ch-local`, because a
client started from the dock or the Start menu often has no `PATH` set up by
nvm. An nvm or system Node upgrade changes that path: run `ch-local snippet
<client>` again and replace the entry.

The launcher asks the GitHub CLI for the token each time it starts
(`gh auth token`) and holds it in memory: log `gh` in once with
`gh auth login`. No config entry sets a token, and none is written to a file.
A token from `gh auth login` carries gh's scopes, which can write to your
repositories. For a narrower one, set a fine-grained, read-only token
(Actions read, Contents read) in `COUNTINGHOUSE_GITHUB_TOKEN`: when it is set,
the launcher uses it and does not ask `gh`.

For headless or CI use, where `gh` is not logged in, the launcher falls back
to `GITHUB_TOKEN` from the environment the client is started from. A token set
in the environment is plaintext in that client's config, or wherever you set
it. A client started from the dock or the Start menu may not find `gh` on the
`PATH` your shell sets. Only Codex's entry lists the two
variable names, because Codex does not pass its environment on by default.
