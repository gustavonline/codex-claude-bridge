// Native OS credential storage only. Tokens travel over private stdio, never
// argv, tool results, state JSON or logs. This is not a same-UID sandbox claim.
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const tokenOk = x => typeof x === 'string' && /^[\x21-\x7e]{1,4096}$/.test(x);
const keychainHelper = fileURLToPath(new URL('./os-secret.py', import.meta.url));
const exact = (x, keys) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).sort().join() === keys.sort().join();
export class NativeSecrets {
  constructor(root, { platform = process.platform, python = process.env.BRIDGE_PYTHON ?? (process.platform === 'darwin' ? '/usr/bin/python3' : undefined), run = execFileSync, probe = lstatSync } = {}) {
    Object.assign(this, { root, platform, python, run, probe });
    this.service = 'online.gustav.model-bridge.' + createHash('sha256').update(root).digest('hex');
  }
  guard() {
    const s = lstatSync(this.root);
    if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700 || realpathSync(this.root) !== this.root) fail('secret_storage_unavailable');
  }
  available() {
    try {
      const p = this.platform === 'linux' ? '/usr/bin/secret-tool' : this.platform === 'darwin' ? this.python : null;
      if (!p || !isAbsolute(p)) return false;
      const s = this.probe(p); return s.isFile() && (s.mode & 0o111) !== 0 && (s.mode & 0o022) === 0;
    } catch { return false; }
  }
  records() {
    this.guard(); let fd;
    try { fd = openSync(join(this.root, 'native-auth-references.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (e) { if (e.code === 'ENOENT') return []; fail('secret_reference_invalid'); }
    try {
      const s = fstatSync(fd); if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > 65536) fail('secret_reference_invalid');
      const b = Buffer.alloc(65537); let n = 0, got;
      while (n < b.length && (got = readSync(fd, b, n, b.length - n, null))) n += got;
      const v = JSON.parse(b.subarray(0, n));
      if (n > 65536 || !exact(v, ['version', 'references']) || v.version !== 1 || !Array.isArray(v.references) || v.references.length > 16) fail('secret_reference_invalid');
      const seen = new Set();
      for (const r of v.references) {
        if (!exact(r, ['id', 'baseUrl']) || !/^native_[a-f0-9]{32}$/.test(r.id) || seen.has(r.id)
          || typeof r.baseUrl !== 'string' || r.baseUrl.length > 2048 || !r.baseUrl.startsWith('https://') && !/^http:\/\/(127\.0\.0\.1|\[::1\]):/.test(r.baseUrl)) fail('secret_reference_invalid');
        seen.add(r.id);
      }
      return v.references;
    } catch { fail('secret_reference_invalid'); } finally { closeSync(fd); }
  }
  command(action, reference, token, baseUrl) {
    if (typeof baseUrl !== 'string' || baseUrl.length > 2048) fail('credential_endpoint_mismatch');
    const endpoint = createHash('sha256').update(baseUrl).digest('hex');
    if (!this.available() || !/^native_[a-f0-9]{32}$/.test(reference)) fail('secret_storage_unavailable');
    let executable, args;
    if (this.platform === 'linux') {
      executable = '/usr/bin/secret-tool';
      args = [action === 'get' ? 'lookup' : action === 'delete' ? 'clear' : 'store', ...(action === 'store' ? ['--label=Model Bridge'] : []), 'service', this.service, 'reference', reference, 'endpoint', endpoint];
    } else { executable = this.python; args = ['-I', '-B', keychainHelper, action, this.service, reference + '_' + endpoint]; }
    try {
      const b = this.run(executable, args, { input: action === 'store' ? Buffer.from(token) : undefined, timeout: 10000, maxBuffer: 8192, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      if (action !== 'get') return;
      if (typeof b !== 'string') fail('secret_unavailable');
      const key = b.replace(/\r?\n$/, ''); if (!tokenOk(key)) fail('secret_unavailable'); return key;
    } catch { fail(action === 'get' ? 'secret_unavailable' : 'secret_storage_unavailable'); }
  }
  get(reference, baseUrl) {
    if (!this.records().some(r => r.id === reference && r.baseUrl === baseUrl)) fail('credential_endpoint_mismatch');
    return this.command('get', reference, undefined, baseUrl);
  }
  discard(reference, baseUrl) {
    // Roll back ONLY the newly enrolled reference from this failed auth attempt.
    // There is no Home/model tool for deleting arbitrary credentials.
    this.guard(); const lock = join(this.root, 'native-auth-references.lock');
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const records = this.records(); if (!records.some(r => r.id === reference && r.baseUrl === baseUrl)) return;
      this.command('delete', reference, undefined, baseUrl);
      const temp = join(this.root, 'native-auth-' + randomBytes(8).toString('hex') + '.tmp');
      writeFileSync(temp, JSON.stringify({ version: 1, references: records.filter(r => r.id !== reference) }) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temp, join(this.root, 'native-auth-references.json'));
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  enroll(baseUrl, token, guard = () => {}) {
    if (!tokenOk(token)) fail('credential_invalid'); this.guard();
    const lock = join(this.root, 'native-auth-references.lock');
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const reference = 'native_' + randomBytes(16).toString('hex'); let stored = false, published = false;
    try {
      guard(); const records = this.records(); if (records.length >= 16) fail('secret_reference_limit');
      this.command('store', reference, token, baseUrl); stored = true; guard();
      const temp = join(this.root, 'native-auth-' + randomBytes(8).toString('hex') + '.tmp');
      writeFileSync(temp, JSON.stringify({ version: 1, references: [...records, { id: reference, baseUrl }] }) + '\n', { flag: 'wx', mode: 0o600 });
      renameSync(temp, join(this.root, 'native-auth-references.json')); published = true; return reference;
    } finally {
      // Only this attempt's newly created native item; never existing keys.
      if (stored && !published) try { this.command('delete', reference, undefined, baseUrl); } catch { /* native orphan requires explicit operator cleanup, never key output */ }
      closeSync(fd); unlinkSync(lock);
    }
  }
}
