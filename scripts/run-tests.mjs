// Runs the test suite with a canonical temporary directory. On macOS os.tmpdir() is a /var/folders path whose real path is under /private,
// and Bridge's state guards (rootOk) rightly refuse any root whose real path differs from its path. Test roots therefore live in the real path;
// the guards stay strict. Arguments are passed to `node --test` (default: every test file).
import { spawn } from 'node:child_process';
import { realpathSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const tests = fileURLToPath(new URL('../test/', import.meta.url));
const args = process.argv.slice(2);
const files = args.some(a => !a.startsWith('-')) ? [] : readdirSync(tests).filter(f => f.endsWith('.test.mjs')).sort().map(f => tests + f);
const child = spawn(process.execPath, ['--test', ...args, ...files], { stdio: 'inherit', env: { ...process.env, TMPDIR: realpathSync(tmpdir()) } });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
