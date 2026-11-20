import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTransfer, visibleTurns } from '../continuity.mjs';
import { runtimeHandoff } from '../runtime-handoff.mjs';

// The exact native fork copies the source provider's opaque encrypted reasoning into the target (lead receipt
// NATIVE-OPAQUE-CROSS-PROVIDER-REVIEW-NOV9.json: 17 pass, 1 red). Continuation therefore never forks: the new
// thread receives only plain visible items. These checks cover everything that is delivered to a target.
const OPAQUE = 'gAAAAA-OPAQUE-ENCRYPTED-REASONING-7f3a';
const history = [{ id: 't1', status: 'completed', encrypted_content: OPAQUE, items: [
  { type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'visible question' }] },
  { type: 'reasoning', id: 'r1', summary: ['s'], content: ['c'], encrypted_content: OPAQUE },
  { type: 'contextCompaction', id: 'k1', encrypted_content: OPAQUE },
  { type: 'agentMessage', id: 'a1', text: 'visible answer', encrypted_content: OPAQUE },
  { type: 'mcpToolCall', id: 'm1', server: 'srv', tool: 'tool', status: 'completed', arguments: {}, result: { content: [{ type: 'text', text: 'tool says hi' }], structuredContent: { encrypted_flag: 'VISIBLE-BUSINESS-VALUE' } }, error: null, encrypted_content: OPAQUE, encrypted_function_args: [OPAQUE] },
] }];

test('no value of an opaque or provider-private field appears anywhere a target can see', () => {
  const transfer = buildTransfer(history);
  assert.doesNotMatch(JSON.stringify(transfer.items), new RegExp(OPAQUE));
  assert.doesNotMatch(JSON.stringify(transfer.turns), new RegExp(OPAQUE), 'nor in the carried copy shown in the new chat');
  assert.match(JSON.stringify(transfer.items), /visible question[\s\S]*visible answer[\s\S]*tool says hi[\s\S]*VISIBLE-BUSINESS-VALUE/, 'the visible conversation and tool result, including its own JSON keys, are intact and in order');
  assert.deepEqual([transfer.report.omitted.reasoning, transfer.report.omitted.contextCompaction], [1, 1]);
});

test('the source history object is not modified by building a transfer', () => {
  const before = JSON.stringify(history); buildTransfer(history); visibleTurns(history); assert.equal(JSON.stringify(history), before);
});

test('what an adapter is asked to deliver contains only plain message items', async () => {
  const delivered = [], calls = [];
  const adapter = {
    start: async () => ({ thread: { id: 'new' }, model: 'm', modelProvider: 'p', reasoningEffort: null, cwd: '/w', sandbox: { type: 'readOnly' }, approvalPolicy: 'never' }),
    confirm: () => true, permissionsKept: () => true, deliver: async (id, items) => { delivered.push(...items); calls.push('deliver'); }, publish: async () => calls.push('publish'),
    archive: async () => true, receipt: () => {},
  };
  await runtimeHandoff({ sourceId: 'src', before: { thread: { id: 'src', status: { type: 'idle' } } }, turns: history, adapter, fail: code => { throw new Error(code); } });
  assert.ok(delivered.length >= 2); assert.ok(delivered.every(item => item.type === 'message' && ['user', 'assistant'].includes(item.role)));
  assert.ok(delivered.every(item => Object.keys(item).sort().join() === 'content,role,type'), 'no id, encrypted or metadata field rides along');
  assert.deepEqual(calls, ['deliver', 'publish']); assert.doesNotMatch(JSON.stringify(delivered), new RegExp(OPAQUE));
});
