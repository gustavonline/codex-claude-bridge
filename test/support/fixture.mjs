import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../../bridge.mjs';

const text = value => [{ type: 'text', text: value }];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
export function fixture(configuredProvider = 'openai') {
  const statePath = mkdtempSync(join(tmpdir(), 'bridge-expanded-'));
  const hosts = new Map(), calls = [], events = [], queries = [], checkpoints = [], controls = {};
  let bridge;
  const nativeModel = model => ({ id: model, model, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] });
  const response = host => ({ thread: structuredClone(host.thread), model: host.settings.model, modelProvider: host.provider,
    sandbox: host.settings.sandboxPolicy, approvalPolicy: 'never', instructionSources: [], disabledPluginIds: [] });
  const native = { request: async (method, p) => {
    calls.push({ method, params: structuredClone(p) });
    if (controls.native) await controls.native(method, p);
    let host = hosts.get(p.threadId);
    if (method === 'config/read') return { config: { model: 'gpt-test', model_provider: configuredProvider } };
    if (method === 'model/list') return { data: [nativeModel('gpt-test'), nativeModel('gpt-other')] };
    if (method === 'thread/start') {
      const id = randomUUID(); host = { thread: { id, cwd: p.cwd ?? statePath, ephemeral: p.ephemeral ?? false, status: { type: 'idle' }, turns: [] }, queue: [], provider: p.modelProvider ?? configuredProvider,
        settings: { model: p.model ?? 'gpt-test', effort: 'low', sandboxPolicy: { type: 'readOnly' }, approvalPolicy: 'never' } };
      hosts.set(id, host); return response(host);
    }
    if (method === 'thread/resume') { if (p.model) host.settings.model = p.model; if (p.modelProvider) host.provider = p.modelProvider; return response(host); }
    if (method === 'thread/settings/update') {
      Object.assign(host.settings, p);
      await bridge.nativeNotification('thread/settings/updated', { threadId: p.threadId, threadSettings: structuredClone(host.settings) }); return {};
    }
    if (method === 'thread/unsubscribe') { await bridge.nativeNotification('thread/closed', { threadId: p.threadId }); return { status: 'unsubscribed' }; }
    if (method === 'thread/turns/list') return { data: structuredClone(host.thread.turns) };
    if (method === 'thread/items/list') return { data: host.thread.turns.find(t => t.id === p.turnId).items.map(item => ({ turnId: p.turnId, item: structuredClone(item) })) };
    if (method === 'thread/queue/list') return { data: structuredClone(host.queue) };
    if (method === 'thread/queue/delete') { host.queue = host.queue.filter(q => q.id !== p.queuedSubmissionId); return { deleted: true }; }
    if (method === 'thread/revert') {
      const index = host.thread.turns.findIndex(t => t.id === p.beforeTurnId); assert.ok(index >= 0);
      host.thread.turns.splice(index);
      setImmediate(() => bridge.nativeNotification('thread/reverted', { threadId: p.threadId }));
      return { thread: structuredClone(host.thread) };
    }
    if (method === 'thread/fork') {
      const copy = structuredClone(host); copy.thread.id = randomUUID(); copy.thread.forkedFromId = p.threadId;
      copy.provider = p.modelProvider; copy.settings.model = p.model; hosts.set(copy.thread.id, copy); return response(copy);
    }
    if (method === 'turn/start') {
      const turn = { id: randomUUID(), status: 'inProgress', items: [], error: null };
      host.thread.turns.push(turn);
      // Exercise notifications arriving before the RPC's response.
      await bridge.nativeNotification('turn/started', { threadId: p.threadId, turn: structuredClone(turn) });
      setImmediate(async () => {
        turn.items.push({ type: 'userMessage', id: randomUUID(), content: structuredClone(p.input) });
        turn.items.push({ type: 'agentMessage', id: randomUUID(), text: 'NATIVE RESULT' });
        for (const item of turn.items) await bridge.nativeNotification('item/completed', { threadId: p.threadId, turnId: turn.id, item });
        turn.status = 'completed';
        await bridge.nativeNotification('turn/completed', { threadId: p.threadId, turn: { ...turn, items: [], itemsView: 'notLoaded' } });
      });
      return { turn: { ...turn, items: [] } };
    }
    return {};
  } };
  const build = () => new Bridge({ native, statePath, desktop: { notify: (method, params) => events.push({ method, params: structuredClone(params) }) },
    getModels: async () => [{ value: 'haiku' }, { value: 'sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }],
    history: { checkpoint: async record => ({ sessionId: record.claudeSessionId, messageId: record.turns.at(-1).id }),
      before: async (record, count) => { checkpoints.push({ id: record.thread.id, count }); return count ? randomUUID() : undefined; } },
    runQuery: args => {
      queries.push({ ...args, record: structuredClone(args.record) });
      const stream = (async function* () {
        yield { type: 'system', session_id: args.record.claudeSessionId ?? randomUUID() };
        if (controls.query) await controls.query(args);
        yield { type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'CLAUDE RESULT' }] } };
        yield { type: 'result', subtype: 'success' };
      })(); stream.close = () => {}; return stream;
    } });
  bridge = build();
  const f = { get bridge() { return bridge; }, statePath, hosts, calls, events, queries, checkpoints, controls,
    start: async (model = 'haiku', options = {}) => (await bridge.request('thread/start', { model, cwd: statePath, ...options })).thread.id,
    send: (id, value = 'hello', params = {}) => bridge.request('turn/start', { threadId: id, input: text(value), clientUserMessageId: randomUUID(), ...params }),
    async wait(predicate) {
      for (let i = 0; i < 200; i++) { const event = events.find(predicate); if (event) return event; await new Promise(r => setTimeout(r, 5)); }
      throw new Error('Expected event not observed');
    },
    done: id => f.wait(e => e.method === 'turn/completed' && e.params.turn.id === id),
    restart: () => { bridge = build(); },
    close: () => rmSync(statePath, { recursive: true, force: true }),
  }; return f;
}
