'use strict';
// The Node floor, checked before anything else is loaded (spec §2, "Node").
// It requires nothing, so even a Node far below the floor gets this far.
var FLOOR = '22.16.0';

function parts(v) {
  return String(v).replace(/^v/, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
}

function check(version) {
  var have = parts(version);
  var need = parts(FLOOR);
  var ok = have[0] > need[0] || (have[0] === need[0] && (have[1] > need[1] || (have[1] === need[1] && have[2] >= need[2])));
  return {ok: ok, floor: FLOOR};
}

// The routes the install pages give (docs/install, "Before you start"),
// never "whatever is current": Homebrew's node@24 is keg-only, so it goes on
// the PATH as `brew info node@24` says; winget has no per-major id for 24, so
// Windows takes the installer from latest-v24.x.
var INSTALL = {
  darwin: 'brew install node@24, then put it on your PATH as brew info node@24 says (Homebrew keeps it off the PATH): '
    + 'echo \'export PATH="$(brew --prefix node@24)/bin:$PATH"\' >> ~/.zshrc, and open a new terminal; '
    + 'or the macOS installer (.pkg) from https://nodejs.org/dist/latest-v24.x/',
  win32: 'the Windows installer (.msi, x64) from https://nodejs.org/dist/latest-v24.x/, then open a new terminal',
  linux: 'your distribution\'s package if node -v then prints v24.x; otherwise https://nodejs.org/en/download: '
    + 'choose v24 and Linux, and it shows the commands to run',
  // (any other system: FreeBSD, and the rest)
  other: 'https://nodejs.org/en/download: choose v24 and your system, and it shows the commands to run'
};

// The two paths, in plain text. The consented fetch (Node 24 from nodejs.org,
// its SHA-256 checked against SHASUMS256.txt, into <home>/node/) is not built
// yet: a yes is refused, and nothing is downloaded. -> 'install-yourself' | 'abort'
async function offerNode(io) {
  io.stderr.write('ch-local needs Node ' + FLOOR + ' or later. Two ways on:\n'
    + '  1. install Node 24 yourself: ' + (INSTALL[io.platform] || INSTALL.other) + '\n'
    + '  2. let ch-local fetch its own Node 24 into its home (from nodejs.org, the SHA-256 checked against SHASUMS256.txt; your system Node is not touched)\n');
  var answer = String(await io.ask('Let ch-local fetch Node 24? (yes/no) ')).trim().toLowerCase();
  if (answer !== 'yes') return 'install-yourself';
  io.stderr.write('ch-local cannot fetch Node yet: the consented fetch is not built. Install Node 24 yourself (1 above); nothing was downloaded.\n');
  return 'abort';
}

module.exports = {FLOOR: FLOOR, check: check, offerNode: offerNode};
