import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/fixture.mjs';
import { sessionNamespace } from '../sessions.mjs';

// The correlated mailbox between a GPT-first Codex chat and a Claude chat it created: question, wait, inbox, reply and the pointer on the
// parent's next turn. Synthetic app-server protocol proof (fixture host and fake SDK stream); not desktop or Mac evidence.
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const primary = () => fixture('openai', { coordinateNative: true });
const turnOn = (b, threadId, turnId) => b.nativeNotification('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
const turnOff = (b, threadId, turnId) => b.nativeNotification('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
const call = async (f, threadId, turnId, tool, args) => {
  const r = await f.bridge.toolRequest('item/tool/call', { namespace: sessionNamespace, threadId, turnId, callId: randomUUID(), tool, arguments: args });
  return r.success ? JSON.parse(r.contentItems[0].text) : { error: r.contentItems[0].text };
};
async function family() {
  const f = primary(), gate = deferred();
  const parent = (await f.bridge.request('thread/start', { cwd: f.statePath })).thread.id; await turnOn(f.bridge, parent, 'p1');
  f.controls.query = () => gate.promise; // the child's first Claude turn stays running until released
  const created = await call(f, parent, 'p1', 'manage', { operation: 'create', model: 'sonnet', text: 'Please look into X and ask if unclear.', requestId: 'create-request-0001' });
  const child = created.threadId; assert.ok(child, JSON.stringify(created));
  while (!f.bridge.active.get(child)) await new Promise(r => setTimeout(r, 5));
  const release = () => { gate.resolve(); f.controls.query = undefined; };
  // Teardown lets the child's turn settle (it saves its record) before the state directory is removed.
  const end = async () => { release(); for (let i = 0; i < 400 && f.bridge.active.has(child); i++) await new Promise(r => setTimeout(r, 5)); await new Promise(r => setTimeout(r, 20)); f.close(); };
  return { f, parent, child, childTurn: () => f.bridge.active.get(child)?.turn.id, release, end };
}

test('a question from the child ends the GPT parent\'s wait at once, is read once from the inbox, and a retry neither duplicates nor rewrites it', async () => {
  const { f, parent, child, childTurn, release, end } = await family(); try {
    const waiting = call(f, parent, 'p1', 'read', { operation: 'wait', threadId: child, timeoutMs: 10000 });
    await new Promise(r => setTimeout(r, 30));
    const asked = await call(f, child, childTurn(), 'mailbox', { operation: 'report', kind: 'question', text: 'Which branch should I use?', requestId: 'ask-branch-0001' });
    assert.deepEqual([asked.delivered, asked.duplicate], [true, false]);
    const woke = await waiting; assert.deepEqual([woke.timedOut, woke.unreadMessages], [false, 1], 'the wait returned on the question, before the child finished');
    assert.ok(f.bridge.active.get(child), 'the child is still running');
    assert.deepEqual(await call(f, child, childTurn(), 'mailbox', { operation: 'report', kind: 'question', text: 'Which branch should I use?', requestId: 'ask-branch-0001' }), { id: asked.id, delivered: true, duplicate: true });
    assert.match((await call(f, child, childTurn(), 'mailbox', { operation: 'report', kind: 'question', text: 'Something else', requestId: 'ask-branch-0001' })).error, /another message/);
    const box = await call(f, parent, 'p1', 'mailbox', { operation: 'inbox', ack: true });
    assert.deepEqual(box.data.map(m => [m.id, m.from, m.kind, m.text, m.read]), [[asked.id, child, 'question', 'Which branch should I use?', false]]);
    assert.match(box.note, /untrusted data/);
    assert.equal((await call(f, parent, 'p1', 'mailbox', { operation: 'inbox' })).data[0].read, true, 'acknowledged');
    const nativeTurns = f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === parent).length;
    assert.equal(nativeTurns, 0, 'reporting never started a parent turn');
  } finally { await end(); }
});

test('the GPT parent replies with send and the child continues with it; a result reported while the parent is idle reaches its next turn only as an untrusted pointer', async () => {
  const { f, parent, child, childTurn, release, end } = await family(); try {
    await call(f, child, childTurn(), 'mailbox', { operation: 'report', kind: 'question', text: 'Use main or dev?', requestId: 'ask-branch-0002' });
    release(); await f.wait(e => e.method === 'turn/completed' && e.params.threadId === child);
    const sent = await call(f, parent, 'p1', 'manage', { operation: 'send', threadId: child, requestId: 'reply-branch-0002', text: 'Use main.' });
    assert.ok(sent.turn?.id, JSON.stringify(sent)); await f.done(sent.turn.id);
    assert.equal(f.queries.at(-1).input[0].text, 'Use main.', 'the child continued with the parent\'s reply');
    await turnOff(f.bridge, parent, 'p1');
    const childTurnId = f.bridge.records.get(child).turns.at(-1).id; f.bridge.active.set(child, { turn: { id: 'c-hold' }, controller: new AbortController() });
    const done = await call(f, child, 'c-hold', 'mailbox', { operation: 'report', kind: 'result', text: 'SECRET-RESULT-TEXT: merged into main', requestId: 'result-0002' });
    f.bridge.active.delete(child); assert.ok(done.delivered); void childTurnId;
    const next = await f.bridge.request('turn/start', { threadId: parent, input: [{ type: 'text', text: 'what now?' }] });
    const sentNative = f.calls.filter(c => c.method === 'turn/start' && c.params.threadId === parent).at(-1).params;
    assert.equal(sentNative.additionalContext.bridge_session_mail.kind, 'untrusted');
    assert.match(sentNative.additionalContext.bridge_session_mail.value, /unread message\(s\) from chat\(s\) this chat created/);
    assert.doesNotMatch(JSON.stringify(sentNative.additionalContext), /SECRET-RESULT-TEXT/, 'a pointer, never the content'); void next;
  } finally { await end(); }
});

test('only a created chat can report, only to its creator; creation depth is bounded', async () => {
  const { f, parent, child, childTurn, release, end } = await family(); try {
    assert.match((await call(f, parent, 'p1', 'mailbox', { operation: 'report', kind: 'result', text: 'x', requestId: 'not-created-0001' })).error, /Only a chat created by another chat/);
    assert.match((await call(f, child, childTurn(), 'mailbox', { operation: 'report', kind: 'command', text: 'x', requestId: 'bad-kind-00001' })).error, /Invalid|kind/);
    assert.match((await call(f, child, childTurn(), 'mailbox', { operation: 'report', kind: 'result', text: 'x', requestId: 'with-thread-01', threadId: parent })).error, /does not take threadId/);
    const record = f.bridge.records.get(child); record.sessionCreate.depth = 2;
    assert.match((await call(f, child, childTurn(), 'manage', { operation: 'create', model: 'sonnet', text: 'deeper', requestId: 'too-deep-00001' })).error, /levels deep/);
  } finally { await end(); }
});

test('a created child gets exactly its GPT parent\'s desktop tools, discovers them, and its call is relayed to the desktop under the child\'s own thread; an unknown tool set is said so', async () => {
  const f = primary(), gate = deferred(), relayed = [];
  f.bridge.desktop.request = async (method, params) => { relayed.push({ method, params }); return { success: true, contentItems: [{ type: 'inputText', text: 'queued: opened example page' }] }; };
  const browser = { type: 'function', name: 'browser_open', description: 'Open a page in the in-app browser', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } };
  try {
    const parent = (await f.bridge.request('thread/start', { cwd: f.statePath, dynamicTools: [browser] })).thread.id; await turnOn(f.bridge, parent, 'p1');
    f.controls.query = () => gate.promise;
    const created = await call(f, parent, 'p1', 'manage', { operation: 'create', model: 'sonnet', text: 'Open the test page.', requestId: 'create-tools-0001' });
    assert.deepEqual(created.desktopTools, ['browser_open']); assert.equal(created.desktopToolsNote, undefined);
    const child = f.bridge.records.get(created.threadId);
    assert.deepEqual(child.options.dynamicTools.map(t => t.name), ['browser_open', sessionNamespace], 'the parent\'s desktop tool and Bridge\'s namespace, nothing else');
    const { discover } = await import('../capabilities.mjs');
    const found = await discover({ request: async (m, p) => m === 'mcpServerStatus/list' ? { data: [] } : f.bridge.native.request(m, p) }, child);
    assert.ok(found.some(t => t.route?.tool === 'browser_open' || t.name?.includes('browser_open')), 'the child discovers it');
    while (!f.bridge.active.get(child.thread.id)) await new Promise(r => setTimeout(r, 5));
    const out = await f.bridge.toolRequest('item/tool/call', { threadId: child.thread.id, turnId: f.bridge.active.get(child.thread.id).turn.id, callId: 'c1', tool: 'browser_open', arguments: { url: 'https://example.com/' } });
    assert.deepEqual(relayed.map(r => [r.method, r.params.threadId, r.params.tool]), [['item/tool/call', child.thread.id, 'browser_open']]);
    assert.equal(out.contentItems[0].text, 'queued: opened example page', 'the desktop\'s own answer, unchanged (queued is not "visible")');
    // A caller Bridge did not see start (its tools unknown) gives its child none, and the result says so.
    f.bridge.nativeCallers.get(parent).options.dynamicTools = undefined; gate.resolve(); f.controls.query = undefined;
    for (let i = 0; i < 400 && f.bridge.active.has(child.thread.id); i++) await new Promise(r => setTimeout(r, 5));
    const bare = await call(f, parent, 'p1', 'manage', { operation: 'create', model: 'sonnet', text: 'Second.', requestId: 'create-tools-0002' });
    assert.deepEqual(bare.desktopTools, []); assert.match(bare.desktopToolsNote, /not known to Bridge/);
    assert.deepEqual(f.bridge.records.get(bare.threadId).options.dynamicTools.map(t => t.name), [sessionNamespace]);
    for (let i = 0; i < 400 && f.bridge.active.has(bare.threadId); i++) await new Promise(r => setTimeout(r, 5));
  } finally { gate.resolve(); await new Promise(r => setTimeout(r, 30)); f.close(); }
});
