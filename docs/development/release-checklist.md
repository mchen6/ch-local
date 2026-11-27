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
3. **No client is on the tested-client list.**
   - How: `lib/elicitation-clients.json` in the countinghouse release holds
     `"tested": []` for every client, and by hand, a loosening asked for in
     conversation is answered with the terminal command and no dialog.
   - Evidence: the file at the release commit, and the record of that by-hand
     check.
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
   - Check: each says "under audit, countinghouse logs what a pack reads and
     refuses its file writes outside its own area; it does not stop a module
     that starts a process, a thread or native code: enforce refuses those"
     exactly once, as one notice (within the runtime's 200-character cut). countinghouse's audit
     writes test passes.
   - Evidence: `test/start.test.js` (ch-local), countinghouse's
     `test/sandbox/60-audit-writes.js`, and one hand start's stderr.
7. **Uninstall leaves nothing.**
   - How: the acceptance run's last check, plus one hand uninstall on each
     system. Close the clients first: while the shared runtime still serves,
     uninstall removes nothing and says so, and the runtime stops 10 minutes
     after the last client closes. Answer yes, then check the home is gone.
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
    - Also: a published shim names no local home path (byte check); shim.yml remap in 1.1.
14. **No tag and no publish has happened before.**
    - How: `git ls-remote --tags` on each repository, and `npm view <name>
      versions` for each package.
    - Check: no `v*` or `shim-v*` tag. No npm version, except the one-time
      placeholder (a throwaway pre-release under a dist-tag other than
      latest, deprecated once the real version is out). A release never
      pins it.
    - Evidence: the two commands' output, saved with the checklist.

20. **The Claude Code plugin's marketplace entry is pinned to this
    release's tag.**
    - Why: `claude plugin marketplace update` reads `.claude-plugin/
      marketplace.json` from this repository's default branch, and a
      relative-path source (`./clients/claude-code`) gives whatever that
      branch holds, not the release's checked files.
    - How: set the `ch-packs` entry's source to a pinned one (Claude Code's
      marketplace reference, "Plugin sources": `git-subdir` with `url`,
      `path`, and `ref` set to a tag or `sha` to a full commit), e.g.
      `{"source": "git-subdir", "url": "mchen6/ch-local", "path":
      "clients/claude-code", "ref": "v<version>", "sha": "<the tag's
      commit>"}`, on the default branch, after the tag exists. The tag is
      protected by the ruleset (item 12). `test/plugin.test.js` pins the
      entry's source: change it in the same commit as the entry.
    - Check: the docs do not say whether `git-subdir` may point into the
      marketplace's own repository. Before the first release, add the
      marketplace on a test machine, install the plugin and confirm the
      files are the tag's (the installed directory's commit). If it isn't
      supported, keep the relative path, and docs/install/claude-code.md's
      Updates already says the plugin follows the default branch. If it is,
      change that sentence with the entry: the plugin then follows the
      release tag.
    - Evidence: the marketplace.json commit, and the test install's
      `claude plugin list --json` entry.

21. **The release pins no part below its floor.**
    - Why: a home's parts are only as new as its release's pins. A floor
      (`floors` in lib/release-pins.json) names the version that carries a
      fix every release must hold, and with it every fix before it. Today's
      floors, each with the fixes it carries:
      - ch-step-redact 0.2.5: secrets and key blocks masked before a result
        reaches the model, with secret names inside escaped JSON (#11) and a
        password after an address and a colon (#12); its README true of the
        release (#17);
      - ch-step-log-clean 0.2.5: the same masking, with an omitted bare key
        body keeping redact's state and step names whole (#7); its README
        true of the release (#13);
      - ch-access-github 0.3.2: the GitHub remote asks for read-only tools
        (0.2.1), a refusal names its cause and a large log comes back as its
        tail (0.2.2); GitHub's attempt number and the workflow's id are given,
        and a run without a branch or a name no longer loses the list
        (#8, #10); a refusal for a rate limit says so in its details (#12);
        a step with no conclusion or name no longer loses the list, and a
        failed job without a name refuses the answer (#13);
      - ch-step-report 0.4.6: the summary quotes no step name and an
        e-mail address costs its field (#7), an @ before a password or after
        a redacted address is an address's (#8), and the final pass's (#9);
        a limit reached is said as one, the summary may be 520 characters,
        and an owner hint of no logins and one reason passes (#14);
      - ch-step-error-patterns 0.3.1: a FAIL's indented message is kept, and
        node's comparison past a long message is one of its values (#10);
      - ch-step-failure-signature 0.2.2, ch-step-dedupe 0.1.3,
        ch-step-owner-hint 0.1.3: their READMEs true of the release (#8, #7,
        #7);
      - ch-pack-ci-failure-triage 0.7.4: step names go through redact before
        any part, the result or the cache (#18); runs are compared by their
        workflow's id where GitHub gives one (#28), a success that was re-run
        only when the attempt before it is known (#29), and an older run's
        log that a part refuses does not lose the call (#30); the window's
        runs are listed a few at a time, a rate limit stops every GitHub
        call, a refusal of the runtime's own fails the call named, and the
        owner hint says when it was refused (#35); its README states the
        known limits of the new-or-recurring verdict (#36). 0.7.4 is built
        against its parts as its own repository pins them; the later
        versions of redact, log-clean, dedupe and owner-hint change their
        READMEs only.
    - How: the machine check holds it. lib/release-pins.js refuses a pin
      below its floor (a pre-release, or anything not a version, counts as
      below), `node scripts/describe-release.js <tarballs>` refuses a
      release tarball below its floor, and an unreleased install
      (`--unreleased-pins`) refuses a development pin below one.
      A floor binds the release whose file names it. A later release may
      lower or retire a floor, since its file is the maintainer's own
      provenance-signed document. Do that only on purpose, saying why in
      that release's notes. This line is the reminder
      to run that step on the release's own tarballs and to read its output.
    - Check: the step exits 0 on the release's tarballs, and `npm test`'s
      release-pins test passes on the tag's commit.
    - Evidence: the step's output, saved with the checklist.

22. **The release's change notes are written into its pins.**
    - Why: `upgrade` and `upgrade --check` show `release.notes` before they
      ask, cleaned, as the release's own words.
    - How: write the notes file (plain text, one change per line, at most 8
      lines of at most 200 characters; blank lines are left out) and pass it
      to the step: `node scripts/describe-release.js <tarballs> --notes
      <file>`, or `--notes none` for a release with none (it writes `null`).
      Pass one of them for every release: without `--notes` the step keeps
      what the file already holds, which is the last release's notes (it
      says so on stderr).
    - Check: `release.notes` in lib/release-pins.json is the file's lines,
      and the release-pins test passes.
    - Evidence: the notes file, saved with the checklist.

23. **The guide links point at the release's tag.**
    - Why: `countinghouse_overview` and the setup skill send the user to
      countinghouse's module guide; on `blob/master` it can describe what
      this release doesn't have.
    - How: at gating, change each link from `blob/master` to
      `blob/<the release tag>`: countinghouse `lib/overview.js` (`GUIDE`)
      and the setup skill's section 7
      (`clients/claude-code/skills/countinghouse-setup/SKILL.md`: the
      module-development.md and composite-tools.md links). The tests pin
      them, so change them in the same commit: countinghouse
      `test/mcp-contract/42-overview.js` (`GUIDE`) and ch-local
      `test/plugin.test.js` (the setup skill's checked sentences).
    - Check: no `blob/master` link is left in either file, and both tests
      pass.
    - Evidence: the two commits.

24. **The pinned countinghouse knows every held-back reason this ch-local
    writes.**
    - Why: start writes the held-back file the overview reads, and a
      runtime refuses that file whole when a reason in it is one it
      doesn't know. The overview then shows no held-back module's reason,
      though nothing about what loads changes. Every reason in ch-local's
      `lib/held-back.js` REASONS must be in the pinned countinghouse's:
      `gone` (an own module's copy not there at all) needs countinghouse
      c313b561 (#534) or later.
    - How: the machine check holds it. `node scripts/describe-release.js
      <tarballs> --check` reads the runtime's tarball in that directory,
      the pinned version, else its only `countinghouse-<version>.tgz`.
      From it the step reads `lib/held-back.js`'s one-line REASONS. It fails
      naming each reason the runtime lacks, and it also fails when there is
      no such tarball, the tarball holds another version than the pin's, or
      the line can't be read so. It checks reasons only. Every root and
      field ch-local writes came in the runtime with the reason it rides on
      (roots and `via` with `calls`, #490; `code` with `refused`, #525;
      `via` with `collision`). A new root or field needs this check widened
      with it.
    - Check: the step exits 0 on the release's tarballs with the runtime's
      beside them.
    - Evidence: the step's output, saved with the checklist.

## Reviews, Windows and the notes

16. **The pre-release trust-boundary review is done, and its findings are
    closed.**
    - How: the review of every trust boundary release 1 has: the shim and
      the session socket, the daemon, the sandbox, the settings dialog,
      upgrades from npm and the shim install. It includes the back-sweep
      over the 28 pull requests already merged.
    - Check: every finding is fixed, or ruled a residual and recorded in
      the specs.
    - Evidence: the review's report, with each finding's pull request or
      ruling.
17. **Windows is green, and hand-tested.**
    - How: once countinghouse #272 lands, the acceptance run's and the stdio
      job's Windows legs, then the maintainer's hand test of the Windows
      items.
    - Check:
      - both legs pass, and now gate;
      - the hand test covers the daemon on its named pipe, two sessions,
        rollback with the shim (`ch-shim.exe`), and uninstall.
    - Evidence: those CI runs, and the hand-test notes.
18. **The release notes' residuals match the specs'.**
    - How: compare the notes' residuals section with the residuals recorded
      in the specs and the design notes.
    - Check: the same residuals, each stated as precisely as the spec
      states it. They include at least:
      - audit mode lets a pack read outside its area, logged;
      - on Windows, another user can hold the pipe's pre-auth slots
        (availability only);
      - the same-user local residual, a client's configuration choosing
        the environment;
      - the Sigstore verifier is the last of its major version.
    - Evidence: the release notes, and the specs' residual sections.
    - Also: set `release.security` in lib/release-pins.json from the
      security fixes since the previous published release, in one line
      (rollback shows it before going back), or null for the first release,
      which has no published release before it to roll back to.

## After the tag

19. **The released packages verify as an upgrade would.**
    - How: a clean `ch-local install` from npm, with no `--from`.
    - Check: every package is fetched by its pin, and its provenance
      verifies under the shipped Sigstore root. That includes the native
      shim for the system it runs on.
    - Evidence: the install's output on each system.
