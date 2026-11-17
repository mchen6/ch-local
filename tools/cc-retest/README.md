# Claude Code version re-test: the surface diff

Before a new Claude Code version goes on countinghouse's tested-client allowlist for the part 3 confirmation dialog (`lib/elicitation-clients.js` there), its **config surface** is diffed against the last approved version's. No model call is made, and nothing is installed or run.

```
node tools/cc-retest/surface.js <version>                       # against the newest approved snapshot
node tools/cc-retest/surface.js <version> --against <version>
node tools/cc-retest/surface.js <version> --approve             # record a snapshot, after the hand test
node tools/cc-retest/surface.js <version> --approved-dir <dir>  # snapshots elsewhere (a trial run)
```

The exit code is `0` for a pass, `1` for a fail, and `2` when the diff could not run. The first line printed is the one-line report; the JSON detail follows it.

## What it does

- **Fetches** `@anthropic-ai/claude-code@<version>` and each platform package in its `optionalDependencies` (the native binaries) from the npm registry. Each tarball is streamed and never written to disk. Its sha512 must equal the registry's published `dist.integrity`, or the version is refused.
- **Extracts** identifiers from every file's bytes, JS bundle and binary alike:
  - `env`: `CLAUDE_CODE_*`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_*`, `DISABLE_*` and `ENABLE_*` names;
  - `flags`: `--long-flag` tokens;
  - `files`: settings and config file names and paths (user, project and managed);
  - `hookTerms`: identifiers that mention hooks, plugins, marketplaces, elicitation, managed sources or policy.
- **Fails** the version when a *new* item touches hooks, plugins, settings, managed sources, policy, marketplaces or elicitation, and on any new file path. The one-line report names the items. Other new items are listed. Removed items are listed too, since they may mean ch-local's location list (`lib/client-conditions.js`) is stale.

## Expect flags, and review them

The surface is large: 2.1.325 has about 2,500 flags and 1,750 terms, many from bundled libraries. So most Claude Code releases will flag something new. The honest default is **off until reviewed**, which is safe because it fails closed. A flag doesn't keep a version off for good.

**The review step for a flagged version:**
1. A person (the maintainer, or the reviewer) reads the diff's `failing` items in the JSON detail. Each one either reaches a place Claude Code reads hooks, plugins or settings from, or it doesn't.
2. If none does, they approve the snapshot: `node tools/cc-retest/surface.js <version> --approve`, committed in a PR the reviewer merges with the allowlist change.
3. If one does, ch-local's location list (`lib/client-conditions.js`) learns the new place first, in its own PR with a test, and then the version is approved as in step 2.

## Snapshots

`approved/<version>.json` holds only the extracted identifiers (names, flags and paths), never a code excerpt, plus each package's version and integrity and the extractor's version. A snapshot from another extractor version has to be taken again before a diff will run.

No snapshot is approved yet. The first is recorded with `--approve` once the maintainer has hand-tested a version.

The live canary (Claude Code driven in a pty against ch-local) and the daily scheduling come later.
