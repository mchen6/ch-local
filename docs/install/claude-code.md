# Claude Code

## Add

The plugin is the simplest route:

    claude plugin marketplace add mchen6/ch-local
    claude plugin install ch-packs@ch-packs

It adds the `ci_failure_triage` tool and a skill that tells Claude to call it
first when a CI run failed. The plugin runs the installed launcher; if it is
not installed yet, the tool fails with one line naming the install command.

Or add the server by hand. `ch-local snippet claude-code` prints the command
for this machine, for example:

    claude mcp add --scope user countinghouse -- /usr/local/bin/node /home/you/.countinghouse/bin/ch-local.js start --stdio

A path with a space is double-quoted. The line is for a POSIX shell (bash,
zsh) or, on Windows, `cmd.exe`. In PowerShell an npm-installed `claude`
(`claude.ps1`) drops the `--` before the command, so on Windows run it in
`cmd.exe`, or use the plugin
([`claude mcp add`](https://code.claude.com/docs/en/mcp)).

## Credentials

A credential belongs to a module: the key, for that module's variable, to
the one address the module declares. `ch-local install` and `add-pack` ask
for each module that needs one at their end, or name it with no terminal;
any time later, at a terminal:

```
ch-local credentials add ch-access-github
```

It shows the variable and the address the key will be sent to before it asks
anything, then reads the key with nothing shown as you type or paste it. For
GitHub's MCP server (exactly `https://api.githubcopilot.com`) it first offers
your `gh` login, if `gh` has one (default No): a yes stores no key, and each
start asks `gh auth token` and holds it in memory. A token from
`gh auth login` carries gh's scopes, which can write to your repositories; a
fine-grained, read-only token (Actions read, Contents read) is narrower.

The key is kept in `credentials/` in the ch-local home, readable by your user
only. Another program running as your user can read that file, as it can read
`gh`'s own token; ch-local doesn't use the system keychain yet.
`ch-local credentials list` shows each module's variable, address and source,
never a key; `ch-local credentials remove <module>` removes it. The shared
runtime takes an added or removed key once its calls in flight finish; a
session on a runtime of its own unloads a removed or changed one at once, and
takes a new one at its client's next start.

No client config entry sets or forwards a credential, and a token in the
environment your client starts from is not used. A key is used only for the
address it was added for: a module version that sends it somewhere else is
not loaded until you add it again. Never paste a token into the conversation.

For headless or CI use, pipe the key in and name the address:
`ch-local credentials add ch-access-github --to https://api.githubcopilot.com`
reads one line from standard input.

## Node

The hand-added entry names the absolute path of your Node. An nvm or system
Node upgrade changes that path: run `ch-local snippet claude-code` again,
then `claude mcp remove --scope user countinghouse` and add the new line.
The plugin runs `node` from the `PATH` Claude Code sees, which must be Node
22.16 or later; below that it stops with one line saying so.

## Remove

    claude plugin uninstall ch-packs@ch-packs

or, for the hand-added server:

    claude mcp remove --scope user countinghouse
