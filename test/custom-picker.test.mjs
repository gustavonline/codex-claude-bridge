import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import { ProviderRegistry, localModelId, ResponsesRouter, useDurability } from '../plugins/codex-claude/home/providers.mjs';
// Only the child-disabled (permission) runner forbids fsync; there, and only there, this module substitutes a no-op for its own
// writes and restores the real one afterwards. An ordinary run keeps strict fsync.
test.after(useDurability(process.permission ? () => {} : undefined));
import { fixture as plainFixture } from './support/fixture.mjs';
// A real native host reports the workspace roots in every start/resume response (the plain fixture host does not); the handoff boundary
// requires them on both sides. Re-applied to the new Bridge after every restart.
function fixture(...args) {
  const f = plainFixture(...args);
  // and it ANNOUNCES a rename after answering it: the name event goes through the real Bridge.nativeNotification -> emit -> desktopView path, on its own turn
  // (the host's saved level: what a public settings write really set is what its later start/resume answers report; an answer that names the field itself, a negative override included, is never touched)
  const written = new Map();
  const apply = () => { const prior = f.bridge.native.request, bridge = f.bridge; bridge.native.request = async (m, p) => { const out = await prior(m, p); if (m === 'thread/settings/update' && p?.effort !== undefined) written.set(p.threadId, p.effort); return out && typeof out === 'object' && out.modelProvider ? { ...out, runtimeWorkspaceRoots: out.runtimeWorkspaceRoots ?? [out.thread?.cwd ?? out.cwd], approvalsReviewer: out.approvalsReviewer ?? 'user', serviceTier: out.serviceTier ?? null, multiAgentMode: out.multiAgentMode ?? 'explicitRequestOnly',
    // (and the always-present required fields of a ThreadStart/ThreadResume response, which the FINAL readback must carry itself: nullable ones as explicit nulls)
    cwd: out.cwd ?? out.thread?.cwd, disabledPluginIds: out.disabledPluginIds ?? [], activePermissionProfile: out.activePermissionProfile ?? null, reasoningEffort: 'reasoningEffort' in out ? out.reasoningEffort : written.has(out.thread?.id) ? written.get(out.thread.id) : null } : out; }; };
  apply(); const restart = f.restart; f.restart = () => { restart(); apply(); }; return f;
}

// Exact operator-provided public 0.162.1 generated ModelListResponse schema.
// It establishes shape, not endpoint capabilities or actual desktop visibility.
const schema = JSON.parse(readFileSync(new URL('./support/model-list-0.162.1.schema.json', import.meta.url)));
const validate = new Ajv({ strict: false }).addFormat('int64', { type: 'number', validate: Number.isSafeInteger }).compile(schema);
const root = () => mkdtempSync(join(tmpdir(), 'bridge-picker-'));
const nativeRow = (model, isDefault = false) => ({ id: model, model, displayName: model, description: 'Native fixture', hidden: false, isDefault,
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Native fixture effort' }], defaultReasoningEffort: 'low' });
function catalog(models, status = 200) {
  return { request: (url, options, receive) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = status; res.destroy = () => { res.closed = true; };
      receive(res); if (!res.closed) { res.emit('data', Buffer.from(JSON.stringify({ data: models.map(id => ({ id })) }))); res.emit('end'); }
    }); return req;
  } };
}
async function connection(registry, name = 'Custom fixture', models = ['endpoint-model']) {
  const id = registry.create({ name, baseUrl: 'https://provider.example.invalid/api/' + name.replaceAll(' ', '-') });
  await registry.refresh(id, catalog(models)); registry.select(id, localModelId(id, models[0])); return id;
}
function nativeCatalog(f, rows) {
  const prior = f.bridge.native.request, calls = [];
  f.bridge.native.request = async (method, params) => {
    if (method !== 'model/list') return prior(method, params);
    calls.push(structuredClone(params));
    return params.cursor === 'native-next' ? { data: rows.slice(1), nextCursor: null } : { data: rows.slice(0, 1), nextCursor: rows.length > 1 ? 'native-next' : null };
  }; return calls;
}
test('native schema: list pages preserve GPT/Claude/default and expose conservative namespaced presets; choose routes a new native tool/turn path', async () => {
  const r = root(), registry = new ProviderRegistry(r), f = fixture('openai', { connectionRoot: r });
  f.bridge.getModels = async () => [{ value: 'haiku', displayName: 'Fixture Haiku', description: 'Claude fixture' },
    { value: 'sonnet', displayName: 'Fixture Sonnet', description: 'Claude fixture', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }];
  const rows = [nativeRow('gpt-test', true), nativeRow('gpt-other')], nativeCalls = nativeCatalog(f, rows);
  const baseline = (await f.bridge.request('model/list', {})).data;
  const a = await connection(registry, 'A', ['same-slug', 'other']), b = await connection(registry, 'B', ['same-slug']);
  const all = []; let cursor = null;
  do {
    const page = await f.bridge.request('model/list', { limit: 2, cursor });
    assert.ok(validate(page), JSON.stringify(validate.errors)); assert.ok(page.data.length <= 2);
    all.push(...page.data); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(all.length, baseline.length + 3); assert.equal(new Set(all.map(m => m.id)).size, all.length);
  assert.deepEqual(all.slice(0, baseline.length), baseline, 'native and Claude rows, including defaults, stay byte-equivalent');
  const custom = all.slice(baseline.length); assert.deepEqual(custom.filter(m => m.isDefault), []);
  assert.notEqual(localModelId(a, 'same-slug'), localModelId(b, 'same-slug'));
  assert.ok(custom.every(m => m.id === m.model && m.defaultReasoningEffort === 'none' && m.supportedReasoningEfforts.length === 0));
  assert.ok(custom.every(m => m.inputModalities.join() === 'text' && m.multiAgentVersion === 'disabled' && /Tool support depends on the model/.test(m.description)));
  assert.ok(custom.every(m => !('contextWindow' in m) && !('maxTokens' in m) && !('supportsTools' in m)));
  assert.ok(nativeCalls.some(p => p.cursor === 'native-next'), 'native opaque paging is consumed before Bridge pagination');
  const chosen = all.find(m => m.id === localModelId(b, 'same-slug'));
  const tid = await f.start(chosen.id, { sandbox: 'read-only', approvalPolicy: 'untrusted' });
  const start = f.calls.filter(c => c.method === 'thread/start').at(-1).params;
  assert.equal(start.model, 'same-slug'); assert.equal(start.modelProvider, 'bridge_custom_' + b);
  assert.equal(start.config['model_providers.' + start.modelProvider].base_url, registry.read(b).baseUrl);
  assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalPolicy, 'untrusted');
  const turn = await f.send(tid, 'synthetic native delegation'); await f.done(turn.turn.id);
  assert.equal(f.queries.length, 0); assert.equal(f.hosts.get(tid).thread.turns.length, 1);
  assert.equal((await f.bridge.native.request('config/read', {})).config.model, 'gpt-test');
  assert.equal(await f.start('gpt-test') != null, true); assert.equal(await f.start('haiku') != null, true);
  // Choosing another provider in the SAME conversation is a real feature now: it never changes the old physical thread
  // (native would refuse that), it starts a NEW one carrying the visible history, links it to the conversation's ID and
  // runs the turn there. Nothing is silent: the link, the new physical ID and what was carried are durable.
  const n = f.calls.length, before = JSON.stringify(f.hosts.get(tid).thread.turns);
  await f.bridge.request('turn/start', { threadId: tid, model: 'gpt-test', input: [{ type: 'text', text: 'next request' }] });
  const added = f.calls.slice(n), started = added.filter(c => c.method === 'thread/start'), link = f.bridge.localResponses.readLink(tid);
  assert.equal(started.length, 1); assert.equal(started[0].params.model, 'gpt-test'); assert.ok(added.some(c => c.method === 'thread/inject_items'), 'the visible history is carried as plain items');
  assert.deepEqual([link.logicalId, link.kind, link.previous], [tid, 'native', [tid]]); assert.notEqual(link.physicalId, tid);
  assert.equal(JSON.stringify(f.hosts.get(tid).thread.turns), before, 'the earlier physical thread keeps its history untouched');
  assert.ok(!added.some(c => c.method === 'thread/fork'), 'never a native fork');
  assert.equal(added.filter(c => c.method === 'turn/start').length, 1); assert.equal(added.find(c => c.method === 'turn/start').params.threadId, link.physicalId, 'the turn runs on the new physical thread only');
});

test('picker: a custom conversation switched to Claude in the SAME chat becomes a linked managed chat that holds the visible history; reads and settings stay under the chat\'s own ID', async () => {
  const r = root(), registry = new ProviderRegistry(r), f = fixture('openai', { connectionRoot: r });
  f.bridge.getModels = async () => [{ value: 'haiku', displayName: 'Fixture Haiku' }];
  nativeCatalog(f, [nativeRow('gpt-test', true), nativeRow('gpt-other')]); await f.bridge.request('model/list', {});
  const b = await connection(registry, 'B', ['same-slug']), chosen = localModelId(b, 'same-slug');
  const tid = await f.start(chosen, { sandbox: 'read-only', approvalPolicy: 'never' }); const turn = await f.send(tid, 'EARLIER-USER-MARK'); await f.done(turn.turn.id);
  const sourceTurns = JSON.stringify(f.hosts.get(tid).thread.turns), notified = f.events.length;
  assert.deepEqual(await f.bridge.request('thread/settings/update', { threadId: tid, model: 'haiku' }), {});
  const link = f.bridge.localResponses.readLink(tid); assert.deepEqual([link.logicalId, link.kind, link.previous], [tid, 'claude', [tid]]); assert.notEqual(link.physicalId, tid);
  const record = f.bridge.records.get(link.physicalId); assert.ok(record, 'a Bridge-managed Claude chat is the new physical thread'); assert.equal(f.bridge.records.has(tid), false, 'the original thread is not adopted or changed');
  assert.equal(record.turns.length, 1); assert.equal(record.turns[0].provider, 'imported'); assert.match(JSON.stringify(record.turns), /EARLIER-USER-MARK/); assert.equal(record.claudeSessionId, undefined, 'its first turn receives the carried history once, as reference');
  assert.equal(JSON.stringify(f.hosts.get(tid).thread.turns), sourceTurns, 'the source physical history is untouched');
  const read = await f.bridge.request('thread/read', { threadId: tid, includeTurns: true }); assert.equal(read.thread.id, tid); assert.equal(read.thread.turns.length, 1); assert.equal(read.thread.modelProvider, 'claude_code');
  const told = f.events.slice(notified).filter(e => e.method === 'thread/settings/updated' && e.params.threadId === tid); assert.ok(told.length >= 1, 'the desktop is told about the settings under its own conversation ID');
  assert.ok(f.events.slice(notified).every(e => e.params?.threadId !== link.physicalId), 'the physical ID never reaches the desktop');
  assert.deepEqual((await f.bridge.request('thread/list', {})).data.map(t => t.id).filter(id => id === link.physicalId), [], 'the physical thread is not a chat of its own');
});

async function switched(model, prepare = null, fail = false) {
  const r = root(), registry = new ProviderRegistry(r), f = fixture('openai', { connectionRoot: r });
  f.bridge.getModels = async () => [{ value: 'haiku', displayName: 'Fixture Haiku' }];
  nativeCatalog(f, [nativeRow('gpt-test', true), nativeRow('gpt-other')]); await f.bridge.request('model/list', {});
  const b = await connection(registry, 'B', ['same-slug']);
  const tid = await f.start(localModelId(b, 'same-slug'), { sandbox: 'read-only', approvalPolicy: 'never' });
  const first = await f.send(tid, 'EARLIER-USER-MARK'); await f.done(first.turn.id);
  prepare?.(f, tid);
  if (fail) { // the switch is attempted and must fail: the caller inspects what was left
    const sourceBytes = JSON.stringify(f.hosts.get(tid).thread.turns), error = await f.bridge.request('thread/settings/update', { threadId: tid, model }).then(() => null, e => e);
    return { f, tid, error, sourceBytes };
  }
  await f.bridge.request('thread/settings/update', { threadId: tid, model });
  return { f, tid, firstTurn: first.turn.id, link: f.bridge.localResponses.readLink(tid) };
}
// A long conversation as the source thread's own native history: 220 settled turns, 440 messages, the early and the late fact once each.
const longHistory = () => Array.from({ length: 220 }, (_, i) => ({ id: 'long-' + (i + 1), status: 'completed', error: null, items: [
  { type: 'userMessage', id: 'lu' + (i + 1), clientId: null, content: [{ type: 'text', text: i === 2 ? 'FIRST-FACT-3' : i === 219 ? 'LAST-FACT-220' : 'question ' + (i + 1) }] }, { type: 'agentMessage', id: 'la' + (i + 1), text: 'answer ' + (i + 1) }] }));
const count = (text, mark) => (text.match(new RegExp(mark, 'g')) ?? []).length;

test('picker (Bridge): a LONG history (220 turns, 440 messages) crosses into a managed Claude chat as ONE whole import (never one per chunk), every turn and both facts once; the first Claude request still receives the carried history once', async () => {
  const { f, tid, link } = await switched('haiku', (host, id) => host.hosts.get(id).thread.turns.push(...longHistory())), sourceTurns = JSON.stringify(f.hosts.get(tid).thread.turns);
  assert.deepEqual([link.logicalId, link.kind], [tid, 'claude']);
  const record = f.bridge.records.get(link.physicalId); assert.ok(record); assert.equal(record.turns.length, 221, 'the first native turn and the 220 long ones, each exactly once');
  assert.deepEqual(record.turns.slice(1).map(t => t.id), longHistory().map(t => t.id)); assert.ok(record.turns.every(t => t.provider === 'imported'));
  const stored = JSON.stringify(record.turns); assert.equal(count(stored, 'FIRST-FACT-3'), 1); assert.equal(count(stored, 'LAST-FACT-220'), 1); assert.equal(record.claudeSessionId, undefined);
  assert.equal(JSON.stringify(f.hosts.get(tid).thread.turns), sourceTurns, 'the source history is untouched');
  let captured = null; f.bridge.run = async (rec, running, params) => { captured = params; };
  await f.bridge.request('turn/start', { threadId: tid, model: 'haiku', input: [{ type: 'text', text: 'CURRENT-REQUEST-MARK' }] }); await new Promise(resolve => setImmediate(resolve));
  const history = captured.additionalContext.bridge_conversation.value;
  assert.equal(count(history, 'FIRST-FACT-3'), 1); assert.equal(count(history, 'LAST-FACT-220'), 1); assert.equal(count(history, 'EARLIER-USER-MARK'), 1); assert.doesNotMatch(history, /CURRENT-REQUEST-MARK/, 'the current request is the prompt, never part of the reference');
  assert.equal(f.bridge.records.get(link.physicalId).turns.length, 222, 'the carried turns, then the one new turn');
});

test('picker (Bridge): a failed import into the new managed Claude chat withdraws only that new chat; the source history, link and route stay exactly as they were, and nothing is imported twice', async () => {
  let imports = 0;
  const { f, tid, error, sourceBytes } = await switched('haiku', (host, id) => {
    host.hosts.get(id).thread.turns.push(...longHistory());
    const target = host.bridge.localResponses.claudeTarget, real = target.import; host.bridge.localResponses.claudeTarget = { ...target, import: async (...args) => { imports++; await real(...args); throw Object.assign(new Error('import failed after the records were written'), { code: -32603 }); } };
  }, true);
  assert.match(error.message, /import failed/); assert.equal(imports, 1, 'one whole import, not retried');
  assert.equal(f.bridge.localResponses.readLink(tid), null, 'no link was published'); assert.equal(f.bridge.records.has(tid), false);
  assert.equal(JSON.stringify(f.hosts.get(tid).thread.turns), sourceBytes, 'the source history is byte-identical');
  const children = [...f.bridge.records.values()].filter(r => r.thread.id !== tid); assert.ok(children.length >= 1 && children.every(r => r.archived === true), 'only the new child exists, and it is archived');
});

test('picker (Bridge): streams, tool results, approvals, interrupt and queue of a switched conversation are mapped once under its own ID; away/back and restart keep it', async () => {
  const { f, tid, firstTurn, link } = await switched('gpt-test'), P = link.physicalId, mark = f.events.length;
  const turn = await f.bridge.request('turn/start', { threadId: tid, model: 'gpt-test', input: [{ type: 'text', text: 'second request' }] }); await f.done(turn.turn.id);
  const heard = f.events.slice(mark); assert.ok(['turn/started', 'item/completed', 'turn/completed'].every(m => heard.some(e => e.method === m)), 'the stream arrived');
  assert.ok(heard.every(e => e.params.threadId === tid), 'every notification is under the conversation\'s own ID'); assert.ok(heard.every(e => e.params.threadId !== P));
  // Bridge neither duplicates nor drops: the fixture's native host emits the user item twice (its own loop re-announces it) and the agent item once.
  const completed = heard.filter(e => e.method === 'item/completed'); assert.equal(completed.length, 3, 'exactly the notifications native sent, no extra copy from the mapping');
  assert.equal(completed.filter(e => e.params.item.type === 'agentMessage').length, 1, 'a result item is delivered once');
  assert.equal(f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === P).length, 1, 'the turn ran exactly once, on the physical thread');
  const asked = []; f.bridge.desktop.request = async (method, params) => { asked.push({ method, params }); return { decision: 'accept' }; };
  assert.deepEqual(await f.bridge.toolRequest('item/commandExecution/requestApproval', { threadId: P, turnId: 't', itemId: 'i', command: 'ls' }), { decision: 'accept' });
  await f.bridge.toolRequest('item/commandExecution/requestApproval', { threadId: 'someone-else', turnId: 't', itemId: 'j' });
  assert.deepEqual(asked.map(a => a.params.threadId), [tid, 'someone-else'], 'an approval is shown under the conversation ID; other chats are untouched');
  await f.bridge.request('turn/interrupt', { threadId: tid, turnId: turn.turn.id }); assert.equal(f.calls.filter(c => c.method === 'turn/interrupt').at(-1).params.threadId, P);
  await f.bridge.request('thread/queue/add', { threadId: tid, input: [{ type: 'text', text: 'later' }] }); assert.equal(f.calls.filter(c => c.method === 'thread/queue/add').at(-1).params.threadId, P);
  // Away and back: resume and read under the conversation ID, with the earlier history in front.
  const nativeRequest = f.bridge.native.request; // the fixture host has no thread/read; give it the host's own thread
  f.bridge.native.request = async (method, params) => method === 'thread/read' ? { thread: structuredClone(f.hosts.get(params.threadId).thread) } : nativeRequest(method, params);
  const resumed = await f.bridge.request('thread/resume', { threadId: tid }); assert.equal(resumed.thread.id, tid);
  const read = await f.bridge.request('thread/read', { threadId: tid, includeTurns: true }); assert.equal(read.thread.id, tid); assert.equal(read.thread.turns[0].id, firstTurn, 'the carried history comes first');
  const paged = await f.bridge.request('thread/turns/list', { threadId: tid, sortDirection: 'asc', itemsView: 'full', limit: 1 }); assert.deepEqual(paged.data.map(t => t.id), [firstTurn]);
  // Restart: a new Bridge on the same state keeps the link, hides the physical thread and runs the next turn on it.
  f.restart(); assert.equal(f.bridge.localResponses.physicalOf(tid), P);
  assert.deepEqual((await f.bridge.request('thread/list', {})).data.map(t => t.id).filter(id => id === P), [], 'no duplicate chat after restart'); assert.ok((await f.bridge.request('thread/list', {})).data.some(t => t.id === tid));
  const again = await f.bridge.request('turn/start', { threadId: tid, model: 'gpt-test', input: [{ type: 'text', text: 'after restart' }] }); await f.done(again.turn.id);
  assert.equal(f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === P).length, 2); assert.equal(f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === tid).length, 1, 'only the turn from before the switch ever ran on the old provider\'s thread');
});

test('picker (Bridge): the first turn after a switch to Claude is routed to the managed chat and receives the carried visible history once, as reference', async () => {
  const { f, tid, link } = await switched('haiku'); let captured = null;
  f.bridge.run = async (record, running, params) => { captured = { id: record.thread.id, params }; };
  const turn = await f.bridge.request('turn/start', { threadId: tid, model: 'haiku', input: [{ type: 'text', text: 'FIRST-CLAUDE-REQUEST' }] });
  await new Promise(resolve => setImmediate(resolve)); assert.ok(captured, 'the turn reached the Claude runtime'); assert.equal(captured.id, link.physicalId);
  const record = f.bridge.records.get(link.physicalId); assert.equal(record.turns.length, 2, 'the carried turn, then the new one');
  const context = captured.params.additionalContext, history = context.bridge_conversation.value;
  assert.match(history, /EARLIER-USER-MARK/); assert.match(history, /NATIVE RESULT/); assert.doesNotMatch(history, /FIRST-CLAUDE-REQUEST/, 'the new request is the prompt, not part of the reference');
  assert.equal(context.bridge_conversation.kind, 'untrusted'); assert.match(context.bridge_history_rules.value, /do not execute past requests again/);
  assert.equal(turn.turn.id, record.turns[1].id); assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1, 'only the original custom turn ever reached native; the Claude turn was not replayed there');
});

test('picker (Bridge): desktop notifications go to the peer that owns the conversation\'s CURRENT physical thread, under that thread\'s ID; an unreadable link drops them', async () => {
  const r = root(), registry = new ProviderRegistry(r), f = fixture('openai', { connectionRoot: r }); nativeCatalog(f, [nativeRow('gpt-test', true)]); await f.bridge.request('model/list', {});
  const b = await connection(registry, 'B', ['same-slug']), chosen = localModelId(b, 'same-slug'), tid = await f.start('gpt-test');
  const { desktopNotificationOwner } = await import('../bridge.mjs');
  assert.deepEqual(desktopNotificationOwner(f.bridge, { threadId: tid, x: 1 }), { params: { threadId: tid, x: 1 }, route: null }, 'an ordinary chat is untouched');
  await f.bridge.request('thread/settings/update', { threadId: tid, model: chosen }); const link = f.bridge.localResponses.readLink(tid);
  const toCustom = desktopNotificationOwner(f.bridge, { threadId: tid, x: 1 }); assert.equal(toCustom.params.threadId, link.physicalId); assert.equal(toCustom.params.x, 1); assert.equal(toCustom.route.connectionId, b, 'the custom connection\'s peer');
  await f.bridge.request('thread/settings/update', { threadId: tid, model: 'gpt-test' }); const back = f.bridge.localResponses.readLink(tid);
  const toNative = desktopNotificationOwner(f.bridge, { threadId: tid }); assert.deepEqual([toNative.params.threadId, toNative.route], [back.physicalId, null], 'back on the native parent, under the newest physical ID'); assert.notEqual(back.physicalId, link.physicalId);
  f.restart(); assert.equal(desktopNotificationOwner(f.bridge, { threadId: tid }).params.threadId, back.physicalId, 'the same after a restart');
  writeFileSync(f.bridge.localResponses.linkPath(tid), '{broken', { mode: 0o600 }); const logged = [];
  assert.equal(desktopNotificationOwner(f.bridge, { threadId: tid }, (name) => logged.push(name)), null); assert.deepEqual(logged, ['link.unreadable'], 'dropped, never given to a peer that may be wrong');
});

test('picker (Bridge): a fresh empty chat switches without inventing a turn, returns, and keeps the same conversation ID through a restart', async () => {
  const r = root(), registry = new ProviderRegistry(r), f = fixture('openai', { connectionRoot: r }); nativeCatalog(f, [nativeRow('gpt-test', true)]); await f.bridge.request('model/list', {});
  const b = await connection(registry, 'B', ['same-slug']), chosen = localModelId(b, 'same-slug'), tid = await f.start(chosen, { sandbox: 'read-only', approvalPolicy: 'never' });
  await f.bridge.request('thread/settings/update', { threadId: tid, model: 'gpt-test' }); const first = f.bridge.localResponses.readLink(tid);
  // (the one trusted transition note is a developer-role item; it is not history: nothing of the conversation is carried, and no turn is invented)
  const injects = f.calls.filter(c => c.method === 'thread/inject_items'), carried = injects.filter(c => c.params.items.some(i => i.role !== 'developer'));
  assert.equal(carried.length, 0, 'nothing to carry, nothing injected'); assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 0, 'no seed turn');
  assert.equal(injects.length, 1, 'exactly one transition note'); assert.deepEqual(injects[0].params.items.map(i => [i.type, i.role]), [['message', 'developer']]); assert.match(injects[0].params.items[0].content[0].text, /^Model Bridge note/);
  f.restart(); await f.bridge.request('thread/settings/update', { threadId: tid, model: chosen }); const second = f.bridge.localResponses.readLink(tid);
  assert.deepEqual([second.logicalId, second.kind, second.previous], [tid, 'custom', [first.physicalId, tid]], 'the conversation ID is stable across the hop, the restart and the return');
  f.restart(); assert.equal(f.bridge.localResponses.physicalOf(tid), second.physicalId); assert.deepEqual((await f.bridge.request('thread/list', {})).data.map(t => t.id).filter(id => [first.physicalId, second.physicalId].includes(id)), []);
  const turn = await f.bridge.request('turn/start', { threadId: tid, model: chosen, input: [{ type: 'text', text: 'first words' }] }); await f.done(turn.turn.id);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').at(-1).params.threadId, second.physicalId);
});

test('picker (Bridge): the first turn after a switch to Claude runs through the real Bridge with an injected SDK stream, receives the carried history once, streams under the conversation ID and keeps its session on the next turn', { skip: process.permission ? 'the permission runner blocks the Claude runtime\'s own file reads: lead run outside it (test/custom-picker.test.mjs)' : false }, async () => {
  const { f, tid, link } = await switched('haiku'), mark = f.events.length;
  // a realistic SDK stream: the model's answer carries the public join to its prompt (user_message_uuid), which is what consumes the trusted transition note carried by this first query
  f.controls.messages = async function* (args) { const r = f.bridge.records.get(link.physicalId), sid = r.noticeAttempt?.sessionId ?? r.claudeSessionId;
    yield { type: 'assistant', session_id: sid, parent_tool_use_id: null, user_message_uuid: args.promptId, user_message_uuids: [args.promptId], message: { id: 'm-' + args.promptId, role: 'assistant', model: 'claude-haiku-x', content: [{ type: 'text', text: 'CLAUDE RESULT' }] } };
    yield { type: 'result', subtype: 'success', session_id: sid }; };
  const turn = await f.bridge.request('turn/start', { threadId: tid, model: 'haiku', input: [{ type: 'text', text: 'FIRST-CLAUDE-REQUEST' }] }); await f.done(turn.turn.id); await f.settled(turn.turn.id);
  assert.equal(f.queries.length, 1); const history = f.queries[0].additionalContext.bridge_conversation.value;
  assert.match(history, /EARLIER-USER-MARK/); assert.match(history, /NATIVE RESULT/); assert.doesNotMatch(history, /FIRST-CLAUDE-REQUEST/); assert.equal(f.queries[0].record.thread.id, link.physicalId);
  const heard = f.events.slice(mark); assert.ok(heard.every(e => e.params.threadId === tid || e.params.threadId === undefined), 'the stream is under the conversation ID'); assert.ok(heard.some(e => e.method === 'item/completed' && e.params.item.text === 'CLAUDE RESULT'));
  const record = f.bridge.records.get(link.physicalId); assert.deepEqual(record.turns.map(t => t.status), ['completed', 'completed']); assert.ok(record.claudeSessionId, 'a Claude session now exists');
  const next = await f.bridge.request('turn/start', { threadId: tid, model: 'haiku', input: [{ type: 'text', text: 'second' }] }); await f.done(next.turn.id); await f.settled(next.turn.id);
  assert.equal(f.queries.length, 2); assert.ok(!f.queries[1].additionalContext?.bridge_conversation, 'the carried history is given once, not again'); assert.equal(record.turns.length, 3);
});

// A genuinely old managed record: its native HOST thread lives on the non-executing claude_code provider and the seeds are not neutral.
// The fixture host refuses a same-ID resume on another provider, exactly as native does (modelProviderMismatch), so the old in-place path cannot pass.
function legacyChat(f, turns) {
  const record = f.bridge.records.get(turns.threadId);
  record.turns = turns.turns; Object.assign(record, { hostProvider: 'claude_code', neutralNativeSeed: false }); record.options.modelProvider = 'claude_code';
  // a real native thread reports the session source it was created with
  for (const thread of [record.thread, f.hosts.get(turns.threadId).thread]) Object.assign(thread, { source: 'vscode', createdAt: 1700000000 });
  f.hosts.get(turns.threadId).provider = 'claude_code'; f.bridge.save(record);
  f.controls.native = (method, p) => { const host = f.hosts.get(p.threadId); if (method === 'thread/resume' && p.modelProvider && host && host.provider !== p.modelProvider) throw Object.assign(new Error('modelProviderMismatch'), { code: -32600 }); };
  // a real native host reports the reviewer it runs with; re-applied to the new Bridge after a restart (f.legacyWrap)
  f.legacyWrap = () => {
    const prior = f.bridge.native.request;
    f.bridge.native.request = async (m, p) => {
      const out = await prior(m, p);
      // and its list rows carry the thread's model and provider, as the public Thread schema says (the plain fixture rows do not)
      if (m === 'thread/list' && Array.isArray(out?.data)) return { ...out, data: out.data.map(row => { const host = f.hosts.get(row.id); return host ? { ...row, model: host.settings.model, modelProvider: host.provider } : row; }) };
      return out && out.modelProvider && !out.approvalsReviewer ? { ...out, approvalsReviewer: 'user' } : out;
    };
  };
  f.legacyWrap();
  return record;
}
test('legacy Claude host (real Bridge): the picker moves an old claude_code-hosted chat to GPT as a NEW physical thread under the same conversation ID; old history reaches GPT once; nothing old changes; list, read, next turn and restart agree', async () => {
  const r = root(), f = fixture('openai', { connectionRoot: r });
  f.bridge.getModels = async () => [{ value: 'haiku', displayName: 'Fixture Haiku' }]; nativeCatalog(f, [nativeRow('gpt-test', true), nativeRow('gpt-other')]); await f.bridge.request('model/list', {});
  const tid = await f.start('haiku', { sandbox: 'read-only', approvalPolicy: 'never' });
  const record = legacyChat(f, { threadId: tid, turns: [{ id: 'old-turn-1', status: 'completed', error: null, provider: 'claude', items: [
    { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'LEGACY-USER-MARK' }] }, { type: 'agentMessage', id: 'a1', text: 'LEGACY-ASSISTANT-MARK' }] }] });
  const n = f.calls.length, turnsBefore = JSON.stringify(record.turns), hostBefore = JSON.stringify(f.hosts.get(tid)), mark = f.events.length;
  assert.deepEqual(await f.bridge.request('thread/settings/update', { threadId: tid, model: 'gpt-test' }), {});
  const added = f.calls.slice(n), link = f.bridge.localResponses.readLink(tid), P = link.physicalId;
  assert.deepEqual([link.logicalId, link.kind, link.previous], [tid, 'native', [tid]]); assert.notEqual(P, tid);
  assert.deepEqual([link.origin?.name ?? null, link.private], [null, [P]], 'the real Bridge path: native announced the private label after answering it, the handoff waited for that echo, and neither the null title nor the marker was disturbed');
  const started = added.filter(c => c.method === 'thread/start'); assert.equal(started.length, 1); assert.equal(started[0].params.modelProvider, 'openai'); assert.equal(started[0].params.model, 'gpt-test'); assert.deepEqual(started[0].params.runtimeWorkspaceRoots, [f.statePath], 'the real Bridge forwards the source\'s confirmed roots to the native thread/start');
  assert.equal(f.hosts.get(P).provider, 'openai', 'the new physical thread genuinely runs on the GPT provider'); assert.equal(f.hosts.get(tid).provider, 'claude_code', 'the old host is still the claude_code one');
  assert.ok(!added.some(c => c.method === 'thread/unsubscribe' || (c.method === 'thread/resume' && (c.params.threadId === tid || c.params.modelProvider))), 'no unsubscribe, no same-ID resume on another provider');
  const allInjects = added.filter(c => c.method === 'thread/inject_items'), injected = allInjects.filter(c => c.params.items.some(i => i.role !== 'developer')); assert.equal(injected.length, 1); const wire = JSON.stringify(injected[0].params.items);
  const notes = allInjects.filter(c => c.params.items.every(i => i.role === 'developer')); assert.equal(notes.length, 1, 'plus exactly one trusted developer-role transition note, after the carried history'); assert.ok(allInjects.indexOf(notes[0]) > allInjects.indexOf(injected[0]));
  assert.match(notes[0].params.items[0].content[0].text, /from Claude Code \(SDK session\) · haiku .* to GPT \(native Codex\) · gpt-test .*serving backend model: not reported/);
  assert.equal(wire.split('LEGACY-USER-MARK').length, 2, 'the old visible history reaches the GPT thread exactly once'); assert.equal(wire.split('LEGACY-ASSISTANT-MARK').length, 2); assert.ok(injected[0].params.items.every(i => i.type === 'message'));
  assert.ok(!added.some(c => c.method === 'thread/fork' || c.method === 'turn/start'), 'no fork and no prompt');
  assert.equal(JSON.stringify(f.bridge.records.get(tid).turns), turnsBefore, 'the old managed history is unchanged'); assert.equal(JSON.stringify(f.hosts.get(tid)), hostBefore, 'and so is the old native host thread'); assert.equal(f.queries.length, 0, 'no SDK run');
  const heard = f.events.slice(mark); assert.ok(heard.some(e => e.method === 'thread/settings/updated' && e.params.threadId === tid), 'the desktop hears about it under the conversation ID'); assert.ok(heard.every(e => e.params?.threadId !== P && e.params?.thread?.id !== P), 'the physical ID never reaches the desktop');
  const rows = (await f.bridge.request('thread/list', {})).data, row = rows.find(t => t.id === tid);
  assert.ok(row && !rows.some(t => t.id === P), 'one conversation row, no physical chat'); assert.deepEqual([row.model, row.modelProvider], ['gpt-test', 'openai'], 'the row shows the CURRENT runtime, not the old Claude provider');
  const nativeRead = f.bridge.native.request; f.bridge.native.request = async (m, p) => m === 'thread/read' ? { thread: structuredClone(f.hosts.get(p.threadId).thread) } : nativeRead(m, p);
  const read = await f.bridge.request('thread/read', { threadId: tid, includeTurns: true }); assert.equal(read.thread.id, tid); assert.equal(read.thread.turns[0].id, 'old-turn-1', 'the old canonical history comes first');
  const turn = await f.bridge.request('turn/start', { threadId: tid, model: 'gpt-test', input: [{ type: 'text', text: 'NEXT-GPT-REQUEST' }], clientUserMessageId: randomUUID() }); await f.done(turn.turn.id);
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1); assert.equal(f.calls.find(c => c.method === 'turn/start').params.threadId, P, 'the turn runs on the new physical thread only'); assert.equal(f.queries.length, 0);
  f.restart(); assert.deepEqual([f.bridge.localResponses.physicalOf(tid), f.bridge.localResponses.logicalOf(P)], [P, tid], 'the same conversation after a restart');
  assert.equal((await f.bridge.request('thread/list', {})).data.filter(t => t.id === P).length, 0);
});

test('legacy Claude host (real Bridge): a fresh managed chat on an OpenAI host keeps the ordinary same-thread model change; a pending queue refuses the legacy switch untouched', async () => {
  const r = root(), f = fixture('openai', { connectionRoot: r });
  f.bridge.getModels = async () => [{ value: 'haiku', displayName: 'Fixture Haiku' }]; nativeCatalog(f, [nativeRow('gpt-test', true), nativeRow('gpt-other')]); await f.bridge.request('model/list', {});
  const fresh = await f.start('haiku', { sandbox: 'read-only', approvalPolicy: 'never' }), startsBefore = f.calls.filter(c => c.method === 'thread/start').length;
  await f.bridge.request('thread/settings/update', { threadId: fresh, model: 'gpt-test' });
  assert.equal(f.bridge.localResponses.readLink(fresh), null, 'no link, no new thread: the ordinary path'); assert.equal(f.calls.filter(c => c.method === 'thread/start').length, startsBefore); assert.equal(f.bridge.records.get(fresh).provider, 'native');
  const tid = await f.start('haiku', { sandbox: 'read-only', approvalPolicy: 'never' });
  const record = legacyChat(f, { threadId: tid, turns: [] }); record.queue = [{ id: 'q1', input: [{ type: 'text', text: 'pending' }], clientUserMessageId: 'c1' }]; f.bridge.save(record); const n = f.calls.length;
  await assert.rejects(f.bridge.request('thread/settings/update', { threadId: tid, model: 'gpt-test' }), { code: 'handoff_queue_pending' });
  assert.deepEqual(f.calls.slice(n).filter(c => c.method === 'thread/start'), [], 'nothing created'); assert.deepEqual(f.bridge.records.get(tid).queue.map(q => q.id), ['q1'], 'the queued entry is untouched'); assert.equal(f.bridge.localResponses.readLink(tid), null);
});

test('legacy Claude host (real Bridge): discovery of missing roots is a read-only thread/read of the source (its primary environment\'s roots, its OWN provider confirmed), never a resume, never rewrites the old record; a mislabelled or rootless read is refused', async () => {
  // native 0.167 refuses any thread/resume of a thread whose provider differs from the app-server's configured one, whatever override is named
  const environments = (f, provider = null, roots = [f.statePath]) => { const prior = f.bridge.native.request; f.reads = []; f.bridge.native.request = async (m, p) => m === 'thread/read' && f.hosts.get(p.threadId) && f.reads.push(p.threadId)
    ? { thread: { ...structuredClone(f.hosts.get(p.threadId).thread), id: p.threadId, modelProvider: provider ?? f.hosts.get(p.threadId).provider, environments: roots ? [{ environmentId: 'local', cwd: f.statePath, runtimeWorkspaceRoots: roots }] : null } } : prior(m, p); };
  const make = async () => {
    const r = root(), f = fixture('openai', { connectionRoot: r });
    f.bridge.getModels = async () => [{ value: 'haiku', displayName: 'Fixture Haiku' }]; nativeCatalog(f, [nativeRow('gpt-test', true), nativeRow('gpt-other')]); await f.bridge.request('model/list', {});
    const tid = await f.start('haiku', { sandbox: 'read-only', approvalPolicy: 'never' });
    const record = legacyChat(f, { threadId: tid, turns: [{ id: 'old-turn-1', status: 'completed', error: null, provider: 'claude', items: [{ type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'LEGACY-USER-MARK' }] }] }] });
    delete record.runtimeWorkspaceRoots; f.bridge.save(record); return { f, tid, record };
  };
  const { f, tid } = await make(), file = join(f.statePath, tid + '.json'), before = readFileSync(file); environments(f);
  await f.bridge.request('thread/settings/update', { threadId: tid, model: 'gpt-test' });
  assert.ok(f.reads.includes(tid), 'discovery is a read of the source'); assert.deepEqual(f.calls.filter(c => c.method === 'thread/resume' && (c.params.threadId === tid || c.params.modelProvider)), [], 'never a resume of the source');
  assert.deepEqual(readFileSync(file), before, 'the old record file is byte-identical: discovery did not rewrite it'); assert.equal(f.bridge.localResponses.readLink(tid).kind, 'native');
  // roots already saved with the host's own start response (thread.environments) are evidence too, with no read at all; a cold read's null environments is "unknown"
  const saved = await make(); saved.record.thread.environments = [{ environmentId: 'local', cwd: saved.f.statePath, runtimeWorkspaceRoots: [saved.f.statePath] }]; saved.f.bridge.save(saved.record); environments(saved.f);
  await saved.f.bridge.request('thread/settings/update', { threadId: saved.tid, model: 'gpt-test' }); assert.deepEqual(saved.f.reads, [], 'no read was needed'); assert.equal(saved.f.bridge.localResponses.readLink(saved.tid).kind, 'native');
  for (const [label, arrange] of [['a read that names another provider (a mislabelled owner)', f => environments(f, 'someone-else')], ['a read with no environment roots (not loaded)', f => environments(f, null, null)], ['a read whose roots are not strings', f => environments(f, null, [7])]]) {
    const bad = await make(); arrange(bad.f); const n = bad.f.calls.length;
    await assert.rejects(bad.f.bridge.request('thread/settings/update', { threadId: bad.tid, model: 'gpt-test' }), { code: 'native_permissions_unconfirmed' }, label);
    assert.deepEqual(bad.f.calls.slice(n).filter(c => c.method === 'thread/start' || c.method === 'thread/resume'), [], label + ': nothing is guessed, resumed or created');
  }
});

// INITIAL OPEN: an old claude_code-hosted chat, after a cold start, opened through the public resume BEFORE any picker. Native 0.167 refuses to load a thread whose
// provider differs from the app-server's configured one (the fixture host does too, see legacyChat), so the old host is never resumed: the conversation continues,
// under the same ID, on a NEW neutral Claude chat through the existing hand-off.
async function coldLegacy({ model = 'haiku', effort = null, models = null } = {}) {
  const r = root(), f = fixture('openai', { connectionRoot: r });
  const old = { id: 'old-turn-1', status: 'completed', error: null, provider: 'claude', items: [{ type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'LEGACY-USER-MARK' }] }, { type: 'agentMessage', id: 'a1', text: 'LEGACY-ASSISTANT-MARK' }] };
  const tid = await f.start(model, { sandbox: 'read-only', approvalPolicy: 'never' }), record = legacyChat(f, { threadId: tid, turns: [old] });
  if (effort) { record.effort = effort; f.bridge.save(record); } // the SDK selection the old chat was left on
  f.restart(); f.legacyWrap(); // a cold start: a new Bridge on the same state, nothing loaded
  if (models) f.bridge.getModels = async () => models; // what the SDK advertises today
  return { f, tid, oldFile: join(f.statePath, tid + '.json') };
}
test('legacy Claude host (real Bridge): INITIAL OPEN after a cold start: the public resume succeeds before any picker, continues the SAME conversation on a NEW neutral Claude chat (never the old host), reads and lists create nothing, the old record stays byte-identical, and the first Claude turn reaches the Claude runtime once with the old history as reference', async () => {
  const { f, tid, oldFile } = await coldLegacy(), turnsBefore = JSON.stringify(f.bridge.records.get(tid).turns), hostBefore = JSON.stringify(f.hosts.get(tid)), n = f.calls.length; let oldBytes;
  const read = await f.bridge.request('thread/read', { threadId: tid, includeTurns: true }); assert.equal(read.thread.turns[0].id, 'old-turn-1', 'the old history is readable without opening');
  await f.bridge.request('thread/list', {}); const created = ['thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'thread/inject_items', 'thread/unsubscribe'];
  assert.deepEqual(f.calls.slice(n).filter(c => created.includes(c.method)), [], 'a read and a list start, resume and create nothing'); assert.equal(f.bridge.localResponses.readLink(tid), null);
  oldBytes = readFileSync(oldFile); // (Bridge's own list syncs native metadata into a saved record; the hand-off itself must not touch the record at all)
  const mark = f.events.length, m = f.calls.length, opened = await f.bridge.request('thread/resume', { threadId: tid });
  const added = f.calls.slice(m), link = f.bridge.localResponses.readLink(tid), P = link.physicalId;
  assert.equal(opened.thread.id, tid, 'the conversation ID the desktop knows'); assert.equal(opened.modelProvider, 'claude_code'); assert.equal(opened.model, 'haiku'); assert.equal(opened.thread.turns[0].id, 'old-turn-1', 'the old canonical history comes first');
  assert.deepEqual([link.logicalId, link.kind, link.previous, link.origin.source, link.origin.createdAt === f.bridge.records.get(tid).thread.createdAt], [tid, 'claude', [tid], 'vscode', true]); assert.notEqual(P, tid);
  const started = added.filter(c => c.method === 'thread/start'); assert.equal(started.length, 1, 'exactly one new neutral host'); assert.equal(started[0].params.modelProvider, 'openai', 'on the CONFIGURED provider'); assert.deepEqual(started[0].params.runtimeWorkspaceRoots, [f.statePath], 'the old chat\'s own roots');
  assert.equal(f.hosts.get(P).provider, 'openai'); assert.equal(f.hosts.get(tid).provider, 'claude_code', 'the old host is still the claude_code one');
  assert.ok(added.every(c => c.method !== 'thread/resume' || (c.params.threadId === P && c.params.modelProvider === 'openai')), 'only the NEW chat is resumed: no same-ID resume of the old host, no override');
  assert.ok(!added.some(c => ['thread/unsubscribe', 'thread/fork', 'turn/start', 'thread/inject_items'].includes(c.method)), 'no unsubscribe, no fork, no prompt, no seed');
  assert.equal(readFileSync(oldFile).equals(oldBytes), true, 'the old record file is byte-identical'); assert.equal(JSON.stringify(f.hosts.get(tid)), hostBefore, 'and so is the old native host'); assert.equal(f.queries.length, 0, 'no SDK run');
  const heard = f.events.slice(mark); assert.ok(heard.every(e => e.params?.threadId !== P && e.params?.thread?.id !== P), 'the physical ID never reaches the desktop');
  const rows = (await f.bridge.request('thread/list', {})).data; assert.equal(rows.filter(t => t.id === tid).length, 1); assert.ok(!rows.some(t => t.id === P)); assert.equal(rows.find(t => t.id === tid).modelProvider, 'claude_code');
  assert.equal(JSON.stringify(f.bridge.records.get(tid).turns), turnsBefore, 'the old visible history is unchanged'); oldBytes = readFileSync(oldFile);
  await f.bridge.request('thread/resume', { threadId: tid }); assert.equal(f.calls.filter(c => c.method === 'thread/start').length, 2, 'a second open reuses the chat (the first start was the original one, this is its only child)');
  let captured = null; f.bridge.run = async (record, running, params) => { captured = { id: record.thread.id, params }; };
  const turn = await f.bridge.request('turn/start', { threadId: tid, model: 'haiku', input: [{ type: 'text', text: 'FIRST-CLAUDE-REQUEST' }] }); await new Promise(resolve => setImmediate(resolve));
  assert.ok(captured, 'the turn reached the Claude runtime'); assert.equal(captured.id, P); const record = f.bridge.records.get(P); assert.equal(record.turns.length, 2, 'the carried turn, then the new one'); assert.equal(turn.turn.id, record.turns[1].id);
  const history = captured.params.additionalContext.bridge_conversation.value; assert.match(history, /LEGACY-USER-MARK/); assert.match(history, /LEGACY-ASSISTANT-MARK/); assert.doesNotMatch(history, /FIRST-CLAUDE-REQUEST/, 'the old history is the reference, once; the request is the prompt');
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 0, 'the Claude turn was never sent to native'); assert.equal(readFileSync(oldFile).equals(oldBytes), true, 'the old record is still byte-identical after the turn');
});

test('legacy Claude host (real Bridge): INITIAL OPEN: a Claude turn on an unopened old chat migrates first; roots native does not confirm refuse the open and create nothing; a busy or queued old chat is refused untouched', async () => {
  const first = await coldLegacy(); let captured = null; first.f.bridge.run = async (record, running, params) => { captured = { id: record.thread.id, params }; };
  await first.f.bridge.request('turn/start', { threadId: first.tid, model: 'haiku', input: [{ type: 'text', text: 'TURN-BEFORE-OPEN' }] }); await new Promise(resolve => setImmediate(resolve));
  const P = first.f.bridge.localResponses.readLink(first.tid).physicalId; assert.equal(captured?.id, P, 'the turn ran on the new chat'); assert.match(captured.params.additionalContext.bridge_conversation.value, /LEGACY-USER-MARK/);
  assert.ok(!first.f.calls.some(c => c.method === 'thread/resume' && c.params.threadId === first.tid), 'the old host was never resumed');
  // unknown roots: an old record that never saved them, with a read that cannot confirm them
  const unknown = await coldLegacy(), record = unknown.f.bridge.records.get(unknown.tid); delete record.runtimeWorkspaceRoots; delete record.thread.environments; unknown.f.bridge.save(record);
  const before = readFileSync(unknown.oldFile), n = unknown.f.calls.length; const reader = unknown.f.bridge.native.request; unknown.f.bridge.native.request = async (m, p) => m === 'thread/read' ? { thread: { ...structuredClone(unknown.f.hosts.get(p.threadId).thread), modelProvider: 'claude_code', environments: null } } : reader(m, p);
  await assert.rejects(unknown.f.bridge.request('thread/resume', { threadId: unknown.tid }), { code: 'native_permissions_unconfirmed' }); assert.deepEqual(unknown.f.calls.slice(n).filter(c => c.method === 'thread/start' || c.method === 'thread/resume'), [], 'nothing guessed, resumed or created');
  assert.equal(unknown.f.bridge.localResponses.readLink(unknown.tid), null); assert.equal(readFileSync(unknown.oldFile).equals(before), true);
  // a queued entry is never carried or replayed
  const queued = await coldLegacy(), queuedRecord = queued.f.bridge.records.get(queued.tid); queuedRecord.queue = [{ id: 'q1', input: [{ type: 'text', text: 'pending' }], clientUserMessageId: 'c1' }]; queued.f.bridge.save(queuedRecord); const m = queued.f.calls.length;
  await assert.rejects(queued.f.bridge.request('thread/resume', { threadId: queued.tid }), { code: 'handoff_queue_pending' }); assert.deepEqual(queued.f.calls.slice(m).filter(c => c.method === 'thread/start'), []); assert.deepEqual(queued.f.bridge.records.get(queued.tid).queue.map(q => q.id), ['q1']);
});

test('legacy Claude host (real Bridge): INITIAL OPEN only repairs the HOST: a Claude chat left on Medium (advertised) opens on Medium, the public resume shows it, the first Claude query keeps it, and permissions and roots are the old chat\'s; a level the SDK no longer advertises refuses the open untouched', async () => {
  const sonnet = levels => [{ value: 'sonnet', supportsEffort: true, supportedEffortLevels: levels }];
  const { f, tid } = await coldLegacy({ model: 'sonnet', effort: 'medium', models: sonnet(['low', 'medium', 'high']) }), old = f.bridge.records.get(tid);
  const opened = await f.bridge.request('thread/resume', { threadId: tid }), P = f.bridge.localResponses.readLink(tid).physicalId, child = f.bridge.records.get(P);
  assert.deepEqual([opened.model, opened.modelProvider, opened.reasoningEffort], ['sonnet', 'claude_code', 'medium'], 'the public resume shows the chat\'s own model and effort, never an implicit High');
  assert.deepEqual([child.model, child.effort, child.sandbox, child.approvalPolicy, child.runtimeWorkspaceRoots], [old.model, 'medium', old.sandbox, old.approvalPolicy, old.runtimeWorkspaceRoots], 'the new host carries the old chat\'s selection, permissions and roots');
  let captured = null; f.bridge.run = async record => { captured = { model: record.model, effort: record.effort }; };
  await f.bridge.request('turn/start', { threadId: tid, model: 'sonnet', input: [{ type: 'text', text: 'FIRST-CLAUDE-REQUEST' }] }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(captured, { model: 'sonnet', effort: 'medium' }, 'the first Claude query keeps the selection unless the person asks for another');
  // public resume inputs: the current SDK model asked for by its RESOLVED name (the SDK normalizes it to the same model), with the chat's own provider and path
  const resolved = await coldLegacy({ model: 'sonnet', effort: 'medium', models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-4-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }] });
  const asked = await resolved.f.bridge.request('thread/resume', { threadId: resolved.tid, model: 'claude-sonnet-4-5', modelProvider: 'claude_code', path: resolved.f.bridge.records.get(resolved.tid).thread.path });
  assert.deepEqual([asked.model, asked.modelProvider, asked.reasoningEffort], ['sonnet', 'claude_code', 'medium'], 'the same SDK model under its resolved name keeps the selection');
  const foreign = await coldLegacy(), f0 = foreign.f.calls.length;
  await assert.rejects(foreign.f.bridge.request('thread/resume', { threadId: foreign.tid, model: 'haiku', modelProvider: 'openai' }), { code: 'provider_override_refused' }); assert.deepEqual(foreign.f.calls.slice(f0).filter(c => ['thread/start', 'thread/resume'].includes(c.method)), [], 'a foreign provider is refused before anything exists');
  // a GPT target asked on the open of a legacy host: never the main resume of the old host, but the existing new-physical-GPT-thread hand-off
  const gpt = await coldLegacy(), g0 = gpt.f.calls.length, oldBytes = readFileSync(gpt.oldFile);
  const gptOpened = await gpt.f.bridge.request('thread/resume', { threadId: gpt.tid, model: 'gpt-test' }), gptLink = gpt.f.bridge.localResponses.readLink(gpt.tid), gptAdded = gpt.f.calls.slice(g0);
  assert.equal(gptOpened.thread.id, gpt.tid); assert.equal(gptLink.kind, 'native'); assert.notEqual(gptLink.physicalId, gpt.tid);
  assert.deepEqual(gptAdded.filter(c => c.method === 'thread/resume' && c.params.threadId === gpt.tid), [], 'the old host is never resumed'); assert.equal(gptAdded.filter(c => c.method === 'thread/start').length, 1); assert.equal(gptAdded.find(c => c.method === 'thread/start').params.modelProvider, 'openai');
  assert.equal(readFileSync(gpt.oldFile).equals(oldBytes), true, 'the old record is untouched');
  const refused = await coldLegacy({ model: 'sonnet', effort: 'medium', models: sonnet(['low', 'high']) }), before = readFileSync(refused.oldFile), n = refused.f.calls.length;
  await assert.rejects(refused.f.bridge.request('thread/resume', { threadId: refused.tid }), /Unsupported effort medium/);
  assert.equal(refused.f.bridge.localResponses.readLink(refused.tid), null, 'nothing published'); assert.equal(refused.f.calls.slice(n).filter(c => c.method === 'thread/archive').length, 1, 'only the just-created chat is withdrawn'); assert.equal(readFileSync(refused.oldFile).equals(before), true, 'the old record is untouched');
  assert.deepEqual(refused.f.calls.slice(n).filter(c => c.method === 'thread/resume' && c.params.threadId === refused.tid), [], 'and its old host was never asked anything');
});

test('legacy Claude host (real Bridge): INITIAL OPEN, real Claude stream: the first turn after the open streams under the conversation ID, receives the old history once, and keeps its session on the next turn', { skip: process.permission ? 'the permission runner blocks the Claude runtime\'s own file reads: lead run outside it (test/custom-picker.test.mjs)' : false }, async () => {
  const { f, tid, oldFile } = await coldLegacy(), oldBytes = readFileSync(oldFile);
  await f.bridge.request('thread/resume', { threadId: tid }); const P = f.bridge.localResponses.readLink(tid).physicalId, mark = f.events.length;
  // a realistic SDK stream: the answer carries the public join to its prompt (consuming the trusted note this first query carries)
  f.controls.messages = async function* (args) { const r = f.bridge.records.get(P), sid = r.noticeAttempt?.sessionId ?? r.claudeSessionId;
    yield { type: 'assistant', session_id: sid, parent_tool_use_id: null, user_message_uuid: args.promptId, user_message_uuids: [args.promptId], message: { id: 'm-' + args.promptId, role: 'assistant', model: 'claude-haiku-x', content: [{ type: 'text', text: 'CLAUDE RESULT' }] } };
    yield { type: 'result', subtype: 'success', session_id: sid }; };
  const turn = await f.bridge.request('turn/start', { threadId: tid, model: 'haiku', input: [{ type: 'text', text: 'FIRST-CLAUDE-REQUEST' }] }); await f.done(turn.turn.id); await f.settled(turn.turn.id);
  assert.equal(f.queries.length, 1); const history = f.queries[0].additionalContext.bridge_conversation.value; assert.match(history, /LEGACY-USER-MARK/); assert.match(history, /LEGACY-ASSISTANT-MARK/); assert.doesNotMatch(history, /FIRST-CLAUDE-REQUEST/); assert.equal(f.queries[0].record.thread.id, P);
  const heard = f.events.slice(mark); assert.ok(heard.every(e => e.params.threadId === tid || e.params.threadId === undefined), 'under the conversation ID'); assert.ok(heard.some(e => e.method === 'item/completed' && e.params.item.text === 'CLAUDE RESULT'));
  const next = await f.bridge.request('turn/start', { threadId: tid, model: 'haiku', input: [{ type: 'text', text: 'second' }] }); await f.done(next.turn.id); await f.settled(next.turn.id);
  assert.equal(f.queries.length, 2); assert.ok(!f.queries[1].additionalContext?.bridge_conversation, 'the old history is given once, not again'); assert.equal(f.bridge.records.get(P).turns.length, 3);
  assert.equal(readFileSync(oldFile).equals(oldBytes), true, 'the old record is byte-identical through both turns'); assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 0, 'native never ran a turn');
});

// ---- THE HUMAN SEQUENCE: Qwen -> OpenRouter (free) -> Opus -> GPT, a full cold reopen, and back to Qwen --------------------------------------
// What this can and cannot prove: it checks, on the synthetic host, EXACTLY what each new runtime is handed as model input (the injected plain items, the turn's input and its
// additionalContext, i.e. everything Bridge sends) and that the desktop's own settings consumer survives every event. Whether a MODEL then recalls what it was handed is a model
// behaviour this cannot show; if every message reaches the wire exactly once and the model still forgets, that is not history loss in Bridge.
// The installed desktop's consumer of thread/settings/updated (early-bootstrap-815-e030c49be4b9c405.js) reads `.settings` of its previous collaboration mode AND of the incoming one.
const SETTINGS_FIELDS = ['activePermissionProfile', 'approvalPolicy', 'approvalsReviewer', 'collaborationMode', 'cwd', 'disabledPluginIds', 'effort', 'model', 'modelProvider', 'multiAgentMode', 'personality', 'sandboxPolicy', 'serviceTier', 'summary'];
const consumeSettings = (state, event) => { const { threadId: n, threadSettings: i } = event, e = state.get(n); let t; t = e.latestCollaborationMode.settings.model; e.latestThreadSettings = i; e.latestModel = i.model; e.modelProvider = i.modelProvider; e.latestReasoningEffort = i.effort; e.latestCollaborationMode = i.collaborationMode; e.cwd = i.cwd; return [t, i.collaborationMode.settings.model]; };
test('HUMAN SEQUENCE (real Bridge): Qwen -> OpenRouter -> Opus -> GPT -> OpenRouter again, a full cold reopen, back to Qwen: each earlier message reaches every new runtime exactly once, nothing private is model input, source threads keep their bytes, the conversation ID never changes, and every settings event is the full contract the desktop consumes', async () => {
  const r = root(), registry = new ProviderRegistry(r); let f = fixture('openai', { connectionRoot: r });
  // The GPT target's own catalog for this sequence: Medium and High are offered (default Medium), none is NOT - exactly what the owner's gpt-6.1-sol advertises.
  const gptRow = { ...nativeRow('gpt-test', true), supportedReasoningEfforts: ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort, description: 'Native fixture effort' })), defaultReasoningEffort: 'medium' };
  const stale = { mode: 'default', settings: { model: 'gpt-test', reasoning_effort: 'none', developer_instructions: null } }; // the client's stale mode from the previous provider
  const prepare = async () => { f.bridge.getModels = async () => [{ value: 'haiku', displayName: 'Fixture Haiku' }]; nativeCatalog(f, [gptRow, nativeRow('gpt-other')]); await f.bridge.request('model/list', {});
    const prior = f.bridge.native.request; f.bridge.native.request = async (m, p) => m === 'thread/read' && f.hosts.get(p.threadId) ? { thread: structuredClone(f.hosts.get(p.threadId).thread) } : prior(m, p); }; // (the fixture host has no thread/read: it answers with its own thread)
  await prepare(); const qwen = await connection(registry, 'Qwen Z13', ['qwen-z13']), openrouter = await connection(registry, 'OpenRouter free', ['free-model']), Q = localModelId(qwen, 'qwen-z13'), O = localModelId(openrouter, 'free-model');
  const answers = ['ASSISTANT-ANSWER-ONE-1101', 'ASSISTANT-ANSWER-TWO-2202', 'ASSISTANT-ANSWER-GPT-3303', 'ASSISTANT-ANSWER-GPT-AGAIN-3304', 'ASSISTANT-ANSWER-OR-AGAIN-4404', 'ASSISTANT-ANSWER-QWEN-5505']; let answered = 0;
  f.controls.native = undefined; f.controls.nativeTurn = async turn => { turn.items.push({ type: 'agentMessage', id: randomUUID(), text: answers[answered++] }); };
  const count = (haystack, needle) => haystack.split(needle).length - 1, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), until = async predicate => { for (let i = 0; i < 400 && !predicate(); i++) await sleep(5); assert.ok(predicate(), 'condition not reached'); };
  const CODEWORD = 'REMEMBER-CODEWORD-7741', SECOND = 'SECOND-USER-5502', THIRD = 'THIRD-CLAUDE-REQUEST-6613', CLAUDE_ANSWER = 'CLAUDE-ANSWER-9913', GPT_REQUEST = 'GPT-REQUEST-4418', GPT_AGAIN = 'GPT-AGAIN-REQUEST-4419', BACK = 'BACK-ON-QWEN-3306';
  const states = new Map(); let consumed = 0; const consumeNew = tid => { const events = f.events.slice(consumed).filter(e => e.method === 'thread/settings/updated'); consumed = f.events.length; for (const e of events) { assert.equal(e.params.threadId, tid, 'settings are only ever announced under the conversation ID'); consumeSettings(states, e.params); } return events; };
  const tid = await f.start(Q, { sandbox: 'read-only', approvalPolicy: 'never' }); states.set(tid, { latestCollaborationMode: { mode: 'default', settings: { model: Q, reasoning_effort: null, developer_instructions: null } } });
  const injected = (from, id) => f.calls.slice(from).filter(c => c.method === 'thread/inject_items' && c.params.threadId === id).flatMap(c => c.params.items);
  // 1. Qwen: the codeword
  const t1 = await f.send(tid, CODEWORD); await f.done(t1.turn.id); const originBytes = JSON.stringify(f.hosts.get(tid).thread.turns); consumeNew(tid);
  // 2. OpenRouter free
  let from = f.calls.length; await f.bridge.request('thread/settings/update', { threadId: tid, model: O }); const link1 = f.bridge.localResponses.readLink(tid), P1 = link1.physicalId;
  let events = consumeNew(tid), announce = events.at(-1).params.threadSettings; assert.deepEqual(Object.keys(announce).sort(), SETTINGS_FIELDS, 'the announcement is the full pinned ThreadSettings'); assert.equal(announce.model, O, 'the desktop\'s local model ID'); assert.equal(announce.collaborationMode.settings.model, O);
  let wire = JSON.stringify(injected(from, P1)); assert.equal(count(wire, CODEWORD), 1, 'OpenRouter is handed the codeword exactly once'); assert.equal(count(wire, answers[0]), 1, 'and Qwen\'s answer exactly once');
  const t2 = await f.send(tid, SECOND); await f.done(t2.turn.id); const secondBytes = JSON.stringify(f.hosts.get(P1).thread.turns); consumeNew(tid);
  assert.equal(count(JSON.stringify(f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === P1)), CODEWORD), 0, 'the carried history is not sent again with the next turn');
  // 3. Opus (a managed Claude chat): the fake SDK stream is handed everything once
  from = f.calls.length; await f.bridge.request('thread/settings/update', { threadId: tid, model: 'haiku' }); const link2 = f.bridge.localResponses.readLink(tid), P2 = link2.physicalId; assert.equal(link2.kind, 'claude');
  events = consumeNew(tid); announce = events.at(-1).params.threadSettings; assert.deepEqual(Object.keys(announce).sort(), SETTINGS_FIELDS); assert.equal(announce.model, 'haiku'); assert.equal(announce.modelProvider, 'claude_code');
  let captured = null; f.bridge.run = async (record, running, params) => { captured = params; const turn = running.turn; turn.items.push({ id: randomUUID(), type: 'agentMessage', text: CLAUDE_ANSWER }); turn.status = 'completed'; turn.completedAt = Math.floor(Date.now() / 1000); f.bridge.active.delete(record.thread.id); f.bridge.save(record); };
  await f.bridge.request('turn/start', { threadId: tid, model: 'haiku', input: [{ type: 'text', text: THIRD }], clientUserMessageId: randomUUID() }); await until(() => captured);
  const claudeContext = captured.additionalContext.bridge_conversation.value; for (const [mark, times] of [[CODEWORD, 1], [SECOND, 1], [answers[0], 1], [answers[1], 1], [THIRD, 0]]) assert.equal(count(claudeContext, mark), times, 'Claude context: ' + mark);
  // 4. GPT: the SDK-executed managed chat holds Bridge's private host placeholder in its native host thread, so that host never becomes a GPT model's own thread: GPT is a NEW physical
  // thread under the same conversation ID, handed the canonical history once as plain items (the Claude chat's record stays as it is), then its first turn
  const claudeRecord = JSON.stringify(f.bridge.records.get(P2).turns);
  // The person chooses MEDIUM for the GPT model through the public settings update; the client's mode still carries the stale none of the previous provider (which this GPT model does not offer).
  from = f.calls.length; await f.bridge.request('thread/settings/update', { threadId: tid, model: 'gpt-test', effort: 'medium', collaborationMode: stale }); events = consumeNew(tid);
  announce = events.at(-1).params.threadSettings; assert.equal(announce.model, 'gpt-test'); assert.equal(announce.effort, 'medium', 'the desktop is told Medium'); assert.equal(announce.collaborationMode.settings.reasoning_effort, 'medium', 'in both fields');
  const linkG = f.bridge.localResponses.readLink(tid), PG = linkG.physicalId; assert.deepEqual([linkG.kind, linkG.previous], ['native', [P2, P1, tid]]); assert.notEqual(PG, P2, 'a new physical thread, never the SDK host');
  assert.deepEqual(f.calls.slice(from).filter(c => c.params?.threadId === P2), [], 'nothing at all is sent to the SDK host thread'); assert.equal(JSON.stringify(f.bridge.records.get(P2).turns), claudeRecord, 'the SDK chat record is only read');
  wire = JSON.stringify(injected(from, PG)); for (const mark of [CODEWORD, SECOND, answers[0], answers[1], CLAUDE_ANSWER, THIRD]) assert.equal(count(wire, mark), 1, 'GPT is handed exactly once: ' + mark); assert.doesNotMatch(wire, /Bridge tool host|Conversation is supplied when needed/);
  assert.equal(f.hosts.get(PG).settings.effort, 'medium', 'the new GPT thread really holds Medium'); assert.equal(f.hosts.get(PG).settings.collaborationMode.settings.reasoning_effort, 'medium', 'also in its mode');
  // the first GPT task arrives with the SAME stale mode: the actual Native request carries Medium in BOTH outgoing fields (native honours the nested one)
  const g = await f.bridge.request('turn/start', { threadId: tid, model: 'gpt-test', effort: 'medium', collaborationMode: stale, input: [{ type: 'text', text: GPT_REQUEST }], clientUserMessageId: randomUUID() }); await f.done(g.turn.id);
  const gptCall = f.calls.slice(from).filter(c => c.method === 'turn/start' && c.params.threadId === PG).at(-1), gptWire = JSON.stringify(gptCall.params);
  assert.deepEqual([gptCall.params.effort, gptCall.params.collaborationMode.settings.reasoning_effort], ['medium', 'medium'], 'the final Native turn/start: Medium on top AND inside the mode, never the stale none');
  assert.equal(count(gptWire, GPT_REQUEST), 1, 'the new message is the turn input once'); assert.equal(count(gptWire, CODEWORD), 0, 'the history is the thread\'s own, never repeated with the turn'); assert.equal(count(JSON.stringify(gptCall.params.input), GPT_REQUEST), 1); consumeNew(tid);
  // 4a. a COLD restart and the public open WHILE the conversation is still on GPT, then a new task with the same stale mode: the actual Native request again carries the one valid level, on the same thread
  f.restart(); await prepare(); consumed = f.events.length;
  assert.equal((await f.bridge.request('thread/resume', { threadId: tid })).thread.id, tid, 'the public open answers under the conversation ID'); consumeNew(tid);
  assert.equal(f.bridge.localResponses.readLink(tid).physicalId, PG, 'still the same GPT thread after the reopen');
  const g2 = await f.bridge.request('turn/start', { threadId: tid, model: 'gpt-test', effort: 'medium', collaborationMode: stale, input: [{ type: 'text', text: GPT_AGAIN }], clientUserMessageId: randomUUID() }); await f.done(g2.turn.id); consumeNew(tid);
  const gptCall2 = f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === PG).at(-1);
  assert.deepEqual([gptCall2.params.effort, gptCall2.params.collaborationMode.settings.reasoning_effort], ['medium', 'medium'], 'after the cold restart the actual Native request is still Medium in both fields');
  assert.equal(count(JSON.stringify(gptCall2.params), GPT_AGAIN), 1); assert.equal(count(JSON.stringify(gptCall2.params), CODEWORD), 0, 'no history is repeated'); assert.equal(gptCall2.params.input.length, 1);
  assert.equal(count(JSON.stringify(f.hosts.get(PG).thread.turns), GPT_REQUEST), 1, 'the earlier GPT task is on the host once and was never replayed');
  // the same bad mode with a level the model does not offer is still refused (nothing sent), the accepted Medium stays
  { const sent = f.calls.filter(c => c.method === 'turn/start').length; await assert.rejects(f.bridge.request('turn/start', { threadId: tid, model: 'gpt-test', effort: 'medium', collaborationMode: { ...stale, settings: { ...stale.settings, reasoning_effort: 'bogus' } }, input: [{ type: 'text', text: 'NEVER-SENT-7788' }], clientUserMessageId: randomUUID() }), /Unsupported effort bogus/); assert.equal(f.calls.filter(c => c.method === 'turn/start').length, sent); }
  // 4b. the person's extra hop AFTER GPT: back to OpenRouter (a new runtime again, from the GPT thread that carries everything), one turn there
  const OR_AGAIN = 'OPENROUTER-AGAIN-REQUEST-5527'; from = f.calls.length; await f.bridge.request('thread/settings/update', { threadId: tid, model: O }); const link2b = f.bridge.localResponses.readLink(tid), P2b = link2b.physicalId;
  assert.deepEqual([link2b.kind, link2b.connectionId, link2b.previous], ['custom', openrouter, [PG, P2, P1, tid]]); events = consumeNew(tid); announce = events.at(-1).params.threadSettings; assert.deepEqual(Object.keys(announce).sort(), SETTINGS_FIELDS); assert.equal(announce.model, O);
  wire = JSON.stringify(injected(from, P2b)); for (const mark of [CODEWORD, SECOND, answers[0], answers[1], CLAUDE_ANSWER, THIRD, GPT_REQUEST, answers[2], GPT_AGAIN, answers[3]]) assert.equal(count(wire, mark), 1, 'OpenRouter again, handed exactly once: ' + mark);
  const again = await f.send(tid, OR_AGAIN); await f.done(again.turn.id); consumeNew(tid); const orBytes = JSON.stringify(f.hosts.get(P2b).thread.turns);
  assert.equal(count(JSON.stringify(f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === P2b).at(-1).params), CODEWORD), 0, 'the history is the thread\'s own now');
  // 5. A FULL cold reopen (a new Bridge on the same state), the public open, and back to Qwen
  const logical = tid, beforeRestart = f.events.length; f.restart(); await prepare(); consumed = f.events.length; void beforeRestart;
  const read = await f.bridge.request('thread/read', { threadId: tid, includeTurns: true }); assert.equal(read.thread.id, logical); assert.equal(count(JSON.stringify(read.thread.turns), CODEWORD), 1, 'the reopened chat still shows the codeword once');
  assert.equal((await f.bridge.request('thread/resume', { threadId: tid })).thread.id, logical, 'the public open answers under the conversation ID'); consumeNew(tid);
  from = f.calls.length; await f.bridge.request('thread/settings/update', { threadId: tid, model: Q }); const link3 = f.bridge.localResponses.readLink(tid), P3 = link3.physicalId;
  assert.deepEqual([link3.logicalId, link3.kind, link3.connectionId, link3.previous], [tid, 'custom', qwen, [P2b, PG, P2, P1, tid]], 'the same conversation, back on Qwen, the whole chain kept');
  events = consumeNew(tid); announce = events.at(-1).params.threadSettings; assert.deepEqual(Object.keys(announce).sort(), SETTINGS_FIELDS); assert.equal(announce.model, Q); assert.equal(announce.modelProvider, 'bridge_custom_' + qwen);
  wire = JSON.stringify(injected(from, P3)); for (const mark of [CODEWORD, SECOND, answers[0], answers[1], CLAUDE_ANSWER, THIRD, GPT_REQUEST, answers[2], GPT_AGAIN, answers[3], OR_AGAIN, answers[4]]) assert.equal(count(wire, mark), 1, 'back on Qwen, handed exactly once: ' + mark);
  const back = await f.send(tid, BACK); await f.done(back.turn.id); const backCall = f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === P3).at(-1);
  assert.equal(count(JSON.stringify(backCall.params), BACK), 1); assert.equal(count(JSON.stringify(backCall.params), CODEWORD), 0, 'the history is the thread\'s own now, never repeated with the turn'); consumeNew(tid);
  // nothing private or invented ever reaches a model, no earlier thread is touched, and the desktop only ever knew the conversation ID
  const modelInput = f.calls.filter(c => ['thread/inject_items', 'turn/start'].includes(c.method)).map(c => JSON.stringify(c.params)).join('\n'); assert.doesNotMatch(modelInput, /New chat|Bridge tool host/, 'no private label or placeholder is model input');
  assert.equal(JSON.stringify(f.hosts.get(tid).thread.turns), originBytes, 'the first Qwen thread keeps its bytes'); assert.equal(JSON.stringify(f.hosts.get(P1).thread.turns), secondBytes, 'and so does the OpenRouter thread'); assert.equal(JSON.stringify(f.hosts.get(P2b).thread.turns), orBytes, 'and the second OpenRouter thread, left for Qwen');
  assert.ok(f.events.every(e => ![P1, P2, PG, P2b, P3].includes(e.params?.threadId) && ![P1, P2, PG, P2b, P3].includes(e.params?.thread?.id)), 'the physical IDs never reach the desktop');
});

test('picker (Bridge): a damaged link refuses a server request (an approval) for its known child BEFORE the desktop is asked; independent chats are still asked', async () => {
  const { f, tid, link } = await switched('gpt-test'), P = link.physicalId; f.bridge.localResponses.index(); // the process has seen the child under its conversation
  writeFileSync(f.bridge.localResponses.linkPath(tid), '{broken', { mode: 0o600 }); const asked = [];
  f.bridge.desktop.request = async (method, params) => { asked.push(params.threadId); return { decision: 'accept' }; };
  await assert.rejects(f.bridge.toolRequest('item/commandExecution/requestApproval', { threadId: P, turnId: 't', itemId: 'i', command: 'ls' }), { code: 'link_invalid' }); assert.deepEqual(asked, [], 'never forwarded as the raw physical chat');
  assert.deepEqual(await f.bridge.toolRequest('item/commandExecution/requestApproval', { threadId: 'someone-else', turnId: 't', itemId: 'j' }), { decision: 'accept' }); assert.deepEqual(asked, ['someone-else']);
  const before = f.events.length; f.bridge.emit('thread/started', { thread: { id: P } }); f.bridge.emit('thread/status/changed', { threadId: P, status: { type: 'idle' } }); assert.equal(f.events.length, before, 'and its notifications are withheld');
});

test('disabled, unknown and stale custom catalogs are omitted even with includeHidden; explicit refresh/re-enable changes only the next list', async () => {
  const r = root(), registry = new ProviderRegistry(r), f = fixture('openai', { connectionRoot: r });
  const a = await connection(registry), model = localModelId(a, 'endpoint-model');
  registry.create({ name: 'Never discovered', baseUrl: 'https://not-contacted.example.invalid/v1' });
  const listed = async () => (await f.bridge.request('model/list', { includeHidden: true })).data;
  assert.ok((await listed()).some(m => m.id === model));
  registry.enabled(a, false); assert.ok(!(await listed()).some(m => m.id === model));
  registry.enabled(a, true); assert.ok((await listed()).some(m => m.id === model));
  await assert.rejects(registry.refresh(a, catalog([], 503)));
  const stale = await listed(); assert.deepEqual(stale.map(m => m.id), ['gpt-test', 'gpt-other', 'haiku', 'sonnet']);
  await registry.refresh(a, catalog(['new-model'])); const fresh = await listed();
  assert.ok(!fresh.some(m => m.id === model)); assert.ok(fresh.some(m => m.id === localModelId(a, 'new-model')));
  assert.equal(registry.read(a).selected, null, 'a missing selection is not silently changed to a replacement');
});

test('native id/model collisions win without replacing rows/defaults or intercepting a returned native selection', async () => {
  const r = root(), registry = new ProviderRegistry(r), a = await connection(registry, 'A', ['one', 'two', 'three']);
  const first = localModelId(a, 'one'), second = localModelId(a, 'two'), third = localModelId(a, 'three');
  const existing = [{ ...nativeRow('gpt-test', true), id: first }, { ...nativeRow(second), id: 'native-row-id' }];
  const router = new ResponsesRouter({ root: r, native: { request: () => { throw new Error('must preserve native route'); } } });
  const merged = router.mergeModels(existing);
  assert.deepEqual(merged.models.slice(0, 2), existing); assert.deepEqual(merged.collisions, [first, second]);
  assert.deepEqual(merged.models.slice(2).map(m => m.id), [third]);
  for (const model of [first, second]) assert.equal(await router.request('thread/start', { model }, async () => 'native row'), 'native row');
});

test('corrupt provider store cannot remove the existing native/Claude catalog; no repair or hidden write occurs', async () => {
  const r = root(), registry = new ProviderRegistry(r), a = await connection(registry), f = fixture('openai', { connectionRoot: r });
  const path = join(r, 'responses-providers', a, 'local-responses.json'); writeFileSync(path, '{retained-invalid');
  const page = await f.bridge.request('model/list', {});
  assert.deepEqual(page.data.map(m => m.id), ['gpt-test', 'gpt-other', 'haiku', 'sonnet']);
  assert.equal(readFileSync(path, 'utf8'), '{retained-invalid');
  await assert.rejects(f.bridge.request('model/list', { limit: 0 }));
  await assert.rejects(f.bridge.request('model/list', { cursor: 'not-a-bridge-cursor' }));
});
