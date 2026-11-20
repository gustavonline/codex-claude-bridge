import { acceptQueued, continueQueue } from './queue.mjs';
import { handoffContext, withEffort } from './providers.mjs';
import { noticeContext, validNotice } from './transition-notice.mjs';
import { errorMetadata } from './logging.mjs';
import { neverSent } from './rpc.mjs';
import { settleSteering } from './steering.mjs';
import { randomUUID } from 'node:crypto';

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

export async function beginNative(bridge, record, params, admit) {
  await resetNativeHistory(bridge, record);
  // The history reset is this path's last await before dispatch: check the
  // caller's admission again here (bridge.prepareTurn). A refusal leaves the
  // reset in place, which the next native turn needs anyway.
  admit?.();
  // The public client ID is optional. Give our provisional item and the native
  // host the same identity even when the caller supplies none.
  params = { ...params, clientUserMessageId: params.clientUserMessageId ?? randomUUID() };
  const threadId = record.thread.id;
  let context = record.nativeResetRequired ? handoffContext(record.turns, params.additionalContext) : params.additionalContext;
  // A model-change note the model has not yet seen (trusted application context); cleared once the turn is really accepted by the host.
  const notice = validNotice(record.transitionNotice) && record.transitionNotice.pending === true ? record.transitionNotice : null;
  if (notice) context = { ...(context ?? {}), bridge_transition: noticeContext(notice) };
  if (record.nativeHistoryHasLegacySeeds && !record.legacyHistoryNoticeShown) {
    bridge.emit('warning', { threadId, message: 'This older prototype chat may retain earlier prompt copies on its native host. For a clean GPT context after editing old messages, fork this chat first. New chats and forks do not have this limitation.' });
    record.legacyHistoryNoticeShown = true; bridge.save(record);
  }
  if (record.nativeHistoryHasLegacySeeds && context?.bridge_history_rules)
    context.bridge_history_rules.value += ' This legacy host may contain obsolete prompt copies. Only the retained bridge_conversation reference defines which historical requests belong to this chat.';
  // The dispatch that carries a model-change note is an OBLIGATION from before it is sent: this chat's own record, the stable client message id, the note and the selection it announces are made
  // durable first (fail closed: if that cannot be saved, nothing is sent). An outcome that is not known afterwards (a lost answer, an error answer, a timeout, an abort, a restart) stays recorded and
  // HOLDS the next dispatch until the thread's public record positively shows this client id (Bridge.resolveNativeAttempt, run at the start of prepareTurn, before anything is reset or sent).
  const dispatchId = params.clientUserMessageId;
  if (notice) {
    record.nativeAttempt = { threadId, clientUserMessageId: dispatchId, noticeId: notice.id, notice: structuredClone(notice), to: bridge.recordSelection(record), carriedHistory: !!record.nativeResetRequired, state: 'dispatched' };
    try { bridge.save(record); }
    catch { delete record.nativeAttempt; throw bridge.contextRefusal('context_state_unwritable', 'Model Bridge could not save its record for this chat, so nothing was sent. Try again.'); }
  }
  bridge.nativeStarts.set(threadId, params);
  try {
    const { queuedSubmissionId, ...request } = params;
    let result;
    try {
      // The level that runs is the chat's accepted one (record.effort, chosen by Bridge.selection from the model's advertised levels). The request's own collaborationMode.settings.reasoning_effort
      // is brought to the same level: native honours the nested one, so a stale client value (a 'none' of an earlier provider) must never contradict the accepted selection on the wire.
      result = await bridge.native.request('turn/start', { ...withEffort({ ...request, model: record.model, effort: record.effort }, record.effort),
        ...(context ? { additionalContext: context } : {}) });
    } catch (error) {
      // ONLY a trusted local proof that the request was never written (rpc.mjs neverSent) retires the attempt; every other failure is unknown and the attempt stays.
      if (notice && neverSent(error) && record.nativeAttempt?.clientUserMessageId === dispatchId) {
        const kept = record.nativeAttempt; delete record.nativeAttempt;
        try { bridge.save(record); } catch { record.nativeAttempt = kept; }
      }
      throw error;
    }
    // accepted by the host: this note (and only this one) is consumed; a newer selection change merged meanwhile is still owed
    if (notice) bridge.settleNoticeAttempt(record, 'nativeAttempt');
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
