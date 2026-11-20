import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { ProviderRegistry, ResponsesRouter, localModelId, useDurability } from '../plugins/codex-claude/home/providers.mjs';
// Only the child-disabled (permission) runner forbids fsync; there, and only there, this module substitutes a no-op for its own
// writes and restores the real one afterwards. An ordinary run keeps strict fsync.
test.after(useDurability(process.permission ? () => {} : undefined));

// The native input guard compares process launch selection with saved thread
// affinity. It intentionally ignores a turn's invented modelProvider field.
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-affinity-')), registry = new ProviderRegistry(root);
  const id = registry.create({ name: 'Synthetic custom', baseUrl: 'https://fixture.example.invalid/v1' });
  await registry.refresh(id, { request: (_u, _o, done) => {
    const req = new EventEmitter(); req.destroy = () => {}; req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = 200; res.destroy = () => {}; done(res);
      res.emit('data', Buffer.from('{"data":[{"id":"fixture-model"}]}')); res.emit('end');
    }); return req;
  } });
  const model = localModelId(id, 'fixture-model'), provider = 'bridge_custom_' + id, saved = new Map(), calls = [], factories = [];
  let next = 0;
  function peer(selected) {
    const loaded = new Set();
    return { request: async (method, p) => {
      calls.push({ selected, method, p: structuredClone(p) });
      if (method === 'model/list') return { data: [{ id: 'gpt-fixture', model: 'gpt-fixture' }], nextCursor: null };
      if (method === 'thread/start') {
        const t = { id: 'synthetic-' + (++next), path: '/synthetic/' + next + '.jsonl', forkedFromId: null };
        saved.set(t.id, { thread: t, model: p.model, modelProvider: p.modelProvider ?? selected }); loaded.add(t.id);
        return structuredClone(saved.get(t.id));
      }
      const record = saved.get(p.threadId); assert.ok(record, 'same saved thread must exist');
      if (['thread/resume', 'thread/fork', 'turn/start', 'turn/steer', 'thread/settings/update'].includes(method) && record.modelProvider !== selected)
        throw Object.assign(new Error('This chat uses ' + record.modelProvider + ', but your current provider is ' + selected + '. Switch to ' + record.modelProvider + ' to continue.'), { code: -32600, data: { type: 'modelProviderMismatch', modelProvider: record.modelProvider, currentModelProvider: selected } });
      if (method === 'thread/resume') { loaded.add(p.threadId); return structuredClone(record); }
      if (method === 'thread/fork') {
        const fork = structuredClone(record); fork.thread = { id: 'synthetic-' + (++next), path: '/synthetic/' + next + '.jsonl', forkedFromId: p.threadId };
        saved.set(fork.thread.id, fork); loaded.add(fork.thread.id); return fork;
      }
      if (method === 'turn/start') {
        assert.ok(loaded.has(p.threadId), 'a restarted provider process must resume before accepting input');
        assert.ok(!Object.hasOwn(p, 'modelProvider'), 'turn/start schema has no provider override');
        return { turn: { id: 'turn-' + calls.length, status: 'inProgress' } };
      }
      if (method === 'thread/read') return { thread: structuredClone(record.thread) };
      if (method === 'thread/queue/add') { assert.ok(loaded.has(p.threadId), 'a restarted provider process must resume before it owns a queue entry'); return { queuedSubmissionId: 'queued-' + calls.length }; }
      return {};
    } };
  }
  const native = peer('openai');
  let child = null;
  const nativeFor = async (s, definition) => { factories.push({ id: s.connectionId, definition }); child ??= peer(provider); return child; };
  const router = () => new ResponsesRouter({ root, native, nativeFor });
  return { root, registry, id, model, provider, calls, factories, saved, native, router, restart: () => { child = null; } };
}

test('desktop omitted provider: first turn and explicit Retry use the launch-selected native child, never the GPT parent', async () => {
  const f = await setup(), router = f.router();
  const answer = await router.request('thread/start', { model: f.model }, () => { throw Error('unexpected parent route'); });
  const id = answer.thread.id;
  for (const params of [{ threadId: id, input: [{ type: 'text', text: 'synthetic first' }] },
    { threadId: id, model: f.model, parentTurnId: 'failed-turn', input: [{ type: 'text', text: 'synthetic explicit Retry' }] }])
    assert.equal((await router.request('turn/start', params, () => {})).turn.status, 'inProgress');
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 2, 'exactly one input dispatch per caller action');
  assert.ok(f.calls.filter(c => c.method === 'turn/start').every(c => c.selected === f.provider));
  assert.ok(f.factories.length > 0); assert.equal(f.factories[0].definition.wire_api, 'responses');
  assert.equal(f.factories[0].definition.requires_openai_auth, false);
});

test('restart/resume/fork without provider keeps exact saved identity and history; alternate/cross-provider overrides remain refused', async () => {
  const f = await setup(); let router = f.router(); const start = await router.request('thread/start', { model: f.model }, () => {}), id = start.thread.id;
  const route = readFileSync(join(f.root, 'local-routes', id + '.json'));
  f.restart(); router = f.router();
  await router.request('turn/start', { threadId: id, input: [] }, () => {});
  const childCalls = f.calls.filter(c => c.selected === f.provider);
  assert.equal(childCalls.at(-2).method, 'thread/resume'); assert.equal(childCalls.at(-2).p.threadId, id);
  assert.equal((await router.request('thread/resume', { threadId: id }, () => {})).thread.id, id);
  const fork = await router.request('thread/fork', { threadId: id }, () => {});
  assert.equal(fork.thread.forkedFromId, id);
  assert.equal((await router.request('thread/read', { threadId: id }, (m, p) => f.native.request(m, p))).thread.id, id);
  assert.deepEqual(readFileSync(join(f.root, 'local-routes', id + '.json')), route);
  const n = f.calls.length;
  for (const extra of [{ modelProvider: 'openai' }, { model: 'gpt-fixture' }, { collaborationMode: { settings: { model: 'gpt-fixture' } } }])
    await assert.rejects(router.request('turn/start', { threadId: id, input: [], ...extra }, () => {}), { code: 'cross_provider_switch_requires_new_thread' });
  await assert.rejects(router.request('thread/resume', { threadId: id, path: '/synthetic/foreign.jsonl' }, () => {}), { code: 'alternate_history_refused' });
  assert.equal(f.calls.length, n, 'invalid input never reaches any native child');
  // Queueing on a custom chat is qualified now: the entry is accepted by the owning provider child exactly once, on the saved
  // thread, and queueing never starts a turn, never reaches the GPT parent and never replays a message.
  const queueCalls = () => f.calls.filter(c => c.method === 'thread/queue/add'), turns = f.calls.filter(c => c.method === 'turn/start').length;
  const queued = await router.request('thread/queue/add', { threadId: id, input: [{ type: 'text', text: 'synthetic queued message' }] }, () => { throw Error('queueing must not use the GPT parent'); });
  assert.match(queued.queuedSubmissionId, /^queued-/); assert.equal(queueCalls().length, 1, 'exactly one queue dispatch per caller action');
  assert.deepEqual([queueCalls()[0].selected, queueCalls()[0].p.threadId, queueCalls()[0].p.input[0].text], [f.provider, id, 'synthetic queued message']);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, turns, 'queueing starts no turn'); assert.ok(!f.calls.some(c => c.selected === 'openai' && c.p.threadId === id && /queue/.test(c.method)), 'the GPT parent never sees the entry');
  f.restart(); const again = f.router(); await again.request('thread/queue/add', { threadId: id, input: [] }, () => {});
  const afterRestart = f.calls.filter(c => c.selected === f.provider); assert.equal(afterRestart.at(-2).method, 'thread/resume', 'a restarted child resumes the saved thread first'); assert.equal(afterRestart.at(-1).method, 'thread/queue/add');
  f.registry.enabled(f.id, false); await assert.rejects(again.request('thread/queue/add', { threadId: id, input: [] }, () => {}), { code: 'provider_disabled' }); assert.equal(queueCalls().length, 2, 'a disabled connection refuses before any dispatch');
});

test('GPT dispatch stays byte-identical on its native parent; failed custom dispatch is not retried or reclassified as auth/inference', async () => {
  const f = await setup(), router = f.router(), params = { model: 'gpt-fixture', approvalPolicy: 'untrusted' }, calls = [];
  assert.equal(await router.request('thread/start', params, async (method, p) => { calls.push({ method, p }); return 'native GPT'; }), 'native GPT');
  assert.deepEqual(calls, [{ method: 'thread/start', p: params }]); assert.equal(f.factories.length, 0);
  const failure = Object.assign(new Error('native structured mismatch'), { code: -32600, data: { type: 'modelProviderMismatch' } });
  const bad = new ResponsesRouter({ root: f.root, native: f.native, nativeFor: async () => ({ request: async () => { throw failure; } }) });
  await assert.rejects(bad.request('thread/start', { model: f.model }, () => {}), e => e === failure);
});

// Legacy routes intentionally have no threadId/path members. The caller ID is
// authoritative for a v1 resume; the sidecar is never silently migrated.
test('legacy v1 route first input after restart resumes the caller ID and preserves route bytes', async () => {
  const f = await setup(); let router = f.router();
  const start = await router.request('thread/start', { model: f.model }, () => {}), tid = start.thread.id;
  const path = join(f.root, 'local-routes', tid + '.json'), current = JSON.parse(readFileSync(path));
  writeFileSync(path, JSON.stringify({ version: 1, connectionId: current.connectionId, endpointHash: current.endpointHash, model: current.model }));
  const before = readFileSync(path); f.restart(); router = f.router();
  await router.request('turn/start', { threadId: tid, input: [] }, () => {});
  assert.equal(f.calls.at(-2).method, 'thread/resume'); assert.equal(f.calls.at(-2).p.threadId, tid);
  assert.deepEqual(readFileSync(path), before);
});

test('failed execution child or disabled connection never hides retained native history and never retries input on GPT', async () => {
  const f = await setup(), first = f.router();
  const start = await first.request('thread/start', { model: f.model }, () => {}), tid = start.thread.id;
  let acquisitions = 0;
  const failed = new ResponsesRouter({ root: f.root, native: f.native, nativeFor: async () => { acquisitions++; throw Error('retained child failure'); } });
  f.registry.enabled(f.id, false);
  for (const method of ['thread/read', 'thread/turns/list', 'thread/items/list']) {
    const result = await failed.request(method, { threadId: tid }, async (m, p) => ({ thread: { id: p.threadId }, retained: m }));
    assert.equal(result.thread.id, tid); assert.equal(result.retained, method);
  }
  assert.equal(acquisitions, 0, 'history reads require no execution process/credential/endpoint');
  await assert.rejects(failed.request('turn/start', { threadId: tid, input: [] }, () => { throw Error('must not fall back'); }), { code: 'provider_disabled' });
  f.registry.enabled(f.id, true);
  await assert.rejects(failed.request('turn/start', { threadId: tid, input: [] }, () => { throw Error('must not fall back'); }), /retained child failure/);
  assert.equal(acquisitions, 1);
});

test('choosing a custom connection on an existing native chat explains the new-chat boundary without contacting the endpoint', async () => {
  const f = await setup(), n = f.calls.length;
  await assert.rejects(f.router().request('thread/settings/update', { threadId: 'existing-native', model: f.model }, () => { throw Error('must not forward'); }), e => e.code === 'local_requires_new_thread' && /Start a new chat/.test(e.message));
  assert.equal(f.calls.length, n); assert.equal(f.factories.length, 0);
});
