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

The launcher asks the GitHub CLI for the token each time it starts
(`gh auth token`) and holds it in memory: log `gh` in once with
`gh auth login`. No config entry sets a token, and none is written to a file.
A token from `gh auth login` carries gh's scopes, which can write to your
repositories. For a narrower one, set a fine-grained, read-only token
(Actions read, Contents read) in `COUNTINGHOUSE_GITHUB_TOKEN`: when it is set,
the launcher uses it and does not ask `gh`.

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
