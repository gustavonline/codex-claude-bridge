import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/fixture.mjs';
import { sessionNamespace } from '../sessions.mjs';
import { harnessModelId } from '../plugins/codex-claude/home/harnesses.mjs';

// An Antigravity chat in Bridge's core with a scripted session in place of agy (offline): picker rows, start, streamed turns, resume,
// cancel, refusals and the shared mailbox. The live proof is test/live-antigravity-child.test.mjs (opt-in).
const MODEL = harnessModelId('antigravity', 'google', 'gemini-x');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function agy(f, { hold } = {}) {
  const opened = [], cancelled = [];
  f.bridge.antigravityCatalog = async () => ({ models: [{ id: MODEL, model: 'gemini-x', name: 'Gemini X' }], levels: ['low', 'high'] });
  f.bridge.antigravityRuntime = () => ({ executable: '/opt/agy', home: '/home/x' });
  f.bridge.antigravityAgent = () => 'bridge-mcp-000000000000';
  f.bridge.antigravityOpen = async opts => {
    const sessionId = opts.resume ?? 'agy-' + randomUUID(); opened.push({ resume: opts.resume ?? null, sessionId });
    return { sessionId, catalog: { models: [{ id: 'gemini-x' }], levels: ['low', 'high'] }, configure: async () => {},
      prompt: async text => { opts.onEvent({ type: 'text', text: 'echo:' }); opts.onEvent({ type: 'text', text: text.split('\n').at(-1) }); if (hold) { const r = await hold.promise; return r; } return { stopReason: 'end_turn' }; },
      cancel: () => { cancelled.push(sessionId); hold?.resolve({ stopReason: 'cancelled' }); }, close: async () => ({ state: 'exited' }) };
  };
  return { opened, cancelled };
}
const start = async f => (await f.bridge.request('thread/start', { model: MODEL, cwd: f.statePath })).thread.id;

test('qualified Antigravity models are offered under their routes; nothing is offered without a catalog', async () => {
  const f = fixture(); try {
    assert.ok(!(await f.bridge.request('model/list', {})).data.some(m => m.id.startsWith('bridge-harness/')), 'no catalog, no rows');
    f.bridge.agyCatalogReady = { models: [{ id: MODEL, model: 'gemini-x', name: 'Gemini X' }], levels: ['low', 'high'] };
    const row = (await f.bridge.request('model/list', {})).data.find(m => m.id === MODEL);
    assert.deepEqual([row.displayName, row.isDefault, row.defaultReasoningEffort, row.supportedReasoningEfforts.map(e => e.reasoningEffort)], ['Gemini X · Antigravity', false, 'low', ['low', 'high']]);
  } finally { f.close(); }
});

test('an Antigravity chat starts on its model, streams a turn into Codex items, and its next turn resumes the same agy session', async () => {
  const f = fixture(), a = agy(f); try {
    const id = await start(f), record = f.bridge.records.get(id);
    assert.deepEqual([record.provider, record.model, record.harnessModel], ['antigravity', MODEL, 'gemini-x']);
    const one = (await f.send(id, 'first')).turn; await f.done(one.id);
    const two = (await f.send(id, 'second')).turn; await f.done(two.id);
    const turns = f.bridge.records.get(id).turns;
    assert.deepEqual(turns.map(t => t.status), ['completed', 'completed']);
    assert.equal(turns[1].items.find(i => i.type === 'agentMessage').text, 'echo:second');
    assert.deepEqual(a.opened.map(o => o.resume), [null, a.opened[0].sessionId], 'the second turn resumed the first turn\'s session');
    assert.ok(f.events.some(e => e.method === 'item/agentMessage/delta' && e.params.threadId === id), 'streamed');
    assert.equal(f.queries.length, 0, 'never the Claude SDK');
  } finally { f.close(); }
});

test('Stop cancels the agy prompt and ends the turn interrupted', async () => {
  const hold = deferred(), f = fixture(), a = agy(f, { hold }); try {
    const id = await start(f), turn = (await f.send(id, 'long')).turn;
    while (!a.opened.length) await new Promise(r => setTimeout(r, 5)); await new Promise(r => setTimeout(r, 20));
    await f.bridge.request('turn/interrupt', { threadId: id, turnId: turn.id }); await f.done(turn.id);
    assert.equal(f.bridge.records.get(id).turns[0].status, 'interrupted'); assert.equal(a.cancelled.length >= 1, true);
  } finally { hold.resolve({ stopReason: 'cancelled' }); f.close(); }
});

test('what an Antigravity chat cannot do is refused with the reason and changes nothing', async () => {
  const f = fixture(); agy(f); try {
    const id = await start(f), first = (await f.send(id, 'x')).turn; await f.done(first.id);
    const before = JSON.stringify(f.bridge.records.get(id));
    for (const [method, params] of [['thread/revert', { beforeTurnId: first.id }], ['thread/fork', {}], ['turn/steer', { expectedTurnId: first.id, input: [{ type: 'text', text: 's' }] }],
      ['thread/settings/update', { model: 'gpt-test' }], ['turn/start', { model: 'sonnet', input: [{ type: 'text', text: 'm' }] }]])
      await assert.rejects(f.bridge.request(method, { threadId: id, ...params }), e => /Antigravity|harness|keeps its model|not available/.test(e.message), method);
    await assert.rejects(f.bridge.request('turn/start', { threadId: id, input: [{ type: 'image', url: 'data:image/png;base64,AA==' }] }), /text messages/);
    assert.equal(JSON.stringify(f.bridge.records.get(id)), before, 'nothing changed');
  } finally { f.close(); }
});

test('the shared mailbox works from an Antigravity child exactly as from a Claude child', async () => {
  const hold = deferred(), f = fixture('openai', { coordinateNative: true }); agy(f, { hold }); try {
    const parent = (await f.bridge.request('thread/start', { cwd: f.statePath })).thread.id;
    await f.bridge.nativeNotification('turn/started', { threadId: parent, turn: { id: 'p1', status: 'inProgress' } });
    const call = async (threadId, turnId, tool, args) => { const r = await f.bridge.toolRequest('item/tool/call', { namespace: sessionNamespace, threadId, turnId, callId: randomUUID(), tool, arguments: args }); return r.success ? JSON.parse(r.contentItems[0].text) : { error: r.contentItems[0].text }; };
    const created = await call(parent, 'p1', 'manage', { operation: 'create', model: 'antigravity/gemini-x', text: 'Ask me a question.', requestId: 'agy-child-000001' });
    assert.ok(created.threadId, JSON.stringify(created)); assert.equal(f.bridge.records.get(created.threadId).provider, 'antigravity');
    while (!f.bridge.active.get(created.threadId)) await new Promise(r => setTimeout(r, 5));
    const asked = await call(created.threadId, f.bridge.active.get(created.threadId).turn.id, 'mailbox', { operation: 'report', kind: 'question', text: 'Which file?', requestId: 'agy-ask-0000001' });
    assert.equal(asked.delivered, true);
    assert.deepEqual((await call(parent, 'p1', 'mailbox', { operation: 'inbox' })).data.map(m => [m.kind, m.text]), [['question', 'Which file?']]);
  } finally { hold.resolve({ stopReason: 'end_turn' }); await new Promise(r => setTimeout(r, 50)); f.close(); }
});

test('Gemini models join the same library and saved slots: a saved one is offered, an unselected one stays hidden, and a cold catalog keeps the selection as unavailable', async () => {
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { prepareProviderHome, providerControls } = await import('../plugins/codex-claude/home/provider-controls.mjs');
  const { ProviderRegistry } = await import('../plugins/codex-claude/home/providers.mjs');
  const p = prepareProviderHome(join(mkdtempSync(join(tmpdir(), 'bridge-agy-slots-')), 'scope')), registry = new ProviderRegistry(p.state);
  const OTHER = harnessModelId('antigravity', 'google', 'gemini-y'), ready = { models: [{ id: MODEL, model: 'gemini-x', name: 'Gemini X' }, { id: OTHER, model: 'gemini-y', name: 'Gemini Y' }], levels: ['low', 'high'] };
  const f = fixture('openai', { connectionRoot: p.state }); f.bridge.agyCatalogReady = ready;
  try {
    await f.bridge.request('model/list', {});
    const catalog = registry.pickerCatalog(), agy = catalog.models.filter(m => m.kind === 'antigravity');
    assert.deepEqual(agy.map(m => [m.id, m.available, m.defaultVisible]), [[MODEL, true, false], [OTHER, true, false]], 'in the library, available, never shown by default');
    registry.savePickerSlots(['gpt-test', MODEL], registry.slots().revision, catalog.revision);
    let ids = (await f.bridge.request('model/list', {})).data.map(m => m.id);
    assert.ok(ids.includes(MODEL) && !ids.includes(OTHER), 'the saved Gemini model is offered, the unselected one is hidden');
    f.restart(); f.bridge.agyCatalogReady = ready;
    ids = (await f.bridge.request('model/list', {})).data.map(m => m.id); assert.ok(ids.includes(MODEL) && !ids.includes(OTHER), 'and after a restart');
    f.restart(); f.bridge.agyCatalogReady = null; f.bridge.antigravityRuntime = () => null; // cold: not loaded (or turned off)
    ids = (await f.bridge.request('model/list', {})).data.map(m => m.id); assert.ok(!ids.includes(MODEL), 'not offered while it cannot run');
    assert.deepEqual(registry.pickerCatalog().models.filter(m => m.kind === 'antigravity').map(m => [m.id, m.available]), [[MODEL, false], [OTHER, false]], 'kept in the library as unavailable');
    assert.deepEqual(registry.slots().models, ['gpt-test', MODEL], 'the saved selection is never rewritten');
    // Home shows it as a connected provider while it is on, its models unavailable while the catalog is cold.
    const { setHarnessEnabled } = await import('../plugins/codex-claude/home/harnesses.mjs');
    const card = () => providerControls(p.bindingPath).snapshot().providers.find(x => x.kind === 'antigravity');
    assert.deepEqual([card().enabled, card().catalogState, card().models.every(m => m.available === false)], [false, 'stale', true]);
    setHarnessEnabled(p.state, 'antigravity', true, { platform: 'linux', find: () => process.execPath });
    assert.equal(card().enabled, true); assert.ok(!providerControls(p.bindingPath).snapshot().harnesses.some(h => h.id === 'antigravity'), 'no second row while it is a connected card');
  } finally { f.close(); }
});
