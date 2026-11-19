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

The entry names the absolute path of your Node. An nvm or system Node upgrade
changes that path: run `ch-local snippet cursor` again and replace the entry.

## Remove

Delete the `countinghouse` entry from the `mcpServers` of the file you
added it to.
