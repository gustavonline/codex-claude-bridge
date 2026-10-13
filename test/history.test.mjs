import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../bridge.mjs';
import { sessionHistory } from '../history.mjs';

const user = (text, id = text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
const turn = (id, text = id) => ({ id, status: 'completed', items: [user(text)] });
const id = '66666666-6666-4666-8666-666666666666';

test('Claude checkpoint includes the last tool/structured-output entry; forks keep the exact prefix and original session', async () => {
  const rows = [{ type: 'assistant', uuid: 'tool-use', parentUuid: 'prompt' },
    { type: 'user', uuid: 'tool-result', parentUuid: 'tool-use' },
    { type: 'attachment', uuid: 'structured-output', parentUuid: 'tool-result' }];
  const calls = [];
  const history = sessionHistory({ read: async (session, cwd) => {
    assert.equal(session, 'original'); assert.equal(cwd, '/workspace'); return rows;
  }, fork: async (...args) => { calls.push(args); return { sessionId: 'branch' }; } });
  const record = { thread: { cwd: '/workspace' }, claudeSessionId: 'original', turns: [turn('a'), turn('b')] };
  record.turns[0].claudeCheckpoint = await history.checkpoint(record);
  assert.deepEqual(record.turns[0].claudeCheckpoint, { sessionId: 'original', messageId: 'structured-output' });
  assert.equal(await history.before(record, 1), 'branch');
  assert.deepEqual(calls, [['original', { dir: '/workspace', upToMessageId: 'structured-output' }]]);
  assert.equal(record.claudeSessionId, 'original');
  assert.equal(await history.before(record, 0), undefined);
  record.turns[0].claudeCheckpoint = null;
  assert.equal(await history.before(record, 1), undefined);
  assert.equal(calls.length, 1);
});

test('older chats require a uniquely matched SDK prompt, including a complete predecessor, before editing', async () => {
  const prompt = { type: 'user', uuid: 'prompt-b', parentUuid: 'last-kept-tool-result', message: { content: [{ type: 'text', text: 'b' }] } };
  let rows = [prompt], forks = 0;
  const history = sessionHistory({ read: async () => rows, fork: async (_id, options) => {
    assert.equal(options.upToMessageId, 'last-kept-tool-result'); forks++; return { sessionId: 'branch' };
  } });
  const record = { thread: { cwd: '/workspace' }, claudeSessionId: 'original', turns: [turn('a'), turn('b')] };
  assert.equal(await history.before(record, 1), 'branch');
  rows = [prompt, { ...prompt, uuid: 'ambiguous' }];
  await assert.rejects(history.before(record, 1), /Cannot identify/);
  record.turns[1].claudePromptId = 'prompt-b';
  assert.equal(await history.before(record, 1), 'branch');
  rows = [{ ...prompt, parentUuid: null }];
  await assert.rejects(history.before(record, 1), /Cannot identify/);
  assert.equal(forks, 2);
});

test('edit truncates bridge history atomically, survives restart, and never sends Claude IDs to native revert', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'bridge-revert-test-'));
  const events = [], nativeCalls = [];
  let fail = false;
  const native = { request: async (method, params) => { nativeCalls.push(method); return { native: true }; } };
  const history = { before: async (record, index) => {
    if (fail) throw new Error('SDK fork failed');
    assert.equal(record.turns[index].id, 'b'); return 'branch';
  } };
  const make = () => new Bridge({ native, desktop: { notify: (method, params) => events.push({ method, params }) }, statePath, history });
  try {
    const bridge = make();
    const record = { thread: { id, cwd: statePath, preview: 'a' }, options: {}, model: 'opus',
      claudeSessionId: 'original', turns: [turn('a'), turn('b'), turn('c')], loadedTools: ['stale-schema'] };
    bridge.records.set(id, record); bridge.save(record);
    fail = true;
    await assert.rejects(bridge.request('thread/revert', { threadId: id, beforeTurnId: 'b' }), /SDK fork failed/);
    assert.equal(bridge.records.get(id), record); assert.equal(events.length, 0);
    assert.equal(JSON.parse(readFileSync(join(statePath, `${id}.json`))).turns.length, 3);
    fail = false;
    const result = await bridge.request('thread/revert', { threadId: id, beforeTurnId: 'b' });
    assert.equal(result.thread.id, id); assert.deepEqual(result.thread.turns, []);
    assert.equal(result.turnsBackwardsCursor, 'at:a');
    assert.deepEqual(bridge.records.get(id).turns.map(t => t.id), ['a']);
    assert.equal(bridge.records.get(id).claudeSessionId, 'branch');
    assert.deepEqual(bridge.records.get(id).loadedTools, []);
    assert.deepEqual(nativeCalls, []);
    assert.deepEqual(events, [{ method: 'thread/reverted', params: { threadId: id } }]);
    const restarted = make();
    assert.equal(restarted.records.get(id).claudeSessionId, 'branch');
    const page = await restarted.request('thread/turns/list', { threadId: id, cursor: result.turnsBackwardsCursor });
    assert.deepEqual(page.data.map(t => t.id), ['a']);
    await assert.rejects(restarted.request('thread/revert', { threadId: id, beforeTurnId: 'missing' }), /Turn not found/);
    assert.equal((await restarted.request('thread/revert', { threadId: 'gpt-thread', beforeTurnId: 'native-turn' })).native, true);
    assert.deepEqual(nativeCalls, ['thread/revert']);
  } finally { rmSync(statePath, { recursive: true, force: true }); }
});

test('editing is exclusive with active turns, starting turns and concurrent edits', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'bridge-revert-lock-'));
  let finish;
  const bridge = new Bridge({ native: {}, desktop: { notify() {} }, statePath,
    history: { before: () => new Promise(resolve => { finish = resolve; }) } });
  const record = { thread: { id, cwd: statePath }, turns: [turn('a')], options: {} };
  bridge.records.set(id, record);
  try {
    bridge.active.set(id, {});
    await assert.rejects(bridge.request('thread/revert', { threadId: id, beforeTurnId: 'a' }), /Interrupt/);
    bridge.active.clear(); bridge.starting.add(id);
    await assert.rejects(bridge.request('thread/revert', { threadId: id, beforeTurnId: 'a' }), /Interrupt/);
    bridge.starting.clear();
    const pending = bridge.request('thread/revert', { threadId: id, beforeTurnId: 'a' });
    for (const method of ['thread/revert', 'turn/start', 'thread/resume', 'thread/archive'])
      await assert.rejects(bridge.request(method, { threadId: id }), /Wait for the history edit/);
    finish(undefined); await pending;
    assert.equal(bridge.reverting.size, 0);
  } finally { rmSync(statePath, { recursive: true, force: true }); }
});

test('resend after a failed first turn starts clean in the same thread and preserves created files', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'bridge-resend-test-'));
  let finish, observed;
  const completed = new Promise(resolve => { finish = resolve; });
  const native = { request: async method => method === 'config/read' ? { config: {} } : {} };
  const bridge = new Bridge({ native, desktop: { notify: method => { if (method === 'turn/completed') finish(); } }, statePath,
    getModels: async () => [{ value: 'opus' }], history: { ...sessionHistory(), checkpoint: async () => ({ sessionId: 'new-session', messageId: 'tail' }) },
    runQuery: ({ record, input, promptId }) => {
      observed = { session: record.claudeSessionId, input, promptId };
      const stream = (async function* () { yield { type: 'result', subtype: 'success', session_id: 'new-session' }; })();
      stream.close = () => {}; return stream;
    } });
  try {
    const file = join(statePath, 'created.txt'); writeFileSync(file, 'keep');
    const record = { thread: { id, cwd: statePath, preview: 'wrong' }, model: 'opus', effort: 'none', options: {},
      claudeSessionId: 'old-session', turns: [{ ...turn('failed', 'wrong'), status: 'failed' }] };
    bridge.records.set(id, record); bridge.loaded.add(id);
    await bridge.request('thread/revert', { threadId: id, beforeTurnId: 'failed' });
    await bridge.request('turn/start', { threadId: id, input: [{ type: 'text', text: 'correct' }] });
    await completed;
    assert.equal(observed.session, undefined);
    assert.deepEqual(observed.input, [{ type: 'text', text: 'correct' }]);
    assert.match(observed.promptId, /^[a-f\d-]{36}$/);
    const saved = bridge.records.get(id);
    assert.equal(saved.turns.length, 1); assert.equal(saved.claudeSessionId, 'new-session');
    assert.equal(saved.thread.preview, 'correct');
    const visible = (await bridge.request('thread/read', { threadId: id, includeTurns: true })).thread.turns[0];
    assert.equal(visible.claudeCheckpoint, undefined); assert.equal(visible.claudePromptId, undefined);
    assert.equal(readFileSync(file, 'utf8'), 'keep');
  } finally { rmSync(statePath, { recursive: true, force: true }); }
});
