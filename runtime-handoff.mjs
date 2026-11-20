// Moves a chat to another provider or runtime as a NEW thread, without touching the source.
//
// The sequence is the same for every target (custom endpoint, native GPT, managed Claude); the
// target-specific steps are supplied as an adapter by the router or the Bridge. Everything that can be
// refused is refused BEFORE a thread exists: idle source, readable complete history, a transfer that fits.
// After the target exists, every step is confirmed by reading back, and a failure BEFORE the commit removes only the thread
// this call created. If that cleanup cannot be confirmed, the single intent records it (archive_pending) and a repeat is refused.
// A failure whose commit may have happened (error.uncertain) or whose intent could not be aborted (error.deferCleanup) triggers
// NO cleanup at all: no archive, no deletion, no receipt; the intent is the one authority and recovery decides.
//
// Guarantees (each is tested): the source thread, its history, its permissions and its route are never
// changed; no prompt is sent and no model is called; no tool is run; no encrypted or provider-private data
// is carried (see continuity.mjs); permissions of the new thread are read back and must equal the source's.
import { buildTransfer, chunks, provenance } from './continuity.mjs';

// `wantedEffort` is a level, null, or a function of the started target's answer (for a choice that depends on what the target turned out to be, e.g. the same model
// under another name); it is applied and read back exactly like an explicit one.
export async function runtimeHandoff({ sourceId, before, turns, adapter, fail, wantedEffort: asked = null }) {
  if (adapter.pending?.()) fail('native_thread_created_but_route_not_saved'); // an earlier outcome is unresolved: never blind-retry
  const source = before?.thread;
  if (source?.id !== sourceId) fail('native_thread_identity_invalid');
  if (source.status?.type !== 'idle') fail('model_change_requires_idle');
  let transfer; // (`let`: the model input of the target may be replaced by a qualified reduction below; the canonical turns never are)
  try { transfer = buildTransfer(turns); }
  catch (error) { if (error.code) fail(error.code); throw error; }
  adapter.checkOverrides?.(before);

  let created = null, answer;
  const archived = async () => { try { return created ? await adapter.archive(created) : true; } catch { return false; } };
  const abandon = async code => {
    const cleaned = await archived();
    if (!cleaned && created) adapter.receipt({ version: 1, sourceId, forkId: created, state: code, archived: false });
    try { fail(code); } catch (error) { error.handled = true; throw error; }
  };
  try {
    answer = await adapter.start();
    const id = answer?.thread?.id;
    if (typeof id === 'string' && id !== sourceId) created = id;
    if (!created || !adapter.confirm(answer, before)) return await abandon('native_selection_not_confirmed');
    if (!adapter.permissionsKept(before, answer)) return await abandon('native_permissions_changed');
    let confirmed = answer, deferred = false;
    const wantedEffort = typeof asked === 'function' ? asked(answer) : asked;
    const effortHolds = result => result.reasoningEffort === wantedEffort && adapter.confirm({ ...answer, ...result, thread: answer.thread }, before) && adapter.permissionsKept(before, { ...answer, ...result });
    if (wantedEffort != null && answer.reasoningEffort !== wantedEffort) {
      if (adapter.readEffort) {
        // A freshly started native thread has no rollout yet and cannot be resumed (read back) until it has metadata or items. The level is APPLIED now, in the same place as always, but its
        // readback waits for the one point where the thread exists for real: after the delivery and the private naming below (the existing public lifecycle, nothing extra is written).
        await adapter.applyEffort(created, wantedEffort, answer); deferred = true;
      } else {
        confirmed = await adapter.setEffort(created, wantedEffort, answer);
        if (!effortHolds(confirmed)) return await abandon('native_selection_not_confirmed');
      }
    }
    // What the target's MODEL receives. The canonical turns (transfer.turns) are always complete; only the model input may be a reduction, and only when the adapter has a
    // qualified reason (a known window of that exact target and a provider-written summary: see context-handoff.mjs decide). The adapter refuses (error.code) when a known window
    // cannot hold a safe input: the target is withdrawn like any other failure before the commit, nothing is clipped or dropped.
    if (adapter.reduce) {
      let chosen;
      try { chosen = await adapter.reduce(transfer, answer); }
      catch (error) { if (error?.code) return await abandon(error.code); throw error; }
      // A reduction replaces the model input; a FULL input may still carry the source-bound summary beside the complete turns (so a later hand-off can use it).
      if (chosen) transfer = { ...transfer, handoff: chosen, ...(chosen.mode === 'reduced' ? { modelItems: chosen.items } : {}), ...(chosen.context ? { context: chosen.context } : {}) };
    }
    const delivered = transfer.modelItems ?? transfer.items;
    // The carried conversation reaches the new runtime only as plain items, in chunks, in order.
    // A target that takes the canonical history as ONE typed whole (a managed Claude chat imports transfer.turns once, and refuses a second import into a chat that is no longer empty)
    // supplies deliverAll instead of deliver: it is called exactly once with the whole transfer, never per chunk. Nothing is delivered twice and nothing is skipped; an empty
    // transfer delivers nothing in either form.
    if (adapter.deliverAll) { if (delivered.length) await adapter.deliverAll(created, transfer); }
    else for (const part of chunks(delivered)) await adapter.deliver(created, part, transfer);
    // A new private thread is not enumerable (and, with no history, not even durable) in native after a cold start until it has metadata: the adapter may
    // name it privately, empty or not (never shown, never sent to a model). Always after the delivery, before the commit.
    await adapter.persistPrivate?.(created, transfer.items.length === 0);
    if (deferred) { // the deferred level, read back exactly like an immediate one: anything else withdraws the new thread
      confirmed = await adapter.readEffort(created, answer);
      if (!effortHolds(confirmed)) return await abandon('native_selection_not_confirmed');
    }
    // The target's FINAL authoritative readback (applying what the person asked for, then reading it back and comparing it with the accepted source and the expected target)
    // is an await of its own: it runs BEFORE the source is validated again, so nothing it takes time over can go unnoticed.
    await adapter.settle?.(created, { ...answer, ...confirmed, thread: answer.thread });
    // The one transition note for the receiving model, built from what the readback just confirmed. It is staged here, inside the still-unpublished private target: nothing can run
    // on that target before the commit below, so a failed or withdrawn switch means no model ever consumed it. It stays AFTER every await of the target and BEFORE the source is validated.
    await adapter.deliverNotice?.(created, { answer, confirmed: { ...answer, ...confirmed, thread: answer.thread }, transfer });
    await adapter.revalidate?.(); // connection, route, source activity, queue and history may have changed while this ran
    const record = provenance({ sourceId, sourceProvider: before.modelProvider, sourceModel: before.model, targetProvider: answer.modelProvider, targetModel: answer.model, targetId: created, transfer });
    try { await adapter.publish(answer, { ...confirmed, reasoningEffort: confirmed.reasoningEffort ?? answer.reasoningEffort }, transfer, record); }
    catch (error) {
      error.handled = true;
      // Once the commit may have happened (uncertain), or the intent could not be marked aborted (deferCleanup), NOTHING is archived,
      // deleted or recorded from here: the single intent is the authority and recovery owns the outcome. The error keeps its own code.
      if (error.uncertain || error.deferCleanup) throw error;
      const cleaned = await archived();
      if (!cleaned) adapter.receipt({ version: 1, sourceId, forkId: created, state: 'not_published', archived: false });
      throw error;
    }
    return { answer: { ...answer, reasoningEffort: confirmed.reasoningEffort ?? answer.reasoningEffort }, created, transfer, provenance: record };
  } catch (error) {
    if (created && !error.handled) {
      const cleaned = await archived();
      if (!cleaned) adapter.receipt({ version: 1, sourceId, forkId: created, state: 'failed_after_create', archived: false });
      error.handled = true;
    }
    throw error;
  }
}
