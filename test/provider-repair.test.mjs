import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ProviderRegistry, ResponsesRouter, localModelId } from '../plugins/codex-claude/home/providers.mjs';
import { fixture } from './support/fixture.mjs';
const root = () => mkdtempSync(join(tmpdir(), 'bridge-repair-'));
const url = 'https://provider.example.invalid/v1';
const hash = b => createHash('sha256').update(b).digest('hex');
function inventory(dir, prefix = '') {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name), rel = prefix + name, s = lstatSync(path);
    return s.isDirectory() ? [[rel, 'directory'], ...inventory(path, rel + '/')] : [[rel, hash(readFileSync(path))]];
  });
}
function catalog(models = ['haiku', 'second']) {
  let calls = 0;
  return { get calls() { return calls; }, request: (_url, _options, receive) => {
    calls++; const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 200; res.destroy = () => {};
      receive(res); res.emit('data', Buffer.from(JSON.stringify({ data: models.map(id => ({ id })) }))); res.emit('end');
    }); return req;
  } };
}
async function configured(r = root(), credentials = null) {
  const registry = new ProviderRegistry(r, credentials), id = registry.create({ name: 'Fixture', baseUrl: url, authRef: credentials ? 'test-ref' : null });
  await registry.refresh(id, catalog()); registry.select(id, localModelId(id, 'haiku'));
  return { r, registry, id, model: localModelId(id, 'haiku') };
}
function credentials() {
  const r = root(), key = join(r, 'synthetic-token'), refs = join(r, 'references.json');
  writeFileSync(key, 'SYNTHETIC-NOT-A-REAL-KEY\n', { mode: 0o600 });
  writeFileSync(refs, JSON.stringify({ version: 1, references: [{ id: 'test-ref', baseUrl: url, credentialFile: key }] }), { mode: 0o600 });
  return { key, refs };
}

test('IDNA-expanded URL and invalid full record are rejected without publishing a directory or poisoning existing providers', async () => {
  const { r, registry, id } = await configured(), before = inventory(r);
  const expanded = 'https://é.example/' + 'a'.repeat(2027);
  assert.equal(expanded.length, 2045); assert.equal(new URL(expanded).href.length, 2051);
  assert.throws(() => registry.create({ name: 'Invalid canonical URL', baseUrl: expanded }), { code: 'endpoint_invalid' });
  assert.deepEqual(inventory(r), before, 'a rejected record publishes no empty provider directory');
  assert.equal(registry.all()[0].connectionId, id);
  assert.throws(() => registry.create({ name: 'bad\u0000name', baseUrl: url })); assert.deepEqual(inventory(r), before);
  assert.ok(registry.create({ name: 'Still usable', baseUrl: 'https://second.example.invalid/v1' }));
});

test('failed private credential refresh makes the expected catalog stale, retaining selection/models and allowing explicit recovery only', async () => {
  const c = credentials(), { r, registry, id, model } = await configured(root(), c.refs), before = registry.read(id), transport = catalog();
  writeFileSync(c.key, 'invalid\ntoken');
  await assert.rejects(registry.refresh(id, transport));
  const failed = registry.read(id); assert.equal(transport.calls, 0); assert.equal(failed.catalog.status, 'stale');
  assert.equal(failed.revision, before.revision + 1); assert.deepEqual(failed.catalog.models, before.catalog.models); assert.equal(failed.selected, model);
  assert.throws(() => registry.select(id, model), { code: 'model_not_available' });
  assert.deepEqual(new ResponsesRouter({ root: r, native: {} }).mergeModels([]).models, []);
  writeFileSync(c.key, 'SYNTHETIC-RECOVERED-NOT-A-REAL-KEY\n');
  await registry.refresh(id, transport); assert.equal(transport.calls, 1); assert.equal(registry.read(id).catalog.status, 'fresh');
  assert.equal(registry.read(id).selected, model); registry.select(id, model);
});

test('credential-resolution failure never overwrites a concurrent newer revision while marking stale', async () => {
  const c = credentials(), { registry, id } = await configured(root(), c.refs), other = localModelId(id, 'second');
  registry.broker.token = async () => { registry.select(id, other); throw new Error('synthetic credential failure'); };
  await assert.rejects(registry.refresh(id, catalog()), { code: 'stale_revision' });
  assert.equal(registry.read(id).selected, other); assert.equal(registry.read(id).catalog.status, 'fresh', 'newer committed revision is not overwritten');
});

function historyNative(connection) {
  const calls = [], owned = { id: 'owned-thread', path: '/synthetic/owned.jsonl', forkedFromId: null }, foreign = { id: 'foreign-thread', path: '/synthetic/foreign.jsonl', forkedFromId: null };
  let resumeId = null, resumePath = null, forkAncestor = 'owned-thread', forkId = 'fork-thread';
  const response = (thread, params) => ({ thread: structuredClone(thread), model: params.model, modelProvider: params.modelProvider });
  const native = { request: async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'model/list') return { data: [], nextCursor: null };
    if (method === 'thread/start') return response(owned, params);
    // This fixture REALLY selects alternate history/path when forwarded.
    if (method === 'thread/resume') return response(params.history != null || params.path && params.path !== owned.path ? foreign : { ...owned, id: resumeId ?? owned.id, path: resumePath ?? owned.path }, params);
    if (method === 'thread/fork') return response({ id: forkId, path: '/synthetic/fork.jsonl', forkedFromId: params.path && params.path !== owned.path ? foreign.id : forkAncestor }, params);
    throw new Error('unexpected native method ' + method);
  } };
  const router = new ResponsesRouter({ root: connection.r, native });
  return { router, native, calls, owned, foreign, setResumeId: id => { resumeId = id; }, setResumePath: path => { resumePath = path; }, setFork: (id, ancestor) => { forkId = id; forkAncestor = ancestor; } };
}
test('resume refuses alternate path/history BEFORE native override, strips matching hints and verifies returned thread identity', async () => {
  const c = await configured(), f = historyNative(c); await f.router.request('thread/start', { model: c.model }, () => {});
  const route = readFileSync(join(c.r, 'local-routes/owned-thread.json')), count = f.calls.length;
  for (const extra of [{ path: f.foreign.path }, { history: [] }])
    await assert.rejects(f.router.request('thread/resume', { threadId: f.owned.id, ...extra }, () => {}));
  assert.equal(f.calls.length, count, 'neither alternate source reached the path-sensitive native fixture');
  const result = await f.router.request('thread/resume', { threadId: f.owned.id, path: f.owned.path }, () => {});
  assert.equal(result.thread.id, f.owned.id); const sent = f.calls.at(-1).params;
  assert.ok(!('path' in sent) && !('history' in sent));
  f.setResumeId(f.foreign.id);
  await assert.rejects(f.router.request('thread/resume', { threadId: f.owned.id }, () => {}), { code: 'native_thread_identity_invalid' });
  f.setResumeId(f.owned.id); f.setResumePath(f.foreign.path);
  await assert.rejects(f.router.request('thread/resume', { threadId: f.owned.id }, () => {}), { code: 'native_thread_identity_invalid' });
  assert.deepEqual(readFileSync(join(c.r, 'local-routes/owned-thread.json')), route);
});

test('fork rejects alternate sources and wrong ancestry/identity before accepting a new route sidecar', async () => {
  const c = await configured(), f = historyNative(c); await f.router.request('thread/start', { model: c.model }, () => {});
  const before = inventory(join(c.r, 'local-routes')), count = f.calls.length;
  await assert.rejects(f.router.request('thread/fork', { threadId: f.owned.id, path: f.foreign.path }, () => {}));
  await assert.rejects(f.router.request('thread/fork', { threadId: f.owned.id, history: [] }, () => {}));
  assert.equal(f.calls.length, count);
  f.setFork('foreign-fork', f.foreign.id);
  await assert.rejects(f.router.request('thread/fork', { threadId: f.owned.id }, () => {}), { code: 'native_thread_identity_invalid' });
  f.setFork(f.owned.id, f.owned.id);
  await assert.rejects(f.router.request('thread/fork', { threadId: f.owned.id }, () => {}), { code: 'native_thread_identity_invalid' });
  assert.deepEqual(inventory(join(c.r, 'local-routes')), before);
  f.setFork('valid-fork', f.owned.id);
  const fork = await f.router.request('thread/fork', { threadId: f.owned.id, path: f.owned.path }, () => {});
  assert.equal(fork.thread.forkedFromId, f.owned.id); assert.equal(fork.model, c.model);
  const saved = JSON.parse(readFileSync(join(c.r, 'local-routes/valid-fork.json')));
  assert.equal(saved.threadId, 'valid-fork'); assert.equal(saved.forkedFromId, f.owned.id); assert.equal(saved.path, '/synthetic/fork.jsonl');
  assert.ok(!('path' in f.calls.at(-1).params));
});

test('native collision ownership survives router restart, disabled custom state and intervening lists; first use also consults native ownership', async () => {
  const c = await configured(), row = { id: c.model, model: c.model, isDefault: true }, called = [];
  const native = { request: async (method, params) => { called.push(method); assert.equal(method, 'model/list'); assert.equal(params.includeHidden, true); return { data: [row], nextCursor: null }; } };
  const first = new ResponsesRouter({ root: c.r, native }), initial = first.mergeModels([row]).models;
  assert.deepEqual(initial[0], row); assert.equal(initial.filter(m => m.id === c.model).length, 1);
  c.registry.enabled(c.id, false);
  const restarted = new ResponsesRouter({ root: c.r, native: { request: async () => ({ data: [], nextCursor: null }) } });
  assert.equal(await restarted.request('thread/start', { model: c.model }, async () => 'retained native choice'), 'retained native choice');
  c.registry.enabled(c.id, true); assert.ok(!restarted.mergeModels([]).models.some(m => m.id === c.model), 'an intervening list never transfers an observed native alias to custom');
  assert.equal(await restarted.request('thread/start', { model: c.model }, async () => 'native again'), 'native again');
  const nativeSettings = { threadId: 'native-owned-alias', threadSettings: { model: c.model, modelProvider: 'bridge_custom_' + c.id } };
  assert.deepEqual(restarted.notification('thread/settings/updated', nativeSettings), nativeSettings, 'an observed native alias keeps native settings ownership too');
  const other = await configured(), direct = new ResponsesRouter({ root: other.r, native: { request: async method => {
    assert.equal(method, 'model/list'); called.push(method); return { data: [{ id: other.model, model: other.model }], nextCursor: null };
  } } });
  other.registry.enabled(other.id, false);
  assert.equal(await direct.request('thread/start', { model: other.model }, async () => 'native without a prior UI list'), 'native without a prior UI list');
  assert.equal(called.length, 1);
});

test('custom settings notifications and collaboration metadata keep namespaced picker identity across restart, preserving native/GPT metadata', async () => {
  const c = await configured(), f = fixture('openai', { connectionRoot: c.r }), tid = await f.start(c.model);
  await f.bridge.request('thread/settings/update', { threadId: tid, model: c.model,
    collaborationMode: { mode: 'default', settings: { model: c.model, reasoning_effort: null } } });
  const update = f.events.filter(e => e.method === 'thread/settings/updated').at(-1).params.threadSettings;
  assert.equal(update.model, c.model); assert.equal(update.collaborationMode.settings.model, c.model);
  assert.notEqual(update.model, 'haiku', 'endpoint slug must never select the unrelated Claude row');
  assert.equal(f.calls.filter(e => e.method === 'thread/settings/update').at(-1).params.model, 'haiku');
  f.restart();
  const raw = { threadId: tid, threadSettings: { model: 'haiku', modelProvider: 'bridge_custom_' + c.id,
    collaborationMode: { mode: 'default', settings: { model: 'haiku' } }, sandboxPolicy: { type: 'readOnly' } } };
  await f.bridge.nativeNotification('thread/settings/updated', raw);
  const emitted = f.events.at(-1).params; assert.equal(emitted.threadSettings.model, c.model); assert.equal(emitted.threadSettings.collaborationMode.settings.model, c.model);
  assert.deepEqual(emitted.threadSettings.sandboxPolicy, raw.threadSettings.sandboxPolicy); assert.equal(raw.threadSettings.model, 'haiku', 'input is not mutated');
  const gpt = { threadId: 'unmanaged-gpt', threadSettings: { model: 'gpt-test', collaborationMode: { settings: { model: 'gpt-test' } } } };
  await f.bridge.nativeNotification('thread/settings/updated', gpt); assert.deepEqual(f.events.at(-1).params, gpt);
  const count = f.events.length;
  await f.bridge.nativeNotification('thread/settings/updated', { threadId: tid, threadSettings: { model: 'unconfirmed-model' } });
  assert.equal(f.events.length, count, 'unexpected custom settings are not emitted as a different picker identity');
  await f.bridge.nativeNotification('thread/settings/updated', { threadId: 'not-yet-bound', threadSettings: { model: 'haiku', modelProvider: 'bridge_custom_' + c.id } });
  assert.equal(f.events.length, count, 'early unbound custom settings never expose the raw Claude-like slug');
});

test('old v1 routes remain readable by exact ID but cannot introduce an unbound path or alternate history', async () => {
  const c = await configured(), f = historyNative(c); await f.router.request('thread/start', { model: c.model }, () => {});
  const path = join(c.r, 'local-routes/owned-thread.json'), v = JSON.parse(readFileSync(path));
  const legacy = { version: 1, connectionId: v.connectionId, endpointHash: v.endpointHash, model: v.model };
  writeFileSync(path, JSON.stringify(legacy)); const bytes = readFileSync(path);
  await assert.rejects(f.router.request('thread/resume', { threadId: f.owned.id, path: f.owned.path }, () => {}));
  assert.equal((await f.router.request('thread/resume', { threadId: f.owned.id }, () => {})).thread.id, f.owned.id);
  assert.deepEqual(readFileSync(path), bytes, 'no implicit sidecar migration or rewrite');
});
