import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTransfer, visibleTurns, readAllTurns, limits, ContinuityError, chunks, stripEnvelope } from '../continuity.mjs';

// Pure checks of what is carried when a chat moves to another provider. No registry, process or network.
const user = (id, text) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text }] });
const agent = (id, text) => ({ type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null, questions: null });
const turn = (id, items, extra = {}) => ({ id, status: 'completed', error: null, items, ...extra });
const bodies = items => items.map(item => item.content[0].text);

test('user messages, assistant messages and finished tool results are carried in order as plain message items', () => {
  const turns = [
    turn('t1', [user('u1', 'Remember ALPHA-7731'), agent('a1', 'Noted ALPHA-7731')]),
    turn('t2', [user('u2', 'Look the file up'),
      { type: 'dynamicToolCall', id: 'd1', namespace: 'bridge', tool: 'lookup', arguments: { q: 'x' }, status: 'completed', contentItems: [{ type: 'inputText', text: 'TOOL-RESULT-5521' }], success: true, durationMs: 4 },
      { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/work', status: 'completed', aggregatedOutput: 'file-one', exitCode: 0, commandActions: [], source: 'agent', pluginId: null, scriptPath: null, processId: null, durationMs: 1 },
      agent('a2', 'The file says TOOL-RESULT-5521')]),
  ];
  const transfer = buildTransfer(turns), text = bodies(transfer.items);
  assert.equal(transfer.items[0].role, 'user'); assert.match(text[0], /reference data/); assert.match(text[0], /Do not run earlier requests or tools again/);
  assert.deepEqual(text.slice(1, 3), ['Remember ALPHA-7731', 'Noted ALPHA-7731']);
  assert.deepEqual(transfer.items.slice(1).map(i => [i.role, i.content[0].type]), [['user', 'input_text'], ['assistant', 'output_text'], ['user', 'input_text'], ['assistant', 'output_text'], ['assistant', 'output_text'], ['assistant', 'output_text']]);
  assert.match(text[4], /TOOL-RESULT-5521/); assert.match(text[4], /finished; do not run it again|finished/); assert.match(text[5], /file-one/);
  assert.ok(transfer.items.every(i => i.type === 'message'), 'tool activity is reference text, never a callable function_call item');
  assert.deepEqual(transfer.report, { turns: 2, sourceItems: 6, transferredItems: 6, bytes: transfer.report.bytes, omitted: { reasoning: 0, contextCompaction: 0, opaqueFields: 0 } });
});

test('provider-private reasoning and compaction never travel, and are counted instead of silently dropped', () => {
  const turns = [turn('t1', [user('u1', 'hello'),
    { type: 'reasoning', id: 'r1', summary: ['thinking'], content: ['hidden'], encrypted_content: 'OPAQUE-ENCRYPTED-BLOB' },
    { type: 'contextCompaction', id: 'k1' }, agent('a1', 'hi')])];
  const transfer = buildTransfer(turns), wire = JSON.stringify(transfer);
  assert.doesNotMatch(wire, /OPAQUE-ENCRYPTED-BLOB|thinking|hidden/);
  assert.equal(transfer.report.omitted.reasoning, 1); assert.equal(transfer.report.omitted.contextCompaction, 1);
  assert.equal(transfer.turns[0].items.length, 2, 'the carried visible copy has only the visible items');
});

test('CV1: provider protocol metadata is removed by position (envelope keys only); visible tool and user JSON keeps every byte', () => {
  assert.deepEqual(stripEnvelope({ a: 1, encrypted_content: 'x', encrypted_function_args: ['y'], internal_chat_message_metadata_passthrough: { z: 1 }, deep: { encrypted_content: 'kept-here' } }), { a: 1, deep: { encrypted_content: 'kept-here' } }, 'shallow: only the envelope');
  const counter = { opaqueFields: 0 }; stripEnvelope({ encrypted_content: 'x', other: 1 }, counter); assert.equal(counter.opaqueFields, 1);
  const turns = [turn('t1', [user('u1', 'go'),
    { type: 'mcpToolCall', id: 'm1', server: 's', tool: 't', status: 'completed', arguments: { encrypted_flag: 'VISIBLE-ARG-SENTINEL', q: 1 },
      result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { encrypted_flag: 'VISIBLE_TOOL_JSON_SENTINEL', encrypted_content: 'BUSINESS-BYTES' } }, error: null, encrypted_content: 'ENVELOPE-OPAQUE' }],
    { encrypted_content: 'TURN-OPAQUE' })];
  const transfer = buildTransfer(turns), wire = JSON.stringify(transfer);
  assert.match(bodies(transfer.items)[2], /VISIBLE_TOOL_JSON_SENTINEL/); assert.match(bodies(transfer.items)[2], /VISIBLE-ARG-SENTINEL/); assert.match(bodies(transfer.items)[2], /BUSINESS-BYTES/, 'a tool result may legitimately carry any key');
  assert.doesNotMatch(wire, /ENVELOPE-OPAQUE|TURN-OPAQUE/); assert.equal(transfer.report.omitted.opaqueFields, 2, 'what was removed is counted');
  assert.match(JSON.stringify(transfer.turns), /VISIBLE_TOOL_JSON_SENTINEL/, 'and the carried visible copy keeps it too');
});

test('an attachment refuses the move (no placeholder, no "incomplete" success); an unknown visible item type refuses it too, naming the type', () => {
  for (const part of [{ type: 'image', url: 'https://x.invalid/a.png' }, { type: 'localImage', path: '/x.png' }, { type: 'mention', name: 'f', path: '/f' }, { type: 'skill', name: 's', path: '/s' }, null])
    assert.throws(() => buildTransfer([turn('t1', [{ type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'see this' }, part] }, agent('a1', 'ok')])]),
      error => error.code === 'handoff_attachment_unsupported' && typeof error.detail.type === 'string', JSON.stringify(part));
  const fine = buildTransfer([turn('t1', [{ type: 'userMessage', id: 'u1', clientId: null, content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }])]); assert.equal(bodies(fine.items)[1], 'a\nb', 'text-only multi-part input is carried whole');
  assert.ok(!('complete' in fine.report) && !('attachments' in fine.report.omitted), 'no completeness flag: a transfer either carries everything visible or is refused');
  assert.throws(() => buildTransfer([turn('t1', [user('u1', 'x'), { type: 'sleep', id: 's1' }, { type: 'subAgentActivity', id: 'a' }])]), error => error.code === 'handoff_content_unsupported' && JSON.stringify(error.detail) === JSON.stringify({ types: { sleep: 1, subAgentActivity: 1 } }));
  assert.throws(() => visibleTurns([turn('t1', [null])]), { code: 'handoff_history_unreadable' });
});

test('an unfinished tool is described as not finished, so a target never assumes it ran', () => {
  const transfer = buildTransfer([turn('t1', [user('u1', 'go'), { type: 'mcpToolCall', id: 'm1', server: 's', tool: 'write', status: 'failed', arguments: {}, result: null, error: { message: 'died' } }])]);
  assert.match(bodies(transfer.items)[2], /did not finish, outcome unknown/);
});

test('an empty source stays empty; a non-empty source is never replaced by an empty transfer', () => {
  const empty = buildTransfer([]); assert.deepEqual(empty.items, []); assert.equal(empty.report.turns, 0);
  assert.throws(() => buildTransfer([turn('t1', [{ type: 'sleep', id: 's1' }])]), { code: 'handoff_content_unsupported' }, 'visible content existed that cannot be carried');
  const privateOnly = buildTransfer([turn('t1', [{ type: 'reasoning', id: 'r1', summary: [], content: [], encrypted_content: 'x' }])]);
  assert.deepEqual(privateOnly.items, []); assert.equal(privateOnly.report.omitted.reasoning, 1, 'only provider-private data existed: nothing visible is lost, and it is counted');
  assert.equal(buildTransfer([turn('t1', [])]).items.length, 0, 'a turn with no items at all transfers nothing but is not a failure');
});

test('capacity limits are explicit failures before anything is created, never truncation', () => {
  const big = [turn('t1', [user('u1', 'x'.repeat(2000))])];
  assert.throws(() => buildTransfer(big, { maxBytes: 1000 }), error => error instanceof ContinuityError && error.code === 'handoff_context_too_large' && error.detail.bytes > 1000);
  assert.throws(() => buildTransfer([turn('t1', Array.from({ length: 6 }, (_, i) => user('u' + i, 'm')))], { maxItems: 5 }), { code: 'handoff_context_too_large' });
  const fits = buildTransfer(big, { maxBytes: 100000 }); assert.equal(bodies(fits.items).at(-1).length, 2000, 'what fits is carried whole');
  assert.ok(limits.maxBytes >= 1024 * 1024);
});

test('malformed history is refused rather than guessed at', () => {
  assert.throws(() => visibleTurns([{ id: 'x' }]), { code: 'handoff_history_unreadable' });
  assert.throws(() => visibleTurns([null]), { code: 'handoff_history_unreadable' });
});

test('chunks keep order and cover every item exactly once', () => {
  const parts = chunks(Array.from({ length: 250 }, (_, i) => i), 100);
  assert.deepEqual(parts.map(p => p.length), [100, 100, 50]); assert.deepEqual(parts.flat(), Array.from({ length: 250 }, (_, i) => i));
});

test('reading history follows every page and refuses a repeating or unreadable source', async () => {
  const all = Array.from({ length: 250 }, (_, i) => turn('t' + i, [user('u' + i, 'm' + i)]));
  const pages = [];
  const got = await readAllTurns(async ({ cursor, limit, sortDirection, itemsView }) => {
    pages.push({ cursor, limit, sortDirection, itemsView });
    const start = Number(cursor ?? 0); return { data: all.slice(start, start + 100), nextCursor: start + 100 < all.length ? String(start + 100) : null };
  });
  assert.equal(got.length, 250); assert.deepEqual(got.map(t => t.id), all.map(t => t.id));
  assert.deepEqual(pages.map(p => p.cursor), [undefined, '100', '200']); assert.ok(pages.every(p => p.sortDirection === 'asc' && p.itemsView === 'full' && p.limit === 100));
  await assert.rejects(readAllTurns(async () => ({ data: [], nextCursor: 'same' })), { code: 'handoff_history_unreadable' });
  await assert.rejects(readAllTurns(async () => ({ nope: true })), { code: 'handoff_history_unreadable' });
  await assert.rejects(readAllTurns(async ({ cursor }) => ({ data: [], nextCursor: String(Number(cursor ?? 0) + 1) }), { maxPages: 5 }), { code: 'handoff_context_too_large' });
});
