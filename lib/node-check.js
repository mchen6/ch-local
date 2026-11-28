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

// The routes the install pages give (docs/install/README.md, "Before you
// start", as they land),
// never "whatever is current": Homebrew's node@24 is keg-only, so it goes on
// the PATH as `brew info node@24` prints; winget has no per-major id for 24,
// so Windows takes the installer from latest-v24.x. Each command and address
// stands on its own indented line with nothing after it, so a copy of it is
// whole (CMD); the prose around it is indented under the header (MORE), broken
// to fit an 80-column terminal.
var MORE = '\n     ';
var CMD = '\n       ';
var INSTALL = {
  darwin: 'the macOS installer (.pkg) from' + CMD + 'https://nodejs.org/dist/latest-v24.x/'
    + MORE + 'or Homebrew:' + CMD + 'brew install node@24'
    + MORE + 'then add the PATH line that brew info node@24 prints to your shell\'s'
    + MORE + 'startup file (~/.zshrc for zsh, the default; ~/.bash_profile for bash),'
    + MORE + 'and open a new terminal',
  win32: 'the Windows installer (.msi, x64) from' + CMD + 'https://nodejs.org/dist/latest-v24.x/'
    + MORE + 'then open a new terminal',
  linux: 'your distribution\'s package if node -v' + MORE + 'then prints v24.x; otherwise' + CMD + 'https://nodejs.org/en/download'
    + MORE + 'choose v24 and Linux, and it shows the commands to run',
  // (any other system: FreeBSD, and the rest)
  other: 'your system\'s package manager or ports,' + MORE + 'for Node 24'
};

// The route a person takes, in plain text: the install pages' own, under
// its header (bin/ch-local.js has said what is needed and what was found). ch-local's own fetch of Node (24 from
// nodejs.org, its SHA-256 checked against SHASUMS256.txt) is not built, so
// none is offered and nothing is asked or downloaded. -> 'install-yourself'
async function offerNode(io) {
  // (under bin's own line, "needs Node 22.16 or later; this is <version>")
  io.stderr.write('Install Node 24 yourself:' + MORE
    + (Object.prototype.hasOwnProperty.call(INSTALL, io.platform) ? INSTALL[io.platform] : INSTALL.other) + '\n');
  return 'install-yourself';
}

module.exports = {FLOOR: FLOOR, check: check, offerNode: offerNode};
