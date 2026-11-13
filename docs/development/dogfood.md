# Running pack 1 before a release (dogfood)

For development only. Until the first release, ch-local pins nothing, so pack
1 is installed from tarballs built from each repository's current main, with
`--unreleased-pins`. `scripts/dogfood.js` does the whole path:

1. It packs every package:
   - countinghouse at `master`;
   - ch-local from the checkout you run it in, since that launcher reads what
     this install writes;
   - ch-pack-ci-failure-triage, ch-access-github and the seven `ch-step-*`
     parts at `main`.
2. It writes their pins (version and sha512) and generates the runtime's
   lockfile, as a release would.
3. It installs pack 1 into your home (`--home`, else `$COUNTINGHOUSE_HOME`,
   else `~/.countinghouse`) with
   `CH_LOCAL_DEV=1` and `--unreleased-pins`. The home is recorded as
   unreleased: `status` and every `start` say so, and `upgrade` refuses until
   a clean install from a release.
4. It prints the commands to add the server to Claude Code.

It never reads, prints or stores a token, and it changes no client
configuration: you run the printed commands yourself.

## Run it

From a ch-local checkout, with Node 24:

    node scripts/dogfood.js

Without clones, it clones each repository from GitHub at its branch.

To build from clones you already have instead (a repository with no clone
there is cloned from GitHub):

    node scripts/dogfood.js --src <directory of clones>

Here the clones are used at their last fetched `origin/main` (`origin/master`
for countinghouse), read with `git archive`. Nothing is fetched, and no
working tree is read or changed. Other options:

- `--clone <repo>=<path>` names a clone that is elsewhere; it must exist.
- `--ref <repo>=<ref>` builds another ref, for example
  `--ref countinghouse=origin/lm1-c-compose-wait`. A repository cloned from
  GitHub takes a branch only.
- `--home <dir>` installs somewhere other than `~/.countinghouse`.

Installing the runtime's own dependencies reaches the npm registry, as any
install does.

## Then

The script ends with the commands to run:

    read -rs COUNTINGHOUSE_GITHUB_TOKEN
    claude mcp add --scope user countinghouse -e "COUNTINGHOUSE_GITHUB_TOKEN=$COUNTINGHOUSE_GITHUB_TOKEN" -- <node> <home>/bin/ch-local.js start --stdio
    claude --resume

`read -rs` takes the token you paste without showing it, and keeps it out of
your shell history. Use a fine-grained token that can only read the
repositories you want triaged: Actions read and Contents read. Claude Code
keeps it in its user configuration and passes it to the server's
environment. ch-local sends it only to GitHub's MCP server
(`https://api.githubcopilot.com`, the one origin the launcher allows). With
a home other than `~/.countinghouse`, the line also passes
`COUNTINGHOUSE_HOME`.

The script then prints the `status` and `uninstall` commands for that home,
and `claude mcp remove --scope user countinghouse`.

## Test

`test/dogfood.test.js` checks the printed line (no token value, quoting) and
the arguments. The full run into a temporary home needs local clones:

    CH_DOGFOOD_SRC=<dir of clones> CH_DOGFOOD_CLONES=countinghouse=<path> \
    CH_DOGFOOD_REFS=countinghouse=origin/master node --test test/dogfood.test.js

Without `CH_DOGFOOD_SRC` it is skipped and says why.
