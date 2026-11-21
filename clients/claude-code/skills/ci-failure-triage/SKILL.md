---
name: ci-failure-triage
description: Use when a CI run (GitHub Actions) failed and the user wants to know why. Calls the ci_failure_triage tool of the ch-packs plugin.
---

# CI failure triage

when a CI run failed, call `ci_failure_triage` first and show its receipt line verbatim.

Then answer from what the tool returned: the failing step, its error lines, whether the failure is new, flaky or recurring, and who last touched it. Do not read the raw logs yourself unless the user asks; the receipt says how much of them the tool read.

If the `ci_failure_triage` tool is not available, one of these is why:
- countinghouse is not installed, or the `ch-packs` plugin is not connected (or Claude Code was not restarted after the install);
- a module the tool needs has no credential: a module without its credential does not load, so its tool is not listed;
- a module the tool needs is turned off.

If `countinghouse_overview` is available, call it: it names what is not ready and the command for it. Otherwise follow the countinghouse-setup skill from its first step, which checks whether countinghouse is installed.

The tool reads GitHub through ch-access-github's credential, a read-only token or the user's `gh` login. Never ask the user to paste a token into the conversation. If the credential is missing, ask them to run, in their own terminal, `node "<home>/bin/ch-local.js" credentials add ch-access-github`, where `<home>` is the countinghouse home as the countinghouse-setup skill finds it (`~/.countinghouse` by default; on Windows, `node "%USERPROFILE%\.countinghouse\bin\ch-local.js" credentials add ch-access-github`). Never the bare `ch-local`: installing does not put it on their PATH.
