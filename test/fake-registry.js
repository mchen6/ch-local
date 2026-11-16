'use strict';
// A fake npm registry for the upgrade tests (docs/development/auto-upgrade.md,
// "Tests (no network)"): an HTTP server on 127.0.0.1 serving packuments and
// tarballs, as registry.npmjs.org does. Nothing here reaches the network.
//
//   const reg = await fakeRegistry();
//   reg.publish('@countinghouse/ch-local', '0.2.0', tarballBytes, {latest: true});
//   reg.url            // http://127.0.0.1:<port>/
//   reg.requests       // every path asked for, in order
//   reg.tamper(name, version, {integrity, tarball, body, delayMs})
//   await reg.close();
//
// tamper: what a hostile or broken registry would serve instead: another
// integrity (or a sha1 one), a tarball URL elsewhere, other bytes, a slow
// answer, an oversized packument.
const crypto = require('node:crypto');
const http = require('node:http');

const sri = (bytes) => `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
const tarballPath = (name, version) => `/${name}/-/${name.split('/').pop()}-${version}.tgz`;

async function fakeRegistry() {
  const packages = new Map();   // name -> {versions: Map(version -> {bytes, tamper}), latest}
  const attestations = new Map();   // name@version -> the JSON served
  const requests = [];
  let base = null;
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url);
    requests.push(url);
    // connection: close on every answer, so the client never reuses a
    // socket: Node's server closes an idle keep-alive socket after
    // keepAliveTimeout (5 s), and a fetch (undici) that reuses one just as it
    // closes fails ECONNRESET, which the Windows legs hit in two different
    // shim-install tests (ch-local #51). A fresh connection per request takes
    // that race away; the code under test fetches the same either way.
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, {'content-type': type, connection: 'close'});
      res.end(body);
    };
    // attestations: /-/npm/v1/attestations/<name>@<version>
    if (url.startsWith('/-/npm/v1/attestations/')) {
      const a = attestations.get(url.slice('/-/npm/v1/attestations/'.length));
      return a == null ? send(404, JSON.stringify({error: 'Not found'})) : send(200, typeof a === 'string' ? a : JSON.stringify(a));
    }
    // a tarball: /<name>/-/<basename>-<version>.tgz
    for (const [name, p] of packages) {
      for (const [version, v] of p.versions) {
        if (url !== tarballPath(name, version)) continue;
        const t = v.tamper;
        const bytes = t.body != null ? t.body : v.bytes;
        const go = () => send(200, bytes, 'application/octet-stream');
        return t.delayMs != null ? setTimeout(go, t.delayMs) : go();
      }
    }
    // a packument: /<name>
    const p = packages.get(url.slice(1));
    if (p == null) return send(404, JSON.stringify({error: 'Not found'}));
    const versions = {};
    let pad = null;
    for (const [version, v] of p.versions) {
      const t = v.tamper;
      versions[version] = {name: url.slice(1), version, dist: {
        tarball: t.tarball != null ? t.tarball : `${base}${tarballPath(url.slice(1), version).slice(1)}`,
        integrity: t.integrity !== undefined ? t.integrity : sri(v.bytes)
      }};
      if (t.packumentBytes != null) pad = t.packumentBytes;
    }
    const doc = {name: url.slice(1), 'dist-tags': p.latest != null ? {latest: p.latest} : {}, versions};
    if (pad != null) doc.padding = 'x'.repeat(pad);
    return send(200, JSON.stringify(doc));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
  return {
    url: base,
    requests,
    publish(name, version, bytes, {latest = false} = {}) {
      if (!packages.has(name)) packages.set(name, {versions: new Map(), latest: null});
      const p = packages.get(name);
      p.versions.set(version, {bytes: Buffer.from(bytes), tamper: {}});
      if (latest) p.latest = version;
      return sri(bytes);
    },
    attest(name, version, doc) { attestations.set(`${name}@${version}`, doc); },
    tamper(name, version, t) { Object.assign(packages.get(name).versions.get(version).tamper, t); },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })
  };
}

module.exports = {fakeRegistry, sri, tarballPath};
