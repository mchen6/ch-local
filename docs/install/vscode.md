# VS Code (Copilot)

## Add

`ch-local snippet vscode` prints the entry for this machine, in the portable
format of `~/.copilot/mcp-config.json`. Merge it under `mcpServers`:

    {
      "mcpServers": {
        "countinghouse": {
          "type": "stdio",
          "command": "/usr/local/bin/node",
          "args": ["/home/you/.countinghouse/bin/ch-local.js", "start", "--stdio"]
        }
      }
    }

`.vscode/mcp.json` is deprecated for February 2027, so it is not the target
here.

## Token

The launcher asks the GitHub CLI for the token each time it starts
(`gh auth token`) and holds it in memory: log `gh` in once with
`gh auth login`. No config entry sets a token, and none is written to a file.
A token from `gh auth login` carries gh's scopes, which can write to your
repositories. For a narrower one, set a fine-grained, read-only token
(Actions read, Contents read) in `COUNTINGHOUSE_GITHUB_TOKEN`: when it is set,
the launcher uses it and does not ask `gh`.

For headless or CI use, where `gh` is not logged in, the launcher falls back
to `GITHUB_TOKEN` from the environment VS Code is started from. A token set
in the environment is plaintext in that client's config, or wherever you set
it. A client started from the dock or the Start menu may not find `gh` on the
`PATH` your shell sets.

Started from the dock, the Start menu or a desktop icon, VS Code does not
see what your shell's profile sets: start it from a terminal (`code .`), or set
the variable for your desktop session.

## Node

The entry names the absolute path of your Node. An nvm or system Node upgrade
changes that path: run `ch-local snippet vscode` again and replace the entry.

## Remove

Delete the `countinghouse` entry from `~/.copilot/mcp-config.json`.
