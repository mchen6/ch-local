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

## Token

The packs that read GitHub need a token. The recommended one is a
fine-grained, read-only token (Actions read, Contents read), stored once at a
terminal:

```
ch-local credentials add github
```

It asks for the token with nothing shown as you type or paste it, and keeps
it in `credentials/` in the ch-local home, readable by your user only. Every
session uses it, including the shared runtime that serves them all. Another
program running as your user can read that file, as it can read `gh`'s own
token; ch-local doesn't use the system keychain yet.
`ch-local credentials list` shows what is stored (names only), and
`ch-local credentials remove github` removes it. The shared runtime moves to
a new or removed token once its calls in flight finish; a session that runs
a runtime of its own takes it at its next start (restart that client). Every
session sharing the runtime uses the token it then holds.

Without a stored token, the launcher asks the GitHub CLI each time it starts
(`gh auth token`) and holds the token in memory: log `gh` in once with
`gh auth login`. A token from `gh auth login` carries gh's scopes, which can
write to your repositories. No client config entry sets a token.

The order, the same everywhere: `COUNTINGHOUSE_GITHUB_TOKEN` set in the
environment Claude Code is started from, then the stored token, then
`gh auth token`, then `GITHUB_TOKEN`. A session whose environment sets a
token the shared runtime doesn't hold runs a runtime of its own.

For headless or CI use, where `gh` is not logged in, the launcher falls back
to `GITHUB_TOKEN` from the environment Claude Code is started from. A token set
in the environment is plaintext in that client's config, or wherever you set
it. A client started from the dock or the Start menu may not find `gh` on the
`PATH` your shell sets.
Never paste a token into the conversation.

`claude` in a terminal sees your shell's profile. An IDE or desktop app that
hosts Claude Code, started from the dock, the Start menu or a desktop icon,
does not: start it from a terminal, or set the variable for your desktop
session.

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
