import { RpcError } from './rpc.mjs';
import { provider } from './providers.mjs';
import { resetNativeHistory } from './native-turns.mjs';

export function forkCount(record, params) {
  if (record.thread.ephemeral) throw new RpcError('Ephemeral chats do not support persistent forks', -32602);
  if (params.path) throw new RpcError('Fork bridge chats by threadId, not an alternative history path', -32602);
  if (params.experimentalPredictionMode || params.ephemeral)
    throw new RpcError('A persistent conversation fork is required for this bridge', -32602);
  if (params.beforeTurnId && params.lastTurnId) throw new RpcError('Choose beforeTurnId or lastTurnId, not both', -32602);
  const activeIndex = record.turns.findIndex(t => t.status === 'inProgress');
  const settled = activeIndex < 0 ? record.turns.length : activeIndex;
  let count = settled;
  const anchor = params.beforeTurnId ?? params.lastTurnId;
  if (anchor) {
    const index = record.turns.findIndex(t => t.id === anchor);
    if (index < 0) throw new RpcError('Fork boundary does not belong to this conversation', -32602);
    count = index + (params.lastTurnId ? 1 : 0);
  }
  if (count > settled) throw new RpcError('Fork before the active turn or wait for it to finish', -32602);
  return count;
}

export async function forkThread(bridge, record, params) {
  const count = forkCount(record, params);
  bridge.log('thread.fork_requested', { threadId: record.thread.id, retainedTurns: count,
    reason: params.beforeTurnId ? 'before_turn' : params.lastTurnId ? 'through_turn' : 'settled_prefix' });
  const selected = await bridge.selection(record, params);
  const claudeSessionId = selected.provider === 'native' || record.turns[count - 1]?.provider === 'native' || (params.cwd && params.cwd !== record.thread.cwd)
    ? undefined : await bridge.history.before(record, count);
  // Claude owns the turn IDs. The native fork supplies a separate real tool
  // host with native workspace/permissions and native fork metadata.
  const { beforeTurnId, lastTurnId, ...nativeParams } = params;
  const legacy = record.nativeHistoryHasLegacySeeds;
  const hostProvider = record.nativeProvider
    ?? (await bridge.native.request('config/read', { cwd: record.thread.cwd, includeLayers: false })).config.model_provider ?? 'openai';
  const request = { ...(legacy ? record.options : {}), ...nativeParams,
    model: selected.provider === 'native' ? selected.model : record.nativeModel,
    modelProvider: hostProvider, excludeTurns: true };
  if (legacy) {
    delete request.threadId; delete request.excludeTurns;
    if (params.permissions) delete request.sandbox;
    if (params.sandbox) delete request.permissions;
  }
  // Old prototypes injected user text outside native turn boundaries. Public
  // revert cannot erase that prelude; a new real host gives the fork clean context.
  const result = await bridge.native.request(legacy ? 'thread/start' : 'thread/fork', request);
  const options = { ...structuredClone(record.options), ...Object.fromEntries(Object.entries(nativeParams).filter(([, v]) => v != null)),
    model: selected.model, modelProvider: result.modelProvider ?? hostProvider, cwd: result.thread.cwd };
  if (params.permissions) delete options.sandbox;
  if (params.sandbox) delete options.permissions;
  for (const key of ['threadId', 'path', 'beforeTurnId', 'lastTurnId', 'excludeTurns']) delete options[key];
  const child = { ...structuredClone(record), ...selected, thread: { ...result.thread, forkedFromId: record.thread.id }, options,
    sandbox: result.sandbox, approvalPolicy: result.approvalPolicy, activePermissionProfile: result.activePermissionProfile,
    instructionSources: result.instructionSources ?? record.instructionSources, disabledPluginIds: result.disabledPluginIds ?? record.disabledPluginIds,
    turns: structuredClone(record.turns.slice(0, count)), claudeSessionId, loadedTools: [], queue: [], nativeQueueMigration: [], sessionForks: {}, resumePaths: [], archived: false,
    nativeProvider: result.modelProvider ?? hostProvider, hostProvider: result.modelProvider ?? hostProvider,
    nativeModel: result.model ?? record.nativeModel, nativeEffort: result.reasoningEffort ?? record.nativeEffort,
    approvalsReviewer: result.approvalsReviewer ?? record.approvalsReviewer,
    nativeResetRequired: true,
    updatedAt: Math.floor(Date.now() / 1000) };
  if (legacy) Object.assign(child, { bridgeForkedFromId: record.thread.id, nativeHistoryHasLegacySeeds: false,
    neutralNativeSeed: true, nativeFirstTurnId: undefined, nativePersisted: false, legacyHistoryNoticeShown: false });
  // The native fork copies the host's history; strip its model turns before
  // supplying the independently selected bridge prefix on a later GPT turn.
  try { await resetNativeHistory(bridge, child); }
  catch (error) {
    await bridge.native.request('thread/archive', { threadId: child.thread.id }).catch(() => {});
    throw error;
  }
  bridge.records.set(child.thread.id, child); bridge.loaded.add(child.thread.id); bridge.save(child);
  bridge.log('thread.forked', { threadId: child.thread.id, sourceThreadId: record.thread.id, retainedTurns: count });
  return { ...result, model: child.model, modelProvider: provider(child), reasoningEffort: child.effort,
    thread: bridge.thread(child, !params.excludeTurns) };
}
