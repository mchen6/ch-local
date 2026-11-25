'use strict';
// What a person is told to do next once install or add-pack has put a pack
// in place (A-firstrun d1, the first-run design): one fixed line, the last on
// stdout, true whatever is still missing (it looks at nothing). A change to
// it is a change to checked text.
const READY_LINE = 'Next: add any credential still missing and connect your client; then ask it what countinghouse can do for you.';

module.exports = {READY_LINE};
