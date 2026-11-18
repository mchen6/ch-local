'use strict';
// A running start's heartbeat (its run.json's mtime, refreshed every
// HEARTBEAT_MS) and the host tag of its run directory: what start writes and
// collection (lib/gc.js) reads, apart from collection's own code, so start
// loads nothing of install's.
const HEARTBEAT_MS = 10 * 60 * 1000;
const STALE_MS = 3 * HEARTBEAT_MS;
const hostTag = (hostname) => String(hostname || 'host').replace(/[^A-Za-z0-9.-]/g, '_').slice(0, 64) || 'host';
// Whether a process on this machine is alive: what every io's `alive` is
// (bin/ch-local.js, the acceptance and dogfood scripts' own installs).
// Collection requires it (lib/gc.js), so a home's install never takes a
// running start for dead. EPERM: alive, another user's.
const processAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };

module.exports = {HEARTBEAT_MS, STALE_MS, hostTag, processAlive};
