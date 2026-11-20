// Shows the earlier, carried-over part of a continued chat, with correct paging.
//
// A continued chat runs on a NEW runtime thread. Its model context was rebuilt from the earlier visible
// conversation, but native's own turn list for that thread starts after it. Bridge keeps the carried visible turns
// beside the thread (see providers.mjs) and presents ONE canonical history: carried turns, then native's own.
// They are the same visible turns the model was given, with their original IDs and order. Native's own turns are
// never edited, hidden or reordered, and native's own cursors are passed through untouched.
//
// Paging is honoured exactly: `limit`, `sortDirection` and `cursor` apply to the combined list. Cursors that Bridge
// issues are the strings "bridge-carried:<n>" (position inside the carried part, in the order being listed) and
// "bridge-native:<cursor>" (continue in native's own list); any other cursor is native's and goes to native as it is.

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shaped = (turn, full) => full ? structuredClone(turn) : { ...structuredClone(turn), items: [], itemsView: 'notLoaded' };
const DEFAULT_LIMIT = 100;
const limitOf = params => Number.isInteger(params?.limit) && params.limit > 0 ? params.limit : DEFAULT_LIMIT;

function parse(cursor) {
  if (typeof cursor !== 'string' || !cursor) return { phase: 'start' };
  const carried = /^bridge-carried:(\d{1,9})$/.exec(cursor);
  if (carried) return { phase: 'carried', at: Number(carried[1]) };
  const native = /^bridge-native:(.*)$/s.exec(cursor);
  return { phase: 'native', cursor: native ? native[1] : cursor };
}

// One page of the combined turn list. `native(params)` fetches native's own page for the given parameters.
// Native is asked only for what the page still needs, so a limit is never exceeded.
export async function pageTurns(params, carried, native) {
  const limit = limitOf(params), full = (params.itemsView ?? 'summary') === 'full', desc = params.sortDirection === 'desc';
  const position = parse(params.cursor);
  const { cursor: ignored, ...bare } = params;
  const mine = (desc ? carried.slice().reverse() : carried);
  if (!desc) {
    if (position.phase === 'native') return native({ ...bare, ...(position.cursor ? { cursor: position.cursor } : {}) });
    const at = position.phase === 'carried' ? position.at : 0, slice = mine.slice(at, at + limit).map(turn => shaped(turn, full));
    if (at + limit < mine.length) return { data: slice, nextCursor: 'bridge-carried:' + (at + limit), backwardsCursor: null };
    const room = limit - slice.length;
    if (room === 0) return { data: slice, nextCursor: 'bridge-native:', backwardsCursor: null };
    const page = await native({ ...bare, limit: room });
    const own = new Set(page.data.map(turn => turn.id));
    return { ...page, data: [...slice.filter(turn => !own.has(turn.id)), ...page.data] };
  }
  // Newest first: native's own turns come first, the carried part after them, newest of it first.
  if (position.phase !== 'carried') {
    const page = await native({ ...bare, ...(position.phase === 'native' && position.cursor ? { cursor: position.cursor } : {}) });
    if (page.nextCursor != null) return page;
    const room = Math.max(0, limit - page.data.length), own = new Set(page.data.map(turn => turn.id));
    const rest = mine.filter(turn => !own.has(turn.id)), slice = rest.slice(0, room).map(turn => shaped(turn, full));
    return { ...page, data: [...page.data, ...slice], nextCursor: room < rest.length ? 'bridge-carried:' + room : null };
  }
  const slice = mine.slice(position.at, position.at + limit).map(turn => shaped(turn, full));
  return { data: slice, nextCursor: position.at + limit < mine.length ? 'bridge-carried:' + (position.at + limit) : null, backwardsCursor: null };
}

// Items of a carried turn, paged with the same rules. Native has no such turn, so no native call is made.
// Returns null when the turn is not a carried one.
export function pageItems(params, carried) {
  if (!Array.isArray(carried) || typeof params?.turnId !== 'string') return null;
  const turn = carried.find(item => item.id === params.turnId);
  if (!turn) return null;
  const limit = limitOf(params), desc = params.sortDirection === 'desc';
  const rows = turn.items.map(item => ({ turnId: turn.id, item: structuredClone(item) }));
  const ordered = desc ? rows.reverse() : rows, cursor = params.cursor;
  const invalid = () => Object.assign(new Error('invalid_cursor'), { code: 'invalid_cursor' });
  let at = 0;
  if (cursor !== undefined && cursor !== null) {
    if (typeof cursor === 'string') {
      const match = /^bridge-item:(\d{1,9})$/.exec(cursor);
      if (!match || Number(match[1]) > ordered.length) throw invalid(); // a cursor Bridge did not issue is never guessed at
      at = Number(match[1]);
    } else if (isObject(cursor) && cursor.type === 'item' && typeof cursor.itemId === 'string' && cursor.itemId) {
      // An exclusive anchor: ascending continues after the item, descending before it (the order being listed).
      const anchor = ordered.findIndex(row => row.item.id === cursor.itemId);
      if (anchor < 0) throw invalid();
      at = anchor + 1;
    } else throw invalid();
  }
  return { data: ordered.slice(at, at + limit), nextCursor: at + limit < ordered.length ? 'bridge-item:' + (at + limit) : null, backwardsCursor: null };
}

export const overlayMethods = ['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/resume'];

// The whole-thread reads: carried turns are put in front of every turn native reports, once.
// (thread/turns/list and thread/items/list are paged by pageTurns/pageItems instead.)
export function overlayHistory(method, params, answer, carried) {
  if (!Array.isArray(carried) || !carried.length || !isObject(answer)) return null;
  if (method !== 'thread/read' && method !== 'thread/resume') return null;
  if (!isObject(answer.thread) || !Array.isArray(answer.thread.turns)) return null;
  if (method === 'thread/resume' && params.excludeTurns === true) return null;
  if (method === 'thread/read' && params.includeTurns !== true) return null;
  const own = new Set(answer.thread.turns.map(turn => turn.id));
  return { ...answer, thread: { ...answer.thread, turns: [...carried.filter(turn => !own.has(turn.id)).map(turn => shaped(turn, true)), ...answer.thread.turns] } };
}
