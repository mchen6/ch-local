---
name: countinghouse-setup
description: Use when the user asks to install or set up countinghouse or a countinghouse pack, asks what countinghouse can do, or asks how to design a composite scenario.
---

# Setting up countinghouse

countinghouse runs MCP tools from packs the user installs on this machine. Follow these steps in order.

Before every command: say what it does and run it only after the user says yes. Never ask for, accept or repeat a token, key or password. A credential is added only in the user's own terminal; if the user pastes one here anyway, tell them to revoke it and add a new one in their terminal.

## 1. Is it installed?

The launcher is `<home>/bin/ch-local.js`, where `<home>` is `$COUNTINGHOUSE_HOME` if set, else `~/.countinghouse` (`%USERPROFILE%\.countinghouse` on Windows). With the user's yes, run `node "<home>/bin/ch-local.js" status`. If the file does not exist, countinghouse is not installed: go to 2. If it lists the pack the user wants, go to 4.

## 2. Install

First check whether `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy` or `http_proxy` is set in the environment. If one is, say before anything else: "This release of countinghouse does not work through an HTTP proxy, so it can't install or run on a network that reaches the internet only through one." Then ask whether to try anyway.

With the user's yes, run `npx @countinghouse/ch-local install --pack ci-failure-triage`. If the user names a local release folder (a pre-release build), run instead the command docs/install/claude-code.md gives for it, with their folder.

If the install fails because it cannot reach the network directly, say plainly: "This release of countinghouse does not work through an HTTP proxy, so it can't install or run on a network that reaches the internet only through one." Do not suggest a workaround.

## 3. Credentials

Read the install's output. For each line `<module> needs a credential: in your own terminal run ...`, tell the user to run that exact command in their own terminal, not here, and why: the pack's tool reads GitHub through that module. Tell them the command shows where the key will be sent before it asks, and reads the key without showing it; that for GitHub it can offer their `gh` login instead; and that a fine-grained read-only token (Actions read, Contents read) is narrower than a `gh` login. Wait until they say it is done.

## 4. Connect Claude Code

If the `ch-packs` plugin is not installed, with the user's yes run `claude plugin marketplace add mchen6/ch-local` and then `claude plugin install ch-packs@ch-packs`. Then tell the user to restart Claude Code, or open `/mcp` and reconnect `countinghouse`, so it starts with what was installed.

## 5. Ready

Call `countinghouse_overview`. Tell the user what it reports: the packs, their tools, and anything not ready with the command it names. Then say: "countinghouse is ready. You can ask me what countinghouse can do for you, or how to design a composite scenario." Add one or two of the example asks the overview lists.

## 6. "What can countinghouse do for me?"

Call `countinghouse_overview` and answer from it alone, in at most ten lines: what countinghouse is (one sentence), each installed pack and what its tool does, two to four example asks, and anything not ready with its command. Then offer to run one of the asks.

## 7. "How do I design a composite scenario?"

Answer only from what this release has: a composite scenario is a module whose tool calls other modules' tools through `ctx.call`; https://github.com/mchen6/countinghouse/blob/master/docs/module-development.md and https://github.com/mchen6/countinghouse/blob/master/docs/composite-tools.md describe how to write one. Do not promise anything these docs do not describe.

## Never say

That countinghouse is faster, saves tokens or money, works with any npm library, or works through a proxy; that the sandbox is a security boundary; that modules cannot reach the network; that a module learns nothing about other files; anything about tenancy, billing or metering. Show a tool's receipt line as it prints it.
