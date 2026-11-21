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

It runs in the foreground until you stop it with Ctrl-C. The first time, it
makes an admin key and keeps it for later starts; `dev-server` never prints
it. Once the server is listening, it prints two commands that add the server
to Claude Code with that key. Run both in a second terminal, then restart
Claude Code:

```bash
claude mcp remove --scope user countinghouse-dev >/dev/null
claude mcp add --scope user --transport http countinghouse-dev http://127.0.0.1:7531/mcp --header "X-CH-Key: $(cat "<home>/dev-auth/admin-key")" >/dev/null
```

`claude mcp add` repeats the header it was given, key included, in its own
output, so that output is sent nowhere (`>/dev/null`; `| Out-Null` in
PowerShell). Don't remove that part, and don't paste the output anywhere.

The first time, `remove` says there is no such server: that's fine. On
Windows, run them in PowerShell: it prints the PowerShell form, which reads
the key with `Get-Content -LiteralPath` (cmd and Git Bash would not read the
key there).
(`<home>` is `~/.countinghouse`, or `$COUNTINGHOUSE_HOME` when it is set.)

Later starts on the same port use the same key, so Claude Code's entry keeps
working, and they print no commands. `dev-server --new-key` makes a new key
and prints the two commands again; a start on another port needs it, and
`dev-server` says so.

On a machine other people log into, start it with --new-key each time: while
the server is stopped, another account could listen on its port and catch the
key Claude Code sends. Claude Code sends it at the start of every session, in
every project, since the entry is the user's. The key lets whoever holds it
run code as you on this machine: the server's tools load and run any module
from any path.

## Where the key is

Your terminal fills in the key from its file, so it never appears in a
conversation, and `claude mcp add`'s own output, which repeats it, is sent
nowhere. Claude Code keeps it in its own settings on this machine, as
part of the `countinghouse-dev` entry. The key file is readable by your user
only; while `claude mcp add` runs, the key is also in its command line, which
other users of this machine may be able to see. The server listens only on
127.0.0.1 and runs your own code. Claude Code is told never to read the key
file or that entry.

## Where things are

- `<home>/dev/modules`: your tools' modules, one directory each. The server
  doesn't load them by itself: after each start, ask Claude Code to load your
  tool again before you use it.
- `<home>/dev/store`: the development server's own data.
- `<home>/dev-auth`: the admin key and its configuration.

The server uses port 7531. If the port is in use, `dev-server` says so and
exits; choose another with `dev-server --port <n> --new-key`, and run the two
commands it prints (`remove`, then `add` with that port).

## Limits in this release

- A tool runs with a short environment: `PATH`, `HOME`, `LANG` and `TMPDIR`
  (on Windows, the system's own variables), plus the locale and
  `NODE_EXTRA_CA_CERTS`. No other variable of yours reaches it, and no
  credential is passed to it, so a tool that needs a key or a token can't get
  one on the development server.
- It does not work through an HTTP proxy: no proxy variable is passed.
- It runs the countinghouse your packs installed. Install a pack first;
  without one, `dev-server` says so.
- Your packs are not loaded there, and their credentials are not used.
- Stop it before `ch-local upgrade`, `rollback` or `uninstall`: they replace
  or remove the countinghouse it runs.

## Stopping and removing

Ctrl-C stops the server. To remove it from Claude Code:

```bash
claude mcp remove --scope user countinghouse-dev
```

`ch-local uninstall` removes `<home>/dev-auth` always, and `<home>/dev` (your
modules) unless you pass `--keep-data`. It reminds you to remove the
`countinghouse-dev` entry from Claude Code, which only you can do.
