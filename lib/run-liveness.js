'use strict';
// A running start's heartbeat (its run.json's mtime, refreshed every
// HEARTBEAT_MS) and the host tag of its run directory: what start writes and
// collection (lib/gc.js) reads, apart from collection's own code, so start
// loads nothing of install's.
const HEARTBEAT_MS = 10 * 60 * 1000;
const STALE_MS = 3 * HEARTBEAT_MS;
const hostTag = (hostname) => String(hostname || 'host').replace(/[^A-Za-z0-9.-]/g, '_').slice(0, 64) || 'host';

module.exports = {HEARTBEAT_MS, STALE_MS, hostTag};
