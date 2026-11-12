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

    claude mcp add --scope user ci-failure-triage -- /usr/local/bin/node /home/you/.countinghouse/bin/ch-local.js start --pack ci-failure-triage --stdio

A path with a space is single-quoted. The line is for a POSIX shell (bash,
zsh) or PowerShell, which both read single quotes literally; Windows
`cmd.exe` does not, so on Windows run it in PowerShell, or use the plugin
([`claude mcp add`](https://code.claude.com/docs/en/mcp)).

## Token

The pack reads `COUNTINGHOUSE_GITHUB_TOKEN` (or, failing that,
`GITHUB_TOKEN`) from the environment Claude Code is started from: the server
inherits it, and no config entry sets it. Never paste a token into the conversation or into a config file.

`claude` in a terminal sees your shell's profile. An IDE or desktop app that
hosts Claude Code, started from the dock, the Start menu or a desktop icon,
does not: start it from a terminal, or set the variable for your desktop
session.

## Node

The hand-added entry names the absolute path of your Node. An nvm or system
Node upgrade changes that path: run `ch-local snippet claude-code` again,
then `claude mcp remove --scope user ci-failure-triage` and add the new line.
The plugin runs `node` from the `PATH` Claude Code sees, which must be Node
22.16 or later; below that it stops with one line saying so.

## Remove

    claude plugin uninstall ch-packs@ch-packs

or, for the hand-added server:

    claude mcp remove --scope user ci-failure-triage
