# Release 1: the acceptance checklist

What the maintainer checks before tagging release 1. Each line says what is
checked, how, and where the evidence is. Nothing is tagged or published until
every line is checked off. A line that can't be checked holds the release.

The checks are grouped. Within a group, the order doesn't matter.

## The code

1. **The acceptance run is green on Linux and macOS.**
   - How: run `.github/workflows/acceptance.yml` on the release commit of
     `main` (it runs on every push to `main`).
   - Evidence: that run's two jobs, and their `acceptance-report-<os>`
     artifacts. Every check is `ok: true` with `skipped 0`, `fail 0`, and
     install-to-first-result under 5 minutes.
   - Windows: the job reports without gating until countinghouse #272 (the
     enforced sandbox on an 8.3 short path) closes. After that, it gates
     like the others.
2. **The latency gate's verdict is a pass.**
   - How: the latency split, a warm call through the native shim against
     the per-session mode, measured by the gate harness on a quiet machine.
   - Evidence: the gate report that closes the register row, with its
     numbers and its verdict.
3. **The P2 hand test passed for the Claude Code version the release
   supports.**
   - How: the settings tool's confirmation dialog, by hand: a loosening asked
     for in conversation gets the dialog, a decline locks it, an expiry
     counts, and a confirmed change applies.
   - Evidence: the countinghouse pull request that adds that version's range
     to `lib/elicitation-clients.json` (`tested`), which names the hand test.
4. **The shared runtime serves two or more Claude Code sessions at once.**
   - How: install, then open two sessions in different repositories. In
     each, list the tools and call `ci_failure_triage`.
   - Check:
     - one daemon: one `pid` in `<home>/run/daemon/daemon.json`;
     - each session gets its own answer and its own receipt;
     - a tightening made in one session doesn't reach the other;
     - closing one session leaves the other working.
   - Evidence: the hand-test notes, with `daemon.json`, each session's
     output, and `history.jsonl`.
5. **Per-session modules behave as section 4a of countinghouse's
   shared-runtime design says.**
   - How: countinghouse's R1 tests, on its CI. Two sessions get separate
     store keys and `/data`, a hop runs in the calling session's worker, and
     the 16-worker cap hands a slot over with its notice.
   - Evidence: the R1 pull request's green CI.
6. **Audit mode warns, and refuses a pack's writes outside its own area.**
   - How: `ch-local start --stdio --moduleSandbox audit`, and a start with
     `moduleSandbox: audit` stored, and a start on Windows.
   - Check: each says "audit watches what a pack reads and never lets it
     change files outside its own area" exactly once. countinghouse's audit
     writes test passes.
   - Evidence: `test/start.test.js` (ch-local), countinghouse's
     `test/sandbox/60-audit-writes.js`, and one hand start's stderr.
7. **Uninstall leaves nothing.**
   - How: the acceptance run's last check, plus one hand uninstall on each
     system. Answer yes, then check the home is gone.
   - Check: `<home>` no longer exists. The client entries ch-local wrote
     are removed, and no others are touched.
   - Evidence: the acceptance report's "uninstall leaves nothing" check,
     and the hand-test notes.

## Upgrades

8. **Automatic upgrades are off by default.**
   - How: a clean install with no terminal (stdin not a TTY), then
     `ch-local settings`.
   - Check: install says "automatic upgrades are off (no terminal to ask)",
     and `autoUpgrade` is off. At a terminal, install asks once, and a no is
     kept.
   - Evidence: `test/upgrade.test.js` (offerAuto), and the hand install's
     output.
9. **An automatic upgrade waits 72 hours.**
   - How: the tests that pin the wait. Optionally, a hand run against a
     version published inside the window.
   - Check: the wait counts from the later of the version's verified
     publish time and when the install first saw it. 71 hours doesn't
     install; 73 does. `ch-local upgrade` doesn't wait.
   - Evidence: `test/auto-apply.test.js`.
10. **Rollback undoes an upgrade.**
    - How: by hand, after an upgrade: `ch-local rollback`, then
      `ch-local rollback` again.
    - Check: the runtime, the packs and the native shim return to the
      release before, with data, settings and the identity secret unchanged.
      A second rollback returns to the newer one.
    - Evidence: `test/rollback.test.js`, and the hand-test notes.

## Release gating

11. **The publish environment is set up** on each repository that
    publishes: ch-local, countinghouse, and each pack's repository.
    - How: each repository's Settings → Environments.
    - Check: a protected environment that only the release workflow uses,
      requiring the maintainer's approval.
    - Evidence: `gh api repos/<owner>/<repo>/environments` for each.
12. **The tag rulesets are in place.**
    - How: each repository's Settings → Rules.
    - Check: `v*` and `shim-v*` tags only on commits reachable from `main`,
      created only by the maintainer, and never moved or deleted. The
      upgrade's provenance check relies on this: it binds a version to a
      tag, and only the ruleset binds the tag to `main`.
    - Evidence: `gh api repos/<owner>/<repo>/rulesets` for each.
13. **Trusted publishers are configured on npm for every package a release
    pins.**
    - Which packages: `@countinghouse/ch-local`, `countinghouse`, each pack
      and part, and the shim's six `@countinghouse/ch-shim-<os>-<arch>`
      packages.
    - Check: each is tied to its repository and its workflow (`publish.yml`,
      or `shim.yml` for the shim's six), with "require two-factor
      authentication and disallow tokens" on.
    - Evidence: each package's settings on npmjs.com.
14. **No tag and no publish has happened before.**
    - How: `git ls-remote --tags` on each repository, and `npm view <name>
      versions` for each package.
    - Check: no `v*` or `shim-v*` tag. No npm version, except a first
      version the maintainer published by hand only to set up trusted
      publishing. A release never pins such a version, since it has no
      provenance.
    - Evidence: the two commands' output, saved with the checklist.

## After the tag

15. **The released packages verify as an upgrade would.**
    - How: a clean `ch-local install` from npm, with no `--from`.
    - Check: every package is fetched by its pin, and its provenance
      verifies under the shipped Sigstore root. That includes the native
      shim for the system it runs on.
    - Evidence: the install's output on each system.
