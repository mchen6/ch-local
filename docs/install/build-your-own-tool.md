# Building a tool of your own

Claude Code can build a small tool for you and run it on a separate
countinghouse development server on this machine. Ask it, for example,
"build me a tool that summarises a CSV file". The `ch-packs` plugin's
`countinghouse-setup` skill hands over to its `countinghouse-module` skill,
which works with you in this order:

1. the need, and what the tool may return;
2. the split into services and actions, shown to you, and approved before any
   file is written;
3. validate, then load, then a call to check it works.

The tool is yours and stays on this machine. It runs on the development
server only: not inside your installed packs, not upgraded with them, and not
published or shared.

## The two commands

Claude Code asks you to run both in your own terminal, not in the
conversation:

```bash
node ~/.countinghouse/bin/ch-local.js dev-server
```

It runs in the foreground until you stop it with Ctrl-C. On its first run it
makes an admin key; the key is never printed. It then prints one command to
add the server to Claude Code. Run that in a second terminal, once:

```bash
claude mcp add --scope user --transport http countinghouse-dev http://127.0.0.1:7531/mcp --header "X-CH-Key: $(cat "<home>/dev-auth/admin-key")"
```

On Windows it prints the PowerShell form, which reads the key with
`Get-Content`. (`<home>` is `~/.countinghouse`, or `$COUNTINGHOUSE_HOME` when
it is set.)

## Where the key is

Your terminal fills in the key from its file, so it never appears in a
conversation. Claude Code keeps it in its own settings on this machine, as
part of the `countinghouse-dev` entry. The key file is readable by your user
only. The server listens only on 127.0.0.1 and runs your own code.

## Where things are

- `<home>/dev/modules`: your tools' modules, one directory each.
- `<home>/dev/store`: the development server's own data.
- `<home>/dev-auth`: the admin key and its configuration.

The server uses port 7531, so Claude Code's entry stays valid from one run to
the next. If the port is in use, `dev-server` says so and exits; choose
another with `--port <n>`, and add the entry again with that port.

## Limits in this release

- A tool runs with a short environment: `PATH`, `HOME`, `LANG` and `TMPDIR`
  (on Windows, the system's own variables), plus the locale and
  `NODE_EXTRA_CA_CERTS`. No variable of yours reaches it, and no credential
  is passed to it, so a tool that needs a key or a token can't get one on
  the development server.
- It does not work through an HTTP proxy: no proxy variable is passed.
- It runs the countinghouse your packs installed. Install a pack first;
  without one, `dev-server` says so.
- Your packs are not loaded there, and their credentials are not used.

## Stopping and removing

Ctrl-C stops the server. To remove it from Claude Code:

```bash
claude mcp remove --scope user countinghouse-dev
```

`ch-local uninstall` removes `<home>/dev-auth` (the key) always, and
`<home>/dev` (your modules) unless you pass `--keep-data`.
