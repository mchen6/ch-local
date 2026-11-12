# Codex CLI

## Add

`ch-local snippet codex` prints the entry for this machine. Append it to
`~/.codex/config.toml`:

    [mcp_servers.countinghouse]
    command = "/usr/local/bin/node"
    args = ["/home/you/.countinghouse/bin/ch-local.js", "start", "--stdio"]
    env_vars = ["COUNTINGHOUSE_GITHUB_TOKEN", "GITHUB_TOKEN"]

`env_vars` lists the variables Codex passes from its own environment to the
server ([docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)); the
file holds their names, never the token. The config-file entry is preferred
over `codex mcp add --url`, which probes the server for OAuth and may start a
browser login.

## Token

The pack reads `COUNTINGHOUSE_GITHUB_TOKEN` (or, failing that,
`GITHUB_TOKEN`) from the environment `codex` is started from. Codex does not
pass its environment to a server by default, which is why the entry lists the
two names in `env_vars`. `codex` runs in a terminal, so a variable your
shell's profile sets reaches it; an IDE or dock launcher that starts it does not
see that profile.

## Node

The entry names the absolute path of your Node. An nvm or system Node upgrade
changes that path: run `ch-local snippet codex` again and replace the entry.

## Remove

    codex mcp remove countinghouse

or delete the `[mcp_servers.countinghouse]` table from
`~/.codex/config.toml`.
