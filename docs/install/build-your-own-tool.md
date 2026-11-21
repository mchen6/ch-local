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
checks the folder without running any of its code, copies it into the home,
shows you what the module can reach, and asks you to confirm. Only a yes
there adds it; Claude Code never runs this command for you and never answers
its question. `countinghouse_load_module` tells the agent the same: in this
setup it never loads a module itself.

What a module needs to be added:

- It is a scenario: `"countinghouse": {"role": "scenario"}` in its
  package.json. Otherwise its tools are never listed.
- It has no npm dependencies and no `node_modules` folder: copy any code it
  needs into its own folder.
- Its name and device name are its own: not a pack's, a part's or another
  module's, and not in the `@countinghouse/` scope.
- The sandbox is enforced (the default).

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

`ch-local status` lists each module you added as `own`, with the short hash
of what you confirmed, and says why one is not loaded.

```bash
node ~/.countinghouse/bin/ch-local.js remove-module <module name>
```

removes it. Its data and its key are kept, and the command says how to
remove them too.
