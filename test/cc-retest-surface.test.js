'use strict';
// tools/cc-retest/surface.js: Claude Code's config surface per version, and
// its diff against the last approved version's. No network: the registry and
// its tarballs are stand-ins, built here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {packageTgz} = require('./tgz');
const surface = require('../tools/cc-retest/surface');

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// A stand-in native binary: identifiers among bytes that are not UTF-8.
const binary = (...strings) => Buffer.concat(strings.flatMap((s) => [Buffer.from([0xff, 0xfe, 0x00, 0x9c]), Buffer.from(s, 'latin1'), Buffer.from([0x00, 0xc3])]));

const BASE_JS = [
  'process.env.CLAUDE_CODE_USE_BEDROCK', 'process.env.ANTHROPIC_API_KEY', 'process.env.DISABLE_TELEMETRY',
  'opt("--settings <file>")', 'opt("--plugin-dir <dir>")', 'opt("--model <m>")', 'opt("--print")',
  'join(home, ".claude/settings.json")', '"settings.local.json"', '"/etc/claude-code/managed-settings.json"',
  'cfg.disableAllHooks', 'hooks/hooks.json', 'enabledPlugins'
].join(';\n');
const BASE_BIN = ['CLAUDE_CODE_ENTRYPOINT', '--verbose', 'ProgramData\\ClaudeCode\\managed-settings.json', 'allowManagedHooksOnly'];

// A registry for one version: {version: {js, bin}}, each version with one
// platform package. tamper: a package name whose tarball is not the one the
// registry publishes.
function registry(versions, {tamper = null} = {}) {
  const meta = {};
  const tarballs = {};
  for (const [v, {js, bin}] of Object.entries(versions)) {
    const main = packageTgz({name: surface.PACKAGE, version: v}, {'cli.js': js});
    const plat = packageTgz({name: '@anthropic-ai/claude-code-linux-x64', version: v}, {'bin/claude': binary(...bin)});
    for (const [name, buf] of [[surface.PACKAGE, main], ['@anthropic-ai/claude-code-linux-x64', plat]]) {
      const url = `https://registry.npmjs.org/${name}/-/${v}.tgz`;
      tarballs[url] = (tamper === name) ? Buffer.concat([buf, Buffer.from('x')]) : buf;
      meta[`https://registry.npmjs.org/${name.replace('/', '%2F')}/${v}`] = {name, version: v, dist: {tarball: url, integrity: surface.integrityOf(buf)},
        ...(name === surface.PACKAGE ? {optionalDependencies: {'@anthropic-ai/claude-code-linux-x64': v}} : {})};
    }
  }
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    if (meta[url] != null) return {ok: true, status: 200, json: async () => meta[url]};
    if (tarballs[url] != null) return {ok: true, status: 200, arrayBuffer: async () => tarballs[url].buffer.slice(tarballs[url].byteOffset, tarballs[url].byteOffset + tarballs[url].length)};
    return {ok: false, status: 404};
  };
  return {fetch, fetched};
}

async function run(argv, reg, approvedDir) {
  const lines = [];
  const code = await surface.main(argv, {fetch: reg.fetch, out: (l) => lines.push(l), approvedDir});
  return {code, lines, detail: lines.length > 1 ? JSON.parse(lines.slice(1).join('\n')) : null};
}

test('extraction reads the JS bundle and the native binary alike, into sorted identifier sets', () => {
  const dir = tmp('ccr-x-');
  fs.writeFileSync(path.join(dir, 'cli.js'), BASE_JS);
  fs.writeFileSync(path.join(dir, 'claude'), binary(...BASE_BIN));
  const s = surface.extractSurface([dir]);
  assert.deepStrictEqual(s.env, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_USE_BEDROCK', 'DISABLE_TELEMETRY']);
  assert.ok(s.flags.includes('--settings') && s.flags.includes('--plugin-dir') && s.flags.includes('--verbose'), JSON.stringify(s.flags));
  assert.ok(s.files.includes('.claude/settings.json') && s.files.includes('/etc/claude-code/managed-settings.json'), JSON.stringify(s.files));
  assert.ok(s.files.some((f) => /ProgramData\\ClaudeCode/.test(f)), JSON.stringify(s.files));
  assert.ok(s.hookTerms.includes('disableAllHooks') && s.hookTerms.includes('allowManagedHooksOnly') && s.hookTerms.includes('enabledPlugins'), JSON.stringify(s.hookTerms));
  for (const set of Object.values(s)) assert.deepStrictEqual(set, [...set].sort());
  assert.deepStrictEqual(surface.extractSurface([dir]), s, 'deterministic');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('the diff: a new item touching hooks, plugins, settings, managed or policy fails, and so does any new file path; others are listed; removals are said', () => {
  const was = {env: ['CLAUDE_CODE_A'], flags: ['--model'], files: ['.claude/settings.json'], hookTerms: ['disableAllHooks']};
  const now = {env: ['CLAUDE_CODE_A', 'CLAUDE_CODE_HOOKS_DIR', 'CLAUDE_CODE_FAST'], flags: ['--model', '--plugin-url', '--quiet'],
    files: ['.claude/settings.json', '.claude/agents.json'], hookTerms: []};
  const d = surface.diffSurface(was, now);
  assert.deepStrictEqual(d.failing.map((x) => `${x.set} ${x.item}`).sort(), ['env CLAUDE_CODE_HOOKS_DIR', 'files .claude/agents.json', 'flags --plugin-url']);
  assert.deepStrictEqual(d.added.map((x) => x.item).sort(), ['--quiet', 'CLAUDE_CODE_FAST']);
  assert.deepStrictEqual(d.removed, [{set: 'hookTerms', item: 'disableAllHooks'}]);
});

test('end to end: approve a version, then a later one with only an unrelated new variable passes', async () => {
  const approved = tmp('ccr-a-');
  const reg = registry({'2.1.300': {js: BASE_JS, bin: BASE_BIN}, '2.1.301': {js: BASE_JS + ';process.env.CLAUDE_CODE_FAST_MODE', bin: BASE_BIN}});
  assert.strictEqual((await run(['2.1.300', '--approve'], reg, approved)).code, 0);
  const snap = JSON.parse(fs.readFileSync(path.join(approved, '2.1.300.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(snap.packages).sort(), ['@anthropic-ai/claude-code', '@anthropic-ai/claude-code-linux-x64']);
  assert.ok(snap.surface.env.includes('CLAUDE_CODE_ENTRYPOINT'), 'the native binary was read');
  const r = await run(['2.1.301'], reg, approved);
  assert.strictEqual(r.code, 0, r.lines.join('\n'));
  assert.match(r.lines[0], /^Claude Code 2\.1\.301: pass against 2\.1\.300 \(1 other new, 0 removed\)$/);
  assert.deepStrictEqual(r.detail.added, [{set: 'env', item: 'CLAUDE_CODE_FAST_MODE'}]);
  fs.rmSync(approved, {recursive: true, force: true});
});

test('end to end: a new hook variable, plugin flag or settings path fails, named in the one-line report', async () => {
  const approved = tmp('ccr-b-');
  const reg = registry({'2.1.300': {js: BASE_JS, bin: BASE_BIN},
    '2.1.302': {js: BASE_JS + ';process.env.CLAUDE_CODE_EXTRA_HOOKS;opt("--plugin-url <u>")', bin: [...BASE_BIN, '.claude/hooks.d/settings.json']}});
  await run(['2.1.300', '--approve'], reg, approved);
  const r = await run(['2.1.302', '--against', '2.1.300'], reg, approved);
  assert.strictEqual(r.code, 1);
  assert.match(r.lines[0], /^Claude Code 2\.1\.302: FAIL against 2\.1\.300: new /);
  for (const item of ['CLAUDE_CODE_EXTRA_HOOKS', '--plugin-url', '.claude/hooks.d/settings.json']) assert.ok(r.lines[0].includes(item), `${item} not named: ${r.lines[0]}`);
  fs.rmSync(approved, {recursive: true, force: true});
});

test('a tarball whose bytes are not the registry\'s published integrity is refused: could not run', async () => {
  for (const name of ['@anthropic-ai/claude-code', '@anthropic-ai/claude-code-linux-x64']) {
    const approved = tmp('ccr-c-');
    const reg = registry({'2.1.300': {js: BASE_JS, bin: BASE_BIN}}, {tamper: name});
    const r = await run(['2.1.300', '--approve'], reg, approved);
    assert.strictEqual(r.code, 2, `${name}: ${r.lines.join('\n')}`);
    assert.match(r.lines[0], /integrity is not the registry's published one; refused/);
    assert.deepStrictEqual(fs.readdirSync(approved), [], 'a snapshot was written');
    fs.rmSync(approved, {recursive: true, force: true});
  }
});

test('snapshots hold identifiers only, never a code excerpt', async () => {
  const approved = tmp('ccr-d-');
  const reg = registry({'2.1.300': {js: BASE_JS + ';function secretLogic(){return "a long line of code that must not be copied"}', bin: BASE_BIN}});
  await run(['2.1.300', '--approve'], reg, approved);
  const text = fs.readFileSync(path.join(approved, '2.1.300.json'), 'utf8');
  assert.ok(!/secretLogic|must not be copied|process\.env|join\(/.test(text), 'code was copied into the snapshot');
  const snap = JSON.parse(text);
  for (const items of Object.values(snap.surface)) for (const item of items) assert.ok(!/\s/.test(item) || /Managed Preferences/.test(item), `not an identifier: ${item}`);
  fs.rmSync(approved, {recursive: true, force: true});
});

test('no approved snapshot, a snapshot from another extractor, or a bad version: could not run (2)', async () => {
  const approved = tmp('ccr-e-');
  const reg = registry({'2.1.300': {js: BASE_JS, bin: BASE_BIN}, '2.1.301': {js: BASE_JS, bin: BASE_BIN}});
  assert.strictEqual((await run(['2.1.301'], reg, approved)).code, 2);
  await run(['2.1.300', '--approve'], reg, approved);
  const file = path.join(approved, '2.1.300.json');
  fs.writeFileSync(file, JSON.stringify({...JSON.parse(fs.readFileSync(file, 'utf8')), extractor: surface.EXTRACTOR - 1}));
  const r = await run(['2.1.301'], reg, approved);
  assert.strictEqual(r.code, 2);
  assert.match(r.lines[0], /snapshot it again first/);
  assert.strictEqual((await run(['latest'], reg, approved)).code, 2);
  fs.rmSync(approved, {recursive: true, force: true});
});

test('a run writes nothing but its snapshot: no temp directory, no unpacked file', async () => {
  const before = new Set(fs.readdirSync(os.tmpdir()));
  const approved = tmp('ccr-f-');
  await run(['2.1.300', '--approve'], registry({'2.1.300': {js: BASE_JS, bin: BASE_BIN}}), approved);
  const after = fs.readdirSync(os.tmpdir()).filter((f) => !before.has(f) && f !== path.basename(approved));
  assert.deepStrictEqual(after, []);
  assert.deepStrictEqual(fs.readdirSync(approved), ['2.1.300.json']);
  fs.rmSync(approved, {recursive: true, force: true});
});

test('streamed in small chunks, every identifier is found whole, once, and none is cut at a chunk edge', async () => {
  const js = Array.from({length: 40}, (_, i) => `x${'y'.repeat(i)};process.env.CLAUDE_CODE_VAR_${i}_HOOKS;opt("--flag-number-${i}")`).join('\n');
  const tgzBuf = packageTgz({name: 'p', version: '1.0.0'}, {'cli.js': js, 'bin/claude': binary(...BASE_BIN)});
  const whole = surface.extractSurface((() => { const d = tmp('ccr-g-'); fs.writeFileSync(path.join(d, 'cli.js'), js); fs.writeFileSync(path.join(d, 'claude'), binary(...BASE_BIN)); return [d]; })());
  for (const size of [1, 7, 512, 4096]) {
    const sets = {env: new Set(), flags: new Set(), files: new Set(), hookTerms: new Set()};
    async function* chunks() { for (let i = 0; i < tgzBuf.length; i += size) yield tgzBuf.subarray(i, i + size); }
    const {integrity, error} = await surface.scanTarball(chunks(), sets);
    assert.strictEqual(error, null);
    assert.strictEqual(integrity, surface.integrityOf(tgzBuf));
    const got = Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, [...v].sort()]));
    assert.deepStrictEqual(got.env, whole.env, `chunks of ${size}`);
    assert.deepStrictEqual(got.flags, whole.flags, `chunks of ${size}`);
    assert.strictEqual(got.env.filter((e) => /^CLAUDE_CODE_VAR_\d+_HOOKS$/.test(e)).length, 40);
  }
});

test('a tarball over the caps, or not a tarball at all, could not be read: could not run', async () => {
  const sets = {env: new Set(), flags: new Set(), files: new Set(), hookTerms: new Set()};
  const r = await surface.scanTarball((async function* () { yield Buffer.from('not gzip'); })(), sets);
  assert.ok(r.error != null);
});
