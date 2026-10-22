import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateRawSync, gzipSync } from 'node:zlib';

// Final-artifact check (issue #15) on tiny synthetic archives only, written to a
// private scratch directory (BRIDGE_ARTIFACT_SCRATCH, else the system temp).
// No real release artifact, owner data or real secret is read or created.
const checker = fileURLToPath(new URL('../scripts/check-artifacts.mjs', import.meta.url));
const VERSION = '0.0.0-test', RUNTIME = `synthetic-bridge-${VERSION}.tgz`;
const PLUGIN = `model-bridge-plugin-${VERSION}.zip`, INSTALLER = `model-bridge-installer-${VERSION}.zip`;
const PRIVATE = 'SYNTHETIC_PRIVATE_VALUE_DO_NOT_PRINT';

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = data => { let c = 0xffffffff; for (const byte of data) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
// Classic ZIP as the bundle's standard-library writer produces it. unlisted
// leaves an entry's bytes out of the central directory (a hidden entry);
// extra, localExtra and comment add the optional metadata that writer omits.
function zip(entries) {
  const locals = [], centrals = [];
  let offset = 0, count = 0;
  for (const { name, data, mode = 0o100644, method = 8, unlisted = false, extra = '', localExtra = '', comment = '' } of entries) {
    const raw = Buffer.from(data), path = Buffer.from(name), body = method === 8 ? deflateRawSync(raw) : raw;
    const [centralExtra, ownExtra, note] = [extra, localExtra, comment].map(value => Buffer.from(value));
    const local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(path.length, 26);
    local.writeUInt16LE(ownExtra.length, 28);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(raw), 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(path.length, 28);
    central.writeUInt16LE(centralExtra.length, 30); central.writeUInt16LE(note.length, 32);
    central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, path, ownExtra, body); if (!unlisted) { centrals.push(central, path, centralExtra, note); count++; }
    offset += 30 + path.length + ownExtra.length + body.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
// A well-formed ZIP extra field: header ID, data length, data.
const extraField = (id, data) => { const field = Buffer.alloc(4); field.writeUInt16LE(id, 0); field.writeUInt16LE(Buffer.byteLength(data), 2); return Buffer.concat([field, Buffer.from(data)]); };
// A POSIX pax record: the decimal length counts the whole record, its own digits included.
const paxRecord = (key, value) => {
  const rest = Buffer.byteLength(` ${key}=${value}\n`);
  let length = rest + String(rest).length;
  if (String(length).length !== String(rest).length) length = rest + String(length).length;
  return `${length} ${key}=${value}\n`;
};
// ustar in one gzip stream, as npm pack produces. pax (an object of records, or
// raw record bytes) precedes the entry with an extended header; padding fills
// the entry's alignment padding and uname its header owner field.
function tgz(entries) {
  const blocks = [];
  const block = (name, body, type, { padding = '', uname = '' } = {}) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8'); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.write('        ', 148);
    header.write(type, 156); header.write('ustar\0', 257); header.write('00', 263); header.write(uname, 265, 31);
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
    pad.write(padding, 0, pad.length, 'latin1');
    blocks.push(header, body, pad);
  };
  for (const { name, data = '', type = '0', pax, ...options } of entries) {
    if (pax) block(`PaxHeader/${name.split('/').at(-1)}`.slice(0, 99), Buffer.isBuffer(pax) || typeof pax === 'string' ? Buffer.from(pax)
      : Buffer.from(Object.entries(pax).map(([key, value]) => paxRecord(key, value)).join('')), 'x');
    block(name, Buffer.from(data), type, options);
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
// The same gzip member with an RFC 1952 header comment (FCOMMENT).
const gzipComment = (gz, comment) => Buffer.concat([gz.subarray(0, 3), Buffer.from([gz[3] | 0x10]), gz.subarray(4, 10), Buffer.from(`${comment}\0`, 'latin1'), gz.subarray(10)]);

function release({ runtimeExtra = [], pluginExtra = [], installerExtra = [], pluginRuntime, wrapRuntime = gz => gz } = {}) {
  const root = mkdtempSync(join(process.env.BRIDGE_ARTIFACT_SCRATCH ?? tmpdir(), 'bridge-artifacts-')), dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'synthetic-bridge', version: VERSION }));
  // The empty directory entries (package/docs/, codex-claude/skills/) are the positive directory control.
  const runtime = wrapRuntime(tgz([{ name: 'package/package.json', data: '{"name":"synthetic-bridge"}\n' }, { name: 'package/cli.mjs', data: 'console.log("synthetic");\n' },
    { name: 'package/docs/', type: '5' }, { name: 'package/docs/guide.md', data: 'Use auth.json only through the official login.\n' }, ...runtimeExtra]));
  const files = {
    [RUNTIME]: runtime,
    [PLUGIN]: zip([{ name: 'codex-claude/plugin.json', data: '{"name":"synthetic"}\n' }, { name: 'codex-claude/skills/', data: '', method: 0, mode: 0o40755 },
      { name: 'codex-claude/skills/setup/SKILL.md', data: '# Setup\n' },
      { name: 'codex-claude/.env.example', data: 'EXAMPLE_SETTING=replace-me\n' }, { name: `codex-claude/${RUNTIME}`, data: pluginRuntime ?? runtime, method: 0 }, ...pluginExtra]),
    [INSTALLER]: zip([{ name: 'Model Bridge/README.md', data: 'Synthetic installer.\n' }, { name: `Model Bridge/${RUNTIME}`, data: runtime }, ...installerExtra]),
  };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dist, name), data);
  const sums = () => Object.keys(files).map(name => `${createHash('sha256').update(readFileSync(join(dist, name))).digest('hex')}  ${name}`).join('\n') + '\n';
  writeFileSync(join(dist, 'SHA256SUMS'), sums());
  const run = (args = [], env = {}) => {
    const result = spawnSync(process.execPath, [checker, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
    let report = null; try { report = JSON.parse(result.stderr); } catch {}
    return { ...result, report, categories: report?.findings?.map(f => f.category) ?? [] };
  };
  return { root, dist, run, sums, record: () => join(dist, 'ARTIFACT-CHECK.json'), close: () => rmSync(root, { recursive: true, force: true }) };
}

test('a clean synthetic release set passes, records its exact artifacts, and the gate lists only them', () => {
  const r = release();
  try {
    const checked = r.run();
    assert.equal(checked.status, 0, checked.stderr);
    const record = JSON.parse(readFileSync(r.record(), 'utf8'));
    assert.deepEqual(record.artifacts.map(a => a.name), [RUNTIME, PLUGIN, INSTALLER]);
    for (const artifact of record.artifacts) assert.equal(artifact.sha256, createHash('sha256').update(readFileSync(join(r.dist, artifact.name))).digest('hex'));
    const gate = r.run(['--verify']);
    assert.equal(gate.status, 0, gate.stderr);
    assert.deepEqual(gate.stdout.trim().split('\n'), [RUNTIME, PLUGIN, INSTALLER, 'SHA256SUMS'].map(name => join('dist', name)));
  } finally { r.close(); }
});

test('private files in the plugin directory or nested runtime are refused regardless of Git ignore rules, without printing contents', () => {
  for (const [name, category] of [['.env', 'environment-file'], ['.env.local', 'environment-file'], ['config/prod.env', 'environment-file'],
    ['auth.json', 'auth-state'], ['.codex/state.json', 'auth-state'], ['.npmrc', 'auth-state'], ['logs/bridge.txt', 'log'], ['debug.log', 'log'],
    ['threads/chat.json', 'transcript'], ['session.jsonl', 'transcript'], ['keys/server.pem', 'key-file'], ['.ssh/id_ed25519', 'auth-state'],
    ['id_rsa', 'key-file'], ['.git/config', 'repository-state']]) {
    const r = release({ pluginExtra: [{ name: `codex-claude/${name}`, data: PRIVATE }] });
    try {
      const result = r.run();
      assert.equal(result.status, 1, name);
      assert.deepEqual(result.report.findings, [{ artifact: PLUGIN, entry: `codex-claude/${name}`, category }], name);
      assert.ok(!(result.stdout + result.stderr).includes(PRIVATE), `${name}: contents are never printed`);
      assert.equal(existsSync(r.record()), false, `${name}: no passing record`);
    } finally { r.close(); }
  }
  // The same entry inside the runtime is found in the outer TGZ and in each ZIP's nested copy.
  const nested = release({ runtimeExtra: [{ name: 'package/.env', data: PRIVATE }] });
  try {
    const result = nested.run();
    assert.equal(result.status, 1);
    assert.deepEqual(result.report.findings.map(f => [f.artifact, f.entry, f.category]), [[RUNTIME, 'package/.env', 'environment-file'],
      [PLUGIN, `codex-claude/${RUNTIME} > package/.env`, 'environment-file'], [INSTALLER, `Model Bridge/${RUNTIME} > package/.env`, 'environment-file']]);
    assert.ok(!(result.stdout + result.stderr).includes(PRIVATE));
  } finally { nested.close(); }
});

test('supported secret formats in allowed text are refused by category, never by value', () => {
  const secrets = [['github-token', `ghp_${'A1'.repeat(18)}`], ['github-token', `github_pat_${'B2_'.repeat(20)}`], ['anthropic-key', `sk-ant-api03-${'x'.repeat(48)}`],
    ['openai-key', `sk-proj-${'Y'.repeat(48)}`], ['openai-key', `sk-${'a'.repeat(20)}T3BlbkFJ${'b'.repeat(20)}`], ['aws-access-key', `AKIA${'Z'.repeat(16)}`],
    ['npm-token', `npm_${'n'.repeat(36)}`], ['google-api-key', `AIza${'g'.repeat(35)}`], ['slack-token', `xoxb-${'1'.repeat(12)}`],
    ['private-key', `-----BEGIN ${'OPENSSH'} PRIVATE KEY-----`], ['secret-assignment', `ANTHROPIC_API_KEY=${'q'.repeat(20)}`], ['local-path', '/Users/someone/project']];
  for (const [category, secret] of secrets) {
    const r = release({ pluginExtra: [{ name: 'codex-claude/skills/setup/notes.md', data: `Allowed text with ${secret} inside.\n` }] });
    try {
      const result = r.run();
      assert.equal(result.status, 1, category);
      assert.deepEqual(result.report.findings, [{ artifact: PLUGIN, entry: 'codex-claude/skills/setup/notes.md', category }], category);
      assert.ok(!(result.stdout + result.stderr).includes(secret), `${category}: the value is never printed`);
      assert.equal(existsSync(r.record()), false);
    } finally { r.close(); }
  }
  const nested = release({ runtimeExtra: [{ name: 'package/README.md', data: `ghp_${'C3'.repeat(18)}` }] });
  try {
    const result = nested.run();
    assert.equal(result.status, 1);
    assert.deepEqual(result.report.findings.map(f => f.artifact), [RUNTIME, PLUGIN, INSTALLER]);
    assert.ok(result.report.findings.every(f => f.category === 'github-token' && f.entry.endsWith('package/README.md')));
  } finally { nested.close(); }
});

test('invalid, hidden, unsupported or unbounded archive content fails closed and replaces an earlier pass with no record', () => {
  const cases = [
    ['truncated ZIP', r => writeFileSync(join(r.dist, PLUGIN), readFileSync(join(r.dist, PLUGIN)).subarray(0, 80)), ['archive-hidden-data']],
    ['bytes after the ZIP end', r => writeFileSync(join(r.dist, PLUGIN), Buffer.concat([readFileSync(join(r.dist, PLUGIN)), Buffer.from('trailing')])), ['archive-hidden-data']],
    ['corrupt runtime TGZ', r => writeFileSync(join(r.dist, RUNTIME), Buffer.from('not a gzip stream')), ['archive-structure']],
  ];
  for (const [name, damage, expected] of cases) {
    const r = release();
    try {
      assert.equal(r.run().status, 0, `${name}: clean first`);
      damage(r); writeFileSync(join(r.dist, 'SHA256SUMS'), r.sums());
      const result = r.run();
      assert.equal(result.status, 1, name);
      for (const category of expected) assert.ok(result.categories.includes(category), `${name}: ${JSON.stringify(result.report)}`);
      assert.equal(existsSync(r.record()), false, `${name}: the earlier passing record is gone`);
      assert.equal(r.run(['--verify']).status, 1, `${name}: the gate refuses`);
    } finally { r.close(); }
  }
  for (const [name, options, category, env] of [
    ['an unlisted (hidden) ZIP entry', { pluginExtra: [{ name: 'codex-claude/hidden.txt', data: PRIVATE, unlisted: true }] }, 'archive-hidden-data'],
    ['a symbolic link', { pluginExtra: [{ name: 'codex-claude/link', data: '/etc/passwd', mode: 0o120777 }] }, 'archive-unsupported'],
    ['a path escaping the archive', { pluginExtra: [{ name: 'codex-claude/../escape.txt', data: 'x' }] }, 'unsafe-path'],
    ['a TGZ link entry', { runtimeExtra: [{ name: 'package/link', type: '2' }] }, 'archive-unsupported'],
    ['an archive nested two levels', { runtimeExtra: [{ name: 'package/inner.zip', data: zip([{ name: 'a.txt', data: 'a' }]) }] }, 'archive-nesting'],
    ['an entry over the size bound', { pluginExtra: [{ name: 'codex-claude/large.txt', data: 'z'.repeat(4096) }] }, 'archive-bound', { BRIDGE_ARTIFACT_MAX_ENTRY_BYTES: '1024' }],
    ['too many entries', {}, 'archive-bound', { BRIDGE_ARTIFACT_MAX_ENTRIES: '3' }],
    ['a nested runtime that differs from the released one', { pluginRuntime: tgz([{ name: 'package/cli.mjs', data: 'other' }]) }, 'nested-runtime-mismatch'],
    ['a ZIP entry outside its folder', { installerExtra: [{ name: 'elsewhere.txt', data: 'x' }] }, 'unexpected-layout'],
  ]) {
    const r = release(options);
    try {
      const result = r.run([], env);
      assert.equal(result.status, 1, name);
      assert.ok(result.categories.includes(category), `${name}: ${JSON.stringify(result.report)}`);
      assert.ok(!(result.stdout + result.stderr).includes(PRIVATE));
      assert.equal(existsSync(r.record()), false, name);
    } finally { r.close(); }
  }
});

test('the delivery gate refuses changed, substituted, added, missing or unchecked artifacts', () => {
  const cases = [
    ['substituted plugin ZIP', r => writeFileSync(join(r.dist, PLUGIN), zip([{ name: 'codex-claude/plugin.json', data: '{}' }])), 'artifact-changed'],
    ['substituted with matching checksums', r => { writeFileSync(join(r.dist, INSTALLER), zip([{ name: 'Model Bridge/README.md', data: 'x' }])); writeFileSync(join(r.dist, 'SHA256SUMS'), r.sums()); }, 'artifact-changed'],
    ['added artifact', r => writeFileSync(join(r.dist, 'extra.zip'), zip([{ name: 'a', data: 'a' }])), 'artifact-set'],
    ['missing artifact', r => rmSync(join(r.dist, INSTALLER)), 'artifact-set'],
    ['changed checksum file', r => writeFileSync(join(r.dist, 'SHA256SUMS'), `${'0'.repeat(64)}  ${RUNTIME}\n`), 'checksum-mismatch'],
    ['no check record', r => rmSync(r.record()), 'missing-evidence'],
    ['a record that did not pass', r => { const record = JSON.parse(readFileSync(r.record(), 'utf8')); writeFileSync(r.record(), JSON.stringify({ ...record, passed: false })); }, 'missing-evidence'],
    ['a record from another checker', r => { const record = JSON.parse(readFileSync(r.record(), 'utf8')); writeFileSync(r.record(), JSON.stringify({ ...record, checker: '0'.repeat(64) })); }, 'checker-changed'],
  ];
  for (const [name, change, category] of cases) {
    const r = release();
    try {
      assert.equal(r.run().status, 0, name);
      change(r);
      const gate = r.run(['--verify']);
      assert.equal(gate.status, 1, name);
      assert.deepEqual(gate.categories, [category], `${name}: ${gate.stderr}`);
      assert.equal(gate.stdout, '', `${name}: nothing is listed for upload`);
    } finally { r.close(); }
  }
});

test('a scanner failure or missing artifact produces no result for the gate', () => {
  const missing = release();
  try {
    assert.equal(missing.run().status, 0);
    rmSync(join(missing.dist, INSTALLER));
    const result = missing.run();
    assert.equal(result.status, 1);
    assert.ok(result.categories.includes('artifact-missing') && result.categories.includes('artifact-set'));
    assert.equal(existsSync(missing.record()), false);
    assert.deepEqual(missing.run(['--verify']).categories, ['missing-evidence']);
  } finally { missing.close(); }
  const broken = release();
  try {
    writeFileSync(join(broken.root, 'package.json'), '{"version":1}');
    const result = broken.run();
    assert.equal(result.status, 2, 'an inspection error exits distinctly');
    assert.deepEqual(result.categories, ['missing-evidence']);
    assert.equal(existsSync(broken.record()), false);
  } finally { broken.close(); }
  // An invalid invocation after a clean pass withdraws that pass instead of leaving it standing.
  for (const args of [['--skip-scan'], ['--verify', '--skip-scan'], ['--dir']]) {
    const usage = release();
    try {
      assert.equal(usage.run().status, 0, 'clean first');
      assert.ok(existsSync(usage.record()));
      assert.equal(usage.run(args).status, 2, `${args.join(' ')}: refused, not ignored`);
      assert.equal(existsSync(usage.record()), false, `${args.join(' ')}: the earlier record is withdrawn`);
      const gate = usage.run(['--verify']);
      assert.equal(gate.status, 1); assert.deepEqual(gate.categories, ['missing-evidence']); assert.equal(gate.stdout, '');
    } finally { usage.close(); }
  }
});

// A deliberately fake value in a supported format, never used for anything.
const TOKEN = `ghp_${'T4'.repeat(18)}`;
// Expect a refusal with no record, no upload list and no quoted value.
function refused(r, name, expected = [], env = {}) {
  const result = r.run([], env);
  assert.equal(result.status, 1, `${name}: ${result.stderr}`);
  for (const category of expected) assert.ok(result.categories.includes(category), `${name}: ${JSON.stringify(result.report)}`);
  assert.ok(!(result.stdout + result.stderr).includes(TOKEN) && !(result.stdout + result.stderr).includes(PRIVATE), `${name}: no value is printed`);
  assert.equal(existsSync(r.record()), false, `${name}: no passing record`);
  const gate = r.run(['--verify']);
  assert.equal(gate.status, 1, name); assert.equal(gate.stdout, '', `${name}: nothing is listed for upload`);
  return result;
}

test('pax records are read by their declared lengths, so a multiline value cannot hide an entry name', () => {
  // The framing itself, independent of the checker (POSIX: the length counts the whole record).
  assert.equal(paxRecord('path', 'package/.env'), '21 path=package/.env\n');
  const comment = paxRecord('comment', 'synthetic\n1 path=package/notes.txt');
  assert.equal(comment, '46 comment=synthetic\n1 path=package/notes.txt\n');
  assert.equal(Buffer.byteLength(comment), 46);
  // The actual entry is package/.env; the comment only looks like a path record when split on newlines.
  const hidden = release({ runtimeExtra: [{ name: 'package/.env', data: PRIVATE, pax: { path: 'package/.env', comment: 'synthetic\n1 path=package/notes.txt' } }] });
  try {
    const result = refused(hidden, 'multiline pax value', ['environment-file']);
    assert.deepEqual(result.report.findings.map(f => [f.artifact, f.entry, f.category]), [[RUNTIME, 'package/.env', 'environment-file'],
      [PLUGIN, `codex-claude/${RUNTIME} > package/.env`, 'environment-file'], [INSTALLER, `Model Bridge/${RUNTIME} > package/.env`, 'environment-file']]);
  } finally { hidden.close(); }
  // A valid multiline pax value on an allowed entry still passes.
  const clean = release({ runtimeExtra: [{ name: 'package/notes.txt', data: 'Harmless text.\n', pax: { path: 'package/notes.txt', comment: 'synthetic\nsecond line' } }] });
  try { const result = clean.run(); assert.equal(result.status, 0, result.stderr); } finally { clean.close(); }
  // Controls for the byte-order-mark cases: an ordinary pax path override passes, and the same .env without one is refused.
  const override = release({ runtimeExtra: [{ name: 'package/header.txt', data: 'Harmless text.\n', pax: { path: 'package/notes.txt' } }] });
  try { const result = override.run(); assert.equal(result.status, 0, result.stderr); } finally { override.close(); }
  const plain = release({ runtimeExtra: [{ name: 'package/.env', data: PRIVATE }] });
  try {
    assert.deepEqual(refused(plain, 'plain .env').report.findings.map(f => [f.artifact, f.entry, f.category]), [[RUNTIME, 'package/.env', 'environment-file'],
      [PLUGIN, `codex-claude/${RUNTIME} > package/.env`, 'environment-file'], [INSTALLER, `Model Bridge/${RUNTIME} > package/.env`, 'environment-file']]);
  } finally { plain.close(); }
  // A leading U+FEFF is part of a key or value (a standard reader keeps it), never removed.
  const bomKey = paxRecord('﻿path', 'package/notes.txt');
  assert.equal(Buffer.byteLength(bomKey), 29);
  assert.deepEqual([...Buffer.from(bomKey).subarray(0, 6)], [0x32, 0x39, 0x20, 0xef, 0xbb, 0xbf]);
  // "﻿path" is an unknown key, not "path": the actual entry stays package/.env, and the key is refused.
  const key = release({ runtimeExtra: [{ name: 'package/.env', data: PRIVATE, pax: bomKey }] });
  try {
    const result = refused(key, 'byte-order-mark key', ['archive-unsupported']);
    assert.deepEqual(result.report.findings.map(f => [f.artifact, f.category]), [[RUNTIME, 'archive-unsupported'], [PLUGIN, 'archive-unsupported'], [INSTALLER, 'archive-unsupported']]);
  } finally { key.close(); }
  // A path value keeps its U+FEFF, so the entry is outside the literal package/ root.
  const value = release({ runtimeExtra: [{ name: 'package/header.txt', data: 'Harmless text.\n', pax: { path: '﻿package/notes.txt' } }] });
  try {
    assert.deepEqual(refused(value, 'byte-order-mark path value', ['unexpected-layout']).report.findings, [{ artifact: RUNTIME, entry: '', category: 'unexpected-layout' }]);
  } finally { value.close(); }
  // Malformed, ambiguous or unsupported extended headers are refused, never skipped.
  const file = { name: 'package/notes.txt', data: 'Harmless text.\n' };
  for (const [name, runtimeExtra, category] of [
    ['a declared length past the header', [{ ...file, pax: '99 path=package/notes.txt\n' }], 'archive-structure'],
    ['a declared length inside the record', [{ ...file, pax: '10 path=package/notes.txt\n' }], 'archive-structure'],
    ['a record without its length', [{ ...file, pax: 'path=package/notes.txt\n' }], 'archive-structure'],
    ['a duplicate path record', [{ ...file, pax: paxRecord('path', 'package/notes.txt') + paxRecord('path', 'package/.env') }], 'archive-structure'],
    ['a value that is not UTF-8', [{ ...file, pax: Buffer.concat([Buffer.from('18 path=package/'), Buffer.from([0xff]), Buffer.from('\n')]) }], 'archive-structure'],
    ['a size that disagrees with the header', [{ ...file, pax: { size: '5' } }], 'archive-structure'],
    ['a link path', [{ ...file, pax: { linkpath: 'package/.env' } }], 'archive-unsupported'],
    ['a vendor path key', [{ ...file, pax: { 'GNU.sparse.name': 'package/.env' } }], 'archive-unsupported'],
    ['two extended headers for one entry', [{ name: 'package/a', type: 'x', data: paxRecord('path', 'package/.env') }, { ...file, pax: { path: 'package/notes.txt' } }], 'archive-structure'],
    ['an extended header with no entry', [{ name: 'package/a', type: 'x', data: paxRecord('path', 'package/.env') }], 'archive-structure'],
  ]) {
    const r = release({ runtimeExtra });
    try {
      const result = refused(r, name, [category]);
      assert.deepEqual(result.report.findings.map(f => f.artifact), [RUNTIME, PLUGIN, INSTALLER], `${name}: the runtime and both nested copies`);
    } finally { r.close(); }
  }
});

test('directory entries must be empty; a payload is refused rather than skipped', () => {
  for (const [name, options] of [
    ['a ZIP directory with a payload', { pluginExtra: [{ name: 'codex-claude/notes/', data: TOKEN, mode: 0o40755 }] }],
    ['a stored ZIP directory with a payload', { pluginExtra: [{ name: 'codex-claude/notes/', data: TOKEN, method: 0, mode: 0o40755 }] }],
    ['a TGZ directory with a payload', { runtimeExtra: [{ name: 'package/notes/', type: '5', data: TOKEN }] }],
  ]) {
    const r = release(options);
    try { refused(r, name, ['archive-hidden-data']); } finally { r.close(); }
  }
  // The same value as an ordinary file body is refused by its format.
  const body = release({ pluginExtra: [{ name: 'codex-claude/notes.txt', data: TOKEN }] });
  try { refused(body, 'file body', ['github-token']); } finally { body.close(); }
});

test('delivered metadata and padding are scanned or refused', () => {
  for (const [name, options, category] of [
    ['a ZIP entry comment', { pluginExtra: [{ name: 'codex-claude/notes.txt', data: 'Harmless text.\n', comment: TOKEN }] }, 'archive-unsupported'],
    ['a ZIP central extra field', { pluginExtra: [{ name: 'codex-claude/notes.txt', data: 'Harmless text.\n', extra: extraField(0xcafe, TOKEN) }] }, 'archive-unsupported'],
    ['a ZIP local extra field', { pluginExtra: [{ name: 'codex-claude/notes.txt', data: 'Harmless text.\n', localExtra: extraField(0xcafe, TOKEN) }] }, 'archive-unsupported'],
    ['a pax comment', { runtimeExtra: [{ name: 'package/notes.txt', data: 'Harmless text.\n', pax: { comment: TOKEN } }] }, 'github-token'],
    ['a tar header field', { runtimeExtra: [{ name: 'package/notes.txt', data: 'Harmless text.\n', uname: `AKIA${'Z'.repeat(16)}` }] }, 'aws-access-key'],
    ['nonzero tar alignment padding', { runtimeExtra: [{ name: 'package/notes.txt', data: 'Harmless text.\n', padding: TOKEN }] }, 'archive-hidden-data'],
    ['a gzip header comment', { wrapRuntime: gz => gzipComment(gz, TOKEN) }, 'archive-unsupported'],
  ]) {
    const r = release(options);
    try { refused(r, name, [category]); } finally { r.close(); }
  }
  // The scanned pax comment is reported on its entry, in the runtime and both nested copies.
  const pax = release({ runtimeExtra: [{ name: 'package/notes.txt', data: 'Harmless text.\n', pax: { comment: TOKEN } }] });
  try {
    assert.deepEqual(refused(pax, 'pax comment').report.findings.map(f => [f.artifact, f.entry, f.category]), [[RUNTIME, 'package/notes.txt', 'github-token'],
      [PLUGIN, `codex-claude/${RUNTIME} > package/notes.txt`, 'github-token'], [INSTALLER, `Model Bridge/${RUNTIME} > package/notes.txt`, 'github-token']]);
  } finally { pax.close(); }
});

test('an entry name in a supported format is refused and redacted in every output', () => {
  for (const data of [TOKEN, 'Harmless text.\n']) {
    const r = release({ pluginExtra: [{ name: `codex-claude/${TOKEN}.txt`, data }] });
    try {
      const result = refused(r, `name with body ${data === TOKEN ? 'token' : 'clean'}`, ['github-token']);
      assert.deepEqual(result.report.findings, [{ artifact: PLUGIN, entry: 'codex-claude/[redacted].txt', category: 'github-token' }]);
    } finally { r.close(); }
  }
  const nested = release({ runtimeExtra: [{ name: `package/${TOKEN}.md`, data: TOKEN }] });
  try {
    const result = refused(nested, 'nested name');
    assert.deepEqual(result.report.findings.map(f => [f.artifact, f.entry, f.category]), [[RUNTIME, 'package/[redacted].md', 'github-token'],
      [PLUGIN, `codex-claude/${RUNTIME} > package/[redacted].md`, 'github-token'], [INSTALLER, `Model Bridge/${RUNTIME} > package/[redacted].md`, 'github-token']]);
  } finally { nested.close(); }
  // A private-file name keeps its own category, still with the value redacted.
  const env = release({ pluginExtra: [{ name: `codex-claude/${TOKEN}.env`, data: 'x' }] });
  try {
    assert.deepEqual(refused(env, 'private-file name').report.findings, [{ artifact: PLUGIN, entry: 'codex-claude/[redacted].env', category: 'environment-file' },
      { artifact: PLUGIN, entry: 'codex-claude/[redacted].env', category: 'github-token' }]);
  } finally { env.close(); }
});
