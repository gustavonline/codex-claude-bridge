// Task-only metadata audit. Never records bytes from any file.
import fs from 'node:fs';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const fd = fs.openSync(process.env.FS_AUDIT_LOG, 'wx', 0o600), write = fs.writeSync;
for (const name of ['readFileSync', 'openSync', 'lstatSync', 'statSync', 'realpathSync', 'readdirSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'chmodSync']) {
  const original = fs[name];
  fs[name] = function (...args) {
    const writes = name === 'openSync' ? (typeof args[1] === 'number' ? !!(args[1] & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) : /[wa+]/.test(args[1])) : ['writeFileSync', 'renameSync', 'unlinkSync', 'mkdirSync', 'chmodSync'].includes(name);
    const paths = args.slice(0, name === 'renameSync' ? 2 : 1).filter(x => typeof x === 'string' || x instanceof URL).map(x => resolve(x instanceof URL ? x.pathname : x));
    write(fd, JSON.stringify({ operation: name, writes, paths }) + '\n');
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
