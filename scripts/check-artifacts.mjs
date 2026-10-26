// Final release-artifact check (issue #15). Inspects the actual runtime TGZ,
// plugin ZIP and installer ZIP after bundling, including every outer entry and
// the nested runtime archives, and refuses private state or supported secret
// formats in entry names, retained metadata and contents. Reports only the
// artifact, entry path (supported formats redacted) and category, never a match.
//
//   node scripts/check-artifacts.mjs [--dir dist]           check, then record ARTIFACT-CHECK.json
//   node scripts/check-artifacts.mjs --verify [--dir dist]  confirm those exact bytes; print the upload list
//
// Any inspection error, bound, unsupported format or missing artifact fails and
// leaves no passing record. Dependency-free; reads package.json from the cwd.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { inflateRawSync } from 'node:zlib';

const SCHEMA = 'model-bridge-artifact-check/1', RECORD = 'ARTIFACT-CHECK.json', SUMS = 'SHA256SUMS';
const MiB = 1024 * 1024;
// Environment values can only tighten these bounds (used by synthetic tests).
const bound = (name, value) => { const v = Number(process.env[name]); return Number.isSafeInteger(v) && v > 0 ? Math.min(v, value) : value; };
const LIMITS = { artifactBytes: bound('BRIDGE_ARTIFACT_MAX_ARTIFACT_BYTES', 64 * MiB), entryBytes: bound('BRIDGE_ARTIFACT_MAX_ENTRY_BYTES', 32 * MiB),
  totalBytes: bound('BRIDGE_ARTIFACT_MAX_TOTAL_BYTES', 256 * MiB), entries: bound('BRIDGE_ARTIFACT_MAX_ENTRIES', 5000),
  milliseconds: bound('BRIDGE_ARTIFACT_MAX_MILLISECONDS', 120_000) };

class Refusal extends Error { constructor(category) { super(category); this.category = category; } }
const sha256 = data => createHash('sha256').update(data).digest('hex');

// Private state, by entry path, regardless of Git ignore rules.
const ENV_EXAMPLE = /^\.env\.(?:example|sample|template)$/; // Reviewed names for placeholders; their content is still scanned.
const AUTH_FILES = new Set(['auth.json', 'credentials.json', '.credentials.json', '.netrc', '.npmrc', '.pypirc', '.git-credentials', 'token.json']);
const AUTH_DIRS = new Set(['.codex', '.claude', '.ssh', '.aws', '.gnupg', '.config']);
const TRANSCRIPT_DIRS = new Set(['threads', 'sessions', 'transcripts', 'rollouts', 'history']);
export function pathCategory(path) {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const parts = trimmed.toLowerCase().split('/'), name = parts.at(-1), dirs = parts.slice(0, -1);
  if (!trimmed || trimmed.startsWith('/') || /^[a-z]:/i.test(trimmed) || trimmed.includes('\\') || /[\x00-\x1f\x7f]/.test(trimmed)
    || parts.some(part => part === '' || part === '.' || part === '..')) return 'unsafe-path';
  if (parts.includes('.git')) return 'repository-state';
  if ((/^\.env(?:\..+)?$/.test(name) || name.endsWith('.env')) && !ENV_EXAMPLE.test(name)) return 'environment-file';
  if (AUTH_FILES.has(name) || parts.some(part => AUTH_DIRS.has(part))) return 'auth-state';
  if (name.endsWith('.log') || dirs.includes('logs')) return 'log';
  if (name.endsWith('.jsonl') || dirs.some(part => TRANSCRIPT_DIRS.has(part))) return 'transcript';
  if (/\.(?:pem|key|p12|pfx|p8|jks|keystore|kdbx)$/.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(name)) return 'key-file';
  return null;
}

// Supported secret formats in any entry's bytes, plus private local paths.
export const CONTENT = [
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/],
  ['openai-key', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}T3BlbkFJ[A-Za-z0-9_-]{16,}|\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}/],
  ['anthropic-key', /\bsk-ant-(?:api|admin|oat)\d{2}-[A-Za-z0-9_-]{40,}/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['secret-assignment', /\b(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"]?[A-Za-z0-9_\-+/.]{16,}/],
  ['local-path', /\/Users\/|\/home\/factory\//],
];
// Diagnostics quote untrusted entry paths: redact every supported format before
// replacing unprintable characters and truncating.
const REDACT = CONTENT.map(([, pattern]) => new RegExp(pattern.source, `${pattern.flags}g`));
const printable = text => REDACT.reduce((out, pattern) => out.replace(pattern, '[redacted]'), String(text)).replace(/[^\x20-\x7e]/g, '?').slice(0, 160);

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = data => { let c = 0xffffffff; for (const byte of data) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
// Decompress within a bound, and require the whole input to be one consumed stream.
function decompress(fn, input, maxOutputLength) {
  let result;
  try { result = fn(input, { maxOutputLength: Math.max(1, maxOutputLength), info: true }); }
  catch (error) { throw new Refusal(error?.code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError ? 'archive-bound' : 'archive-structure'); }
  if (result.engine.bytesWritten !== input.length) throw new Refusal('archive-hidden-data');
  return result.buffer;
}

// ZIP: classic, as the bundle's standard-library writer produces it (no ZIP64,
// encryption, data descriptors, extra fields, comments or spanning). Every byte
// before the central directory must belong to exactly one listed entry, in
// order, so hidden or unreferenced entries are refused. Directories are empty.
export function zipEntries(buffer, budget) {
  if (buffer.length < 22) throw new Refusal('archive-structure');
  const u16 = at => buffer.readUInt16LE(at), u32 = at => buffer.readUInt32LE(at), eocd = buffer.length - 22;
  if (u32(eocd) !== 0x06054b50) throw new Refusal('archive-hidden-data'); // A comment or trailing bytes.
  const count = u16(eocd + 10), cdSize = u32(eocd + 12), cdOffset = u32(eocd + 16);
  if (u16(eocd + 4) || u16(eocd + 6) || u16(eocd + 8) !== count || u16(eocd + 20) || count === 0xffff || cdOffset === 0xffffffff)
    throw new Refusal('archive-unsupported');
  if (cdOffset + cdSize !== eocd) throw new Refusal('archive-hidden-data');
  if (count > LIMITS.entries) throw new Refusal('archive-bound');
  const central = [], names = new Set();
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || u32(at) !== 0x02014b50) throw new Refusal('archive-structure');
    const flags = u16(at + 8), nameLength = u16(at + 28), raw = buffer.subarray(at + 46, at + 46 + nameLength);
    const entry = { flags, method: u16(at + 10), crc: u32(at + 16), compressed: u32(at + 20), size: u32(at + 24),
      mode: u32(at + 38) >>> 16, local: u32(at + 42), raw, path: raw.toString(flags & 0x800 ? 'utf8' : 'latin1') };
    if (names.has(entry.path)) throw new Refusal('archive-structure');
    names.add(entry.path); central.push(entry);
    if (u16(at + 30) || u16(at + 32) || u16(at + 34)) throw new Refusal('archive-unsupported'); // Extra field, entry comment or another disk.
    at += 46 + nameLength;
  }
  if (at !== eocd) throw new Refusal('archive-structure');
  const entries = [];
  let expected = 0, total = 0;
  for (const entry of central.sort((a, b) => a.local - b.local)) {
    if (entry.local !== expected) throw new Refusal('archive-hidden-data'); // Bytes no listed entry accounts for.
    if (entry.local + 30 > cdOffset || u32(entry.local) !== 0x04034b50) throw new Refusal('archive-structure');
    if (entry.flags & 0x0009) throw new Refusal('archive-unsupported'); // Encrypted, or sizes in a data descriptor.
    if (u16(entry.local + 28)) throw new Refusal('archive-unsupported'); // Local extra field.
    const nameLength = u16(entry.local + 26), start = entry.local + 30 + nameLength, end = start + entry.compressed;
    if (u16(entry.local + 6) !== entry.flags || u16(entry.local + 8) !== entry.method
      || !buffer.subarray(entry.local + 30, entry.local + 30 + nameLength).equals(entry.raw) || end > cdOffset) throw new Refusal('archive-structure');
    if ((entry.mode & 0o170000) === 0o120000) throw new Refusal('archive-unsupported'); // Symbolic link.
    const directory = entry.path.endsWith('/');
    if (directory && entry.size) throw new Refusal('archive-hidden-data'); // A directory carries no payload.
    total += entry.size;
    if (entry.size > LIMITS.entryBytes || total > budget) throw new Refusal('archive-bound');
    const data = entry.method === 0 ? buffer.subarray(start, end) : entry.method === 8 ? decompress(inflateRawSync, buffer.subarray(start, end), entry.size) : null;
    if (!data) throw new Refusal('archive-unsupported');
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new Refusal('archive-structure');
    expected = end;
    entries.push({ path: entry.path, data, directory });
  }
  if (expected !== cdOffset) throw new Refusal('archive-hidden-data');
  return entries;
}

// gzip: exactly one member with no optional header fields (name, comment,
// extra or header CRC), as zlib writes it; the trailer must match the tar.
function gunzipOne(buffer, budget) {
  if (buffer.length < 18 || buffer[0] !== 0x1f || buffer[1] !== 0x8b || buffer[2] !== 8) throw new Refusal('archive-structure');
  if (buffer[3]) throw new Refusal('archive-unsupported');
  const tar = decompress(inflateRawSync, buffer.subarray(10, buffer.length - 8), budget); // Another member is unconsumed input.
  if (buffer.readUInt32LE(buffer.length - 8) !== crc32(tar) || buffer.readUInt32LE(buffer.length - 4) !== tar.length % 2 ** 32) throw new Refusal('archive-structure');
  return tar;
}

// PAX extended header: "<length> <key>=<value>\n" records, each exactly its
// declared byte length, together covering the whole body. Values may contain
// newlines, so a record is never split on them. Duplicate, malformed or
// non-UTF-8 records are refused, and so are keys other than these (links,
// sparse files and vendor keys would change what other readers see).
const PAX_KEYS = { path: /^[^\0]+$/, size: /^\d{1,15}$/, mtime: /^-?\d{1,20}(?:\.\d{1,9})?$/, atime: /^-?\d{1,20}(?:\.\d{1,9})?$/,
  ctime: /^-?\d{1,20}(?:\.\d{1,9})?$/, uid: /^\d{1,15}$/, gid: /^\d{1,15}$/, uname: /^/, gname: /^/, comment: /^/ };
// Keys and values keep their exact characters: ignoreBOM: true keeps a leading
// U+FEFF in the decoded text instead of removing it, so "﻿path" is not the
// key "path" and a path value keeps its literal first character. A runtime
// that still removed it fails closed.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const BOM_KEPT = utf8.decode(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61)) === '﻿a';
function paxFields(data) {
  if (!BOM_KEPT) throw new Refusal('archive-unsupported');
  const fields = new Map();
  for (let at = 0; at < data.length;) {
    const space = data.indexOf(0x20, at), digits = space < 0 ? '' : data.subarray(at, space).toString('latin1');
    if (!/^[1-9]\d{0,7}$/.test(digits)) throw new Refusal('archive-structure');
    const end = at + Number(digits), equals = data.indexOf(0x3d, space + 1);
    if (end > data.length || data[end - 1] !== 0x0a || equals <= space + 1 || equals >= end - 1) throw new Refusal('archive-structure');
    let key, value;
    try { key = utf8.decode(data.subarray(space + 1, equals)); value = utf8.decode(data.subarray(equals + 1, end - 1)); }
    catch { throw new Refusal('archive-structure'); }
    if (fields.has(key)) throw new Refusal('archive-structure');
    if (!Object.hasOwn(PAX_KEYS, key)) throw new Refusal('archive-unsupported');
    if (!PAX_KEYS[key].test(value)) throw new Refusal('archive-structure');
    fields.set(key, value);
    at = end;
  }
  return fields;
}

// A ustar header as its separate fields, so a value is scanned from the start
// of its field rather than joined to the field before it.
const USTAR_FIELDS = [100, 108, 116, 124, 136, 148, 156, 157, 257, 263, 265, 297, 329, 337, 345, 500, 512];
const headerText = header => USTAR_FIELDS.map((end, i) => header.subarray(USTAR_FIELDS[i - 1] ?? 0, end).toString('latin1')).join('\n');

// TGZ: one gzip member holding ustar/pax regular files and empty directories
// only; links, devices, global headers, nonzero alignment padding and data
// after the end marker are refused. Header fields and PAX records are returned
// as metadata so their text is scanned like contents.
export function tgzEntries(buffer, budget) {
  const tar = gunzipOne(buffer, budget);
  // A numeric field of the given header (offsets are within that 512-byte header).
  const octal = (header, at, length) => {
    const text = header.subarray(at, at + length).toString('latin1').replace(/\0.*$/s, '').trim();
    if (!/^[0-7]*$/.test(text)) throw new Refusal('archive-unsupported');
    return text ? parseInt(text, 8) : 0;
  };
  const entries = [], names = new Set();
  let at = 0, pax = null;
  for (;;) {
    if (at + 512 > tar.length) throw new Refusal('archive-structure');
    const header = tar.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) {
      if (pax) throw new Refusal('archive-structure'); // An extended header with no entry.
      if (!tar.subarray(at).every(byte => byte === 0)) throw new Refusal('archive-hidden-data');
      return entries;
    }
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (octal(header, 148, 8) !== sum) throw new Refusal('archive-structure');
    const type = String.fromCharCode(header[156] || 48), size = octal(header, 124, 12);
    const start = at + 512, end = start + size, next = start + Math.ceil(size / 512) * 512;
    if (size > LIMITS.entryBytes) throw new Refusal('archive-bound');
    if (next > tar.length) throw new Refusal('archive-structure');
    if (!tar.subarray(end, next).every(byte => byte === 0)) throw new Refusal('archive-hidden-data'); // Alignment padding carries nothing.
    at = next;
    const data = tar.subarray(start, end);
    if (type === 'x') {
      if (pax) throw new Refusal('archive-structure'); // One extended header per entry.
      pax = { fields: paxFields(data), meta: `${headerText(header)}\n${data.toString('latin1')}` };
      continue;
    }
    const fields = pax?.fields ?? new Map(), meta = `${pax ? `${pax.meta}\n` : ''}${headerText(header)}`;
    pax = null;
    if (type !== '0' && type !== '5') throw new Refusal('archive-unsupported');
    if (fields.has('size') && Number(fields.get('size')) !== size) throw new Refusal('archive-structure');
    if (type === '5' && size) throw new Refusal('archive-hidden-data'); // A directory carries no payload.
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, ''), prefix = header.subarray(257, 262).toString('latin1') === 'ustar'
      ? header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '') : '';
    const path = fields.get('path') ?? (prefix ? `${prefix}/${name}` : name);
    if (names.has(path)) throw new Refusal('archive-structure');
    names.add(path);
    entries.push({ path, data, directory: type === '5', meta });
  }
}

function inspect(buffer, where, depth, context) {
  const outer = where.at(-1);
  const budget = LIMITS.totalBytes - context.bytes;
  const entries = /\.zip$/i.test(outer) ? zipEntries(buffer, budget) : tgzEntries(buffer, budget);
  for (const entry of entries) {
    if (Date.now() - context.started > LIMITS.milliseconds) throw new Refusal('timeout');
    context.bytes += entry.data.length;
    if (++context.entries > LIMITS.entries || context.bytes > LIMITS.totalBytes) throw new Refusal('archive-bound');
    const path = [...where, entry.path];
    context.paths.push(path);
    const category = pathCategory(entry.path);
    if (category) context.findings.push({ where: path, category });
    // Names and retained metadata are delivered too; each format is reported once per entry.
    const found = new Set();
    const scan = text => { for (const [name, pattern] of CONTENT) if (!found.has(name) && pattern.test(text)) { found.add(name); context.findings.push({ where: path, category: name }); } };
    scan(entry.path); scan(entry.meta ?? '');
    if (entry.directory) continue; // The parsers refuse directories with a payload.
    if (/\.(?:zip|tgz|tar\.gz)$/i.test(entry.path)) {
      if (depth >= 1) { context.findings.push({ where: path, category: 'archive-nesting' }); continue; }
      context.nested.push({ where: path, sha256: sha256(entry.data) });
      try { inspect(entry.data, path, depth + 1, context); }
      catch (error) { if (!(error instanceof Refusal) || error.category === 'timeout') throw error; context.findings.push({ where: path, category: error.category }); }
      continue;
    }
    scan(entry.data.toString('latin1'));
  }
}

const expectedNames = () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') throw new Refusal('missing-evidence');
  return { version: pkg.version, runtime: `${pkg.name}-${pkg.version}.tgz`, plugin: `model-bridge-plugin-${pkg.version}.zip`, installer: `model-bridge-installer-${pkg.version}.zip` };
};
const artifactFiles = dir => readdirSync(dir).filter(name => /\.(?:tgz|zip)$/i.test(name) && statSync(join(dir, name)).isFile()).sort();
const checker = () => sha256(readFileSync(fileURLToPath(import.meta.url)));
function readArtifact(dir, name) {
  if (statSync(join(dir, name)).size > LIMITS.artifactBytes) throw new Refusal('archive-bound');
  return readFileSync(join(dir, name));
}
function sums(text, expected) {
  const lines = text.split('\n').filter(Boolean).map(line => /^([0-9a-f]{64})  (\S+)$/.exec(line));
  if (lines.some(line => !line)) return null;
  const listed = Object.fromEntries(lines.map(line => [line[2], line[1]]));
  return lines.length === Object.keys(listed).length && isDeepStrictEqual(Object.keys(listed).sort(), Object.keys(expected).sort())
    && Object.entries(expected).every(([name, hash]) => listed[name] === hash);
}

export function check(dir) {
  const record = join(dir, RECORD);
  rmSync(record, { force: true }); // A failed or interrupted run never leaves an earlier pass behind.
  const names = expectedNames(), required = [names.runtime, names.plugin, names.installer];
  const context = { started: Date.now(), bytes: 0, entries: 0, paths: [], nested: [], findings: [] }, artifacts = {};
  if (!isDeepStrictEqual(artifactFiles(dir), [...required].sort())) context.findings.push({ where: ['dist'], category: 'artifact-set' });
  for (const name of required) {
    let buffer;
    try { buffer = readArtifact(dir, name); }
    catch (error) { context.findings.push({ where: [name], category: error instanceof Refusal ? error.category : 'artifact-missing' }); continue; }
    artifacts[name] = { name, bytes: buffer.length, sha256: sha256(buffer) };
    try { inspect(buffer, [name], 0, context); }
    catch (error) { if (!(error instanceof Refusal)) throw error; context.findings.push({ where: [name], category: error.category }); }
  }
  // Layout and identity: each ZIP holds only its folder and exactly the outer runtime.
  const runtimeHash = artifacts[names.runtime]?.sha256;
  for (const [name, folder] of [[names.plugin, 'codex-claude/'], [names.installer, 'Model Bridge/']]) {
    const own = context.paths.filter(path => path.length === 2 && path[0] === name);
    if (artifacts[name] && own.some(path => !path[1].startsWith(folder))) context.findings.push({ where: [name], category: 'unexpected-layout' });
    const nested = context.nested.filter(item => item.where[0] === name);
    if (artifacts[name] && (nested.length !== 1 || nested[0].where[1] !== `${folder}${names.runtime}` || nested[0].sha256 !== runtimeHash))
      context.findings.push({ where: [name], category: 'nested-runtime-mismatch' });
  }
  if (artifacts[names.runtime] && context.paths.some(path => path.length === 2 && path[0] === names.runtime && !path[1].startsWith('package/')))
    context.findings.push({ where: [names.runtime], category: 'unexpected-layout' });
  let sumsText;
  try { sumsText = readFileSync(join(dir, SUMS), 'utf8'); } catch { sumsText = null; }
  if (sumsText === null || !sums(sumsText, Object.fromEntries(Object.values(artifacts).map(a => [a.name, a.sha256])))) context.findings.push({ where: [SUMS], category: 'checksum-mismatch' });
  if (context.findings.length) return { passed: false, findings: context.findings };
  const result = { schema: SCHEMA, passed: true, version: names.version, checker: checker(), entries: context.entries,
    artifacts: required.map(name => artifacts[name]), sums: sha256(sumsText) };
  writeFileSync(`${record}.tmp`, JSON.stringify(result, null, 2) + '\n');
  renameSync(`${record}.tmp`, record);
  return result;
}

// The delivery gate: the exact checked bytes, nothing added, missing or changed,
// checked by this same checker. Returns the paths to upload.
export function verify(dir) {
  const fail = category => ({ passed: false, findings: [{ where: [RECORD], category }] });
  let record;
  try { record = JSON.parse(readFileSync(join(dir, RECORD), 'utf8')); } catch { return fail('missing-evidence'); }
  const names = expectedNames(), required = [names.runtime, names.plugin, names.installer];
  if (record?.schema !== SCHEMA || record.passed !== true || record.version !== names.version) return fail('missing-evidence');
  if (record.checker !== checker()) return fail('checker-changed');
  if (!isDeepStrictEqual(record.artifacts?.map(a => a.name), required) || !isDeepStrictEqual(artifactFiles(dir), [...required].sort())) return fail('artifact-set');
  for (const expected of record.artifacts) {
    let buffer;
    try { buffer = readArtifact(dir, expected.name); } catch { return fail('artifact-missing'); }
    if (buffer.length !== expected.bytes || sha256(buffer) !== expected.sha256) return fail('artifact-changed');
  }
  let sumsText;
  try { sumsText = readFileSync(join(dir, SUMS)); } catch { return fail('checksum-mismatch'); }
  if (sha256(sumsText) !== record.sums) return fail('checksum-mismatch');
  return { passed: true, paths: [...required, SUMS].map(name => join(dir, name)) };
}

const report = result => JSON.stringify({ passed: false, findings: result.findings.map(finding =>
  ({ artifact: printable(finding.where[0]), entry: finding.where.slice(1).map(printable).join(' > '), category: finding.category })) });

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2), at = args.indexOf('--dir'), dir = at >= 0 ? args[at + 1] : 'dist';
  const known = args.filter((arg, i) => arg === '--verify' || (arg === '--dir' && i === at) || (at >= 0 && i === at + 1));
  if (!dir || known.length !== args.length) {
    // An invalid invocation is a failed check: withdraw the record it would
    // otherwise leave standing (only that one file, in the named or default directory).
    rmSync(join(dir || 'dist', RECORD), { force: true });
    console.error('Usage: node scripts/check-artifacts.mjs [--verify] [--dir DIR]'); process.exit(2);
  }
  try {
    const result = args.includes('--verify') ? verify(dir) : check(dir);
    if (!result.passed) { console.error(report(result)); process.exitCode = 1; }
    else if (args.includes('--verify')) console.log(result.paths.join('\n'));
    else console.error(`Artifact check passed: ${result.artifacts.length} artifacts, ${result.entries} entries; recorded ${RECORD}.`);
  } catch (error) {
    // Unexpected failure: category only; no message, which could quote content.
    console.error(JSON.stringify({ passed: false, findings: [{ artifact: '', entry: '', category: error instanceof Refusal ? error.category : 'inspection-failed' }] }));
    process.exitCode = 2;
  }
}
