import { acceptQueued, continueQueue } from './queue.mjs';
import { handoffContext } from './providers.mjs';
import { errorMetadata } from './logging.mjs';
import { settleSteering } from './steering.mjs';

// Keep the actual native thread ID: desktop tools still belong to this chat.
// Before handing a mixed conversation back to GPT, remove its old native turns
// and provide the retained visible transcript once, on the first new turn.
export async function resetNativeHistory(bridge, record) {
  if (!record.nativeResetRequired) return;
  if (record.nativeFirstTurnId) {
    const threadId = record.thread.id;
    let timer;
    const reverted = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Native history reset notification timed out')), 5000);
      bridge.internalReverts.set(threadId, resolve);
    });
    reverted.catch(() => {});
    try {
      await bridge.native.request('thread/revert', { threadId, beforeTurnId: record.nativeFirstTurnId });
      record.nativeFirstTurnId = undefined;
      bridge.save(record);
      // Native sends thread/reverted AFTER its RPC response. Drain it before
      // continuing so the desktop never mistakes this reset for a user edit.
      await reverted;
      bridge.log('history.native_reset', { threadId, retainedTurns: record.turns.length });
    } finally { clearTimeout(timer); bridge.internalReverts.delete(threadId); }
  }
}

export async function beginNative(bridge, record, params) {
  await resetNativeHistory(bridge, record);
  const threadId = record.thread.id;
  const context = record.nativeResetRequired ? handoffContext(record.turns, params.additionalContext) : params.additionalContext;
  if (record.nativeHistoryHasLegacySeeds && !record.legacyHistoryNoticeShown) {
    bridge.emit('warning', { threadId, message: 'This older prototype chat may retain earlier prompt copies on its native host. For a clean GPT context after editing old messages, fork this chat first. New chats and forks do not have this limitation.' });
    record.legacyHistoryNoticeShown = true; bridge.save(record);
  }
  if (record.nativeHistoryHasLegacySeeds && context?.bridge_history_rules)
    context.bridge_history_rules.value += ' This legacy host may contain obsolete prompt copies. Only the retained bridge_conversation reference defines which historical requests belong to this chat.';
  bridge.nativeStarts.set(threadId, params);
  try {
    const { queuedSubmissionId, ...request } = params;
    const result = await bridge.native.request('turn/start', { ...request, model: record.model, effort: record.effort,
      ...(context ? { additionalContext: context } : {}) });
    // app-server may send turn/started on either side of its RPC response.
    await captureNative(bridge, record, 'turn/started', { threadId, turn: result.turn });
    return result;
  } finally { bridge.nativeStarts.delete(threadId); }
}

export async function captureNative(bridge, record, method, params) {
  const threadId = record.thread.id;
  const turnId = params.turn?.id ?? params.turnId;
  let turn = record.turns.find(t => t.id === turnId);
  if (method === 'turn/started') {
    if (turn) return;
    const pending = bridge.nativeStarts.get(threadId);
    turn = { ...structuredClone(params.turn), items: structuredClone(params.turn.items ?? []), provider: 'native' };
    if (pending?.input && !turn.items.some(i => i.type === 'userMessage'))
      turn.items.push({ type: 'userMessage', id: pending.clientUserMessageId ?? `${turnId}-input`, clientId: pending.clientUserMessageId, content: structuredClone(pending.input) });
    turn.clientUserMessageId = pending?.clientUserMessageId;
    // Native canonical items may add display metadata; retries compare the
    // exact submitted input, independently of the host's presentation shape.
    if (pending?.input) turn.submittedInput = structuredClone(pending.input);
    const queued = pending && acceptQueued(record, pending, turn);
    record.turns.push(turn); record.nativeFirstTurnId ??= turn.id;
    record.nativeResetRequired = false; record.nativePersisted = true;
    record.updatedAt = Math.floor(Date.now() / 1000);
    record.thread.preview ||= pending?.input?.filter(p => p.type === 'text').map(p => p.text).join(' ').slice(0, 200) ?? '';
    bridge.active.set(threadId, { native: true, turn, controller: new AbortController() }); bridge.save(record);
    if (queued) {
      bridge.emit('thread/queue/changed', { threadId });
      bridge.log('queue.accepted', { threadId, turnId, queuedSubmissionId: turn.queuedSubmissionId, queueLength: record.queue.length });
    }
    bridge.log('turn.started', { threadId, turnId, model: record.model, provider: 'native' });
    return;
  }
  if (!turn) return;
  if (method === 'item/started' || method === 'item/completed') {
    const item = structuredClone(params.item);
    // Match each user message separately: steering gives one turn several
    // inputs. Never replace the first input with the next steering message.
    let index = turn.items.findIndex(i => i.id === item.id);
    if (item.type === 'userMessage') {
      const submissions = [{ clientUserMessageId: turn.clientUserMessageId, nativeUserMessageId: turn.nativeUserMessageId, initial: true }, ...(turn.steering ?? [])];
      const submitted = submissions.find(s => s.nativeUserMessageId === item.id
        || (s.clientUserMessageId && [item.id, item.clientId].includes(s.clientUserMessageId)))
        ?? (index < 0 && !item.clientId ? submissions.find(s => !s.nativeUserMessageId) : null);
      if (submitted) {
        if (index < 0) index = turn.items.findIndex(i => i.type === 'userMessage' && i.id === submitted.clientUserMessageId);
        if (submitted.initial) turn.nativeUserMessageId = item.id;
        else { submitted.nativeUserMessageId = item.id; submitted.status = 'delivered'; }
      }
    }
    if (index < 0) turn.items.push(item); else turn.items[index] = item;
    bridge.save(record);
  } else if (method === 'item/agentMessage/delta') {
    const item = turn.items.find(i => i.id === params.itemId);
    if (item) item.text = (item.text ?? '') + params.delta;
  } else if (method === 'turn/completed') {
    if (bridge.nativeCompletions.has(turnId)) return bridge.nativeCompletions.get(turnId);
    if (turn.status !== 'inProgress') return;
    const completion = (async () => {
      try {
        const items = []; let cursor;
        do {
          const page = await bridge.native.request('thread/items/list', { threadId, turnId, sortDirection: 'asc', limit: 100,
            ...(cursor ? { cursor } : {}) });
          items.push(...page.data.map(row => row.item)); cursor = page.nextCursor;
        } while (cursor);
        if (items.length) {
          for (const receipt of turn.steering ?? []) {
            const item = items.find(i => i.type === 'userMessage' && (i.clientId === receipt.clientUserMessageId || i.id === receipt.nativeUserMessageId));
            if (item) { receipt.nativeUserMessageId = item.id; receipt.status = 'delivered'; }
          }
          // A late/missing hydration result must not erase accepted input.
          const missing = turn.items.filter(i => i.type === 'userMessage' && !items.some(n => n.id === i.id
            || (i.clientId && n.clientId === i.clientId)));
          turn.items = [...items, ...missing];
        }
      } catch (error) {
        // Streaming items are retained if history hydration is temporarily unavailable.
        bridge.log('history.native_hydration_failed', { threadId, turnId, ...errorMetadata(error) });
      }
      const { items, itemsView, ...state } = params.turn;
      Object.assign(turn, state, { itemsView: 'full' });
      if (turn.status === 'failed') record.nativeResetRequired = true;
      if (!bridge.pendingSteers.has(threadId)) settleSteering(bridge, record, turn);
      record.updatedAt = Math.floor(Date.now() / 1000);
      if (bridge.active.get(threadId)?.turn.id === turnId) {
        bridge.active.get(threadId).controller?.abort(); bridge.active.delete(threadId);
      }
      bridge.save(record);
      bridge.log('turn.finished', { threadId, turnId, status: turn.status, provider: 'native', ...(turn.error ? errorMetadata(turn.error) : {}) });
      continueQueue(bridge, record, turn.status);
    })();
    bridge.nativeCompletions.set(turnId, completion);
    try { await completion; } finally { bridge.nativeCompletions.delete(turnId); }
  }
}
