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

var INSTALL = {
  darwin: 'brew install node@24, or the installer from https://nodejs.org/en/download',
  win32: 'winget install OpenJS.NodeJS.LTS, or the installer from https://nodejs.org/en/download',
  linux: 'your package manager, or https://nodejs.org/en/download'
};

// The two paths, in plain text. The consented fetch (Node 24 from nodejs.org,
// its SHA-256 checked against SHASUMS256.txt, into <home>/node/) is not built
// yet: a yes is refused, and nothing is downloaded. -> 'install-yourself' | 'abort'
async function offerNode(io) {
  io.stderr.write('ch-local needs Node ' + FLOOR + ' or later. Two ways on:\n'
    + '  1. install Node 24 yourself: ' + (INSTALL[io.platform] || INSTALL.linux) + '\n'
    + '  2. let ch-local fetch its own Node 24 into its home (from nodejs.org, the SHA-256 checked against SHASUMS256.txt; your system Node is not touched)\n');
  var answer = String(await io.ask('Let ch-local fetch Node 24? (yes/no) ')).trim().toLowerCase();
  if (answer !== 'yes') return 'install-yourself';
  io.stderr.write('ch-local cannot fetch Node yet: the consented fetch is not built. Install Node 24 yourself (1 above); nothing was downloaded.\n');
  return 'abort';
}

module.exports = {FLOOR: FLOOR, check: check, offerNode: offerNode};
