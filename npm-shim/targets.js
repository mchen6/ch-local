'use strict';
// The six targets ch-shim is built for, by npm's process.platform and
// process.arch, with the Rust target each is built from (shim.yml).
module.exports = [
  {key: 'linux-x64',    os: 'linux',  cpu: 'x64',   libc: 'glibc', rust: 'x86_64-unknown-linux-gnu'},
  {key: 'linux-arm64',  os: 'linux',  cpu: 'arm64', libc: 'glibc', rust: 'aarch64-unknown-linux-gnu'},
  {key: 'darwin-x64',   os: 'darwin', cpu: 'x64',   rust: 'x86_64-apple-darwin'},
  {key: 'darwin-arm64', os: 'darwin', cpu: 'arm64', rust: 'aarch64-apple-darwin'},
  {key: 'win32-x64',    os: 'win32',  cpu: 'x64',   rust: 'x86_64-pc-windows-msvc'},
  {key: 'win32-arm64',  os: 'win32',  cpu: 'arm64', rust: 'aarch64-pc-windows-msvc'},
];
