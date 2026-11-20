// Preload for the Home server under test: records every filesystem path the
// server asks the public `fs` API for, one per line, to $FS_AUDIT_LOG.
import fs from 'node:fs';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const log = process.env.FS_AUDIT_LOG, append = fs.appendFileSync;
for (const name of ['readFileSync', 'readdirSync', 'openSync', 'opendirSync', 'statSync', 'lstatSync', 'realpathSync', 'readlinkSync', 'existsSync', 'accessSync',
  'readFile', 'readdir', 'open', 'opendir', 'stat', 'lstat', 'access', 'createReadStream']) {
  const original = fs[name];
  if (typeof original !== 'function') continue;
  const wrapped = function (...args) {
    const [target] = args;
    if (typeof target === 'string' || target instanceof URL || Buffer.isBuffer(target)) append(log, `${name} ${resolve(target instanceof URL ? target.pathname : String(target))}\n`);
    return original.apply(this, args);
  };
  fs[name] = Object.assign(wrapped, original);
}
syncBuiltinESMExports();
