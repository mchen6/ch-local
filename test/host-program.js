'use strict';
// A program header this machine's session check takes (lib/session.js
// formatProblem): ELF for this arch on Linux, a thin Mach-O on macOS, and
// anything on Windows, which isn't checked. For a shim a test installs and
// sessionChoice must pick.
function hostProgram() {
  const b = Buffer.alloc(4096);
  if (process.platform === 'linux') { b.writeUInt32BE(0x7f454c46, 0); b[4] = 2; b[5] = 1; b.writeUInt16LE(process.arch === 'arm64' ? 0xb7 : 0x3e, 18); }
  else if (process.platform === 'darwin') { b.writeUInt32LE(0xfeedfacf, 0); b.writeInt32LE(process.arch === 'arm64' ? 0x0100000c : 0x01000007, 4); }
  else b.write('MZ', 0);
  return b;
}

module.exports = {hostProgram};
