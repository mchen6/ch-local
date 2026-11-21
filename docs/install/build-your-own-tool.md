# Building a tool of your own

Claude Code can build a small tool with you and add it to countinghouse as
your own module, beside your packs. Ask it, for example, "build me a tool
that summarises a CSV file". The `ch-packs` plugin's `countinghouse-setup`
skill hands over to its `countinghouse-module` skill, which works with you in
this order:

1. the need, and what the tool may return;
2. the split into services and actions, shown to you and approved before any
   file is written;
3. the module, written in a folder you choose, outside the countinghouse
   home;
4. a check of its files (`countinghouse_validate_module`), which never runs
   its code;
5. you add it, in your own terminal (below);
6. a call, to see it work.

## Before you add one

An own module runs inside the same countinghouse runtime as your packs. The
sandbox limits what module code can do, but it is not a security boundary:
code written to escape it could reach your other packs' keys. It can send
what it is given to any internet address. Add only code you trust, and
re-add after every change.

## Adding it

Run this in your own terminal, not in a conversation:

```bash
node ~/.countinghouse/bin/ch-local.js add-module "<the module's folder>"
```

(`~/.countinghouse` is the home: `$COUNTINGHOUSE_HOME` when it is set.) It
checks the folder without running any of its code, then shows what it is
about to add and asks you. For a module that calls a pack's module and a
service of its own, it looks like this:

```text
Add your own module csv-summary 1.0.0 (code ba385218dcf1, 4 files)?
It runs inside the same countinghouse runtime as your packs.
It can connect to the internet and send what it is given.
It calls ch-access-github.
It calls https://sheets.example.invalid; add its key with `node "…/bin/ch-local.js" credentials add csv-summary`.
Add it? [y/N]
```

- `code` is the short hash of the module's files: what you confirm is
  exactly what is copied and loaded.
- "It calls <module>." names each installed module your tool calls.
  add-module lists the modules your tool calls; it does not list which of
  your keys those modules use. A module your tool calls acts with its own
  key, so your tool can use that key through it.
- "It calls <address>" is a service your module declares a key for.
- If the module asks for file paths, network hosts or environment
  variables, a line says so; under the enforced sandbox it gets none of
  them.
- If a key or data is already kept under the module's name (from an earlier
  add), a line says the module will use them.

Only a yes there adds it: "Added csv-summary (own, ba385218dcf1): your
clients see it now." Claude Code never runs this command for you and never
answers its question. `countinghouse_load_module` tells the agent the same:
in this setup it never loads a module itself. Running it again on unchanged
files changes nothing ("csv-summary ba385218dcf1 is already added: nothing
changed.").

What a module needs to be added:

- It is a scenario: `"countinghouse": {"role": "scenario"}` in its
  package.json. Otherwise its tools are never listed.
- It has no npm dependencies and no `node_modules` folder: copy any code it
  needs into its own folder.
- Its name and device name are its own: not a pack's, a part's or another
  module's, and not in the `@countinghouse/` scope.
- The sandbox is enforced (the default).
- Its folder is named by its real path, not through a link. On macOS `/tmp`
  and `/var` are links (to `/private/tmp` and `/private/var`): keep the
  folder under your home folder, or give its real path (`/private/tmp/…`).

What is added is the copy you confirmed, by the hash of its files. If the
folder changes afterwards, nothing changes in countinghouse until you run
`add-module` again and confirm again. A copy that no longer matches what you
confirmed is held back, never loaded.

## A key for it

If your module calls a service that needs a key, add the key as for a pack,
in your own terminal:

```bash
node ~/.countinghouse/bin/ch-local.js credentials add <module name>
```

It is sent only to the address your module declares.

## Seeing and removing it

`ch-local status` lists each module you added under "own modules", with the
short hash of what you confirmed, and either its tools or why a start would
not load it:

```text
own modules:
  csv-summary (own, unpinned, ba385218dcf1)   on; tools: summarise_csv
```

or, for example, `not loaded: calls ch-access-github, which needs a
credential: run …`, or `not loaded: its files changed since you added it:
run … add-module … again`.

```bash
node ~/.countinghouse/bin/ch-local.js remove-module <module name>
```

removes it ("Removed csv-summary."). Its data and its key are kept, and the
command says where the data is and how to remove the key.

Remove a tool with `remove-module`, and everything with `ch-local
uninstall`: both handle the copies of your tools, which the home keeps
read-only (under `own`). Deleting the home by hand fails on those copies
with "Permission denied" until you make them writable again:

```bash
chmod -R u+w ~/.countinghouse/own
```

On Windows, clear their read-only attribute instead:

```bat
attrib -r "%USERPROFILE%\.countinghouse\own\*" /s /d
```

(These are the default home's paths. With `COUNTINGHOUSE_HOME` set, use its
`own` folder instead: `chmod -R u+w "$COUNTINGHOUSE_HOME/own"`, or
`attrib -r "%COUNTINGHOUSE_HOME%\own\*" /s /d`.)
