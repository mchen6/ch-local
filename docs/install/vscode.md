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

The pack reads `COUNTINGHOUSE_GITHUB_TOKEN` (or, failing that,
`GITHUB_TOKEN`) from the environment VS Code is started from: the server
inherits it, and no config entry sets it. The portable format has no secret store, and needs none.

Started from the dock, the Start menu or a desktop icon, VS Code does not
see what your shell's profile sets: start it from a terminal (`code .`), or set
the variable for your desktop session.

## Node

The entry names the absolute path of your Node. An nvm or system Node upgrade
changes that path: run `ch-local snippet vscode` again and replace the entry.

## Remove

Delete the `countinghouse` entry from `~/.copilot/mcp-config.json`.
