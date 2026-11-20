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

## For an agent: install by conversation

When a user asks you to install countinghouse, follow these steps in order.
Before each command, say what it does, and run it only after the user says
yes. Never ask for, accept or repeat a token, key or password: a credential
is added only in the user's own terminal.

1. Check whether `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy` or `http_proxy`
   is set. Check only whether each is set, and never print its value: a
   proxy address can hold a password. For example:
   `node -e "console.log(['HTTPS_PROXY','HTTP_PROXY','https_proxy','http_proxy'].filter((k) => process.env[k]))"`.
   If one is, tell the user first: "This release of countinghouse does not
   work through an HTTP proxy, so it can't install or run on a network that
   reaches the internet only through one." Then ask whether to try anyway.
2. Install the pack: `npx @countinghouse/ch-local install --pack ci-failure-triage`.
   Before the first release, install from a prepared local release instead
   (below).
3. For each line `<module> needs a credential: in your own terminal run ...`
   in the install's output, ask the user to run that exact command in their
   own terminal, not in this conversation.
4. If the `ch-packs` plugin is not installed, run
   `claude plugin marketplace add mchen6/ch-local`, then
   `claude plugin install ch-packs@ch-packs`.
5. Ask the user to restart Claude Code, or to reconnect `countinghouse` in
   `/mcp`. Then call `countinghouse_overview` and tell the user what it
   reports. From then on, the plugin's `countinghouse-setup` skill carries
   the conversation.

### Before the first release: a prepared local release

From a ch-local checkout, `node scripts/dogfood.js --release-dir <dir>` builds
one into a new or empty directory: the tarballs (`<dir>/release`), their pins
(`<dir>/pins.json`) and `<dir>/INSTALL.txt`, which holds the command that
installs from it. Nothing is installed. That command replaces step 2:

    CH_LOCAL_DEV=1 node <checkout>/bin/ch-local.js install --pack ci-failure-triage --from <dir>/release --unreleased-pins <dir>/pins.json

Show the user that exact command and run it only after they say yes; if
`INSTALL.txt` holds anything but that one `ch-local … install` line, stop and
tell the user. It is for bash: on Windows, run it in Git Bash or WSL. The home is recorded
as unreleased: `status` and every start say so, and `upgrade` refuses until
a clean install from a release. Every other step is the same.

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
