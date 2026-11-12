# Cursor

## Add

`ch-local snippet cursor` prints the entry for this machine. Merge it into
`~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` (one project),
under `mcpServers`:

    {
      "mcpServers": {
        "countinghouse": {
          "command": "/usr/local/bin/node",
          "args": ["/home/you/.countinghouse/bin/ch-local.js", "start", "--stdio"]
        }
      }
    }

The entry has no `type` and no `env` ([Cursor's MCP docs](https://cursor.com/docs/context/mcp)).

## Token

The pack reads `COUNTINGHOUSE_GITHUB_TOKEN` (or, failing that,
`GITHUB_TOKEN`) from the environment Cursor is started from: the server
inherits it, and no config entry sets it. 

Started from the dock, the Start menu or a desktop icon, Cursor does not
see what your shell's profile sets: start it from a terminal (`cursor .`), or set
the variable for your desktop session.

## Node

The entry names the absolute path of your Node. An nvm or system Node upgrade
changes that path: run `ch-local snippet cursor` again and replace the entry.

## Remove

Delete the `countinghouse` entry from the `mcpServers` of the file you
added it to.
