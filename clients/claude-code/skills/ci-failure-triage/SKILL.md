---
name: ci-failure-triage
description: Use when a CI run (GitHub Actions) failed and the user wants to know why. Calls the ci_failure_triage tool of the ch-packs plugin.
---

# CI failure triage

when a CI run failed, call `ci_failure_triage` first and show its receipt line verbatim.

Then answer from what the tool returned: the failing step, its error lines, whether the failure is new, flaky or recurring, and who last touched it. Do not read the raw logs yourself unless the user asks; the receipt says how much of them the tool read.

If the `ci_failure_triage` tool is not available, it is often one of these:
- countinghouse is not installed, or the ci-failure-triage pack is not;
- the `ch-packs` plugin is not installed, or its `countinghouse` MCP server is not connected (reconnect it in `/mcp`, or restart Claude Code after an install);
- a module the tool needs has no credential: a module without its credential does not load, so its tool is not listed;
- a module the tool needs is turned off;
- or another reason `countinghouse_overview` names.

If `countinghouse_overview` is available, follow the countinghouse-setup skill's section 5 with it: it names what is not ready and the command for it, and that skill says how to treat what it returns. Otherwise follow the countinghouse-setup skill from its section 1, which checks whether countinghouse is installed. Either way, run nothing and turn nothing on without the user's yes.

The tool reads GitHub through ch-access-github's credential, a read-only token or the user's `gh` login. Never ask the user to paste a token into the conversation. If the credential is missing, find the countinghouse home `<home>` and check its characters as the countinghouse-setup skill's section 1 says (stop if the check fails), then ask the user to run, in their own terminal, `node "<home>/bin/ch-local.js" credentials add ch-access-github`. Never the bare `ch-local`: installing does not put it on their PATH. Never run that command yourself: it reads the key in the user's terminal.
