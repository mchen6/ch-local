# Installing a pack in your client

One page per client:

- [Claude Code](claude-code.md)
- [Cursor](cursor.md)
- [VS Code (Copilot)](vscode.md)
- [Codex CLI](codex.md)
- [Claude Desktop](claude-desktop.md)

Every client runs the same launcher: the Node you have, with
`~/.countinghouse/bin/ch-local.js start --pack ci-failure-triage --stdio`
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

The pack reads GitHub with a read-only token in `COUNTINGHOUSE_GITHUB_TOKEN`
(or, failing that, `GITHUB_TOKEN`), from the environment the client is started
from. No entry sets it; only Codex's lists the two names, because Codex does
not pass its environment on by default.
