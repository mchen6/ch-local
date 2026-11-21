'use strict';
// Code that runs from <home>/app while that tree is replaced -- an install
// or upgrade (lib/install.js swaps app.new in), a rollback (lib/rollback.js
// swaps the previous release back, or finishes an interrupted one), the
// daemon, which outlives both -- must never load a file of the other
// release. Node resolves a require('./x') by this file's path, which after
// the swap names the other release's lib: a function this release calls may
// not be there (C-upgrade-path's test caught rollback calling the older
// release's upgrade.js).
//
// So before the swap, and at the daemon's start, preloadForSwap() loads every
// module of this release's lib and every JSON file lib requires: any later
// require('./x') -- however lazy, however deep in a callee -- is this
// release's copy, from the cache. No list to keep: the whole lib, by
// construction (86 modules, about 200 ms). Everywhere else modules stay
// lazily required (start loads only what it needs).
// test/swap-requires.test.js pins that it loads them all, and that it comes
// before every swap.
const fs = require('node:fs');
const path = require('node:path');

// (the JSON files lib requires, from lib/ or the package root)
const JSON_FILES = ['../package.json', './release-pins.json', './sigstore/trusted-root.json', './sigstore/npm-keys.json'];

function preloadForSwap() {
  for (const name of fs.readdirSync(__dirname)) {
    if (name.endsWith('.js')) require(path.join(__dirname, name));
  }
  for (const file of JSON_FILES) require(file);
}

module.exports = {preloadForSwap, JSON_FILES};
