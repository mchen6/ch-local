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

Two settings are stored in a different unit from the one countinghouse's
option and a live `set` over the control channel take:

- `requestTimeout` is stored in milliseconds, and passed in whole seconds,
  rounded down and at least 1: `Math.max(1, Math.floor(ms / 1000))`. A
  tightened timeout never comes out looser than asked;
- `locale` is stored as `en` or `zh`, and passed as `en-US` or `zh-CN`.

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
- `{"by": "start", "setting", "old", "new", "change": "changed outside
  ch-local"}`: see below.

A line with `new` and a `change` label other than `changed outside ch-local`
(such as a change for this start only) does not change what the file is
expected to hold.

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
- a ceiling that cannot be trusted refuses a start whose settings or flags
  are looser than the defaults.

On Windows the sandbox is left out until ch-local installs a runtime with
countinghouse#195: start runs it under audit there, which no setting or flag
chose.

## Edits made outside the tools

Each `start` replays the history to the last value recorded for each
setting and compares `settings.json` with it, under the lock. Each
difference is said on stderr and recorded as `changed outside ch-local`, once.
The file is the user's: the edit still applies.

A running start does the same on each change it applies in place: an edit
made outside the tools is said and recorded, and the change is bound by the
ceiling as start's values are (a cap or timeout clamped, a pack turned on
that the ceiling forbids left off). Under a ceiling that cannot be trusted, a
change that loosens is not applied: the settings in effect are kept.
