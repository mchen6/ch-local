# Installing a pack in your client

`ch-local` on these pages is `node ~/.countinghouse/bin/ch-local.js` (or `npx @countinghouse/ch-local`) unless you installed it globally. On Windows, `node "%USERPROFILE%\.countinghouse\bin\ch-local.js"` in cmd, or `node "$env:USERPROFILE\.countinghouse\bin\ch-local.js"` in PowerShell.

## Before you start

1. **Node 24** (22.16 or later works; our tests run on Node 24 on Linux,
   macOS and Windows). Check with `node -v`: it should print `v24.x`. If
   Node is missing, older than 22.16, or you want 24:
   - Linux: your distribution's package if `node -v` then prints `v24.x`;
     otherwise https://nodejs.org/en/download: choose v24 and Linux, and it
     shows the commands to run.
   - macOS: the macOS installer (.pkg) from
     https://nodejs.org/dist/latest-v24.x/. Or with Homebrew:
     `brew install node@24`, then add the PATH line that `brew info node@24`
     prints to your shell's startup file (~/.zshrc for zsh, the default;
     ~/.bash_profile for bash), and open a new terminal.
   - Windows: the Windows installer (`.msi`, x64) from
     https://nodejs.org/dist/latest-v24.x/.

   After an installer, open a new terminal before `node -v`. A newer major
   than 24 isn't tested; ch-local itself checks only for 22.16 or later.
2. **Install the pack**, in your own terminal:

       npx @countinghouse/ch-local install --pack ci-failure-triage

   <!-- until a release: this paragraph, the Windows one after it and the Clients paragraph's "prepared local release" note go once lib/release-pins.json pins packages; test/docs.test.js then checks they are gone -->
   Installing from npm works once a release pins the packages. Until then,
   install from a prepared local release (`<dir>`, which holds
   `ch-local/bin/ch-local.js`, `release/` and `pins.json`; how to build one,
   and why only on the machine that built it:
   [Before the first release](claude-code.md#before-the-first-release-a-prepared-local-release)).
   `<dir>` is an absolute path that uses only ASCII letters, digits, spaces
   and `_ / \ . : @ + = , ~ -` (no `%`, which cmd expands inside double
   quotes, and `\` allowed, as Windows paths use it; the agent's route on the
   Claude Code page writes the path with forward slashes instead):

       CH_LOCAL_DEV=1 node '<dir>/ch-local/bin/ch-local.js' install --pack ci-failure-triage --from '<dir>/release' --unreleased-pins '<dir>/pins.json'

   On Windows, in cmd: `set CH_LOCAL_DEV=1`, then
   `node "<dir>\ch-local\bin\ch-local.js" install --pack ci-failure-triage --from "<dir>\release" --unreleased-pins "<dir>\pins.json"`,
   then `set CH_LOCAL_DEV=`. In PowerShell: `$env:CH_LOCAL_DEV = '1'`, then
   `node '<dir>\ch-local\bin\ch-local.js' install --pack ci-failure-triage --from '<dir>\release' --unreleased-pins '<dir>\pins.json'`,
   then `Remove-Item Env:CH_LOCAL_DEV`. (Left set, it would count every
   later ch-local command in that window as a development install.) The
   home is recorded as unreleased: `status` and every start say so, and
   `upgrade` refuses until a clean install from a release.
3. **The credential.** At its end, install asks for each module's key that
   is still missing, with nothing shown as you type or paste it (when it
   isn't run from a terminal, it prints the line to run instead). If it
   offers your `gh` login's token (`Use your gh login's token for
   ch-access-github? [y/N]`), that token usually has wider access than this
   pack needs; answer N and paste a read-only token instead (fine-grained,
   with Actions read and Contents read; see
   [Credentials](claude-code.md#credentials)). Any time later, in your own terminal:
   `ch-local credentials add ch-access-github`.
4. **Then your client's page**, below.

## Clients

One page per client:

- [Claude Code](claude-code.md)
- [Cursor](cursor.md)
- [VS Code (Copilot)](vscode.md)
- [Codex CLI](codex.md)
- [Claude Desktop](claude-desktop.md)

Every client runs the same launcher: the Node you have, with
`~/.countinghouse/bin/ch-local.js session --home ~/.countinghouse`
(`$COUNTINGHOUSE_HOME` instead of `~/.countinghouse` when it is set). The
launcher is installed once, by Before you start's step 2: every tarball is
checked against the version and integrity the release pins (for a prepared
local release, its `pins.json`), then installed
into `~/.countinghouse/app` by `npm ci`. `ch-local add
<cursor|vscode|codex>` writes a client's entry for you, and `ch-local
uninstall` takes back exactly what install and add wrote.

`ch-local snippet <client>` prints the exact entry for this machine. The
entry names the absolute path of the Node that ran `ch-local`, because a
client started from the dock or the Start menu often has no `PATH` set up by
nvm. An nvm or system Node upgrade changes that path: run `ch-local snippet
<client>` again and replace the entry (or `ch-local add <client>` for Cursor, VS Code and
Codex). Run `ch-local install` once too, so the shared runtime starts with the new Node.

A module that needs a credential gets it from ch-local's store, never from
the environment your client starts from, and no config entry sets or
forwards one: `ch-local install` asks for it at its end, and
`ch-local credentials add <module>` adds it any time. Each client's page
says more under "Credentials".

Changes to the store are made one at a time: `credentials add`,
`credentials remove` and `uninstall` each take its lock for the moment
they write (a key is typed before that). One that finds another
ch-local changing it says so and waits for it, for up to two minutes, then
says which command holds it and changes nothing; run it again when that
one is done.
