# Settings: the file, the lock and the history

`ch-local settings` and countinghouse's `countinghouse_settings` tool change
the same `<home>/settings.json`. Both follow this protocol, so neither loses
the other's change and every change is recorded.

## The file

`<home>/settings.json` is `{"version": 1, "values": {...}}`. It is replaced
whole: written to a temporary file in the home, then renamed over it.

When it is read:

- A name the reader does not know is ignored, with a warning. A newer
  countinghouse and an older ch-local can share a home.
- A known name with a value its allowlist does not allow makes the whole file
  bad. So does a file that is not JSON, or not version 1.
- A bad file is never applied in part:
  - `ch-local start` refuses to start and says why;
  - a running start keeps the settings in effect;
  - `ch-local settings get` prints the problem;
  - `set` refuses until the file is fixed or `ch-local settings reset` removes
    it.

ch-local start passes the file to countinghouse as `--settingsFile`.

## On and off, and a module's settings

- **`enabled.<package>`** turns a top-level module on or off, for every
  session: `ch-local settings set enabled.@acme/weather-tool off`. Off is
  made at once, and the modules that call it go with it. On is a loosening,
  so it's asked at a terminal and bound by the ceiling's `modules`. A part
  has no switch: `set enabled.<part>` is refused, naming the modules that
  call it, and an `enabled.<part>` written into the file is ignored with a
  warning.
- **`pack.<name>`**, the earlier form, is still read as its pack's scenario
  module's entry, and **off wins**: a leftover `pack.x: false` keeps that
  module off whatever `enabled.*` says. A terminal "on" removes the
  leftover in the same write. `set pack.<name>` is refused and names the
  `enabled.*` command to use. The install that moves a home to
  `modules.json` moves each `pack.<name>` to `enabled.<module>`.
- **A module's settings** are stored as `module.<package>.<setting>`:
  - `ch-local settings modules [<module>]` lists them, for modules not loaded
    too;
  - `ch-local settings set <module>.<setting> [<value>]` checks a value with
    the installed runtime's own reader before anything is written, and
    prompts for it when it is left out;
  - `ch-local settings reset <module>[.<setting>]` goes back to the defaults.

  A `confirm: true` setting, or one the ceiling marks `confirm`, asks at a
  terminal; one the ceiling `fixed` refuses every change. A value over 64
  characters is recorded in the history cut, with the SHA-256 of the whole.
  A running client has its runtime read the values again at once.

`requestTimeout` is stored in a different unit from the one countinghouse's
option and a live `set` over the control channel take: it is stored in
milliseconds, and passed in whole seconds, rounded down and at least 1:
`Math.max(1, Math.floor(ms / 1000))`. A tightened timeout never comes out
looser than asked.

## The lock

`<home>/settings.lock` is held around every change, from reading the file to
writing it:

1. Create it whole: write `{"pid", "host", "at"}` to a temporary file in the
   home, then `link()` it to `settings.lock`. If the link fails with
   `EEXIST`, another writer holds it.
2. A lock whose mtime is more than 30 s old belongs to a holder that died.
   Remove it only if it is still the same file (same inode), then try again.
   An empty or unreadable lock is never taken for stale by its content.
3. Wait up to 5 s, retrying every 50 ms. Then give up, change nothing, and say
   that another change is under way.
4. The holder releases it, removing it only if its content is still the
   holder's own.

## The history

Every change appends one JSON line to `<home>/history.jsonl` before the file
is written. If the line cannot be appended, the change is not made. A line
carries:

- `at`;
- `by`, which is `cli` or the tool's caller;
- `setting`, `old` and `new`;
- `loosened: true` when the change loosens a guarding setting.

A reset is recorded as `{"setting": "*", "change": "reset"}`.

More lines, from countinghouse part 3 (guarding settings by conversation):

- `confirmed: "cli"` on a loosening made at a terminal, after the user
  answered yes. (Conversation's own confirmation is recorded by the runtime.)
- `{"setting", "change": "not made", "problem"}` when the file could not be
  written after the change's line was appended: the change before it, for
  that setting, did not happen.
- `{"setting", "asked", "change"}` (and later `count`): a request the
  runtime did not make, such as `not confirmed` or `refused by the ceiling`.
- `{"by": "settings tool", "setting", "old", "new", "change": "all
  sessions", "session"}` (with `confirmed` on a loosening the user
  confirmed): a session's change for all sessions, kept in the file. It is
  the runtime's own change, never one made outside. `{"setting", "change":
  "all sessions: not made", "problem"}` follows it when the file could not be
  written: that change did not happen.
- `{"by": "start", "setting", "old", "new", "change": "changed outside
  ch-local"}`: see below.

A line with `new` and a `change` label other than `changed outside ch-local`
or `all sessions` (such as a change for this start only, a session's own
value, or a change for all sessions until the runtime restarts) does not
change what the file is expected to hold.

## Loosening from the terminal

`ch-local settings set` and `ch-local upgrade --auto on` make a tightening
at once. A loosening is:

1. checked against the operator's ceiling (below), and refused, before
   anything is asked, if it is above it, forbidden by it, or the ceiling
   cannot be trusted;
2. asked at the terminal: `Loosen <name> from <old> to <new>? ... [y/N]`.
   Only `y` or `yes` makes it. There is no `--yes`. Without a terminal (stdin
   is not a TTY) it is refused. This stops accidents; an agent with a shell
   answers through its client's own command approval, which is the user's;
3. made under the lock, only if the setting still holds the value it had
   when the user was asked.

A raised `maxOutputBytes` or `requestTimeout` is kept in `settings.json`: a
value above what the running runtime started with takes effect when it next
starts (for the shared runtime, when it restarts: `ch-local restart`); a
value at or under it takes effect at once.

`ch-local settings reset` is the loosenings it implies: a module that was
off comes back on, a tightened cap goes back up. A module's settings are
kept. Each is checked against the
ceiling, then one question at the terminal lists them all. A reset that only
tightens is made at once. A settings file that is not valid is reset only at
a terminal: what it held cannot be known.

## The operator's ceiling

ch-local reads the ceiling with the installed runtime's own reader,
`node_modules/countinghouse/lib/settings-ceiling.js`, so there is one
implementation. If the installed runtime has none and a ceiling file exists
(`/etc/countinghouse/ceiling.json`, or `%ProgramData%\countinghouse\ceiling.json`),
every loosening is refused until `ch-local upgrade`. A reader that throws, or
answers anything but a ceiling, fails closed.

`ch-local start` applies it to what it passes the runtime:

- a cap or timeout above the ceiling is passed as the ceiling's value, and
  said; `settings.json` is not rewritten;
- a forbidden `moduleSandbox audit` runs under `enforce`, and forbidden
  automatic upgrades stay off, each said; `--moduleSandbox audit` passed by
  the client refuses the start;
- `"modules": [package names]`, the operator's allowlist: only those
  modules ever load, parts included, at start, in place and on install,
  whatever `settings.json` or the history say. A module that calls one not
  listed doesn't load either. `install` and `add-pack` check every module of
  the pack first, and refuse it whole, naming the ones missing. A ceiling
  that cannot be trusted loads no module at all, and says why: an operator's
  mistake (a typo, a PowerShell that timed out, an older reader) is visible,
  never a lifted list. A ceiling that still holds `"packs"` is not trusted
  ("it holds "packs", which is no longer read: list each module under
  "modules""). A first install, with no runtime yet to read the ceiling,
  goes on, and `start` then applies it;
- a ceiling that cannot be trusted refuses a start whose settings or flags
  are looser than the defaults.

On Windows with a runtime older than countinghouse#195 the sandbox is left
out: start runs audit there, which no setting or flag chose, and says so. A
runtime with #195 runs enforce on Windows as everywhere (lib/sandbox-support.js).

## Edits made outside the tools

Each `start` replays the history to the last value recorded for each
setting and compares `settings.json` with it, under the lock. Each
difference is said on stderr and recorded as `changed outside ch-local`, once.
The file is the user's: the edit still applies, unless it is a loosening the
ceiling forbids, which is said and recorded at every start and not applied.
A settings lock held by another writer, or kept fresh on purpose, never
turns the checks off: a loosening the history has not recorded is not
applied while the lock is held.

A running start does the same on each change it applies in place: an edit
made outside the tools is said and recorded, and the change is bound by the
ceiling as start's values are (a cap or timeout clamped, a pack turned on
that the ceiling forbids left off). Under a ceiling that cannot be trusted, a
change that loosens is not applied: the settings in effect are kept.

## Never silent

What `start` says about the settings and the ceiling goes on stderr and to
the client as a notice over the control channel, which the runtime puts on
the next result of any tool and sends as an MCP `notifications/message`. An
outside edit, and each change a running start applies, is also written to
the history. At start, a value clamped, a loosening refused or kept back, and a module
the ceiling keeps from loading are said on stderr and to the client only;
a running start that applies a change records in the history a module the
change newly keeps out (one turned off excepted), under this release's
record. Notices found before the runtime is up are sent once
it says it is ready; one the runtime does not take is said on stderr. The notices reach the user through the model; stderr and the
history are the record it cannot edit.

## Confirmed in the client's dialog

The runtime may ask the user to confirm a loosening in their client's own
dialog (countinghouse's `docs/security-model.md`, "Confirming a loosening in
the client's dialog"). Before every dialog it asks start, over the control
channel (`may-elicit`), whether the client's own configuration could answer
the dialog for the user. `lib/client-conditions.js` answers. For Claude Code
the answer is yes only when:

- the session says it is an interactive CLI one (`CLAUDE_CODE_ENTRYPOINT=cli`
  and `CLAUDECODE=1`), and `CLAUDE_PROJECT_DIR` is an absolute directory that
  exists;
- no Elicitation or ElicitationResult hook, whatever its matcher, is in the
  user's settings (`settings.json`, `settings.local.json` and
  `remote-settings.json` under `CLAUDE_CONFIG_DIR` or `~/.claude`), the
  managed settings and `managed-settings.d/`, any project, cwd or `--add-dir`
  directory's `.claude` settings (with their ancestors), or a `--settings` or
  `--managed-settings` the client was started with;
- no project or local settings file enables a plugin or adds a marketplace;
- no installed plugin has such a hook: the plugin cache, every
  `--plugin-dir` and `--plugin-dir-no-mcp` (a plugin, or a folder of them),
  and `CLAUDE_CODE_PLUGIN_DIRS` and `CLAUDE_CODE_PLUGIN_SEED_DIR`;
- no skill, agent or command markdown (the user's, any project's, any
  plugin's whole tree) mentions those events, or holds anything that could
  spell one without the plain word;
- every flag on the client's command line is one known not to touch hooks
  or plugins (`SAFE_FLAGS`), and no `CLAUDE_*` variable names a plugin,
  settings, hook, managed, policy, skill, marketplace, mods or config-dir
  source the scan does not read. Two plugin variables Claude Code sets for
  a plugin's own MCP server are known: `CLAUDE_PLUGIN_ROOT`, only when it is
  one of the plugins the scan reads (by its real path, named by it, the same
  directory), and `CLAUDE_PLUGIN_DATA` (absolute), the plugin's data
  directory, which nothing is loaded from. Any other `CLAUDE_PLUGIN_*`
  (`CLAUDE_PLUGIN_OPTION_<KEY>`, a hook's) is not. A root whose path crosses
  a link (a linked `~/.claude` or home, a `CLAUDE_CONFIG_DIR` through one, a
  Windows short-name profile) is not known either, so a session there gets
  no form;
- everything it reads could be read. A file that is not JSON or is over
  1 MiB, a relative `--settings`, `--plugin-dir` or `--add-dir`, a client
  not found among start's ancestors, or a managed source it cannot read
  (the Windows policy key, the macOS managed-preferences profile) means no.

A plugin developer who runs Claude Code with a relative `--plugin-dir` gets
no dialog, and uses the terminal command instead.

Start reads the client's command line once, in the background (on Windows
through PowerShell, which takes seconds), and scans at once. A hook seen
holds for the whole start, though it is removed; every `may-elicit` scans
again. A check waits at most 3 s, under the runtime's 5 s. The scan follows
the Claude Code version tested; what a later one adds is covered by the
runtime's exact-version tested list and the automated re-test.
`lib/client-conditions-fixtures.js` (`LOCATIONS`, `plant()`) holds one
fixture per source, for these tests and for that re-test.

A module is turned on and off for every session, at a terminal
(`ch-local settings set enabled.<module> on|off`) or by the runtime's
settings tool, which writes `enabled.*` itself (countinghouse M5b), never for
one start. The runtime sends no `load-pack` or `unload-pack` ask any more
(M5b, and M6 removed the pack form), and ch-local answers none: one that
came would be the control channel's `CONTROL_UNKNOWN`.

What a session hears instead comes with the unload: a module turned off is
unloaded with `reason: "off"`, and a caller that went with it with
`reason: "calls"` and `because`. On a runtime that serves the settings tool
with the module off in its settings file, each session is told the
runtime's own text, with the way back (countinghouse's moduleMessages
vectors, ids 9 and 10). Anywhere else, the unload's own notice is told
(`<module> turned off`). A module the operator's ceiling refuses is
unloaded with no reason, its notice saying the operator's settings don't
allow it.

## Limits

- `history.jsonl` is a record for the user, not a security boundary: the user
  can write it. Nothing the ceiling enforces rests on it (the pack allowlist
  is the ceiling's own list); outside-edit reports do, and are a notice.
- ch-local reads the ceiling with the runtime under `<home>/app/node_modules/
  countinghouse`. Whoever can replace that code is beyond any ceiling, as
  they are beyond the runtime itself.

`ch-local uninstall --keep-data` keeps `settings.json` with the history, so a
reinstall keeps the user's own tightenings.
