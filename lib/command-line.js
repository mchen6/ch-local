'use strict';
// A ch-local command as a printed hint names it (A-chhints; the reviewer's
// plan approval, 11-20): the home's own launcher, `node "<real path>" <args>`,
// which runs as printed (nothing puts ch-local on PATH after an npx or a
// folder install), by the rule the credential line already used (A-firstrun
// d1: lib/home.js safeLauncher, the runtime's own character check); with
// no safe launcher -- none installed yet, or a path a shell would read --
// the bare `ch-local <args>`, which still names the command.
//
// Every printed hint that names a ch-local command is made here; a lexical
// pin (test/command-line.test.js) fails on a bare one written anywhere else.
const {safeLauncher} = require('./home');

// where: the home's layout (lib/home.js layout), or null (none known: the
// bare form); args: the command after `ch-local`, e.g. 'install' or
// `credentials add ${m}`
function chLocal(where, args, platform = process.platform) {
  const launcher = where != null && where.launcher != null ? safeLauncher(where, platform) : null;
  return launcher != null ? `node "${launcher}" ${args}` : `ch-local ${args}`;
}

module.exports = {chLocal};
