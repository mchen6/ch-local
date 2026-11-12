'use strict';
// Tarballs for tests: single ustar members, a gzipped archive of them, and a
// whole npm-style package tarball (package/ prefix) from a file map.
const zlib = require('node:zlib');

// One ustar member: header + data padded to 512.
function member(name, {type = '0', data = '', linkname = ''} = {}) {
  const body = Buffer.from(data);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(linkname, 157, 100);
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([h, body, pad]);
}

const tgz = (...members) => zlib.gzipSync(Buffer.concat([...members, Buffer.alloc(1024)]));

// A pax extended header (type x) carrying the given records.
const pax = (records, type = 'x') => member('PaxHeader/x', {type, data: Object.entries(records).map(([k, v]) => {
  const body = ` ${k}=${v}\n`;
  let n = body.length + 1;
  while (String(n).length + body.length !== n) n++;
  return `${n}${body}`;
}).join('')});

// manifest: the package.json object; files: {relative path: content}.
const packageTgz = (manifest, files = {}) => tgz(
  member('package/package.json', {data: JSON.stringify(manifest)}),
  ...Object.entries(files).map(([rel, data]) => member(`package/${rel}`, {data}))
);

module.exports = {member, tgz, pax, packageTgz};
