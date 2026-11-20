# Installing a pack in your client

One page per client:

- [Claude Code](claude-code.md)
- [Cursor](cursor.md)
- [VS Code (Copilot)](vscode.md)
- [Codex CLI](codex.md)
- [Claude Desktop](claude-desktop.md)

With Claude Code you can also [build a tool of your own](build-your-own-tool.md),
on a separate local development server.

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

A module that needs a credential gets it from ch-local's store, never from
the environment your client starts from, and no config entry sets or
forwards one: `ch-local install` asks for it at its end, and
`ch-local credentials add <module>` adds it any time. Each client's page
says more under "Credentials".

Changes to the store are made one at a time: `credentials add`,
`credentials remove` and `uninstall` each take its lock for the moment
they write (a key is typed before that). One that finds another
ch-local changing it waits a few seconds, then says which command holds
it and changes nothing; run it again when that one is done.
