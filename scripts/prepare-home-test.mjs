// Create-only synthetic scope. No normal profile or auth is selected/copied.
import { mkdirSync, writeFileSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnections } from '../connections.mjs';
import { backendSha256, bindingName } from '../plugins/codex-claude/home/test-controls.mjs';

export function prepareHomeTest(root) {
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(dirname(root)) !== dirname(root)) throw new Error('Use a new absolute canonical task path');
  const source = readFileSync(new URL('../connections.mjs', import.meta.url));
  if (createHash('sha256').update(source).digest('hex') !== backendSha256) throw new Error('Backend source does not match this test entrypoint');
  mkdirSync(root, { mode: 0o700 }); // exclusive; no overwrite or repair
  for (const name of ['profile', 'state', 'backend']) mkdirSync(join(root, name), { mode: 0o700 });
  const identity = path => { const s = statSync(path); return [s.dev, s.ino, s.uid, s.mode & 0o7777].join(':'); };
  const m = { version: 1, kind: 'bridge-home-synthetic', bindingId: randomBytes(16).toString('hex'), profileId: randomBytes(16).toString('hex'), bridgeId: randomBytes(16).toString('hex'),
    root: identity(root), profile: identity(join(root, 'profile')), state: identity(join(root, 'state')),
    storeId: createConnections(join(root, 'state')).connections.claude_code.storeId, backendSha256 };
  writeFileSync(join(root, 'backend/connections.mjs'), source, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(root, 'profile/bridge-home-test.json'), JSON.stringify({ kind: m.kind, bindingId: m.bindingId, profileId: m.profileId, bridgeId: m.bridgeId }) + '\n', { flag: 'wx', mode: 0o600 });
  const bindingPath = join(root, bindingName);
  writeFileSync(bindingPath, JSON.stringify(m) + '\n', { flag: 'wx', mode: 0o600 });
  return { bindingPath, scope: { kind: m.kind, bindingId: m.bindingId, profileId: m.profileId, bridgeId: m.bridgeId }, nativeProfile: 'unverified', catalog: 'synthetic fixture only' };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/prepare-home-test.mjs /new/absolute/task-root');
  console.log(JSON.stringify(prepareHomeTest(process.argv[2])));
}
