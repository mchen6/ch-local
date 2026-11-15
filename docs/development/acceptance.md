# The acceptance run

`scripts/acceptance.js` checks pack 1 end to end, as a user gets it. It runs
in CI (`.github/workflows/acceptance.yml`) and can be run by hand.

1. It builds countinghouse and every pack package from their mains, the
   same way `scripts/dogfood.js` does.
2. It installs them into a clean, temporary home.
3. It starts the home with the sandbox enforced (`--moduleSandbox off` is
   refused first).
4. It calls `ci_failure_triage` over MCP.

GitHub is a local stand-in serving recorded results (`test/fixtures/mcp-results`).
The runtime sends GitHub's origin there through `--remoteOriginMap`, which
countinghouse honours only under `COUNTINGHOUSE_ACCEPTANCE=1` and logs at
start as acceptance-only. The stand-in accepts only a token generated for the
run. No token of yours is read, and nothing calls GitHub's API.

The checks:
- the receipt counts the calls to github, lists github under `standIn`,
  and its sentence marks the stand-in;
- the usage report counts those calls in its `standIn` section, none as
  real server calls, and their usage records are marked `mapped`;
- the token is in no file under the home;
- the server exits when its client closes stdin;
- install to first result takes under 5 minutes;
- uninstall leaves nothing.

The report is JSON, with every check, the timings and, on a failure, the
runtime's log.

## By hand

From a ch-local checkout, with Node 24:

```bash
CH_ACCEPTANCE_SRC=<dir of clones> node --test test/acceptance.test.js
```

`CH_ACCEPTANCE_SRC` names a directory of clones (`<dir>/<repo>`), used at
their last fetched `origin/main`. A repository missing there is cloned from
GitHub. Two optional variables take comma-separated `repo=value` pairs:
- `CH_ACCEPTANCE_CLONES=repo=path` points at a clone elsewhere;
- `CH_ACCEPTANCE_REFS=repo=ref` builds another branch.

`CH_ACCEPTANCE_REPORT=<file>` keeps the report. Without `CH_ACCEPTANCE_SRC`
the whole run is skipped, and the unit cases still run. You can also run the
script itself:

```bash
node scripts/acceptance.js --src <dir of clones> [--clone repo=path]... [--ref repo=ref]... [--report <file>]
```
