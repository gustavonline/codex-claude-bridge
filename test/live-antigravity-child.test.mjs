import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/fixture.mjs';
import { sessionNamespace } from '../sessions.mjs';

// LIVE, explicit opt-in (BRIDGE_LIVE_ANTIGRAVITY=1, an existing agy login, Linux with bubblewrap): a GPT-first Codex chat creates a Gemini
// child through Antigravity, the child asks a question through the mailbox, the parent's wait wakes, the parent replies, and the child continues
// in the same agy session. The Codex host is the test fixture (no Codex model is called); Gemini runs for real inside the process boundary.
const live = process.env.BRIDGE_LIVE_ANTIGRAVITY === '1';
const call = async (f, threadId, turnId, tool, args) => {
  const r = await f.bridge.toolRequest('item/tool/call', { namespace: sessionNamespace, threadId, turnId, callId: randomUUID(), tool, arguments: args });
  return r.success ? JSON.parse(r.contentItems[0].text) : { error: r.contentItems[0].text };
};
const settle = async (f, id, ms = 240_000) => { for (const end = Date.now() + ms; Date.now() < end && f.bridge.active.has(id);) await new Promise(r => setTimeout(r, 100)); };

test('GPT-first chat → Gemini child question via mailbox → parent reply → child continues in context', { skip: !live && 'set BRIDGE_LIVE_ANTIGRAVITY=1 to run it', timeout: 600_000 }, async () => {
  const f = fixture('openai', { coordinateNative: true }), report = {};
  try {
    const parent = (await f.bridge.request('thread/start', { cwd: f.statePath })).thread.id;
    await f.bridge.nativeNotification('turn/started', { threadId: parent, turn: { id: 'p1', status: 'inProgress' } });
    const models = await call(f, parent, 'p1', 'read', { operation: 'models' });
    const gemini = models.models.find(m => m.model === 'antigravity/gemini-3.8-flash'); assert.ok(gemini, JSON.stringify(models));
    const created = await call(f, parent, 'p1', 'manage', { operation: 'create', model: gemini.model, requestId: 'live-agy-child-0001',
      text: 'Before doing anything else, ask the chat that created you which colour to use: find the codex_bridge_sessions mailbox tool with find_tools and call it with operation report, kind question, requestId ask-colour-0001 and the text "Which colour should I use?". Then reply WAITING and stop.' });
    assert.ok(created.threadId, JSON.stringify(created)); const child = created.threadId; report.child = child;
    const waited = await call(f, parent, 'p1', 'read', { operation: 'wait', threadId: child, timeoutMs: 60_000 });
    await settle(f, child);
    const inbox = await call(f, parent, 'p1', 'mailbox', { operation: 'inbox', ack: true });
    report.waited = { timedOut: waited.timedOut, unread: waited.unreadMessages }; report.inbox = inbox.data?.map(m => ({ kind: m.kind, text: m.text }));
    assert.ok(inbox.data?.some(m => m.kind === 'question' && /colou?r/i.test(m.text)), JSON.stringify(report));
    const record = f.bridge.records.get(child); report.firstTurn = record.turns.at(-1).status; report.tools = record.turns.at(-1).items.filter(i => i.type === 'mcpToolCall').map(i => `${i.tool}:${i.status}`);
    const sent = await call(f, parent, 'p1', 'manage', { operation: 'send', threadId: child, requestId: 'live-agy-reply-0001', text: 'Use teal. Reply with only the colour you were told, in lower case.' });
    assert.ok(sent.turn?.id, JSON.stringify(sent)); await settle(f, child);
    const last = f.bridge.records.get(child).turns.at(-1); report.reply = last.items.filter(i => i.type === 'agentMessage').map(i => i.text).join(' ').trim().slice(0, 200); report.secondTurn = last.status;
    assert.equal(last.status, 'completed'); assert.match(report.reply, /teal/i);
    assert.equal(f.bridge.records.get(child).acpSessionId, record.acpSessionId, 'the same agy session continued');
    console.log('LIVE REPORT', JSON.stringify(report));
  } finally { for (const id of f.bridge.active.keys()) f.bridge.active.get(id)?.controller.abort(); await new Promise(r => setTimeout(r, 500)); f.close(); }
});
