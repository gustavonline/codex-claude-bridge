import test from 'node:test';
import assert from 'node:assert/strict';
import { pageTurns, pageItems, overlayHistory } from '../custom-turns.mjs';
import { readAllTurns, buildTransfer } from '../continuity.mjs';

// A continued chat has ONE canonical history: carried turns, then native's own. limit, cursor and sort apply to the whole.
const turn = (id, text) => ({ id, status: 'completed', error: null, items: [{ type: 'userMessage', id: 'u-' + id, clientId: null, content: [{ type: 'text', text }] }] });
const carried = Array.from({ length: 3 }, (_, i) => turn('old' + i, 'carried ' + i));
const ids = list => list.map(t => t.id);
// A fake native list with its own opaque cursors, honouring limit and direction like native does.
function nativeOf(turns) {
  const calls = [];
  const fn = async params => {
    calls.push(structuredClone(params));
    const ordered = params.sortDirection === 'desc' ? turns.slice().reverse() : turns.slice(), at = params.cursor ? Number(params.cursor.replace('N', '')) : 0, size = params.limit ?? 100;
    return { data: ordered.slice(at, at + size), nextCursor: at + size < ordered.length ? 'N' + (at + size) : null, backwardsCursor: 'back' };
  };
  fn.calls = calls; return fn;
}
async function walk(params, own, kept = carried) {
  const native = nativeOf(own), pages = []; let cursor;
  for (let guard = 0; guard < 20; guard++) {
    const page = await pageTurns({ ...params, ...(cursor ? { cursor } : {}) }, kept, native); pages.push(page);
    if (!page.nextCursor) return { pages, native };
    cursor = page.nextCursor;
  }
  throw new Error('did not end');
}

test('CV2: limit 2 with 3 carried and 1 native returns 2, 2 turns (never all 4), in order, across Bridge and native cursors', async () => {
  const { pages, native } = await walk({ sortDirection: 'asc', itemsView: 'full', limit: 2 }, [turn('new0', 'native 0')]);
  assert.deepEqual(pages.map(p => ids(p.data)), [['old0', 'old1'], ['old2', 'new0']]);
  assert.ok(pages.every(p => p.data.length <= 2)); assert.equal(pages[0].nextCursor, 'bridge-carried:2'); assert.equal(pages[1].nextCursor, null);
  assert.deepEqual(native.calls.map(c => c.limit), [1], 'native is asked only for the one slot the page still has');
});

test('ascending: the carried part is exhausted exactly at a page boundary, then native continues with its own cursors', async () => {
  const own = Array.from({ length: 5 }, (_, i) => turn('new' + i, 'native ' + i));
  const { pages, native } = await walk({ sortDirection: 'asc', itemsView: 'full', limit: 3 }, own);
  assert.deepEqual(pages.map(p => ids(p.data)), [['old0', 'old1', 'old2'], ['new0', 'new1', 'new2'], ['new3', 'new4']]);
  assert.equal(pages[0].nextCursor, 'bridge-native:'); assert.equal(pages[1].nextCursor, 'N3', 'native cursors are passed through untouched');
  assert.deepEqual(ids(pages.flatMap(p => p.data)), ['old0', 'old1', 'old2', 'new0', 'new1', 'new2', 'new3', 'new4'], 'every turn once, in order');
  assert.equal(native.calls[0].cursor, undefined);
});

test('descending: native turns first, newest first, then the carried part newest first; limits and boundaries hold', async () => {
  const own = Array.from({ length: 3 }, (_, i) => turn('new' + i, 'native ' + i));
  const { pages } = await walk({ sortDirection: 'desc', itemsView: 'full', limit: 2 }, own);
  assert.deepEqual(pages.map(p => ids(p.data)), [['new2', 'new1'], ['new0', 'old2'], ['old1', 'old0']]);
  assert.ok(pages.every(p => p.data.length <= 2));
  const { pages: single } = await walk({ sortDirection: 'desc', itemsView: 'full', limit: 100 }, own);
  assert.deepEqual(single.map(p => ids(p.data)), [['new2', 'new1', 'new0', 'old2', 'old1', 'old0']]);
  const { pages: none } = await walk({ sortDirection: 'desc', itemsView: 'full', limit: 2 }, []);
  assert.deepEqual(none.map(p => ids(p.data)), [['old2', 'old1'], ['old0']], 'a carried-only chat pages too');
});

test('without full items the carried turns are summaries, like native summary rows; a default limit applies', async () => {
  const { pages } = await walk({ sortDirection: 'asc', itemsView: 'notLoaded' }, []);
  assert.deepEqual(pages[0].data.map(t => [t.id, t.items.length, t.itemsView]), carried.map(t => [t.id, 0, 'notLoaded']));
  const big = Array.from({ length: 150 }, (_, i) => turn('k' + i, 'x')), { pages: many } = await walk({ sortDirection: 'asc', itemsView: 'full' }, [], big);
  assert.deepEqual(many.map(p => p.data.length), [100, 50]);
});

test('carried items are paged like native items: limit, cursor, direction, and no native call', () => {
  const rich = [{ id: 'c1', status: 'completed', items: Array.from({ length: 5 }, (_, i) => ({ type: 'agentMessage', id: 'i' + i, text: 'item ' + i })) }];
  const first = pageItems({ turnId: 'c1', limit: 2 }, rich); assert.deepEqual(first.data.map(r => r.item.id), ['i0', 'i1']); assert.equal(first.nextCursor, 'bridge-item:2');
  const second = pageItems({ turnId: 'c1', limit: 2, cursor: first.nextCursor }, rich); assert.deepEqual(second.data.map(r => r.item.id), ['i2', 'i3']);
  const last = pageItems({ turnId: 'c1', limit: 2, cursor: second.nextCursor }, rich); assert.deepEqual(last.data.map(r => r.item.id), ['i4']); assert.equal(last.nextCursor, null);
  assert.deepEqual(pageItems({ turnId: 'c1', limit: 3, sortDirection: 'desc' }, rich).data.map(r => r.item.id), ['i4', 'i3', 'i2']);
  assert.equal(pageItems({ turnId: 'native-turn' }, rich), null, 'items of a native turn go to native'); assert.equal(pageItems({}, rich), null);
});

test('LP4: an item anchor is exclusive (ascending continues after it, descending before it) and a cursor Bridge did not issue is rejected', () => {
  const abc = [{ id: 'c1', status: 'completed', items: ['a', 'b', 'c'].map(id => ({ type: 'agentMessage', id, text: id })) }], ids = page => page.data.map(r => r.item.id);
  assert.deepEqual(ids(pageItems({ turnId: 'c1', limit: 1, cursor: { type: 'item', itemId: 'b' } }, abc)), ['c']);
  assert.deepEqual(ids(pageItems({ turnId: 'c1', limit: 1, sortDirection: 'asc', cursor: { type: 'item', itemId: 'a' } }, abc)), ['b']);
  assert.deepEqual(ids(pageItems({ turnId: 'c1', limit: 1, sortDirection: 'desc', cursor: { type: 'item', itemId: 'b' } }, abc)), ['a']);
  assert.deepEqual(ids(pageItems({ turnId: 'c1', limit: 5, sortDirection: 'desc', cursor: { type: 'item', itemId: 'c' } }, abc)), ['b', 'a']);
  assert.deepEqual(pageItems({ turnId: 'c1', limit: 1, cursor: { type: 'item', itemId: 'c' } }, abc).data, [], 'after the last item there is nothing, and no next cursor'); assert.equal(pageItems({ turnId: 'c1', limit: 1, cursor: { type: 'item', itemId: 'c' } }, abc).nextCursor, null);
  const next = pageItems({ turnId: 'c1', limit: 1, cursor: { type: 'item', itemId: 'a' } }, abc).nextCursor; assert.deepEqual(ids(pageItems({ turnId: 'c1', limit: 1, cursor: next }, abc)), ['c'], 'the returned string cursor continues exactly');
  for (const cursor of [{ type: 'item', itemId: 'zzz' }, { type: 'item' }, { type: 'turn', itemId: 'a' }, 'N-opaque-native', 'bridge-item:99', 7, [], { type: 'item', itemId: '' }])
    assert.throws(() => pageItems({ turnId: 'c1', cursor }, abc), { code: 'invalid_cursor' }, JSON.stringify(cursor));
});

test('thread/read and thread/resume prepend only when turns are requested, and never duplicate a native turn', () => {
  const answer = { thread: { id: 'x', turns: [turn('new0', 'native 0')] } };
  assert.deepEqual(ids(overlayHistory('thread/read', { includeTurns: true }, answer, carried).thread.turns), ['old0', 'old1', 'old2', 'new0']);
  assert.equal(overlayHistory('thread/read', {}, answer, carried), null); assert.equal(overlayHistory('thread/resume', { excludeTurns: true }, answer, carried), null);
  assert.deepEqual(ids(overlayHistory('thread/resume', {}, answer, carried).thread.turns), ['old0', 'old1', 'old2', 'new0']);
  const clash = overlayHistory('thread/read', { includeTurns: true }, { thread: { id: 'x', turns: [turn('old1', 'native copy')] } }, carried);
  assert.deepEqual(ids(clash.thread.turns), ['old0', 'old2', 'old1']);
  assert.equal(overlayHistory('thread/turns/list', {}, { data: [] }, carried), null, 'listing is paged by pageTurns, not here');
  assert.equal(overlayHistory('thread/read', { includeTurns: true }, answer, []), null);
});

test('the carried copy is detached from the stored one', async () => {
  const page = await pageTurns({ sortDirection: 'asc', itemsView: 'full', limit: 5 }, carried, nativeOf([]));
  page.data[0].items[0].content[0].text = 'edited'; assert.equal(carried[0].items[0].content[0].text, 'carried 0');
});

test('a multi-page source is read completely, transferred in order, and what fits is never cut', async () => {
  const history = Array.from({ length: 330 }, (_, i) => turn('s' + i, 'message ' + i));
  const read = await readAllTurns(async ({ cursor }) => { const at = Number(cursor ?? 0); return { data: history.slice(at, at + 100), nextCursor: at + 100 < history.length ? String(at + 100) : null }; });
  const transfer = buildTransfer(read);
  assert.equal(transfer.report.turns, 330); assert.equal(transfer.report.transferredItems, 330);
  assert.equal(transfer.items[1].content[0].text, 'message 0'); assert.equal(transfer.items.at(-1).content[0].text, 'message 329');
  assert.deepEqual(ids(transfer.turns), ids(history), 'the carried copy keeps every original turn ID in order');
});
