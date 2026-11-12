---
name: ci-failure-triage
description: Use when a CI run (GitHub Actions) failed and the user wants to know why. Calls the ci_failure_triage tool of the ch-packs plugin.
---

# CI failure triage

when a CI run failed, call `ci_failure_triage` first and show its receipt line verbatim.

Then answer from what the tool returned: the failing step, its error lines, whether the failure is new, flaky or recurring, and who last touched it. Do not read the raw logs yourself unless the user asks; the receipt says how much of them the tool read.

If the `ci_failure_triage` tool is not available, the launcher is not installed. Tell the user, and with their agreement run:

    npx @countinghouse/ch-local install --pack ci-failure-triage

The tool reads GitHub through a read-only token in `COUNTINGHOUSE_GITHUB_TOKEN` (or `GITHUB_TOKEN`). Never ask the user to paste a token into the conversation; they set it in the environment Claude Code starts from.
