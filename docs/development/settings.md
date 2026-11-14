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

- `requestTimeout` is stored in milliseconds, and passed in seconds,
  `Math.ceil(ms / 1000)`;
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
