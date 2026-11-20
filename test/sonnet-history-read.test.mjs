import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { toolText, visibleTurns, historyNamespace as continuityNamespace } from '../continuity.mjs';
import { RpcError } from '../rpc.mjs';
import { HistoryError, canonicalEntries, createCodec, historyBinding, historyFailure, historyInputSchema, historyLimits, historyNamespace, historyRef, historyTools, mergeCarried, openHistoryRef,
  pageEntries, parseHistoryArgs, readHistory, settledPrefix, withHistoryTools } from '../history-read.mjs';

// ---- fixtures ---------------------------------------------------------------------------------------------------------------------------
const user = (id, text) => ({ type: 'userMessage', id, clientId: null, content: [{ type: 'text', text }] });
const agent = (id, text) => ({ type: 'agentMessage', id, text, phase: null });
const turn = (n, extra = {}) => ({ id: `turn-${n}`, status: 'completed', items: [user(`u${n}`, `question ${n}`), agent(`a${n}`, `answer ${n}`)], ...extra });
const history = (count, { fact } = {}) => Array.from({ length: count }, (_, i) => i + 1 === fact?.at ? turn(i + 1, { items: [user(`u${i + 1}`, `remember ${fact.text}`), agent(`a${i + 1}`, 'noted')] }) : turn(i + 1));
const running = n => ({ id: `turn-${n}`, status: 'inProgress', items: [user(`u${n}`, 'the question being answered right now')] });
const identity = (over = {}) => ({ chat: 'chat-1', profile: 'profile-1', workspace: '/work/a', currentTurnId: 'turn-current', fingerprint: 'fp-1', ...over });
// A reader that can be pointed at any turns / identity, like the Bridge's per-route verify and load closures.
function reader(turns, { grant = identity(), codec = createCodec(), calls = [] } = {}) {
  const state = { turns, grant };
  const read = (args, extra = {}) => readHistory({ args, codec, signal: extra.signal,
    verify: async () => { calls.push('verify'); return typeof state.grant === 'function' ? state.grant() : state.grant; },
    load: async () => { calls.push('load'); return state.turns; } });
  return { read, state, calls, codec };
}
const code = async promise => { try { await promise; } catch (error) { assert.ok(error instanceof HistoryError, String(error)); return error.code; } assert.fail('expected a HistoryError'); };
const deepFreeze = value => { if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); } return value; };
// Follow nextCursor until the end, like a model paging the whole history.
async function drain(read, args = {}) {
  const pages = []; let cursor;
  do { const page = await read({ ...args, ...(cursor ? { cursor } : {}) }); pages.push(page); cursor = page.nextCursor; assert.ok(pages.length < 5000, 'paging must end'); } while (cursor);
  return pages;
}

// ---- the tool and its arguments -------------------------------------------------------------------------------------------------------------
test('the tool: namespace codex_bridge_history / function read, lazily loaded, exactly the six arguments and no identity argument', () => {
  assert.equal(historyNamespace, 'codex_bridge_history'); assert.equal(continuityNamespace, historyNamespace);
  assert.equal(historyTools.type, 'namespace'); assert.equal(historyTools.name, 'codex_bridge_history');
  assert.deepEqual(historyTools.tools.map(t => [t.type, t.name, t.deferLoading]), [['function', 'read', true]]);
  assert.deepEqual(Object.keys(historyInputSchema.properties).sort(), ['cursor', 'direction', 'includeTools', 'limit', 'maxCharacters', 'ref']);
  assert.equal(historyInputSchema.additionalProperties, false); assert.equal(historyInputSchema.required, undefined);
  assert.deepEqual([historyInputSchema.properties.limit.minimum, historyInputSchema.properties.limit.maximum], [1, 20]);
  assert.deepEqual([historyInputSchema.properties.maxCharacters.minimum, historyInputSchema.properties.maxCharacters.maximum], [256, 20000]);
  for (const forbidden of ['threadId', 'path', 'provider', 'profile', 'source', 'sourceKey', 'rollout']) assert.equal(forbidden in historyInputSchema.properties, false, forbidden);
  assert.equal(historyTools.tools[0].inputSchema, historyInputSchema);
});

test('withHistoryTools adds the namespace beside the existing dynamic tools, never mutates its input, and refuses a request that already carries the reserved namespace', () => {
  const desktop = { type: 'function', name: 'desktop_tool', description: 'x', inputSchema: { type: 'object' } }, input = deepFreeze({ model: 'gpt-x', dynamicTools: [desktop] });
  const out = withHistoryTools(input);
  assert.deepEqual(out.dynamicTools.map(t => t.name), ['desktop_tool', 'codex_bridge_history']); assert.equal(out.model, 'gpt-x');
  assert.deepEqual(input.dynamicTools.map(t => t.name), ['desktop_tool']);
  assert.deepEqual(withHistoryTools().dynamicTools.map(t => t.name), ['codex_bridge_history']);
  out.dynamicTools[1].tools[0].name = 'changed'; assert.equal(historyTools.tools[0].name, 'read'); // a copy: the shared spec cannot be altered through a request
  assert.throws(() => withHistoryTools({ dynamicTools: [{ type: 'namespace', name: 'codex_bridge_history', tools: [] }] }), e => e instanceof RpcError && e.code === -32602 && /Reserved/.test(e.message));
});

test('arguments: defaults, exact bounds, and every unknown key (including identity-shaped ones) refused', () => {
  assert.deepEqual(parseHistoryArgs(undefined), { cursor: undefined, ref: undefined, direction: undefined, includeTools: undefined, limit: 5, maxCharacters: 8000 });
  assert.deepEqual(parseHistoryArgs({ limit: 20, maxCharacters: 256, direction: 'desc', includeTools: true }), { cursor: undefined, ref: undefined, direction: 'desc', includeTools: true, limit: 20, maxCharacters: 256 });
  assert.equal(parseHistoryArgs({ limit: 1, maxCharacters: 20000 }).limit, 1);
  for (const bad of [{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { limit: '3' }, { maxCharacters: 255 }, { maxCharacters: 20001 }, { includeTools: 'yes' }, { direction: 'sideways' }, { cursor: '' }, { cursor: 7 }, { ref: {} },
    { cursor: 'a', ref: 'b' }, 'text', [], { cursor: 'x'.repeat(historyLimits.token + 1) }])
    assert.throws(() => parseHistoryArgs(bad), e => e instanceof HistoryError && e.code === 'invalid_arguments', JSON.stringify(bad).slice(0, 60));
  for (const key of ['threadId', 'path', 'provider', 'profile', 'sourceKey', 'connectionId', 'turnId', 'workspace', 'cwd', 'revision', '__proto__']) {
    const args = JSON.parse(`{"${key}": "x"}`);
    assert.throws(() => parseHistoryArgs(args), e => e instanceof HistoryError && e.code === 'invalid_arguments' && /Unknown argument/.test(e.message), key);
  }
});

// ---- sealed cursors ------------------------------------------------------------------------------------------------------------------------
test('a sealed token opens only unchanged, only with its own key and only as its own kind', () => {
  const codec = createCodec(), token = codec.seal({ k: 'cursor', c: 'chat', i: 3 });
  assert.deepEqual(codec.open(token, 'cursor'), { k: 'cursor', c: 'chat', i: 3 });
  const [head, body, mac] = token.split('.');
  const flip = value => value.slice(0, 5) + (value[5] === 'A' ? 'B' : 'A') + value.slice(6);
  for (const tampered of [`${head}.${flip(body)}.${mac}`, `${head}.${body}.${flip(mac)}`, `${head}.${body}`, `x.${body}.${mac}`, `${token}x`, '', 'not a token'])
    assert.throws(() => codec.open(tampered, 'cursor'), e => e.code === 'invalid_cursor', tampered.slice(0, 20));
  assert.throws(() => createCodec().open(token, 'cursor'), e => e.code === 'invalid_cursor'); // another process / another key
  assert.throws(() => codec.open(token, 'ref'), e => e.code === 'invalid_ref'); // a cursor is not a ref
  assert.equal(token.includes('chat'), false); // sealed, not readable as plain text of an identifier
});

// ---- what is shown ---------------------------------------------------------------------------------------------------------------------------
test('canonical entries: visible messages in order; no reasoning, compaction or envelope-private field; tool activity only with includeTools and as reference text', () => {
  const OPAQUE = 'OPAQUE-ENCRYPTED-9c1e';
  const turns = [{ id: 't1', status: 'completed', encrypted_content: OPAQUE, items: [user('u1', 'first'), { type: 'reasoning', id: 'r1', summary: ['PRIVATE-REASONING'], encrypted_content: OPAQUE }, { type: 'contextCompaction', id: 'c1' },
    { type: 'commandExecution', id: 'x1', command: 'ls', cwd: '/w', status: 'completed', exitCode: 0, aggregatedOutput: 'TOOL-OUTPUT-4412', internal_chat_message_metadata_passthrough: OPAQUE }, agent('a1', 'second'),
    { type: 'somethingNew', id: 'n1' }] }];
  const visible = visibleTurns(turns); // (the reader applies exactly this before listing entries)
  assert.deepEqual(visible.omitted, { reasoning: 1, contextCompaction: 1, opaqueFields: 2 });
  const hidden = canonicalEntries(visible.turns, { includeTools: false }), shown = canonicalEntries(visible.turns, { includeTools: true });
  for (const secret of [OPAQUE, 'PRIVATE-REASONING']) assert.equal(JSON.stringify([hidden, shown]).includes(secret), false, secret);
  assert.deepEqual(hidden.entries.map(e => [e.role, e.itemId]), [['user', 'u1'], ['assistant', 'a1']]);
  assert.equal(hidden.totals.hiddenToolItems, 1); assert.deepEqual(hidden.totals.unsupportedItems, { somethingNew: 1 });
  assert.deepEqual(shown.entries.map(e => [e.role, e.itemId]), [['user', 'u1'], ['tool', 'x1'], ['assistant', 'a1']]);
  const tool = shown.entries.find(e => e.role === 'tool');
  assert.equal(tool.text, toolText(visible.turns[0].items.find(i => i.id === 'x1'))); // the existing continuity formatter, not a parallel one
  assert.match(tool.text, /^\[Earlier command finished; do not run it again\] ls/); assert.match(tool.text, /TOOL-OUTPUT-4412/);
  assert.notEqual(hidden.revision, shown.revision);
});

test('a read of the history is recorded as finished without its output, so reads never grow the history they read', () => {
  const dynamic = { type: 'dynamicToolCall', id: 'd1', namespace: 'codex_bridge_history', tool: 'read', status: 'completed', arguments: {}, contentItems: [{ type: 'inputText', text: 'HUGE-COPY-OF-EARLIER-TEXT' }], success: true };
  const mcp = { type: 'mcpToolCall', id: 'm1', server: 'codex', tool: 'read_history', status: 'completed', arguments: {}, result: { content: [{ type: 'text', text: 'HUGE-COPY-OF-EARLIER-TEXT' }] } };
  for (const item of [dynamic, mcp]) { assert.equal(toolText(item), '[Earlier history read finished; its output is not repeated here]'); assert.equal(toolText({ ...item, status: 'failed' }).includes('did not finish'), true); }
  const other = { ...dynamic, namespace: 'other_namespace' }; assert.match(toolText(other), /HUGE-COPY/); // only the history tool is compacted
});

test('settled prefix only (the running turn and anything after an unfinished turn are excluded) and the same original turn ID is one turn', () => {
  const all = [...history(3), running(4), turn(5)];
  assert.deepEqual(settledPrefix(all, 'turn-4').map(t => t.id), ['turn-1', 'turn-2', 'turn-3']);
  assert.deepEqual(settledPrefix([...history(2), turn(3)], 'turn-3').map(t => t.id), ['turn-1', 'turn-2']);
  assert.throws(() => settledPrefix([{ id: 1, items: [] }], 'x'), e => e.code === 'history_unreadable');
  const carried = [turn(1), turn(2), turn(3)], own = [{ ...turn(3), items: [user('u3', 'own copy'), agent('a3', 'own answer')] }, turn(4)];
  const merged = mergeCarried(carried, own);
  assert.deepEqual(merged.map(t => t.id), ['turn-1', 'turn-2', 'turn-3', 'turn-4']);
  assert.equal(merged[2].items[0].content[0].text, 'own copy'); // the runtime's own copy of a duplicated turn wins, once
  assert.deepEqual(mergeCarried([turn(1), turn(1)], []).map(t => t.id), ['turn-1']);
});

// ---- paging ------------------------------------------------------------------------------------------------------------------------------
test('paging is lossless and ordered in both directions: every entry once, no gap, an exact end', async () => {
  const turns = history(60), { read } = reader(turns);
  const flat = pages => pages.flatMap(p => p.entries);
  const asc = flat(await drain(read, { limit: 7, maxCharacters: 256 })), desc = flat(await drain(read, { limit: 7, maxCharacters: 256, direction: 'desc' }));
  const expected = turns.flatMap(t => t.items.map(i => i.id));
  assert.deepEqual(asc.map(e => e.itemId), expected);
  assert.deepEqual(desc.map(e => e.itemId), [...expected].reverse());
  assert.equal(asc.every(e => e.offset === 0 && e.length === e.total && !e.truncated && e.nextRef === undefined), true);
  const last = (await drain(read, { limit: 20 })).at(-1); assert.equal(last.end, true); assert.equal(last.nextCursor, null);
  const first = await read({ limit: 1 }); assert.equal(first.end, false); assert.ok(first.nextCursor);
  assert.deepEqual(first.totals, { turns: 60, entries: 120 });
});

test('a 150,000-character item (with surrogate pairs) is returned in segments that join EXACTLY, by cursor and by nextRef, in both directions', async () => {
  const big = 'é' + '😀'.repeat(75_000) + 'END', exactly = createHash('sha256').update(big).digest('hex');
  const turns = [turn(1), { id: 'turn-2', status: 'completed', items: [user('u2', 'give me the big thing'), agent('big', big)] }, turn(3)];
  const { read } = reader(turns);
  for (const direction of ['asc', 'desc']) {
    const pages = await drain(read, { direction, maxCharacters: 20000, limit: 20 }), segments = pages.flatMap(p => p.entries).filter(e => e.itemId === 'big');
    assert.ok(segments.length >= Math.ceil(big.length / 20000), `${segments.length} segments`);
    assert.deepEqual(segments.map(s => s.offset), segments.map((_, i) => segments.slice(0, i).reduce((n, s) => n + s.length, 0))); // contiguous, in order
    assert.equal(segments.every(s => s.total === big.length && s.length <= 20000 && s.text.length === s.length), true);
    assert.equal(segments.map(s => s.truncated).join(), segments.map((_, i) => i < segments.length - 1).join());
    const joined = segments.map(s => s.text).join(''); assert.equal(joined.length, big.length); assert.equal(createHash('sha256').update(joined).digest('hex'), exactly);
    assert.equal(segments.every(s => !/^[\udc00-\udfff]/.test(s.text) && !/[\ud800-\udbff]$/.test(s.text)), true); // no pair is ever split
  }
  // the same item by exact continuation: ref -> nextRef -> nextRef ...
  const page = await read({ maxCharacters: 256, limit: 20 }), target = (await drain(read, { limit: 20, maxCharacters: 20000 })).flatMap(p => p.entries).find(e => e.itemId === 'big');
  assert.ok(page && target.ref);
  let part = await read({ ref: target.ref, maxCharacters: 20000 }), text = part.entries[0].text, hops = 1;
  assert.equal(part.entries.length, 1);
  while (part.entries[0].nextRef) { part = await read({ ref: part.entries[0].nextRef, maxCharacters: 20000 }); assert.equal(part.entries.length, 1); assert.equal(part.entries[0].offset, text.length); text += part.entries[0].text; hops++; }
  assert.equal(text, big); assert.ok(hops >= 8);
  assert.ok(part.entries[0].offset > 0 && !part.entries[0].truncated); assert.ok(part.nextCursor); // the last piece hands back to ordinary paging
});

test('a very long conversation: an early fact in the first turns is found by plain paging and not by luck of the page size', async () => {
  const turns = history(240, { fact: { at: 3, text: 'the launch code is PELICAN-7731' } }), { read } = reader(turns);
  for (const [limit, maxCharacters, direction] of [[20, 20000, 'asc'], [1, 256, 'asc'], [5, 800, 'desc'], [20, 256, 'desc']]) {
    const seen = (await drain(read, { limit, maxCharacters, direction })).flatMap(p => p.entries).filter(e => e.text.includes('PELICAN-7731'));
    assert.equal(seen.length, 1, `${direction} ${limit}/${maxCharacters}`); assert.equal(seen[0].turnId, 'turn-3'); assert.equal(seen[0].itemId, 'u3'); assert.equal(seen[0].role, 'user');
  }
});

test('pageEntries: an item that does not fit continues at its offset, a page never starts a slice under the minimum, and an empty item is still an entry', () => {
  const entries = [{ text: 'a'.repeat(300) }, { text: '' }, { text: 'b'.repeat(10) }];
  const first = pageEntries(entries, { direction: 'asc', limit: 20, maxCharacters: 256, start: { index: 0, offset: 0 } });
  assert.deepEqual(first.segments.map(s => [s.index, s.offset, s.end]), [[0, 0, 256]]); assert.deepEqual(first.next, { index: 0, offset: 256 });
  const second = pageEntries(entries, { direction: 'asc', limit: 20, maxCharacters: 256, start: first.next });
  assert.deepEqual(second.segments.map(s => [s.index, s.offset, s.end]), [[0, 256, 300], [1, 0, 0], [2, 0, 10]]); assert.equal(second.next, null);
  const tight = pageEntries([{ text: 'x'.repeat(250) }, { text: 'y'.repeat(100) }], { direction: 'asc', limit: 20, maxCharacters: 256, start: { index: 0, offset: 0 } });
  assert.deepEqual(tight.segments.map(s => [s.index, s.end]), [[0, 250]]); assert.deepEqual(tight.next, { index: 1, offset: 0 }); // 6 left < 64: the next item starts on the next page, whole
});

// ---- cursors, refs and revisions ---------------------------------------------------------------------------------------------------------------
test('cursor errors are explicit: tampered, foreign conversation / profile / workspace, another process key, changed options, stale revision', async () => {
  const turns = history(10), codec = createCodec(), a = reader(turns, { codec }), cursor = (await a.read({ limit: 2 })).nextCursor;
  assert.equal((await a.read({ cursor, limit: 2 })).entries[0].itemId, 'u2'); // the honest cursor works, and continues exactly after the first page
  const [head, body, mac] = cursor.split('.');
  assert.equal(await code(a.read({ cursor: `${head}.${body.slice(0, -2)}AA.${mac}` })), 'invalid_cursor');
  assert.equal(await code(a.read({ cursor: `${head}.${body}.${mac.slice(0, -2)}AA` })), 'invalid_cursor');
  assert.equal(await code(a.read({ cursor: 'h1.' + body + '.' + 'A'.repeat(43) })), 'invalid_cursor');
  assert.equal(await code(reader(turns).read({ cursor })), 'invalid_cursor'); // sealed by another key: not ours
  for (const [field, value] of [['chat', 'chat-2'], ['profile', 'profile-2'], ['workspace', '/work/b']]) {
    const foreign = reader(turns, { codec, grant: identity({ [field]: value }) });
    assert.equal(await code(foreign.read({ cursor })), 'cursor_mismatch', field);
  }
  assert.equal(await code(a.read({ cursor, direction: 'desc' })), 'cursor_options_mismatch');
  assert.equal(await code(a.read({ cursor, includeTools: true })), 'cursor_options_mismatch');
  assert.equal((await a.read({ cursor, direction: 'asc', includeTools: false })).direction, 'asc'); // restating the bound options is fine
  assert.equal((await a.read({ cursor, limit: 9, maxCharacters: 300 })).entries.length, 9); // paging size is not part of the cursor
  a.state.turns = [...turns, turn(11)]; // history gained a settled turn: a strictly newer revision
  assert.equal(await code(a.read({ cursor })), 'history_revision_changed');
  a.state.turns = turns.map((t, i) => i === 4 ? { ...t, items: [t.items[0], agent('a5', 'answer 5 EDITED')] } : t); // same shape, changed text
  assert.equal(await code(a.read({ cursor })), 'history_revision_changed');
  a.state.turns = turns; assert.ok((await a.read({ cursor })).entries.length); // back to the revision it was issued for
});

test('a cursor may not be combined with ref, and a cursor from the end of one direction is not a start in the other', async () => {
  const { read } = reader(history(5)), page = await read({ limit: 2 });
  assert.equal(await code(read({ cursor: page.nextCursor, ref: page.entries[0].ref })), 'invalid_arguments');
  const desc = await read({ direction: 'desc', limit: 2 });
  assert.equal(desc.entries[0].itemId, 'a5'); assert.equal(await code(read({ cursor: desc.nextCursor, direction: 'asc' })), 'cursor_options_mismatch');
});

test('ref errors are explicit: tampered, foreign, unknown item, tool item without includeTools, out-of-range offset; an honest ref survives an appended turn', async () => {
  const toolTurn = { id: 'turn-t', status: 'completed', items: [user('ut', 'run it'), { type: 'commandExecution', id: 'cmd', command: 'ls', cwd: '/w', status: 'completed', exitCode: 0, aggregatedOutput: 'out' }, agent('at', 'ran')] };
  const turns = [turn(1), toolTurn, turn(3)], codec = createCodec(), a = reader(turns, { codec }), page = await a.read({ limit: 20, includeTools: true });
  const refOf = id => page.entries.find(e => e.itemId === id).ref;
  assert.equal((await a.read({ ref: refOf('a1') })).entries[0].text, 'answer 1');
  const [head, body, mac] = refOf('a1').split('.');
  assert.equal(await code(a.read({ ref: `${head}.${body.slice(0, -2)}AA.${mac}` })), 'invalid_ref');
  assert.equal(await code(a.read({ ref: 'h1.' + body + '.' + 'A'.repeat(43) })), 'invalid_ref');
  assert.equal((await reader(turns).read({ ref: refOf('a1') })).entries[0].text, 'answer 1'); // another process key (a restart): a ref does not depend on it
  assert.equal(await code(a.read({ ref: `${head}.${body}.${'0'.repeat(16)}` })), 'invalid_ref'); // a damaged copy
  assert.equal(await code(a.read({ ref: `${head}.${Buffer.from('{"c":1}').toString('base64url')}.${'0'.repeat(16)}` })), 'invalid_ref');
  for (const [field, value] of [['chat', 'chat-2'], ['profile', 'profile-2'], ['workspace', '/work/b']])
    assert.equal(await code(reader(turns, { codec, grant: identity({ [field]: value }) }).read({ ref: refOf('a1') })), 'ref_mismatch', field);
  assert.equal(await code(a.read({ ref: (await a.read({ limit: 1 })).nextCursor })), 'invalid_ref'); // a cursor is never a ref
  const toolRef = refOf('cmd'); assert.equal((await a.read({ ref: toolRef, includeTools: true })).entries[0].role, 'tool');
  const hidden = await a.read({ ref: toolRef }).then(() => null, e => e); assert.equal(hidden.code, 'ref_not_found'); assert.match(hidden.message, /includeTools/);
  a.state.turns = [turn(1), turn(3)]; assert.equal(await code(a.read({ ref: toolRef, includeTools: true })), 'ref_not_found'); // an item that is no longer in the history is gone
  a.state.turns = [...turns, turn(4)]; assert.equal((await a.read({ ref: refOf('a1') })).entries[0].text, 'answer 1'); // an appended turn does not break a ref
  const long = reader([{ id: 'turn-l', status: 'completed', items: [agent('long', 'z'.repeat(1000))] }], { codec }), piece = (await long.read({ maxCharacters: 256 })).entries[0];
  const forged = historyRef(historyBinding(identity()), { turnId: 'turn-l', ordinal: 0, itemId: 'long' }, 1000); // a well-formed ref whose offset lies at the end of the item
  assert.equal(await code(long.read({ ref: forged })), 'ref_offset_out_of_range');
  assert.equal((await long.read({ ref: piece.nextRef, maxCharacters: 20000 })).entries[0].text.length, 744);
});

test('COLD RESTART: a stored ref reopens the exact old item and its later segments after every in-memory key is gone; a stored cursor fails clearly; the ref is derived from stable IDs only', async () => {
  const big = 'ö' + 'x'.repeat(50_000) + '😀'.repeat(30_000) + 'END', exactly = createHash('sha256').update(big).digest('hex');
  const turns = [...history(30), { id: 'turn-big', status: 'completed', items: [user('ub', 'keep this safe'), agent('big', big)] }, turn(32)];
  // ---- the first process: a summary / hand-off stores refs (and a model holds a cursor)
  const first = reader(turns, { codec: createCodec() }), pages = await drain(first.read, { limit: 20, maxCharacters: 20000 });
  const segments = pages.flatMap(p => p.entries).filter(e => e.itemId === 'big'), stored = { item: segments[0].ref, middle: segments[0].nextRef, last: segments.at(-1).ref, user: pages.flatMap(p => p.entries).find(e => e.itemId === 'ub').ref };
  const storedCursor = (await first.read({ limit: 3 })).nextCursor;
  assert.ok(segments.length >= 6 && stored.middle && stored.item === segments[0].ref);
  // the ref is a pure function of stable IDs: nothing of the first process (no key, no counter, no revision) is in it
  const binding = historyBinding(identity());
  assert.equal(historyRef(binding, { turnId: 'turn-big', ordinal: 1, itemId: 'big' }, 0), stored.item);
  assert.equal(historyRef(binding, { turnId: 'turn-big', ordinal: 1, itemId: 'big' }, segments[0].length), segments[0].nextRef);
  assert.deepEqual(openHistoryRef(stored.item), { ...binding, t: 'turn-big', n: 1, m: 'big', o: 0 });
  // ---- COLD RESTART: a new process key, fresh objects, a later turn already appended, and the conversation now lives on another runtime
  const restarted = reader([...structuredClone(turns), turn(33)], { codec: createCodec(), grant: identity({ fingerprint: 'fp-another-runtime' }) });
  assert.equal((await restarted.read({ ref: stored.user })).entries[0].text, 'keep this safe');
  let part = await restarted.read({ ref: stored.item, maxCharacters: 20000 }), text = part.entries[0].text;
  assert.equal(part.entries[0].offset, 0); assert.equal(part.entries[0].total, big.length);
  while (part.entries[0].nextRef) { part = await restarted.read({ ref: part.entries[0].nextRef, maxCharacters: 20000 }); assert.equal(part.entries[0].offset, text.length); text += part.entries[0].text; }
  assert.equal(text, big); assert.equal(createHash('sha256').update(text).digest('hex'), exactly);
  const tail = await restarted.read({ ref: stored.middle, maxCharacters: 20000 }); // a stored mid-item ref reopens exactly there
  assert.equal(tail.entries[0].offset, segments[0].length); assert.equal(tail.entries[0].text, segments[1].text);
  assert.equal((await restarted.read({ ref: stored.last })).entries[0].offset, 0);
  assert.equal(await code(restarted.read({ cursor: storedCursor })), 'invalid_cursor'); // the cursor was a bookmark of the first process: clear failure, then read again
  assert.match((await restarted.read({ cursor: storedCursor }).catch(e => e)).message, /restart/);
  assert.ok((await restarted.read({ limit: 1 })).nextCursor); // and a fresh read pages again
  // the checks that make a ref safe to keep are still all there after the restart
  for (const [field, value] of [['chat', 'chat-2'], ['profile', 'profile-2'], ['workspace', '/work/b']])
    assert.equal(await code(reader(turns, { codec: createCodec(), grant: identity({ [field]: value }) }).read({ ref: stored.item })), 'ref_mismatch', field);
  assert.equal(await code(reader(turns.filter(t => t.id !== 'turn-big'), { codec: createCodec() }).read({ ref: stored.item })), 'ref_not_found');
  assert.equal(await code(reader(turns, { codec: createCodec(), calls: [], grant: () => { throw new HistoryError('turn_not_current', 'x'); } }).read({ ref: stored.item })), 'turn_not_current'); // a ref is never a way past the caller check
});

// ---- the caller is verified, twice, and nothing is returned for a caller that changed ------------------------------------------------------------
test('the caller is verified before anything is loaded and again after the last await; a denial loads nothing; a changed caller returns nothing', async () => {
  const calls = [], a = reader(history(3), { calls });
  await a.read({}); assert.deepEqual(calls, ['verify', 'load', 'verify']);
  const denied = []; const b = reader(history(3), { calls: denied, grant: () => { throw new HistoryError('foreign_peer', 'This connection does not run that thread.'); } });
  assert.equal(await code(b.read({})), 'foreign_peer'); assert.deepEqual(denied, ['verify']);
  let n = 0; const c = reader(history(3), { grant: () => identity({ fingerprint: 'fp-' + ++n }) });
  assert.equal(await code(c.read({})), 'caller_changed');
  const gone = []; let phase = 0; const d = reader(history(3), { calls: gone, grant: () => { if (++phase === 2) throw new HistoryError('turn_not_current', 'The call does not belong to the turn that is running now.'); return identity(); } });
  assert.equal(await code(d.read({})), 'turn_not_current'); assert.deepEqual(gone, ['verify', 'load', 'verify']);
  const controller = new AbortController(), slow = readHistory({ args: {}, signal: controller.signal, verify: async () => identity(), load: async () => { controller.abort(); return history(1); } });
  assert.equal(await code(slow), 'aborted');
  assert.equal(await code(a.read({ unknown: 1 })), 'invalid_arguments'); // arguments are checked before the caller is even looked at
});

test('a read never mutates what it reads, and a failure shows only a code and a fixed sentence', async () => {
  const frozen = deepFreeze(structuredClone([...history(4), running(5)])), before = JSON.stringify(frozen);
  const { read } = reader(frozen, { grant: identity({ currentTurnId: 'turn-5' }) });
  const page = await read({ includeTools: true, limit: 20 }); assert.equal(page.entries.length, 8); assert.equal(page.excludedTurns, 1);
  assert.equal(JSON.stringify(frozen), before);
  assert.equal(page.entries.some(e => /being answered right now/.test(e.text)), false); // the running turn is not part of its own history
  assert.deepEqual(historyFailure(new Error('/Users/someone/secret/path exploded')), { error: { code: 'history_failed', message: 'The history could not be read.' } });
  assert.deepEqual(historyFailure(new HistoryError('aborted', 'The calling turn ended.')), { error: { code: 'aborted', message: 'The calling turn ended.' } });
  assert.equal(JSON.stringify(page).includes('tokens'), false); // no invented usage
  const unreadable = reader([{ id: 'x', items: 'nope' }]); assert.equal(await code(unreadable.read({})), 'history_unreadable');
});

test('an attachment in a user message is shown as an explicit placeholder and counted, never silently dropped', async () => {
  const turns = [{ id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'look at this' }, { type: 'image', url: 'data:image/png;base64,AAAA' }] }] }];
  const page = await reader(turns).read({});
  assert.equal(page.entries[0].text, 'look at this\n[non-text input not shown: image]'); assert.equal(page.nonTextInputs, 1);
});
