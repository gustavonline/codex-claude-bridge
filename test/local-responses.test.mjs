import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { endpointUrl, catalogModels, discoverLocal, createLocal, readLocal, refreshLocal, selectLocal, localStatus, localModelId, localFile, LocalResponsesRouter } from '../plugins/codex-claude/home/providers.mjs';
import { fixture } from './support/fixture.mjs';
import { main as cli } from '../cli.mjs';

// No endpoint listeners or real SDK/inference calls. The transport seam is the
// real node:http request interface; the native seam is the public app-server RPC.
const root = () => mkdtempSync(join(tmpdir(), 'bridge-local-'));
const url = 'http://127.0.0.1:11434/v1';
function transport({ status = 200, data = { data: [{ id: 'qwen3.5:4b' }, { id: 'qwen3.8:27b' }] }, chunks, stall = false, onRequest = () => {} } = {}) {
  const calls = [];
  const request = (target, options, receive) => {
    const req = new EventEmitter(); req.destroy = () => { req.destroyed = true; };
    req.end = () => queueMicrotask(() => {
      onRequest(); if (stall) return;
      const res = new EventEmitter(); res.statusCode = status; res.headers = { location: 'http://outside.invalid/leak' }; res.destroy = () => { res.destroyed = true; };
      receive(res);
      if (!res.destroyed) { for (const b of chunks ?? [Buffer.from(JSON.stringify(data))]) res.emit('data', b); res.emit('end'); }
    });
    calls.push({ target, options, req }); return req;
  };
  return { request, calls };
}
async function prepared() {
  const r = root(); createLocal(r, url); const state = await refreshLocal(r, transport());
  selectLocal(r, state.catalog.models[0].id); return r;
}

test('endpoint validation permits HTTPS/custom paths or explicit HTTP loopback, but no plaintext DNS, credential, query, fragment or alternate address spelling', () => {
  assert.equal(endpointUrl(url + '/'), url);
  assert.equal(endpointUrl('https://models.example.invalid/api/v1/'), 'https://models.example.invalid/api/v1');
  assert.equal(endpointUrl(url + '/responses'), url + '/responses', 'custom base paths remain explicit; compatibility is not inferred');
  assert.equal(endpointUrl('http://[::1]:8090/v1'), 'http://[::1]:8090/v1');
  assert.equal(endpointUrl('http://127.0.0.1:80/v1/'), 'http://127.0.0.1:80/v1');
  for (const bad of ['http://localhost:8090/v1', 'http://127.1:8090/v1', 'http://2130706433:8090/v1',
    'http://user:secret@127.0.0.1:8090/v1', url + '?key=x', url + '#fragment', 'http://127.0.0.1:99999/v1', 'http://0.0.0.0:8090/v1', 'http://10.0.0.1:8090/v1', '\n' + url])
    assert.throws(() => endpointUrl(bad), { code: 'endpoint_invalid' });
});

test('catalog GET carries no auth/proxy/env headers, follows no redirect and consumes a bounded body with a finite deadline', async () => {
  const t = transport(); assert.deepEqual(await discoverLocal(url, t), ['qwen3.5:4b', 'qwen3.8:27b']);
  assert.equal(t.calls.length, 1); assert.equal(t.calls[0].target, url + '/models');
  assert.deepEqual(t.calls[0].options, { method: 'GET', agent: false, headers: { Accept: 'application/json' } });
  for (const status of [301, 302, 303, 307, 308, 401, 500]) {
    const denied = transport({ status }); await assert.rejects(discoverLocal(url, denied), { code: 'catalog_failed' });
    assert.equal(denied.calls.length, 1, 'no follow-up request to Location'); assert.ok(denied.calls[0].req.destroyed);
  }
  await assert.rejects(discoverLocal(url, transport({ chunks: [Buffer.alloc(512 * 1024 + 1)] })), { code: 'catalog_failed' });
  await assert.rejects(discoverLocal(url, { ...transport({ stall: true }), timeoutMs: 10 }), { code: 'catalog_failed' });
  for (const invalid of [{ models: [{ slug: 'qwen' }] }, { data: [{ id: 'a' }, { id: 'a' }] }, { data: [{ id: 'white space' }] }, { data: [] , extra: 'accepted list envelope' }]) {
    if (invalid.data?.length === 0) assert.deepEqual(catalogModels(invalid), []);
    else assert.throws(() => catalogModels(invalid), { code: 'catalog_invalid' });
  }
});

test('connection create/selection persist; catalog IDs are namespaced observations, never invented native ModelsResponse/capability metadata', async () => {
  const r = await prepared(), s = readLocal(r), status = localStatus(s);
  assert.throws(() => createLocal(r, url), { code: 'EEXIST' });
  assert.equal(status.selected, localModelId(s.connectionId, 'qwen3.5:4b'));
  assert.equal(status.catalog.format, 'openai-model-ids');
  assert.deepEqual(status.capabilities, { responses: 'unverified', tools: 'unverified', inference: 'unverified', nativePicker: 'unverified' });
  assert.deepEqual(Object.keys(status.catalog.models[0]), ['id', 'endpointModel']);
  assert.notEqual(localModelId('f'.repeat(32), 'qwen3.5:4b'), status.selected, 'separate connections do not collide');
  assert.deepEqual(readdirSync(r), [localFile]);
  assert.doesNotMatch(readFileSync(join(r, localFile), 'utf8'), /api_key|Bearer|auth\.json|model_provider|codex\.toml/);
});

test('failed refresh retains last catalog as stale, denies new selection, recovers explicitly and never overwrites a concurrent selection', async () => {
  const r = await prepared(), before = readLocal(r);
  await assert.rejects(refreshLocal(r, transport({ status: 503 })), { code: 'catalog_failed' });
  const stale = readLocal(r); assert.equal(stale.catalog.status, 'stale'); assert.deepEqual(stale.catalog.models, before.catalog.models);
  assert.equal(stale.selected, before.selected); assert.throws(() => selectLocal(r, stale.selected), { code: 'model_not_available' });
  await refreshLocal(r, transport());
  const changed = localModelId(readLocal(r).connectionId, 'qwen3.8:27b');
  await assert.rejects(refreshLocal(r, transport({ onRequest: () => selectLocal(r, changed) })), { code: 'stale_revision' });
  assert.equal(readLocal(r).selected, changed);
  await refreshLocal(r, transport({ data: { data: [{ id: 'replacement' }] } })); assert.equal(readLocal(r).selected, null);
});

test('malformed, linked and unknown stores fail without repair; refused targets contain only synthetic task data', async () => {
  const r = await prepared(), path = join(r, localFile), saved = join(r, 'retained.json');
  renameSync(path, saved); symlinkSync(saved, path); const bytes = readFileSync(saved);
  assert.throws(() => readLocal(r), { code: 'unsafe_file' }); assert.deepEqual(readFileSync(saved), bytes);
  const other = root(); writeFileSync(join(other, localFile), '{broken', { mode: 0o600 });
  assert.throws(() => readLocal(other), { code: 'invalid_store' }); assert.equal(readFileSync(join(other, localFile), 'utf8'), '{broken');
});

test('Bridge opts in only a new selected local thread; GPT/default/Claude catalog, native permissions and config remain intact', async () => {
  const r = await prepared(), s = readLocal(r), f = fixture('openai', { connectionRoot: r });
  const before = (await f.bridge.request('model/list', {})).data;
  assert.deepEqual(before.slice(0, 4).map(x => x.id), ['gpt-test', 'gpt-other', 'haiku', 'sonnet'], 'native GPT/Claude catalog remains first and unchanged');
  assert.deepEqual(before.slice(4).map(x => x.id), s.catalog.models.map(model => localModelId(s.connectionId, model)), 'discovered IDs are offered as conservative Bridge presets');
  assert.ok(before.slice(4).every(x => x.isDefault === false && /unverified/.test(x.description)));
  const native = await f.start('gpt-test'), claude = await f.start('haiku');
  const cid = await f.start('bridge-responses/selected', { sandbox: 'read-only', approvalPolicy: 'untrusted', config: { arbitrary_existing_setting: true } });
  const call = f.calls.filter(x => x.method === 'thread/start').at(-1).params, pid = 'bridge_custom_' + s.connectionId;
  assert.equal(call.model, 'qwen3.5:4b'); assert.equal(call.modelProvider, pid);
  assert.equal(call.sandbox, 'read-only'); assert.equal(call.approvalPolicy, 'untrusted');
  assert.equal(call.config.arbitrary_existing_setting, true);
  assert.equal(call.config['model_providers.' + pid].base_url, url); assert.equal(call.config['model_providers.' + pid].requires_openai_auth, false);
  assert.equal(call.config['model_providers.' + pid].supports_websockets, false);
  assert.ok(!('env_key' in call.config['model_providers.' + pid]));
  assert.equal(f.bridge.records.has(cid), false, 'native owns local history, no Claude transcript replacement');
  assert.deepEqual((await f.bridge.request('model/list', {})).data, before);
  assert.equal(f.hosts.get(native).provider, 'openai'); assert.equal(f.bridge.records.get(claude).provider, 'claude');
  assert.equal((await f.bridge.native.request('config/read', {})).config.model, 'gpt-test');
  const attempted = f.calls.length;
  for (const params of [{ threadId: native, model: s.selected }, { threadId: claude, model: s.selected }, { threadId: cid, model: 'haiku' },
    { threadId: cid, config: { 'model_providers.' : {} } }, { threadId: cid, modelProvider: 'openai' }])
    await assert.rejects(f.bridge.request('turn/start', { input: [{ type: 'text', text: 'refused' }], ...params }));
  assert.equal(f.calls.length, attempted, 'refused changes never reach native');
  const turn = await f.send(cid, 'local synthetic'); await f.done(turn.turn.id);
  assert.equal(f.queries.length, 0, 'local turns never enter the Claude SDK');
  f.restart(); const reopened = await f.bridge.request('thread/resume', { threadId: cid });
  assert.equal(reopened.model, s.selected); assert.equal(reopened.modelProvider, pid);
  const next = await f.send(cid, 'follow up'); await f.done(next.turn.id);
  assert.equal(f.hosts.get(cid).thread.turns.length, 2);
});

test('local route delegates streaming/tool/approval/queue/interrupt data without changing native messages or substituting a harness', async () => {
  const r = await prepared(), calls = [], events = [], toolCalls = [], threads = new Map(); let sequence = 0;
  let bridge;
  const native = { request: async (method, p) => {
    calls.push({ method, p: structuredClone(p) });
    if (method === 'model/list') return { data: [], nextCursor: null };
    if (method === 'thread/start') {
      const thread = { id: 'local-thread-1', model: p.model, modelProvider: p.modelProvider };
      threads.set(thread.id, { thread, turns: [] }); return { thread, model: p.model, modelProvider: p.modelProvider };
    }
    if (method === 'turn/start') {
      const stored = threads.get(p.threadId), turn = { id: 'native-turn-' + ++sequence, status: 'completed' };
      const delta = { threadId: p.threadId, turnId: turn.id, itemId: 'native-item', delta: 'synthetic native stream' };
      await bridge.nativeNotification('item/agentMessage/delta', delta);
      const request = { threadId: p.threadId, turnId: turn.id, namespace: 'fixture', tool: 'bridge_fixture', arguments: { value: 4827 } };
      assert.deepEqual(await bridge.toolRequest('item/tool/call', request), { success: true, contentItems: [{ type: 'inputText', text: 'fixture result' }] });
      assert.deepEqual(await bridge.toolRequest('item/commandExecution/requestApproval', { threadId: p.threadId, command: 'SYNTHETIC-NOT-EXECUTED' }), { decision: 'decline' });
      stored.turns.push({ input: p.input, delta }); return { turn };
    }
    if (method === 'thread/read') return structuredClone(threads.get(p.threadId));
    return { fixtureNative: method, retained: structuredClone(p) };
  } };
  const { Bridge } = await import('../bridge.mjs');
  bridge = new Bridge({ native, statePath: join(r, 'threads'), connectionRoot: r,
    desktop: { notify: (method, params) => events.push({ method, params }), request: async (method, params) => { toolCalls.push({ method, params }); return method === 'item/tool/call' ? { success: true, contentItems: [{ type: 'inputText', text: 'fixture result' }] } : { decision: 'decline' }; }, },
    getModels: async () => { throw new Error('Claude discovery must not run'); }, runQuery: () => { throw new Error('Claude inference must not run'); } });
  const started = await bridge.request('thread/start', { model: 'bridge-responses/selected', sandbox: 'read-only', approvalPolicy: 'untrusted' });
  for (const text of ['first', 'exact tool-result follow up']) await bridge.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text }] });
  assert.equal(events.filter(x => x.method === 'item/agentMessage/delta').length, 2); assert.equal(toolCalls.length, 4);
  assert.deepEqual((await bridge.request('thread/read', { threadId: started.thread.id })).turns.map(t => t.input[0].text), ['first', 'exact tool-result follow up']);
  for (const method of ['thread/queue/list', 'thread/queue/delete', 'turn/interrupt']) {
    const p = { threadId: started.thread.id, turnId: 'native-turn-2', queuedSubmissionId: 'existing-Q' };
    assert.deepEqual(await bridge.request(method, p), { fixtureNative: method, retained: p });
  }
  assert.equal(calls.filter(x => x.method === 'turn/start').length, 2);
});

test('CLI requires an explicit private task state, never infers settings or copies a profile', async () => {
  await assert.rejects(cli(['local', 'status']), /explicit private/);
  const r = root(), oldLog = console.log, lines = []; console.log = text => lines.push(text);
  try { await cli(['local', 'configure', '--state', r, '--url', url]); await cli(['local', 'status', '--state', r]); }
  finally { console.log = oldLog; }
  assert.equal(JSON.parse(lines[0]).configured, true); assert.deepEqual(readdirSync(r), [localFile]);
});

test('stale catalog blocks only new local admission; existing native local history/forks and GPT survive selection changes and local outages', async () => {
  const r = await prepared(), f = fixture('openai', { connectionRoot: r }), original = readLocal(r).selected;
  const local = await f.start('bridge-responses/selected');
  const t = await f.send(local, 'retained'); await f.done(t.turn.id);
  const kept = structuredClone(f.hosts.get(local).thread.turns);
  selectLocal(r, localModelId(readLocal(r).connectionId, 'qwen3.8:27b'));
  assert.equal((await f.bridge.request('thread/resume', { threadId: local })).model, original, 'changing the next selection never retargets an existing chat');
  const fork = await f.bridge.request('thread/fork', { threadId: local });
  assert.equal(fork.model, original); assert.deepEqual(f.hosts.get(fork.thread.id).thread.turns, kept);
  await assert.rejects(refreshLocal(r, transport({ status: 500 })));
  const n = f.calls.length; await assert.rejects(f.start('bridge-responses/selected'), { code: 'catalog_not_fresh' });
  assert.deepEqual(f.calls.slice(n).map(c => c.method), ['model/list'], 'only the ownership lookup ran; no native thread was created from stale discovery');
  assert.deepEqual(f.calls.at(-1).params, { includeHidden: true, limit: 100 });
  assert.equal((await f.bridge.request('thread/resume', { threadId: local })).model, original);
  assert.deepEqual(f.hosts.get(local).thread.turns, kept);
  writeFileSync(join(r, localFile), 'broken');
  assert.ok(await f.start('gpt-test'), 'corrupt local config leaves new native GPT admission alone');
  assert.ok(await f.start('haiku'), 'Claude admission still uses its separate accepted store');
  await assert.rejects(f.send(local, 'must not silently use GPT'), { code: 'invalid_store' });
  assert.deepEqual(f.hosts.get(local).thread.turns, kept);
});
