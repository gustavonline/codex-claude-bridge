// Explicit synthetic test scope only. The ordinary plugin never imports this
// module. No path comes from a tool argument, HTML, environment or user profile.
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const backendSha256 = 'c89c64d90e1d8b380851a5e30b9f0d8df2933b3e9edafe76b412cf3c420980a0';
export const bindingName = 'home-test-binding.json';
export const fixtureModels = () => [{ value: 'haiku', displayName: 'Fixture Haiku' }, { value: 'sonnet', displayName: 'Fixture Sonnet' }];
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const id = x => typeof x === 'string' && /^[a-f0-9]{32}$/.test(x);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => object(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const identity = s => [s.dev, s.ino, s.uid, s.mode & 0o7777].join(':');

function directory(path) {
  const s = lstatSync(path);
  if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o7777) !== 0o700 || realpathSync(path) !== path) fail('binding_invalid');
  return s;
}
// Walk metadata only; never follow a link in an operator-supplied path.
function parents(path) {
  for (let p = path;; p = dirname(p)) {
    if (!lstatSync(p).isDirectory()) fail('binding_invalid');
    if (p === dirname(p)) break;
  }
  if (realpathSync(path) !== path) fail('binding_invalid');
}
function bytes(path, max) {
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || (before.mode & 0o7777) !== 0o600 || before.size > max) fail('binding_invalid');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (identity(s) !== identity(before) || s.nlink !== 1 || s.size !== before.size) fail('binding_invalid');
    const b = Buffer.alloc(max + 1); let n = 0, count;
    while (n < b.length && (count = readSync(fd, b, n, b.length - n, null))) n += count;
    if (n !== before.size || n > max || identity(lstatSync(path)) !== identity(s)) fail('binding_invalid');
    return b.subarray(0, n);
  } finally { closeSync(fd); }
}

// The startup path is operator-owned. Its contents declare only IDs and fixed
// child identities, never another path. The backend bytes are pinned to the
// accepted c4b962e module; import those verified bytes, not a raceable filename.
export async function testControls(bindingPath, { discover = async () => fixtureModels() } = {}) {
  if (!isAbsolute(bindingPath) || resolve(bindingPath) !== bindingPath || basename(bindingPath) !== bindingName) fail('binding_invalid');
  const root = dirname(bindingPath); parents(root);
  const rootStat = directory(root), profile = join(root, 'profile'), state = join(root, 'state'), backend = join(root, 'backend');
  const profileStat = directory(profile), stateStat = directory(state), backendStat = directory(backend);
  const manifestBytes = bytes(bindingPath, 4096), m = JSON.parse(manifestBytes);
  const keys = ['version', 'kind', 'bindingId', 'profileId', 'bridgeId', 'root', 'profile', 'state', 'storeId', 'backendSha256'];
  if (!exact(m, keys) || m.version !== 1 || m.kind !== 'bridge-home-synthetic' || !id(m.bindingId) || !id(m.profileId) || !id(m.bridgeId) || !id(m.storeId)
    || m.root !== identity(rootStat) || m.profile !== identity(profileStat) || m.state !== identity(stateStat) || m.backendSha256 !== backendSha256) fail('binding_invalid');
  const markerPath = join(profile, 'bridge-home-test.json'), markerBytes = bytes(markerPath, 512);
  if (markerBytes.toString() !== JSON.stringify({ kind: m.kind, bindingId: m.bindingId, profileId: m.profileId, bridgeId: m.bridgeId }) + '\n') fail('binding_invalid');
  const sourcePath = join(backend, 'connections.mjs'), source = bytes(sourcePath, 65536);
  if (hash(source) !== backendSha256) fail('binding_invalid');
  const store = await import('data:text/javascript;base64,' + source.toString('base64'));
  const scope = { kind: 'synthetic', bindingId: m.bindingId, profileId: m.profileId, bridgeId: m.bridgeId };
  const guard = () => {
    parents(root);
    if (identity(directory(root)) !== m.root || identity(directory(profile)) !== m.profile || identity(directory(state)) !== m.state
      || identity(directory(backend)) !== identity(backendStat) || !bytes(bindingPath, 4096).equals(manifestBytes)
      || !bytes(markerPath, 512).equals(markerBytes) || hash(bytes(sourcePath, 65536)) !== backendSha256) fail('binding_invalid');
    const file = lstatSync(join(state, 'connections.json'));
    if (!file.isFile() || file.nlink !== 1 || file.uid !== process.getuid() || (file.mode & 0o7777) !== 0o600) fail('store_unavailable');
    const read = store.readConnections(state);
    if (read.status !== 'ok' || read.legacy || read.store.connections.claude_code.storeId !== m.storeId) fail('store_unavailable');
    return read.store;
  };
  const view = value => {
    const c = value.connections.claude_code;
    return { ...scope, revision: value.revision, enabled: c.enabled, visible: c.visible,
      catalogState: c.catalog?.status ?? 'unknown', models: (c.catalog?.models ?? []).map(model => ({ id: model.value, name: model.displayName })),
      catalogSource: 'synthetic fixture; no SDK/runtime or model call', authentication: 'unknown', inference: 'unverified', nativeProfile: 'unverified' };
  };
  guard();
  return {
    snapshot: () => view(guard()),
    async call(action, args) {
      const extra = { status: [], enabled: ['revision', 'enabled'], visible: ['revision', 'visible'], refresh: ['revision'] }[action];
      if (!extra || !exact(args, ['bindingId', 'profileId', 'bridgeId', ...extra])) fail('invalid_request');
      if (args.bindingId !== m.bindingId || args.profileId !== m.profileId || args.bridgeId !== m.bridgeId) fail('wrong_scope');
      const before = guard();
      if (action === 'status') return view(before);
      if (!Number.isSafeInteger(args.revision) || args.revision < 0) fail('invalid_request');
      if (args.revision !== before.revision) fail('stale_revision');
      const options = { expectedRevision: args.revision, wait: false };
      if (action === 'enabled') return view(store.setEnabled(state, args.enabled, options));
      if (action === 'visible') return view(store.setVisible(state, args.visible, options));
      // Discovery is finite and injectable only by the fixture owner, never by
      // tools/call. A failed/invalid discovery is not persisted as success.
      let timer;
      try {
        const result = await Promise.race([Promise.resolve().then(discover), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('catalog_timeout'), { code: 'catalog_timeout' })), 2000); })]);
        const models = store.normalizeModels(result); guard();
        return view(store.updateConnections(state, c => {
          c.catalog = { observedAt: Date.now(), revision: (c.catalog?.revision ?? 0) + 1, status: 'fresh', error: null, models };
          c.evidence.catalog = 'observed';
        }, options));
      } finally { clearTimeout(timer); }
    },
  };
}
