# VS Code (Copilot)

`ch-local` on this page is `node ~/.countinghouse/bin/ch-local.js` (or `npx @countinghouse/ch-local`) unless you installed it globally. On Windows, `node "%LOCALAPPDATA%\countinghouse\bin\ch-local.js"` in cmd, or `node "$env:LOCALAPPDATA\countinghouse\bin\ch-local.js"` in PowerShell.

## Add

First do [Before you start](README.md#before-you-start): Node, the install, the credential.

`ch-local snippet vscode` prints the entry for this machine, in the portable
format of `~/.copilot/mcp-config.json` (or `$COPILOT_HOME/mcp-config.json`
when that is set). Merge it under `mcpServers`:

    {
      "mcpServers": {
        "countinghouse": {
          "type": "stdio",
          "command": "/usr/local/bin/node",
          "args": ["/home/you/.countinghouse/bin/ch-local.js", "session", "--home", "/home/you/.countinghouse"]
        }
      }
    }

VS Code's Copilot reads `~/.copilot/mcp-config.json` (`$COPILOT_HOME/mcp-config.json`
when that is set, where `ch-local add vscode` writes it too), with its servers
under `mcpServers`, as the Copilot CLI does. The editor-managed files, `.vscode/mcp.json` and the profile's
`mcp.json`, with their servers under `servers`, belong to VS Code's Local
harness, which is deprecated for removal in February 2027, so they are not the
target here. (Checked by hand against VS Code's MCP configuration reference
and GitHub's Copilot CLI docs, November 2026.)

In VS Code's Copilot chat, MCP servers start with your first chat message:
starting one by hand from MCP: List Servers before that fails with 'Cannot
start an MCP server before the session runtime has been created'.

The `ch-packs` plugin's skills (guided setup, building your own module, and
the CI triage guide) come with Claude Code only ([Claude
Code](claude-code.md)); in VS Code, countinghouse's tools and its overview
work without them.

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
changes that path: run `ch-local add vscode` again (or `ch-local snippet vscode`,
and replace the entry). Run `ch-local install` once too, so the shared runtime starts with the new Node.

## Remove

Delete the `countinghouse` entry from `~/.copilot/mcp-config.json` (or
`$COPILOT_HOME/mcp-config.json`), or run `ch-local uninstall`, which takes back
what `ch-local add vscode` wrote.
