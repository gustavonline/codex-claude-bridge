#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { EventEmitter } from 'node:events';
import { Peer, RpcError, neverSent } from './rpc.mjs';
import { createLogger, errorMetadata, unsafeActivity } from './logging.mjs';
import { models, codexModels, startQuery, contextFragments } from './claude.mjs';
import { instructions, makeTools, permissionState } from './capabilities.mjs';
import { HistoryError, historyBinding, historyFailure, historyNamespace, historyRef, mergeCarried, readHistory, withHistoryTools } from './history-read.mjs';
import { BudgetStore, PrivateMap, claudeContext, contextTokens, decide, estimateTokens, fitsAtDispatch, gateDone, planBudget, qualifyNativeWindow, qualifySdkCompaction, qualifyUsage, requestTokensOf, validContext, validGate, validSummary } from './context-handoff.mjs';
import { durability } from './plugins/codex-claude/home/providers.mjs';
import { buildNotice, noticeContext, noticeId, noticeItem, nextNotice, sameSelection, validNotice } from './transition-notice.mjs';
import { sessionHistory } from './history.mjs';
import { queueRequest, acceptQueued, continueQueue, restoreQueue, adoptQueue } from './queue.mjs';
import { forkThread } from './fork.mjs';
import { configurationMirror } from './mirror.mjs';
import { beginNative, captureNative } from './native-turns.mjs';
import { isClaude, provider, nativeSelection, adoptNativeThread, finishQueueMigration, reloadNativeHost, handoffContext, legacyClaudeHost, nativeModels, advertisedLevels, chooseEffort, normalizeNativeEffort } from './providers.mjs';
import { sessionCall, sessionNamespace, withSessionTools } from './sessions.mjs';
import { messageStream, submission, steerTurn, steeringResult, settleSteering } from './steering.mjs';
import { claudeDecision, claudeDenial, mergeClaudeModels, normalizeModels, recordCatalog, recordOffered, storedModels } from './connections.mjs';
import { ResponsesRouter } from './plugins/codex-claude/home/providers.mjs';
import { harnessRefusal, isHarnessModel, parseHarnessModelId } from './plugins/codex-claude/home/harnesses.mjs';
import { readAllTurns } from './continuity.mjs';
import { runtimeHandoff } from './runtime-handoff.mjs';
import { overlayHistory, pageTurns, pageItems } from './custom-turns.mjs';

const now = () => Math.floor(Date.now() / 1000);
const clone = value => structuredClone(value);
const publicTurn = ({ claudePromptId, claudeSessionId, claudeCheckpoint, noticeId: _noticeId, noticeAudit: _noticeAudit, queuedSubmissionId, provider, clientUserMessageId, submittedInput, steering, nativeUserMessageId, ...turn }) => turn;
const envelope = turn => ({ ...publicTurn(turn), items: [], itemsView: 'notLoaded' });
const workspacePath = path => { try { return realpathSync(path); } catch { return resolve(path); } };
// ---- the history tool's caller identity (see Bridge.historyToolCall) ----------------------------------------------------------------
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stableJson = value => JSON.stringify(value, (key, x) => isObject(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
// The settings a runtime itself confirmed for a thread (its start / resume / fork answer, or its own settings event). Anything missing makes the scope UNKNOWN (null):
// it is never completed from the cwd, a default or an earlier value.
// The runtime's OWN workspace roots (runtimeWorkspaceRoots of its start / resume / fork answer) are part of the scope: the boundary a turn runs in is the cwd, the full
// sandbox policy AND those roots. A scope whose roots the runtime did not report is not confirmed (never inferred from the cwd, a request or an earlier value).
const rootList = value => Array.isArray(value) && value.length <= 256 && value.every(r => typeof r === 'string' && r !== '') ? [...value].sort() : null;
const canonicalRoots = roots => roots.map(r => { try { return realpathSync(r); } catch { return r; } }).sort();
const confirmedScope = value => isObject(value) && typeof value.cwd === 'string' && value.cwd !== '' && isObject(value.sandbox) && value.approvalPolicy != null && rootList(value.runtimeWorkspaceRoots)
  && typeof value.approvalsReviewer === 'string' && value.activePermissionProfile !== undefined && Array.isArray(value.disabledPluginIds)
  ? { cwd: value.cwd, sandbox: clone(value.sandbox), approvalPolicy: clone(value.approvalPolicy), approvalsReviewer: value.approvalsReviewer, activePermissionProfile: clone(value.activePermissionProfile), disabledPluginIds: [...value.disabledPluginIds],
    roots: rootList(value.runtimeWorkspaceRoots), stale: false,
    // (what the runtime reports for its own model: not part of the scope key; a window declared for it is only valid for exactly this provider and model)
    model: typeof value.model === 'string' ? value.model : null, modelProvider: typeof value.modelProvider === 'string' ? value.modelProvider : null } : null;
// The workspace (real path), the runtime's confirmed roots and the permission state a turn runs under, as one comparable string; null when it is not confirmed
// (unresolvable workspace, unknown roots, or a request that may have changed it and that the runtime has not yet confirmed: `stale`).
const scopeKey = scope => {
  if (!scope || scope.stale || !rootList(scope.roots)) return null;
  try { return stableJson([realpathSync(scope.cwd), canonicalRoots(scope.roots), scope.sandbox, scope.approvalPolicy, scope.approvalsReviewer, scope.activePermissionProfile ?? null, scope.disabledPluginIds]); } catch { return null; }
};
// A config override that can touch permissions or the workspace.
const permissionConfigKey = /^(sandbox|permissions|default_permissions|approval|projects|workspace|environments?)([._]|$)/i;
const originValid = (bridge, origin) => isObject(origin) && origin.peer instanceof Peer && !origin.peer.closed
  && (origin.kind === 'native' ? origin.peer === bridge.native : origin.kind === 'custom' && /^[a-f0-9]{32}$/.test(origin.connectionId ?? '') && origin.peer !== bridge.native);
const historyDenied = (code, message) => { throw new HistoryError(code, message); };
const MAX_HISTORY_CALLERS = 256, MAX_HISTORY_SCOPES = 512, HISTORY_READ_BYTES = 64 * 1024 * 1024;
// A native / custom thread's model-change note that its model has not seen yet, kept across a cold start (see Bridge.acceptSelection).
const validSelection = value => isObject(value) && isObject(value.route) && typeof value.route.kind === 'string' && typeof value.model === 'string' && (value.effort === null || typeof value.effort === 'string');
// seen: what the model last saw. now: the accepted selection. pending: the note it is owed (null if none). intent: a change asked of the runtime whose outcome is not known. dispatching: the turn
// (stable client id) that carries the note, written BEFORE it is sent, until its outcome is known.
const validOutbox = value => isObject(value) && ['native', 'custom'].includes(value.kind) && validSelection(value.seen) && validSelection(value.now) && Number.isInteger(value.seq)
  && (value.pending == null || validNotice(value.pending)) && (value.intent == null || (isObject(value.intent) && validSelection(value.intent.to)))
  && (value.dispatching == null || (isObject(value.dispatching) && typeof value.dispatching.noticeId === 'string' && typeof value.dispatching.clientId === 'string' && validSelection(value.dispatching.from) && validSelection(value.dispatching.to)));
// The most pages of a thread's public record that are read to settle an uncertain dispatch (100 turns each, newest first): a bound reached with more to read is "undetermined", never "absent".
const RECONCILE_PAGES = 50;
const owesState = value => !!(value.pending || value.intent || value.dispatching);
// Is this SDK message the MODEL answering the query of this attempt? Per the public SDK types (SDKAssistantMessage, SDKPartialAssistantMessage): a message of the MAIN agent (parent_tool_use_id
// null), of the attempt's own KNOWN session, that is bound to THIS prompt by the wrapper's public join (user_message_uuid, or user_message_uuids containing the prompt uuid), and that is either an
// assistant message (role assistant, no error, content blocks) or a message_start, carrying a named, non-synthetic actual model (aliases need not equal it: the model that answered is whatever the
// provider resolved). The first assistant message of a turn can be a synthetic API-error message: it names the synthetic model / carries an error and is never an answer. A result message - success
// included, which may be a local command - is never an answer, and an absent join or model is no receipt: nothing is assumed to make an old stream shape pass.
const realModel = model => typeof model === 'string' && model !== '' && model !== '<synthetic>';
const promptJoined = (message, attempt) => typeof attempt.promptId === 'string' && attempt.promptId !== '' && (message.user_message_uuid === attempt.promptId || (Array.isArray(message.user_message_uuids) && message.user_message_uuids.includes(attempt.promptId)));
const noticeAck = (message, attempt) => {
  if (!isObject(message) || message.parent_tool_use_id !== null || typeof attempt.sessionId !== 'string' || attempt.sessionId === '' || message.session_id !== attempt.sessionId || !promptJoined(message, attempt)) return false;
  if (message.type === 'assistant') { const m = message.message; return !message.error && isObject(m) && m.role === 'assistant' && Array.isArray(m.content) && realModel(m.model); }
  if (message.type === 'stream_event') { const m = message.event?.message; return message.event?.type === 'message_start' && isObject(m) && realModel(m.model); }
  return false;
};
// A result message of the attempt's own session: the owner query reached its end (success or error). It is a TERMINAL fact, never an answer.
const ownResult = (message, attempt) => isObject(message) && message.type === 'result' && typeof attempt.sessionId === 'string' && attempt.sessionId !== '' && message.session_id === attempt.sessionId;
const sameRoute = (a, b) => a?.kind === b?.kind && (a?.connectionId ?? null) === (b?.connectionId ?? null);
const mergeOptions = (previous, params) => {
  const next = { ...previous, ...Object.fromEntries(Object.entries(params).filter(([, value]) => value != null)) };
  if (params.permissions) delete next.sandbox;
  if (params.sandbox) delete next.permissions;
  return next;
};

// Which peer a notification from the desktop belongs to. The desktop names a conversation by its logical ID; the peer that owns
// its CURRENT physical thread (a routed custom connection, or the native parent) must receive it under that thread's own ID.
// Returns { params, route } or null when the link cannot be read: a notification is then dropped, never given to a peer that may be wrong.
export function desktopNotificationOwner(bridge, params, log = () => {}) {
  try {
    const physical = bridge?.localResponses?.physicalOf(params?.threadId);
    const target = physical && physical !== params.threadId ? { ...params, threadId: physical } : params;
    return { params: target, route: bridge?.localResponses?.readRoute(target?.threadId) ?? null };
  } catch (error) { log('link.unreadable', errorMetadata(error)); return null; }
}

export class Bridge {
  // connectionRoot is the explicit launch root that holds connections.json; without it no
  // connection decision exists and Claude Code behaves as it always has.
  constructor({ native, desktop, statePath, getModels = models, runQuery = startQuery, history = sessionHistory(), log = () => {}, coordinateNative = false, connectionRoot = null, credentialBindings = null, providerNative = null }) {
    Object.assign(this, { native, desktop, statePath, getModels, runQuery, history, log, coordinateNative, connectionRoot });
    // Unmanaged GPT chats that received the session tools (primary mode only).
    // Their native host owns them; this keeps only what coordination checks.
    this.nativeCallers = new Map();
    // History-tool callers (native and custom threads), separate from nativeCallers (which is session coordination only and is not changed):
    // physical thread -> { peer, origin, turnId, controller, scopeKey }, set only by a turn/started that arrived on that peer and ended by its
    // turn/completed, close or abort. historyScopes: physical thread -> the settings that thread's OWN runtime confirmed (see observeNative).
    this.historyCallers = new Map(); this.historyScopes = new Map();
    // The paging-cursor codec (history-read.mjs): undefined = this process's own in-memory key. A test replaces it to stand for a restart (stable refs must not care).
    this.historyCodec = undefined;
    // Context windows of exact route+model pairs (measured or declared by that provider, with their source and time), a private bounded file beside the state; and, for the
    // native / custom threads this process has seen, the selection each model last SAW and the transition note it has not yet received (see transition-notice.mjs).
    this.budgets = new BudgetStore(join(statePath, 'context-budgets.json'));
    // Durable across a cold start: the first-request gate of a reduced hand-off, and a model-change note not yet delivered to a native / custom thread.
    // (Both are critical: durable with the same injectable fsync the router's own writes use, never evicting an obligation, never reading damage as empty - see PrivateMap.)
    const sync = fd => durability.sync(fd); this.gatesDone = new Set();
    this.gates = new PrivateMap(join(statePath, 'context-gates.json'), { limit: 256, valid: validGate, sync, inactive: gateDone });
    this.outbox = new PrivateMap(join(statePath, 'context-notices.json'), { limit: 1024, valid: validOutbox, sync, inactive: value => !owesState(value) });
    this.selections = new Map(); this.reducedPending = new Map();
    this.records = new Map(); this.active = new Map(); this.loaded = new Set(); this.starting = new Set();
    this.localResponses = connectionRoot ? new ResponsesRouter({ root: connectionRoot, native, managed: id => this.records.has(id), credentialBindings, nativeFor: providerNative, notify: (method, params) => this.emit(method, params),
      continuity: { runtimeHandoff, readAllTurns, overlayHistory, pageTurns, pageItems, withHistoryTools, context: this.contextKit() }, managedSource: id => this.managedSource(id), managedRoots: id => this.managedRoots(id), claudeTarget: this.claudeContinuationTarget() }) : null;
    this.reverting = new Set();
    this.changing = new Set(); this.pendingStarts = new Map(); this.pendingSteers = new Map(); this.resuming = new Map();
    this.settingsWaiters = new Map();
    this.closeWaiters = new Map();
    this.nativeStarts = new Map(); this.nativeCompletions = new Map(); this.internalReverts = new Map();
    this.adopting = new Set();
    this.sessionEvents = new EventEmitter();
    mkdirSync(statePath, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(statePath).filter(f => /^[\da-f-]+\.json$/.test(f))) {
      let record, recovered = false;
      try { record = JSON.parse(readFileSync(join(statePath, file), 'utf8')); }
      catch (error) { this.log('state.restore_failed', { threadId: file.slice(0, -5), ...errorMetadata(error) }); throw error; }
      record.nativeHistoryHasLegacySeeds ??= !record.neutralNativeSeed && record.turns.length > 0;
      if (!record.options.dynamicTools?.some(t => t.name === sessionNamespace)) record.options = withSessionTools(record.options);
      // A managed GPT chat is rebuilt from its retained transcript after a
      // backend restart; provider response-cache IDs may no longer be valid.
      if (record.provider === 'native') record.nativeResetRequired = true;
      for (const turn of record.turns) if (turn.status === 'inProgress') {
        recovered = true;
        this.log('turn.recovered_interrupted', { threadId: record.thread.id, turnId: turn.id, queueLength: record.queue?.length ?? 0 });
        turn.status = 'interrupted'; turn.error = { message: 'Bridge stopped before this turn completed.', codexErrorInfo: 'other' };
        for (const item of turn.items) if (item.type === 'mcpToolCall' && item.status === 'inProgress')
          Object.assign(item, { status: 'failed', error: { message: 'Bridge stopped before receiving the tool result; an external action may already have run.' } });
      }
      for (const turn of record.turns) if (turn.steering?.some(s => s.status === 'accepted')) {
        recovered = true; settleSteering(this, record, turn);
      }
      this.records.set(record.thread.id, record);
      // A restored queue is settled against the connection decision and its generation now, so a disable the
      // Bridge never saw (or one still in force) is a saved pause before anything can continue it.
      restoreQueue(this, record);
      // Persist recovery immediately so a later CLI stop/status does not mistake
      // the old on-disk inProgress flag for work still executing after a crash.
      if (recovered) this.save(record);
    }
    this.log('bridge.ready', { restoredThreads: this.records.size });
  }
  save(record) {
    if (record.thread.ephemeral) return;
    const target = join(this.statePath, `${record.thread.id}.json`);
    try { writeFileSync(target + '.tmp', JSON.stringify(record), { mode: 0o600 }); renameSync(target + '.tmp', target); }
    catch (error) { this.log('state.save_failed', { threadId: record.thread.id, ...errorMetadata(error) }); throw error; }
  }
  // A managed chat as a continuation source: its own visible turns and settings. Nothing here is changed by a continuation.
  managedSource(id) {
    const record = this.records.get(id);
    if (!record) return null;
    const busy = this.active.has(id) || this.starting.has(id) || this.changing.has(id) || this.reverting.has(id) || this.pendingSteers.has(id) || record.turns.some(t => t.status === 'inProgress');
    // sdkHost: the SDK really executes this chat (provider claude_code, not a record that now runs a native model) and its native host thread has been used (the private host
    // placeholder was injected on its first run, or turns exist): that host must never become a GPT model's own thread.
    const sdkHost = provider(record) === 'claude_code' && (record.nativePersisted === true || record.turns.length > 0);
    // compaction / contextSummary: the provider-written summaries this chat holds (its own, and the one a reduced hand-off into it carried): read only, never changed by a transfer.
    return { turns: clone(record.turns), legacyHost: legacyClaudeHost(record), sdkHost, compaction: clone(record.compaction ?? null), contextSummary: clone(record.contextHandoff?.summary ?? null), snapshot: { queue: clone(record.queue ?? []), thread: { ...clone(record.thread), updatedAt: record.updatedAt, status: { type: busy ? 'active' : 'idle' } }, model: record.model, modelProvider: provider(record),
      reasoningEffort: record.effort, cwd: record.thread.cwd, sandbox: record.sandbox, approvalPolicy: record.approvalPolicy,
      approvalsReviewer: record.approvalsReviewer ?? 'user', activePermissionProfile: record.activePermissionProfile ?? null,
      ...(Array.isArray(record.runtimeWorkspaceRoots) ? { runtimeWorkspaceRoots: record.runtimeWorkspaceRoots } : {}) } };
  }
  // The Claude side of a continuation from another runtime: a NEW managed chat whose first Claude turn receives the
  // carried visible turns once (handoffContext). The source runtime is never touched.
  claudeContinuationTarget() {
    const defined = value => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
    return {
      start: params => this.request('thread/start', params, { localRouted: true }),
      setEffort: async (id, effort) => {
        await this.request('thread/settings/update', { threadId: id, effort }, { localRouted: true });
        const r = this.records.get(id);
        return defined({ reasoningEffort: r.effort, model: r.model, modelProvider: 'claude_code', sandbox: r.sandbox, approvalPolicy: r.approvalPolicy, approvalsReviewer: r.approvalsReviewer, activePermissionProfile: r.activePermissionProfile });
      },
      import: async (id, transfer) => {
        const record = this.records.get(id);
        if (!record || record.turns.length) throw new RpcError('The new chat is not empty.', -32602);
        record.turns = transfer.turns.map(turn => ({ ...clone(turn), provider: 'imported',
          ...(turn.status === 'inProgress' ? { status: 'interrupted', error: { message: 'This earlier turn had not finished.', codexErrorInfo: 'other' } } : {}) }));
        record.claudeSessionId = undefined; record.nativeResetRequired = false;
        // A REDUCED hand-off: the record keeps every canonical turn; only the first query's context is the reduction (a summary written by the previous model, whole recent and newer turns).
        if (transfer.context) record.contextHandoff = clone(transfer.context); else delete record.contextHandoff;
      },
      // A new managed chat with no history: its native host is not durable until it has metadata. The public thread/name/set on the HOST
      // thread (never a history item, turn or model call) persists it; the label is private and never shown (see ResponsesRouter.maskPrivate).
      persistPrivate: id => this.native.request('thread/name/set', { threadId: id, name: 'New chat' }),
      // The staged chat's own, authoritative settings (the same view the desktop is given for any managed chat). A settings change asked for by the person (the effort is applied
      // separately; here a collaboration mode) is applied through the ordinary managed-chat path first, so what is read back is what the chat now really has.
      settings: async (id, update) => {
        if (update) await this.request('thread/settings/update', { threadId: id, ...update }, { localRouted: true });
        // The settings view carries no workspace roots; the staged chat's own confirmed roots (saved from its start answer) travel beside it, so the final readback is
        // compared on what this chat really has. Absent roots stay absent: the caller refuses them, nothing is copied from the source or the start answer.
        const record = this.records.get(id); return { ...this.settingsView(record, this.hostSettings(record)), threadId: record.thread.id, ...(Array.isArray(record.runtimeWorkspaceRoots) ? { runtimeWorkspaceRoots: [...record.runtimeWorkspaceRoots] } : {}) };
      },
      // The transition note for the NEW chat's model, staged on its own record (pending until a query consumes it). The chat is private and unpublished until the commit, so nothing runs on it first.
      notice: (id, notice) => { const record = this.records.get(id); record.transitionNotice = { ...notice, pending: true }; },
      publish: async (id, continuation) => { const record = this.records.get(id); record.continuation = continuation; this.save(record); },
      archive: id => this.request('thread/archive', { threadId: id }, { localRouted: true }),
      thread: id => this.thread(this.records.get(id), true),
    };
  }
  async catalog() {
    this.modelPromise ??= this.loadCatalog();
    return this.modelPromise;
  }
  // Asks the official SDK for its model list (no prompt) and records the outcome in the
  // connection store when one exists. A failed request is not cached.
  // The list is validated here, once: the value returned, offered by model/list and used to select
  // a model is the one the store accepts. A catalog with excess or repeated models is an explicit
  // failure, not a catalog that stays selectable.
  loadCatalog() {
    const pending = this.getModels().then(list => {
      try { normalizeModels(list); }
      catch (error) { this.observeCatalog({ error: error.code === 'catalog_invalid' ? 'catalog_invalid' : 'catalog_failed' }); throw error; }
      this.catalogList = list; this.observeCatalog({ models: list }); return list;
    }, error => { this.observeCatalog({ error: 'catalog_failed' }); throw error; });
    pending.catch(() => { if (this.modelPromise === pending) this.modelPromise = null; });
    return pending;
  }
  observeCatalog(outcome) {
    this.pickerClaudeCatalogFailed = !!outcome.error;
    if (!this.connectionRoot) return;
    // Evidence only: it never waits for a lock on the Bridge's event loop, and a failure is logged.
    try { recordCatalog(this.connectionRoot, outcome, { wait: false }); }
    catch (error) { this.log('connections.record_failed', errorMetadata(error)); }
  }
  // Asks the SDK again. One refresh runs at a time, and a failed refresh keeps the last good catalog.
  refreshCatalog() {
    this.refreshing ??= (async () => {
      const next = this.loadCatalog();
      const list = await next; this.modelPromise = next; return list;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  // The connection decision is read when it is needed, so a change applies to the very next
  // admission without a restart. Disabled or unreadable settings refuse new Claude work.
  claudeDenied(options) { return this.claudeState(options).denied; }
  // The refusal (or null) and the disable-generation token, from one read of the store.
  claudeState(options) {
    const { policy, token } = claudeDecision(this.connectionRoot);
    // Unified slots are picker visibility, not execution permission. The
    // connection's enabled state and durable disable-generation stay intact.
    try { if (this.localResponses?.registry.slots().version === 2) policy.visible = null; } catch { /* keep the original safe connection decision */ }
    const message = claudeDenial(policy, options);
    return { denied: message ? new RpcError(message, -32602) : null, token, policy };
  }
  async selectModel(value = 'opus', { continuing = false } = {}) {
    const disabled = this.claudeDenied();
    if (disabled) throw disabled;
    const list = await this.catalog();
    const selected = list.find(m => m.value === value || m.resolvedModel === value);
    if (!selected) throw new RpcError(`Claude Code does not advertise model ${value}`, -32602);
    const hidden = this.claudeDenied({ model: selected.value, continuing });
    if (hidden) throw hidden;
    return selected;
  }
  async selection(record, params) {
    const mode = params.collaborationMode?.settings;
    const requested = mode?.model ?? params.model ?? record.model;
    if (!isClaude(requested)) return nativeSelection(this, record, params);
    const model = await this.selectModel(requested, { continuing: (record.provider ?? 'claude') === 'claude' && requested === record.model });
    const levels = model.supportedEffortLevels ?? [];
    const inherited = levels.includes(record.effort) ? record.effort : levels.includes('high') ? 'high' : levels[0];
    const effort = mode?.reasoning_effort ?? params.effort ?? inherited;
    if (model.supportsEffort && !levels.includes(effort)) throw new RpcError(`Unsupported effort ${effort} for ${model.value}`, -32602);
    return { model: model.value, effort: model.supportsEffort ? effort : 'none', provider: 'claude' };
  }
  applySelection(record, selected) {
    const before = this.recordSelection(record); // (the selection the model last saw; the accepted change, if any, stages ONE note after it)
    try { this.applyAcceptedSelection(record, selected); } finally { this.stageRecordNotice(record, before); }
  }
  applyAcceptedSelection(record, selected) {
    const changedProvider = (record.provider ?? 'claude') !== selected.provider;
    if (changedProvider || record.model !== selected.model || record.effort !== selected.effort)
      this.log('model.changed', { threadId: record.thread.id, previousModel: record.model, previousProvider: record.provider ?? 'claude',
        previousEffort: record.effort, model: selected.model, provider: selected.provider, effort: selected.effort });
    if (changedProvider) {
      if (selected.provider === 'claude') record.claudeSessionId = undefined;
      record.nativeResetRequired = true;
    }
    Object.assign(record, selected); record.options.model = record.model;
    // A queue that becomes Claude's by this change is bound to the generation now; its stamp is kept otherwise.
    if (changedProvider && selected.provider === 'claude') adoptQueue(this, record);
  }
  checkWorkspace(record, params) {
    if (params.cwd && workspacePath(params.cwd) !== workspacePath(record.thread.cwd))
      throw new RpcError('Start a new thread to change workspace.', -32602);
  }
  async exclusive(record, work, allowActive = false) {
    const id = record.thread.id;
    if (this.changing.has(id) || this.reverting.has(id) || this.starting.has(id) || this.pendingSteers.has(id) || (!allowActive && this.active.has(id)))
      throw new RpcError('Wait for the current turn or chat change to finish');
    const running = this.active.get(id);
    this.changing.add(id);
    try { return await work(); } finally {
      this.changing.delete(id);
      // Completion may have deferred automatic queue progress while this
      // metadata/prefix operation held the lock. Preserve Stop/archive pauses.
      if (running && !this.active.has(id)) continueQueue(this, record, running.turn.status);
    }
  }
  metadata(record, thread) {
    if (!thread || thread.id !== record.thread.id) return;
    // Native may rewrite the rollout on resume/revert. A desktop can still
    // echo a path this same thread previously advertised; it is only a hint.
    record.resumePaths = [...new Set([...(record.resumePaths ?? []), record.thread.path, thread.path]
      .filter(path => typeof path === 'string' && path.length > 0))];
    // Native owns project/title/workspace metadata. The bridge owns the visible
    // Claude transcript, preview and activity, never the native seed turns.
    const { turns, preview, status, model, modelProvider, reasoningEffort, updatedAt, ...metadata } = thread;
    record.thread = { ...record.thread, ...metadata,
      ...(record.bridgeForkedFromId ? { forkedFromId: record.bridgeForkedFromId } : {}) };
    record.updatedAt = Math.max(record.updatedAt ?? 0, updatedAt ?? 0);
    this.save(record);
  }
  // What the desktop is told about a managed chat. The desktop's state callback for thread/settings/updated reads collaborationMode.settings of the incoming event, so it is
  // always present (the pinned ThreadSettings has no optional field): native's own mode is kept when it reported one, otherwise the chat's saved mode instructions with
  // the default mode; the model and effort are always the chat's current ones. The nullable fields native did not report are null.
  settingsView(record, settings) {
    const mode = settings.collaborationMode ?? { mode: 'default', settings: { developer_instructions: record.modeInstructions ?? null } };
    return { ...settings, model: record.model, modelProvider: provider(record), effort: record.effort,
      serviceTier: settings.serviceTier ?? record.nativeServiceTier ?? null, summary: settings.summary ?? null, personality: settings.personality ?? null,
      multiAgentMode: settings.multiAgentMode ?? record.nativeMultiAgentMode ?? 'explicitRequestOnly',
      collaborationMode: { ...mode, settings: { developer_instructions: null, ...mode.settings, model: record.model, reasoning_effort: record.effort } } };
  }
  hostSettings(record) {
    return { ...record.nativeSettings, cwd: record.thread.cwd, model: record.nativeModel ?? record.model,
      modelProvider: record.hostProvider ?? record.options.modelProvider ?? 'openai',
      effort: record.nativeEffort ?? null, approvalPolicy: record.approvalPolicy,
      approvalsReviewer: record.approvalsReviewer ?? 'user', sandboxPolicy: record.sandbox,
      activePermissionProfile: record.activePermissionProfile ?? null, disabledPluginIds: record.disabledPluginIds ?? [],
      // The pinned v2 ThreadSettings has no optional field: what native reported (its own settings events, or its start answer) is kept, the nullable ones are null.
      serviceTier: record.nativeSettings?.serviceTier ?? record.nativeServiceTier ?? null, summary: record.nativeSettings?.summary ?? null,
      multiAgentMode: record.nativeSettings?.multiAgentMode ?? record.nativeMultiAgentMode ?? 'explicitRequestOnly', personality: record.nativeSettings?.personality ?? null,
      collaborationMode: { mode: record.nativeSettings?.collaborationMode?.mode ?? 'default', settings: {
        developer_instructions: record.modeInstructions ?? null, ...record.nativeSettings?.collaborationMode?.settings,
        model: record.nativeModel ?? record.model, reasoning_effort: record.nativeEffort ?? null } } };
  }
  thread(record, withTurns = true) {
    return { ...record.thread, model: record.model, modelProvider: provider(record),
      reasoningEffort: record.effort, updatedAt: record.updatedAt,
      status: this.active.has(record.thread.id) ? { type: 'active', activeFlags: [] } : { type: 'idle' },
      turns: withTurns ? record.turns.map(publicTurn) : [] };
  }
  emit(method, params) {
    // The public item notifications carry when the item's lifecycle started or
    // completed (Unix ms). Keep a value native already supplied; items the Bridge
    // generates get the time they are announced.
    // A continued conversation runs on a physical thread; the desktop knows it only by the conversation's logical ID.
    // (Bridge-internal listeners such as session tools keep the physical ID; only the desktop is shown the logical one.)
    // desktopView is null for what must not be shown yet: a provisional child, held while a switch is in flight, or an abandoned one.
    const shown = p => this.localResponses ? this.localResponses.desktopView(method, p) : p;
    if (method === 'item/started' && !Number.isInteger(params.startedAtMs)) params = { ...params, startedAtMs: Date.now() };
    if (method === 'item/completed' && !Number.isInteger(params.completedAtMs)) params = { ...params, completedAtMs: Date.now() };
    // Archive removes the desktop's subscription while a Claude turn can still
    // finish. Retain its history and internal lifecycle without sending items
    // to a conversation the renderer no longer owns. Unarchive resumes delivery.
    if (!this.records.get(params.threadId)?.archived || !(method.startsWith('item/') || method.startsWith('turn/') || method === 'thread/status/changed'))
    { const view = shown(params); if (view !== null) this.desktop.notify(method, view); }
    this.sessionEvents.emit('change', method, params);
  }
  // ---- the read-only history tool -------------------------------------------------------------------------------------------------
  // Who is calling is decided here, from the TRANSPORT: `origin` is bound by the code that created the connection (the main native Peer, or
  // ProviderNativePool for a custom one) and carries the actual Peer object; the thread and turn are the ones that connection itself reported
  // (a turn/started it sent, a start / resume answer it gave). A model argument can only ever be one of the six history arguments.
  async historyToolCall(params, signal, origin) {
    let bound;
    try {
      if (params.tool !== 'read') historyDenied('unknown_tool', 'Unknown history tool.');
      const lifetime = this.historyCallers.get(params.threadId)?.controller.signal;
      bound = signal && lifetime ? AbortSignal.any([signal, lifetime]) : signal ?? lifetime;
      const page = await readHistory({ args: params.arguments, signal: bound, codec: this.historyCodec,
        verify: () => this.verifyNativeHistory(origin, params), load: grant => this.loadNativeHistory(grant, origin, bound) });
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(page) }] };
    } catch (error) {
      // A call whose turn ended while it was reading is an aborted call, whatever the read was in the middle of.
      const failure = bound?.aborted && !(error instanceof HistoryError) ? new HistoryError('aborted', 'The calling turn ended.') : error;
      return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify(historyFailure(failure)) }] };
    }
  }
  // The conversation a physical thread belongs to, and whether it is still that conversation's accepted CURRENT thread. A runtime that was left
  // (an earlier hop of the link), a child that is not accepted yet or was abandoned, and a damaged link are all refused.
  historyLink(physical) {
    const router = this.localResponses;
    if (!router) return { logical: physical };
    let index; try { index = router.index({ tolerant: true }); } catch { historyDenied('link_unreadable', 'The conversation link could not be read.'); }
    if (index.ambiguous(physical) || index.hidden.has(physical) || router.provisional?.has(physical) || router.abandoned?.has(physical))
      historyDenied('stale_runtime', 'This runtime is not an accepted part of the conversation.');
    const logical = index.physicals.get(physical) ?? physical;
    if ((index.links.get(logical)?.physicalId ?? logical) !== physical) historyDenied('stale_runtime', 'This runtime is no longer the conversation’s current one.');
    return { logical };
  }
  // Does this connection run that thread? A custom connection runs exactly the threads whose saved route names it (and the router's own peer for that
  // route is checked by the caller); the main native connection runs every thread that has no custom route. Synchronous, and false when it cannot be read.
  ownsThread(origin, id) {
    const router = this.localResponses;
    if (!router) return origin.kind === 'native';
    let route; try { route = router.readRoute(id); } catch { return false; }
    return origin.kind === 'custom' ? route?.connectionId === origin.connectionId : !route;
  }
  historyProfile() { return this.profileKey ??= createHash('sha256').update(resolve(this.statePath)).digest('hex').slice(0, 32); }
  // Native / custom caller. Everything after the one await is synchronous, so the answer describes the caller at the moment it was decided.
  async verifyNativeHistory(origin, params) {
    if (!originValid(this, origin)) historyDenied('caller_unverified', 'The caller could not be verified.');
    const physical = params?.threadId, turnId = params?.turnId, router = this.localResponses;
    if (typeof physical !== 'string' || typeof turnId !== 'string') historyDenied('caller_unverified', 'The caller could not be verified.');
    if (origin.kind === 'custom') {
      // The connection that is calling must be the one that actually runs this thread's saved route: the route's own peer, by object identity.
      let owner;
      try {
        const route = router?.readRoute(physical);
        if (route?.connectionId === origin.connectionId) owner = await router.nativeForConnection(router.connection(route), route.model);
      } catch { owner = undefined; }
      if (owner !== origin.peer) historyDenied('foreign_peer', 'This connection does not run that thread.');
    }
    if (!originValid(this, origin)) historyDenied('caller_unverified', 'The caller could not be verified.');
    if (!this.ownsThread(origin, physical)) historyDenied('foreign_peer', 'This connection does not run that thread.');
    const entry = this.historyCallers.get(physical);
    if (!entry || entry.peer !== origin.peer || entry.turnId !== turnId) historyDenied('turn_not_current', 'The call does not belong to the turn that is running now.');
    if (entry.controller.signal.aborted) historyDenied('aborted', 'The calling turn ended.');
    if (this.records.has(physical)) historyDenied('not_available', 'The history tool is not available for this thread.');
    const { logical } = this.historyLink(physical);
    const scope = this.historyScopes.get(physical);
    const key = scope && scope.peer === origin.peer ? scopeKey(scope) : null;
    if (!entry.scopeKey || !key) historyDenied('scope_unconfirmed', 'The workspace and permissions of this turn are not confirmed.');
    if (key !== entry.scopeKey) historyDenied('scope_changed', 'The workspace or permissions changed during this turn.');
    const workspace = realpathSync(scope.cwd);
    return { chat: logical, physical, kind: origin.kind, profile: this.historyProfile(), workspace, currentTurnId: turnId, fingerprint: stableJson([origin.kind, physical, turnId, logical, key]) };
  }
  // The conversation's canonical turns as seen from this runtime: what an earlier hand-off carried here, then the runtime's own turns, asked of the
  // connection that owns the thread (a custom thread is not held by the main process). Read-only: no write, rename or injection.
  async loadNativeHistory(grant, origin, signal) {
    // HONEST LIMIT: every call reads the runtime's whole own history again (readAllTurns: pages of 100, at most 500 pages = 50,000 turns) plus the carried history, builds the
    // entry list and revision over all of it, and only then pages. There is no index and no constant-time lookup: an exact ref costs one full read like any other call, and a
    // conversation longer than these bounds is REFUSED (history_too_large), never silently cut. The bytes read are bounded too (HISTORY_READ_BYTES) so one call cannot hold unbounded memory.
    let own, carried = [], bytes = 0;
    try {
      own = await readAllTurns(async page => {
        const answer = await origin.peer.request('thread/turns/list', { threadId: grant.physical, ...page }, 60_000, signal);
        bytes += Buffer.byteLength(JSON.stringify(answer ?? null));
        if (bytes > HISTORY_READ_BYTES) throw new HistoryError('history_too_large', 'This conversation is longer than the history tool can read in one call.');
        return answer;
      });
    } catch (error) {
      if (signal?.aborted || error instanceof HistoryError) throw error;
      if (error?.code === 'handoff_context_too_large') historyDenied('history_too_large', 'This conversation is longer than the history tool can read in one call.');
      historyDenied('history_unreadable', 'The conversation history could not be read.');
    }
    try { carried = this.localResponses?.readHandoff(grant.physical)?.turns ?? []; }
    catch { historyDenied('history_unreadable', 'The conversation history could not be read.'); }
    return mergeCarried(carried, own);
  }
  // Claude chats: a closure over THIS record, THIS turn and THIS controller. It is handed to the SDK tool server for one turn only and refuses once the
  // turn is no longer the one that bridge.active holds.
  sdkScopeKey(record) {
    const cwd = record.thread?.cwd;
    // The chat's confirmed workspace roots (saved from its own host's start / resume answer) are part of the boundary; a record that has none confirmed has no scope
    // (they are never inferred from the cwd), so a root-only change is a changed scope.
    const roots = rootList(record.runtimeWorkspaceRoots);
    if (typeof cwd !== 'string' || !cwd || typeof record.sandbox?.type !== 'string' || !roots) return null;
    try { return stableJson([realpathSync(cwd), canonicalRoots(roots), permissionState(record), record.approvalsReviewer ?? null]); } catch { return null; }
  }
  sdkHistory(record, running, turn, signal) {
    const id = record.thread.id;
    const verify = async () => {
      if (signal.aborted) historyDenied('aborted', 'The calling turn ended.');
      if (this.active.get(id) !== running || running.finished || running.turn !== turn || turn.status !== 'inProgress' || this.records.get(id) !== record)
        historyDenied('turn_not_current', 'The call does not belong to the turn that is running now.');
      const { logical } = this.historyLink(id);
      const key = this.sdkScopeKey(record);
      if (!running.historyScope || !key) historyDenied('scope_unconfirmed', 'The workspace and permissions of this turn are not confirmed.');
      if (key !== running.historyScope) historyDenied('scope_changed', 'The workspace or permissions changed during this turn.');
      return { chat: logical, physical: id, kind: 'claude', profile: this.historyProfile(), workspace: realpathSync(record.thread.cwd), currentTurnId: turn.id, fingerprint: stableJson(['claude', id, turn.id, logical, key]) };
    };
    return async args => {
      try { return await readHistory({ args, signal, verify, codec: this.historyCodec, load: async () => clone(record.turns) }); }
      catch (error) { return historyFailure(error); }
    };
  }
  // ---- context handoff and transition notices (context-handoff.mjs, transition-notice.mjs) ---------------------------------------------------------------
  // What the router (a standalone module with no repo imports) is given for a hand-off: the pure decision, the budgets this Bridge recorded, stable refs, and the notice builders.
  contextKit() {
    return {
      decide, validSummary,
      budgetFor: (route, model) => this.budgets.get(route, model),
      // Refs of the first and the last SUMMARIZED (omitted from the input) visible message, in this conversation's own scope; they read back through the history tool.
      refs: ({ logical, cwd }) => (turns, omitted) => {
        let binding; try { binding = historyBinding({ chat: logical, profile: this.historyProfile(), workspace: realpathSync(cwd) }); } catch { return null; }
        const shown = turn => (turn?.items ?? []).map((item, ordinal) => ({ item, ordinal })).filter(({ item }) => ['userMessage', 'agentMessage'].includes(item.type));
        const first = shown(turns[0])[0], lastTurn = turns[omitted - 1], last = shown(lastTurn).at(-1);
        return { first: first && historyRef(binding, { turnId: turns[0].id, ordinal: first.ordinal, itemId: first.item.id }, 0), last: last && historyRef(binding, { turnId: lastTurn.id, ordinal: last.ordinal, itemId: last.item.id }, 0) };
      },
      // A REDUCED hand-off: its first real request is measured against the window again (firstDispatchGate). Durable (a cold start keeps it); false when it could not be made durable.
      // `target` is the exact route and model the hand-off was sized for ({ kind: 'native' | 'custom', model }); `context.budget` the provenance of its window.
      reduced: (id, context, target) => this.gates.set(id, { state: 'required', window: context.window, handoffTokens: context.tokens, target,
        parts: { instructions: context.reserves.instructions, tools: context.reserves.tools, output: context.reserves.output, margin: context.reserves.margin }, ...(isObject(context.budget) ? { budget: context.budget } : {}) }),
      accepted: info => this.acceptSelection(info),
      // The reasoning level of a GPT hand-off TARGET, decided from what the runtime advertises (model/list) for that exact model: { levels, effort }. `explicit` are the levels the request names. The
      // first one the model offers wins; a stale 'none' alone is no choice (then `effort` is null: the target's own started level stands if it is offered, else the model's advertised default).
      // Any other level the model does not offer is refused (the same RpcError as a turn). null when the runtime lists no levels for the model (nothing is invented).
      nativeEffort: async ({ model, explicit }) => {
        const found = (await nativeModels(this)).find(m => m.model === model || m.id === model), levels = advertisedLevels(found);
        if (!levels.length) return null;
        const chosen = chooseEffort({ model: found.model, levels, explicit, inherited: null });
        return { levels, effort: chosen ?? null, fallback: levels.includes(found.defaultReasoningEffort) ? found.defaultReasoningEffort : levels[0] };
      },
      // A same-connection model change is made durable as an INTENT before the runtime is asked (false: not written, the change is not made), and settled by what the runtime confirms.
      intend: info => this.stageIntent(info.id, info),
      // The baseline of a thread that has just been published by a hand-off: the model has been given the history and the note, so what it last saw is the announced selection. False: not durable.
      seed: ({ peer, kind, connectionId = null, id, model, effort = null }) => {
        if (typeof id !== 'string' || typeof model !== 'string' || !model) return false;
        const baseline = { route: { kind, ...(connectionId ? { connectionId } : {}) }, model, effort: effort ?? null };
        const entry = { peer: peer ?? (kind === 'native' ? this.native : undefined), kind, connectionId, seen: baseline, now: baseline, pending: null, intent: null, dispatching: null, hadTurn: true, seq: 0, unsaved: false, inflight: null };
        if (!this.persistState(id, entry)) return false;
        this.selections.delete(id); this.selections.set(id, entry); return true;
      },
      beforeTurn: info => this.beforeTurn(info),
      notice: { build: buildNotice, id: noticeId, item: noticeItem },
    };
  }
  // The first real request after a reduced hand-off is checked with its ACTUAL input: handed-over context + reserves + this request must fit the known window. Refused, never clipped.
  // (The check itself is checkGate; this is the same check for a request named by its logical thread, counting everything the request carries.)
  firstDispatchGate(params, options) {
    const router = this.localResponses; if (!router) return null;
    let physical; try { physical = router.physicalOf(params.threadId); } catch { return null; }
    return this.checkGate(physical, params, options);
  }
  // The provider's own compaction, as the SDK reported it through the PostCompact hook of THIS turn's query. Everything is checked against the live record, turn, controller, session and
  // model before it is kept; anything else is ignored (a reduction candidate that is not qualified simply does not exist).
  captureCompaction(record, running, turn, input) {
    const id = record.thread.id;
    if (this.active.get(id) !== running || running.finished || running.turn !== turn || turn.status !== 'inProgress' || running.controller.signal.aborted || this.records.get(id) !== record || record.model !== running.model) return;
    const q = qualifySdkCompaction(input, { sessionId: turn.claudeSessionId ?? record.claudeSessionId, model: record.model, cwd: record.thread?.cwd, turns: record.turns, currentTurnId: turn.id, revision: (record.contextRevision ?? 0) + 1, now: Date.now() });
    if (!q.ok) return;
    record.contextRevision = q.snapshot.revision; record.compaction = q.snapshot; this.save(record);
  }
  // The window of the selected Claude model, from the SDK's own ModelUsage of THIS session's result (exactly one entry must be the selected model).
  observeSdkUsage(record, running, turn, message) {
    const id = record.thread.id;
    if (this.active.get(id) !== running || running.finished || record.model !== running.model || !turn.claudeSessionId || message?.session_id !== turn.claudeSessionId) return;
    const selected = this.catalogList?.find(m => m.value === record.model) ?? { value: record.model };
    const budget = qualifyUsage({ usageMap: message.modelUsage, selected, sessionId: turn.claudeSessionId, now: Date.now() });
    if (budget) this.budgets.set(budget);
  }
  // What a Claude / managed-native chat's model last saw, and the pending note when its ACCEPTED selection changed (called by applySelection, after the selection was accepted).
  recordSelection(record) { return { route: { kind: provider(record) === 'claude_code' ? 'claude' : 'native' }, model: record.model, effort: record.effort ?? null }; }
  // The note an SDK query carried is CONSUMED only when the model answers that query. `settleNoticeAttempt` records it: the attempt is dropped, the pending note it carried is consumed, and a NEWER
  // selection change merged into the pending note meanwhile (a different note) is announced next, from what that model has now been told.
  settleNoticeAttempt(record, field = 'noticeAttempt') {
    const attempt = record[field]; if (!attempt) return;
    delete record[field];
    const pending = validNotice(record.transitionNotice) && record.transitionNotice.pending === true ? record.transitionNotice : null;
    if (pending) {
      if (pending.id === attempt.noticeId || sameSelection(pending.to, attempt.notice.to)) record.transitionNotice = { ...pending, pending: false };
      else {
        const next = nextNotice({ pending: null, seen: attempt.notice.to, now: pending.to, seed: [record.thread.id, record.noticeSeq = (record.noticeSeq ?? 0) + 1] });
        if (next) record.transitionNotice = { ...next, pending: true }; else delete record.transitionNotice;
      }
    }
    this.save(record);
  }
  // Before a new turn of this chat is accepted, an earlier attempt that is still unsettled is dealt with. The USER's earlier task and the model-change NOTE are different things: the task is never
  // sent again by Bridge; the note is idempotent application orientation with a stable id, delivered at least once (not universally exactly once).
  //  - the attempt's owner query is still running: HOLD (nothing is dispatched while it may still be answering);
  //  - its prompt was provably never handed to the SDK (a local fact): dropped, the note stays owed;
  //  - a POSITIVE receipt in the SDK's own public record (history.mjs receipt: a main-branch model answer to the exact prompt uuid, in the exact session and project): the note was consumed;
  //  - otherwise, if the owner query reached its TERMINAL result (exact turn, prompt and session) and has FINISHED (state closed, recorded durably, so this works after a cold start too): nothing is
  //    running or in transport any more. The attempt is retired WITHOUT marking the note consumed: it stays pending and may accompany the next NEW user message again; the first delivery stays
  //    "unknown" in the audit on its turn; the earlier user task is not replayed;
  //  - anything else (handed, no terminal result recorded: a thrown network error, a killed process, an absent active map) is NOT proof that the query stopped: HELD (transition_uncertain). Absence
  //    proves nothing, a failed read proves nothing, a newer selection proves nothing. No private SDK file is read and no history is replayed to repair a note.
  async resolveNoticeAttempt(record) {
    const attempt = record.noticeAttempt; if (!attempt) return;
    const hold = text => this.contextRefusal('transition_uncertain', text);
    const live = this.active.get(record.thread.id);
    if (live && live.turn.id === attempt.turnId) throw hold('The previous message of this chat is still being processed, so nothing was sent. Wait for it to finish, then send again.');
    if (!attempt.handed) { delete record.noticeAttempt; this.save(record); return; }
    let receipt = null; try { receipt = await this.history.receipt?.(record, attempt); } catch { receipt = null; }
    if (receipt?.accepted === true) { this.settleNoticeAttempt(record); return; }
    if (attempt.state === 'closed' && isObject(attempt.terminal)) { delete record.noticeAttempt; this.save(record); return; }
    throw hold('Model Bridge could not confirm whether the previous message of this chat finished or whether the model received the note about its model change, so nothing was sent and nothing was changed. Reopen the chat and try again.');
  }
  stageRecordNotice(record, before) {
    const now = this.recordSelection(record);
    if (!record.turns.some(t => t.status !== 'inProgress') || sameSelection(before, now)) return; // the model has seen nothing yet, or nothing changed
    const pending = validNotice(record.transitionNotice) && record.transitionNotice.pending === true ? record.transitionNotice : null;
    const next = nextNotice({ pending, seen: before, now, seed: [record.thread.id, record.noticeSeq = (record.noticeSeq ?? 0) + 1] });
    if (next) record.transitionNotice = { ...next, pending: true };
    else if (pending) delete record.transitionNotice; // changed back to what the model last saw: nothing to announce
  }
  // Native and custom threads: the selection the runtime itself CONFIRMED (its start / resume / fork answer, its own settings event, or a committed same-connection change). A request alone
  // never counts. A transition stages ONE note from what the model last saw to the latest accepted selection and delivers it (developer role) as soon as no turn is running.
  acceptSelection({ peer, kind, connectionId = null, id, model, effort = null, hadTurn = true }) {
    if (typeof id !== 'string' || typeof model !== 'string' || !model || this.records.has(id)) return;
    const router = this.localResponses;
    try { if (router && (router.provisional?.has(id) || router.abandoned?.has(id) || router.index({ tolerant: true }).hidden.has(id))) { this.selections.delete(id); return; } } catch { this.selections.delete(id); return; }
    // Damaged durable state is never read as "nothing owed": no state is changed here, and the next dispatch on this thread is refused (see beforeTurn) until it is repaired.
    if (this.outbox.isDamaged(id)) return;
    const now = { route: { kind, ...(connectionId ? { connectionId } : {}) }, model, effort: effort ?? null };
    let entry = this.selections.get(id);
    // A thread this process has not seen yet, or one answered by another peer object (a restarted connection process): what the model last saw, the note it has not been given, and an
    // unresolved intent or dispatch are kept (they are durable) while the route is the same; a different route is a new start.
    const saved = this.outbox.get(id), base = entry ?? (saved ? { ...saved, hadTurn: true, unsaved: false, inflight: null } : null);
    if (!base || !sameRoute(base.now.route, now.route)) {
      const fresh = { peer, kind, connectionId, seen: now, now, pending: null, intent: null, dispatching: null, hadTurn, seq: base?.seq ?? 0, unsaved: false, inflight: null };
      this.selections.delete(id); this.selections.set(id, fresh);
      if (saved) this.persistState(id, fresh); // (the route is not the one the saved obligations belong to)
      while (this.selections.size > MAX_HISTORY_SCOPES) this.selections.delete(this.selections.keys().next().value);
      return;
    }
    // (the entry is updated IN PLACE: a dispatch that is in progress holds this very object)
    entry = this.selections.get(id) ?? { ...base }; Object.assign(entry, { peer, kind, connectionId });
    this.selections.delete(id); this.selections.set(id, entry);
    if (sameSelection(entry.now, now)) return;
    entry.now = now;
    // A change the runtime confirms ends an earlier uncertain intent (its outcome is now known); a confirmation of the OLD selection does not.
    entry.intent = null;
    // A turn that carried this very selection (a turn-level model / level, or one in flight) announced it with that turn: the settings event that confirms it is not another transition.
    if ((entry.dispatching && sameSelection(entry.dispatching.to, now)) || (entry.inflight && sameSelection(entry.inflight.to, now))) { this.persistState(id, entry); return; }
    if (!entry.hadTurn) { entry.seen = now; entry.pending = null; this.persistState(id, entry); return; } // a thread that has had no turn: the model saw nothing
    entry.pending = nextNotice({ pending: entry.pending, seen: entry.seen, now, seed: [id, ++entry.seq] });
    this.persistState(id, entry);
  }
  // The durable form of one thread's state. An entry that owes something (a pending note, an unresolved intent, a dispatch whose outcome is not known) is an OBLIGATION: it is written
  // durably or the caller learns it was not (`unsaved`), and dispatch on the thread is refused until it is. A baseline (what the model last saw, nothing owed) is kept for a thread that has
  // had a turn so a later change can still be announced after a cold start; it may be reaped at capacity, an obligation never.
  persistState(id, entry) {
    const owes = !!(entry.pending || entry.intent || entry.dispatching);
    if (!owes && !entry.hadTurn) { entry.unsaved = false; return this.outbox.delete(id); }
    const ok = this.outbox.set(id, { kind: entry.kind, connectionId: entry.connectionId ?? null, seen: entry.seen, now: entry.now, seq: entry.seq ?? 0, pending: entry.pending ?? null, intent: entry.intent ?? null, dispatching: entry.dispatching ?? null });
    entry.unsaved = !ok;
    if (!ok) this.log('context.state_not_durable', { threadId: id, reason: this.outbox.lastError, obligation: owes });
    return ok;
  }
  // The refusal of a dispatch the Bridge cannot make safe. The message is plain; the code is stable.
  contextRefusal(code, message) { return Object.assign(new Error(message), { code }); }
  // Before a model-changing request to the runtime that owns a thread, the intent is made durable (so a crash or a lost answer cannot leave a change that was never announced). Returns false when it
  // could not be made durable: the caller then does NOT send the request. A thread the model has seen nothing on needs no intent.
  stageIntent(id, { peer, kind, connectionId = null, from, to, hadTurn }) {
    if (this.records.has(id)) return true;
    if (this.outbox.isDamaged(id)) return false;
    const saved = this.outbox.get(id);
    let entry = this.selections.get(id) ?? (saved ? { ...saved, peer, hadTurn: true, unsaved: false, inflight: null } : null);
    if (!entry) {
      if (!from) return true;
      const baseline = { route: { kind, ...(connectionId ? { connectionId } : {}) }, model: from.model, effort: from.effort ?? null };
      entry = { peer, kind, connectionId, seen: baseline, now: baseline, pending: null, intent: null, dispatching: null, hadTurn: hadTurn !== false, seq: 0, unsaved: false, inflight: null };
    }
    if (!entry.hadTurn) return true;
    const target = { route: entry.now.route, model: to.model, effort: to.effort ?? null };
    if (sameSelection(entry.now, target)) return true;
    const next = { ...entry, peer: peer ?? entry.peer, intent: { to: target } };
    if (!this.persistState(id, next)) return false;
    const held = this.selections.get(id); if (held) Object.assign(held, next); // (in place: a dispatch that is in progress holds this very object)
    this.selections.delete(id); this.selections.set(id, held ?? next); return true;
  }
  // The state of a thread for a dispatch: this process's own, or the durable one of an earlier process (a cold start). Damage is a refusal, never absence.
  stateFor(id, { peer, kind, connectionId = null }) {
    if (this.outbox.isDamaged(id)) throw this.contextRefusal('context_state_damaged', 'Model Bridge cannot read the record that keeps this chat\'s model-change notes, so nothing was sent. The chat and its history are unchanged; this needs a technical repair of context-notices.json.');
    let entry = this.selections.get(id);
    if (!entry) { const saved = this.outbox.get(id); if (!saved) return null; entry = { ...saved, peer, hadTurn: true, unsaved: false, inflight: null }; this.selections.set(id, entry); }
    entry.peer ??= peer;
    return entry;
  }
  // The outcome of a turn/start whose answer was not seen (a lost connection, a timeout, or an error answer that may have followed an accepted turn) is established from the PUBLIC record of the
  // thread: a user message carrying the stable client id of that dispatch. Found: the turn was accepted and so was its note. Not found while the thread is idle (or the runtime says it has no turn at
  // all yet): not accepted, the note is still owed. Anything else is undetermined and holds further dispatch. The prompt and the note are never sent again to find out.
  async reconcileDispatch(id, entry, peer) {
    // Only a POSITIVE public match settles: a user message carrying the exact client id of THIS dispatch, found by reading the record page by page (newest first, bounded, a repeated cursor or
    // a malformed page is unreadable). ABSENCE settles nothing: not after a complete scan, not with an idle thread, not with "not materialized yet", not with other client ids present. An earlier
    // request whose outcome is unknown (timed out, still live, answered with an error after partial effect) may arrive or apply LATER, and there is no public negative barrier. So every absence leaves
    // the dispatch and its note exactly as recorded and holds further dispatch (transition_uncertain); nothing is sent again and nothing past is re-run. The one thing that clears a dispatch without a
    // positive match is a trusted LOCAL proof that it was never written to the connection (see beforeTurn's failed, and rpc.mjs neverSent).
    const sent = entry.dispatching;
    const hold = () => this.contextRefusal('transition_uncertain', 'Model Bridge could not confirm whether the previous message reached the model, so it is not sending another until that is known. Nothing was sent. Reopen the chat and try again.');
    if (!(await this.publicClientMatch(peer, id, sent.clientId))) throw hold();
    this.settleTurn(id, entry, sent.to);
  }
  // THE one positive reconciliation: the thread's public record is read page by page (newest first, bounded, a repeated cursor or a malformed page is unreadable) and a user message carrying the
  // exact client id of the dispatch is looked for. Returns { turnId } when found, otherwise null - and null is NEVER a negative proof (see reconcileDispatch).
  async publicClientMatch(peer, id, clientId) {
    const cursors = new Set(); let cursor;
    if (typeof clientId !== 'string' || clientId === '') return null;
    try {
      for (let page = 0; page < RECONCILE_PAGES; page++) {
        const list = await peer.request('thread/turns/list', { threadId: id, sortDirection: 'desc', itemsView: 'full', limit: 100, ...(cursor ? { cursor } : {}) }, 30_000);
        if (!isObject(list) || !Array.isArray(list.data)) return null;
        for (const turn of list.data) for (const item of Array.isArray(turn?.items) ? turn.items : []) if (item?.type === 'userMessage' && typeof item.clientId === 'string' && item.clientId === clientId) return { turnId: typeof turn?.id === 'string' ? turn.id : null };
        const next = list.nextCursor ?? null;
        if (next === null || typeof next !== 'string' || next === '' || cursors.has(next)) return null;
        cursors.add(next); cursor = next;
      }
    } catch { /* unreadable: no positive evidence */ }
    return null;
  }
  // A MANAGED native chat (a record whose model runs on the native host) that carried a model-change note: its attempt (own record, client message id, note, selection) was made durable BEFORE the
  // request was sent (native-turns.mjs beginNative). Before ANYTHING of this chat is dispatched, changed or reset, an attempt still recorded is settled ONLY by a positive public match of its client
  // id; absence, an empty or unmaterialized record, other ids, a partial page, a failed read and an error answer are not proof, so the chat is HELD. The failed user task is never replayed.
  async resolveNativeAttempt(record) {
    const attempt = record.nativeAttempt; if (!attempt) return;
    const hold = () => this.contextRefusal('transition_uncertain', 'Model Bridge could not confirm whether the previous message of this chat reached the model, so it is not sending another until that is known. Nothing was sent and nothing was changed. Reopen the chat and try again.');
    if (attempt.threadId !== record.thread.id || typeof attempt.clientUserMessageId !== 'string') throw hold();
    const match = await this.publicClientMatch(this.native, record.thread.id, attempt.clientUserMessageId);
    if (!match) throw hold();
    // accepted: it carried the retained history if one was owed, and it is now the first native turn of this host (the later history reset reverts to it)
    if (attempt.carriedHistory) record.nativeResetRequired = false;
    if (match.turnId) record.nativeFirstTurnId ??= match.turnId;
    record.nativePersisted = true;
    this.settleNoticeAttempt(record, 'nativeAttempt');
  }
  // An unresolved intent (a model or level change whose outcome Bridge did not see) is settled from the runtime's own public readback of the thread.
  async reconcileIntent(id, entry, peer, readback) {
    let answer;
    try { answer = readback ? await readback() : await peer.request('thread/resume', { threadId: id, excludeTurns: true }, 30_000); }
    catch { throw this.contextRefusal('transition_uncertain', 'Model Bridge could not confirm this chat\'s last model change, so nothing was sent. Reopen the chat and try again.'); }
    if (typeof answer?.model !== 'string' || !answer.model) throw this.contextRefusal('transition_uncertain', 'Model Bridge could not confirm this chat\'s last model change, so nothing was sent. Reopen the chat and try again.');
    if (!entry.intent) return; // the readback itself was observed (acceptSelection) and settled it
    const actual = { route: entry.now.route, model: answer.model, effort: answer.reasoningEffort ?? null };
    entry.intent = null;
    if (!sameSelection(actual, entry.now)) {
      entry.now = actual;
      if (entry.hadTurn && !(entry.dispatching && sameSelection(entry.dispatching.to, actual))) entry.pending = nextNotice({ pending: entry.pending, seen: entry.seen, now: actual, seed: [id, ++entry.seq] });
    }
    if (!this.persistState(id, entry)) throw this.contextRefusal('context_state_unwritable', 'Model Bridge could not save its record for this chat, so nothing was sent. Try again.');
  }
  // A turn that carried `to` was accepted: the model has been told, and runs on it. (A different selection confirmed meanwhile is newer: it is announced next, from `to`.)
  settleTurn(id, entry, to) {
    const from = entry.dispatching?.from ?? entry.inflight?.from ?? entry.now, newer = !sameSelection(entry.now, from) && !sameSelection(entry.now, to);
    entry.seen = to; entry.hadTurn = true; entry.dispatching = null; entry.inflight = null;
    if (newer) entry.pending = nextNotice({ pending: null, seen: to, now: entry.now, seed: [id, ++entry.seq] });
    else { entry.now = to; entry.pending = null; }
    this.persistState(id, entry);
  }
  // THE dispatch boundary of a native or custom turn: called by the code that is about to send turn/start to the runtime that owns the thread (the router for a custom connection, with the
  // selection it actually mapped and the peer it validated; the Bridge for the main native process), after every route, free-model, settings and permission check, immediately before the request.
  // It returns the request to send (or throws, having changed nothing) and the two settlements. In order:
  //  1. an earlier dispatch or change of this thread whose outcome is not known is settled from the runtime's PUBLIC record (reconcileDispatch / reconcileIntent), never by sending again;
  //  2. the first request after a REDUCED hand-off is measured, with its actual input, against the budget of the model that will really receive it (checkGate);
  //  3. the model-change note the model has not seen travels WITH this turn as trusted application context (public contract: it reaches the model as a developer-role item, once, and makes
  //     no visible history item). The effective model / level of THIS request (a turn-level selection) is the selection the note announces, and it counts only once the turn is accepted.
  //  4. before anything is sent, the dispatch (its stable client message id and the note's id) is made durable, so a lost answer or a restart is settled from the thread's public record.
  // An error answer is NOT proof that nothing happened (the runtime may have accepted the turn first): after any failure the dispatch stays recorded and is reconciled before the next one.
  async beforeTurn({ physical, peer, kind, connectionId = null, model, params, readback }) {
    if (typeof physical !== 'string' || this.records.has(physical)) return null;
    const entry = this.stateFor(physical, { peer, kind, connectionId });
    if (entry) {
      if (entry.dispatching) await this.reconcileDispatch(physical, entry, peer);
      if (entry.intent) await this.reconcileIntent(physical, entry, peer, readback);
      if (entry.unsaved && owesState(entry) && !this.persistState(physical, entry)) throw this.contextRefusal('context_state_unwritable', 'Model Bridge could not save its record for this chat, so nothing was sent. Try again.');
    }
    // the selection this request actually runs on: for a custom thread the model the router mapped, for the main native thread what the request asks (or what the thread already has)
    const asked0 = params.collaborationMode?.settings, askedModel = typeof asked0?.model === 'string' && asked0.model ? asked0.model : typeof params.model === 'string' && params.model ? params.model : null;
    const effectiveModel = kind === 'custom' ? model : askedModel ?? entry?.now.model ?? model;
    // The main native connection runs this turn with the level the WIRE carries (native honours collaborationMode.settings.reasoning_effort over the top-level one). When the request's two level fields
    // disagree or one is a stale 'none', the model's advertised levels decide ONE level and both fields carry it (so what the note announces, what is recorded and what runs are the same). Custom
    // connections keep the router's own mapping.
    if (kind === 'native') params = await normalizeNativeEffort(this, params, effectiveModel, entry?.now.effort);
    const asked = params.collaborationMode?.settings, askedEffort = params.effort ?? asked?.reasoning_effort;
    const target = entry ? { route: entry.now.route, model: effectiveModel ?? entry.now.model, effort: askedEffort === undefined ? entry.now.effort : askedEffort ?? null } : null;
    const priorPending = entry?.pending ?? null, priorSeq = entry?.seq ?? 0; // (what stands again if this attempt is proven never sent)
    let pending = entry?.pending ?? null;
    if (entry?.hadTurn && !sameSelection(entry.now, target)) pending = nextNotice({ pending: entry.pending, seen: entry.seen, now: target, seed: [physical, (entry.seq ?? 0) + 1] });
    if (pending && !validNotice(pending)) pending = null;
    let out = params, clientId = null;
    if (pending) { clientId = typeof params.clientUserMessageId === 'string' && params.clientUserMessageId ? params.clientUserMessageId : randomUUID(); out = { ...params, clientUserMessageId: clientId, additionalContext: { ...params.additionalContext, bridge_transition: noticeContext(pending) } }; }
    // the first request after a reduced hand-off: refused here (nothing changed, nothing sent) if it does not fit the model that will receive it
    const gate = this.checkGate(physical, out, { kind, model: effectiveModel });
    if (entry && pending) {
      const next = { ...entry, pending, dispatching: { noticeId: pending.id, clientId, from: entry.now, to: target }, seq: sameSelection(entry.now, target) ? entry.seq ?? 0 : (entry.seq ?? 0) + 1, inflight: { from: entry.now, to: target } };
      if (!this.persistState(physical, next)) throw this.contextRefusal('context_state_unwritable', 'Model Bridge could not save its record for this chat, so nothing was sent. Try again.');
      Object.assign(entry, next); // (in place: this object is the one in this.selections)
    } else if (entry && target) entry.inflight = { from: entry.now, to: target };
    return {
      params: out,
      accepted: () => { gate?.done(); if (entry && target) this.settleTurn(physical, entry, target); },
      // With no note aboard there is nothing to settle. With a note aboard the dispatch stays recorded UNLESS the failure is a trusted LOCAL proof that this very request was never written
      // (rpc.mjs neverSent: the connection was already closed). Every other failure - an error answer, a timeout, a lost connection, an abort - is unknown: only a positive public match settles it.
      failed: error => {
        if (!entry) return;
        if (!(pending && clientId)) { entry.inflight = null; return; }
        if (!neverSent(error) || entry.dispatching?.clientId !== clientId) return;
        const cleared = { ...entry, pending: priorPending, seq: priorSeq, dispatching: null, inflight: null };
        if (this.persistState(physical, cleared)) Object.assign(entry, cleared); // (not durable: the earlier durable dispatching stands, and so does the memory of it)
      },
    };
  }
  // The budget check of the first request after a reduced hand-off, against the EXACT model that receives it. `gate.target` is the route and model the hand-off was sized for; the window used is
  // always the one measured for the model that really receives the request (never model A's window for model B), and an unknown one refuses. The request is everything the turn carries
  // (input, every context fragment including the note, the output schema); the target's own system instructions and tool schemas are RESERVED estimates, not measurements.
  checkGate(physical, params, { kind, model } = {}) {
    const info = this.gateFor(physical);
    if (!info || gateDone(info)) return null;
    const request = requestTokensOf(params), refuse = text => { throw this.contextRefusal('handoff_request_too_large', text); };
    let needed, window;
    if (info.target) {
      const receiving = model ?? info.target.model, budget = kind === 'native' ? this.budgets.get('native', receiving) : null;
      if (!budget) refuse(`The context window of ${receiving} is not known, so this message cannot be checked against the shortened context carried to this chat${receiving === info.target.model ? '' : ' (it was prepared for ' + info.target.model + ')'}. Nothing was sent and nothing was shortened. Use the model the chat was switched to, or start a new chat.`);
      const plan = planBudget({ budget, requestTokens: request, reserves: { instructionsTokens: info.parts.instructions, toolsTokens: info.parts.tools } });
      needed = info.handoffTokens + plan.fixed; window = plan.window;
    } else { const p = info.parts; needed = info.handoffTokens + p.instructions + p.tools + p.output + p.margin + request; window = info.window; }
    // every number of the comparison must be a real, non-negative quantity: a NaN would make "does not fit" false and let anything through
    if (![needed, window, request].every(n => Number.isFinite(n) && n >= 0)) throw this.contextRefusal('context_state_damaged', 'Model Bridge cannot work out whether this message fits the context carried to this chat, so nothing was sent. The chat and its history are unchanged.');
    if (needed > window) refuse(`This message is too large to send together with the shortened context carried to this chat (about ${needed} of ${window} tokens, an estimate: its own input, context and output schema, plus reserves for the model's instructions and tools). Nothing was sent and nothing was shortened. Send it in smaller parts, or use the earlier model.`);
    return { done: () => { if (!this.gates.set(physical, { ...info, state: 'done' })) this.log('context.gate_not_cleared', { threadId: physical, reason: this.gates.lastError }); this.gatesDone.add(physical); } };
  }
  // The gate of a thread: its durable entry, or - if the file is damaged - the one the same durable hand-off sidecar describes. A gate that cannot be known is a refusal, never no gate.
  gateFor(physical) {
    if (this.gatesDone.has(physical)) return null;
    const found = this.gates.get(physical);
    if (found) return found;
    if (!this.gates.isDamaged(physical)) return null;
    let context, unreadable = false; try { context = this.localResponses?.readHandoff(physical)?.context; } catch { unreadable = true; }
    if (unreadable) throw this.contextRefusal('context_state_damaged', 'Model Bridge cannot read the record that guards this chat\'s first message, so nothing was sent. This needs a technical repair of context-gates.json.');
    return this.gateFromContext(context);
  }
  // The gate a durable hand-off sidecar describes, when the gate file itself is damaged. It is rebuilt STRICTLY: the window, the handed-over tokens and every reserve must be finite, non-negative
  // integers (a window of at least the minimum), and the exact route, model and measurement the window belongs to must be present. Anything else - a missing part, a string, NaN, a negative, a
  // route that is not native, an unknown mode - is damage that is REPORTED before anything is sent: no value is defaulted, dropped or assumed. No context (nothing was reduced) or a full one owes no gate.
  gateFromContext(context) {
    const damaged = () => this.contextRefusal('context_state_damaged', 'Model Bridge cannot read the record that guards this chat\'s first message, and the hand-off record that describes it is not valid either, so nothing was sent. The chat and its history are unchanged; this needs a technical repair of context-gates.json.');
    if (context === undefined || context === null) return null;
    if (!isObject(context)) throw damaged();
    if (context.mode === 'full') return null;
    if (context.mode !== 'reduced') throw damaged();
    const reserves = context.reserves, budget = context.budget;
    if (!isObject(reserves) || !isObject(budget) || budget.route !== 'native' || typeof budget.model !== 'string' || budget.model === '' || typeof budget.source !== 'string' || budget.source === '') throw damaged();
    const gate = { state: 'required', window: context.window, handoffTokens: context.tokens, target: { kind: 'native', model: budget.model }, budget,
      parts: { instructions: reserves.instructions, tools: reserves.tools, output: reserves.output, margin: reserves.margin } };
    if (!validGate(gate)) throw damaged();
    return gate;
  }
  // The explicit recovery of a damaged state file (nothing is lost: it is moved aside; nothing is guessed).
  repairContextState(which) {
    const map = { gates: this.gates, notices: this.outbox }[which];
    return map ? map.quarantine() : null;
  }
  observeSettingsSelection(origin, params) {
    if (!originValid(this, origin) || typeof params?.threadId !== 'string' || !this.ownsThread(origin, params.threadId)) return;
    if (origin.kind === 'custom' && this.localResponses?.pendingSettings?.has(params.threadId)) return; // a same-connection change in flight: announced once it is committed
    const s = params.threadSettings;
    if (isObject(s)) this.acceptSelection({ peer: origin.peer, kind: origin.kind, connectionId: origin.connectionId, id: params.threadId, model: s.model, effort: s.effort ?? null });
  }
  // The window a native OpenAI thread declares for its own model (its own token event on the main connection); never anything for a custom endpoint.
  observeNativeWindow(origin, params) {
    if (!originValid(this, origin)) return;
    // Only the event of the LIVE turn of this thread, on this connection (the turn it names must be the one Bridge saw start and not yet end), counts, and it is bound to the model and
    // provider that turn started on (not to whatever the thread's settings say now): a late event of an earlier turn or an earlier model never describes the current one.
    const caller = typeof params?.threadId === 'string' ? this.historyCallers.get(params.threadId) : null, window = params?.tokenUsage?.modelContextWindow;
    if (!caller || caller.peer !== origin.peer || typeof params.turnId !== 'string' || params.turnId !== caller.turnId || caller.controller.signal.aborted || !caller.snapshot) return;
    const entry = qualifyNativeWindow({ window, scope: caller.snapshot, mainConnection: origin.kind === 'native' && this.ownsThread(origin, params.threadId), now: Date.now() });
    if (entry) this.budgets.set(entry);
  }
  setHistoryScope(origin, id, scope) {
    this.historyScopes.delete(id);
    if (!scope) return;
    this.historyScopes.set(id, { peer: origin.peer, ...scope });
    while (this.historyScopes.size > MAX_HISTORY_SCOPES) this.historyScopes.delete(this.historyScopes.keys().next().value);
  }
  // What one connection itself confirmed. Responses are read synchronously by the Peer, so a settings event or a turn that follows can never be seen
  // before the answer that came first. Only a start / resume / fork ANSWER seeds a scope; an outbound request that would change the workspace or the
  // permissions drops it until the runtime confirms the new ones (a settings event or a resume answer).
  observeNative(origin, phase, method, params, result) {
    if (!originValid(this, origin)) return;
    if (phase === 'response' && ['thread/start', 'thread/resume', 'thread/fork'].includes(method)) {
      const id = result?.thread?.id;
      if (typeof id === 'string') {
        this.setHistoryScope(origin, id, confirmedScope(result));
        this.acceptSelection({ peer: origin.peer, kind: origin.kind, connectionId: origin.connectionId, id, model: result.model, effort: result.reasoningEffort ?? null, hadTurn: method !== 'thread/start' });
      }
    } else if (phase === 'request' && ['turn/start', 'thread/settings/update', 'thread/resume'].includes(method) && typeof params?.threadId === 'string') {
      const scope = this.historyScopes.get(params.threadId);
      if (!scope || scope.peer !== origin.peer) return;
      // A request that may change what the thread is allowed to touch ends the confirmation BEFORE it is sent; only the runtime's own answer or event confirms again.
      //  - it may change the workspace or its ROOTS (cwd, runtimeWorkspaceRoots, environments, a config override of the workspace): the confirmation is dropped. Settings events
      //    carry no roots, so nothing but the runtime's own start / resume / fork answer can bring a scope back; a requested root is never taken as the actual one.
      //  - it may change only permissions the runtime reports in its settings events (full sandbox policy, profile, approval policy / reviewer, plugins): the scope is marked
      //    stale (reads refuse) until that event arrives, then it is confirmed again with the roots that stood before.
      // A value equal to the confirmed one changes nothing. Anything that cannot be compared with certainty counts as a change; an error here drops the scope.
      try {
        const differs = (asked, current) => asked != null && stableJson(asked) !== stableJson(current);
        const config = isObject(params.config) ? Object.keys(params.config) : [];
        const workspaceChanged = (typeof params.cwd === 'string' && workspacePath(params.cwd) !== workspacePath(scope.cwd)) || (params.cwd != null && typeof params.cwd !== 'string')
          || (params.runtimeWorkspaceRoots != null && stableJson(rootList(params.runtimeWorkspaceRoots)) !== stableJson(scope.roots))
          || params.environments != null || config.some(key => permissionConfigKey.test(key));
        if (workspaceChanged) { this.setHistoryScope(origin, params.threadId, null); return; }
        // (`sandbox` is the sandbox MODE name of a start / resume, not comparable with the reported policy: any value of it counts as a possible change.)
        if (differs(params.sandboxPolicy, scope.sandbox) || params.sandbox != null
          || differs(params.approvalPolicy, scope.approvalPolicy) || differs(params.approvalsReviewer, scope.approvalsReviewer)
          || differs(params.permissions, scope.activePermissionProfile?.id) || differs(params.disabledPluginIds, scope.disabledPluginIds)) scope.stale = true;
      } catch { this.setHistoryScope(origin, params.threadId, null); }
    }
  }
  // The scope a thread's own settings EVENT confirms. ThreadSettings carries no runtimeWorkspaceRoots, so the roots can only be those this same connection confirmed
  // for this same thread earlier (still held, never dropped by a request that might have changed them) with the same workspace; otherwise the scope is unknown.
  scopeFromSettings(origin, id, settings) {
    const before = this.historyScopes.get(id);
    if (!before || before.peer !== origin.peer || !rootList(before.roots) || !isObject(settings) || typeof settings.cwd !== 'string' || workspacePath(settings.cwd) !== workspacePath(before.cwd)) return null;
    return confirmedScope({ ...settings, sandbox: settings.sandboxPolicy, runtimeWorkspaceRoots: before.roots });
  }
  // Turn lifetimes of native / custom threads, from notifications that arrived on that thread's own connection. Runs first and synchronously.
  trackHistory(method, params, origin) {
    if (!originValid(this, origin)) return;
    const id = params?.threadId ?? params?.thread?.id;
    if (typeof id !== 'string') return;
    const entry = this.historyCallers.get(id);
    // Only the connection that runs a thread can announce its turns or its settings; another connection's notice about that ID is not evidence.
    if ((method === 'turn/started' || method === 'thread/settings/updated') && !this.ownsThread(origin, id)) return;
    if (method === 'turn/started' && typeof params.turn?.id === 'string' && !this.records.has(id)) {
      this.endHistoryCaller(id, 'A newer turn started in the calling chat');
      const seen = this.selections.get(id); if (seen?.peer === origin.peer && !seen.hadTurn) { seen.hadTurn = true; this.persistState(id, seen); }
      const scope = this.historyScopes.get(id);
      // The model and provider this turn starts on are captured NOW: a token-window event is only ever bound to the turn it names and to what THAT turn runs on.
      this.historyCallers.set(id, { peer: origin.peer, origin, turnId: params.turn.id, controller: new AbortController(), scopeKey: scope && scope.peer === origin.peer ? scopeKey(scope) : null,
        snapshot: scope && scope.peer === origin.peer && scope.model && scope.modelProvider ? { model: scope.model, modelProvider: scope.modelProvider } : null });
      while (this.historyCallers.size > MAX_HISTORY_CALLERS) this.endHistoryCaller(this.historyCallers.keys().next().value, 'Too many calling chats');
    } else if (entry && entry.peer === origin.peer) {
      if (method === 'turn/completed' && params.turn?.id === entry.turnId) this.endHistoryCaller(id, 'The calling turn ended');
      else if (method === 'thread/closed') { this.endHistoryCaller(id, 'The calling chat was closed'); this.historyScopes.delete(id); this.selections.delete(id); }
      else if (method === 'thread/settings/updated') this.setHistoryScope(origin, id, this.scopeFromSettings(origin, id, params.threadSettings));
    } else if (method === 'thread/settings/updated' && !this.records.has(id)) {
      const scope = this.historyScopes.get(id);
      if (scope?.peer === origin.peer) this.setHistoryScope(origin, id, this.scopeFromSettings(origin, id, params.threadSettings)); // (a scope that is already unknown stays unknown)
    }
  }
  endHistoryCaller(id, reason) {
    const entry = this.historyCallers.get(id);
    if (!entry) return;
    this.historyCallers.delete(id); entry.controller.abort(new RpcError(reason));
  }
  async toolRequest(method, params, timeout, signal, origin) {
    if (method === 'item/tool/call' && params?.namespace === historyNamespace) return this.historyToolCall(params, signal, origin);
    if (method !== 'item/tool/call' || params.namespace !== sessionNamespace)
      return this.desktop.request(method, this.localResponses ? this.localResponses.toLogicalParams(params) : params, timeout, signal);
    try {
      const managed = this.records.has(params.threadId), active = this.active.get(params.threadId);
      // An unmanaged GPT chat's call must come from the native turn the Bridge saw
      // start and not yet end, in a known workspace. Its lifetime bounds the call.
      const turn = managed ? null : this.nativeCallers.get(params.threadId)?.turn;
      if (managed ? !active || params.turnId !== active.turn.id
        : !turn || turn.id !== params.turnId || turn.controller.signal.aborted || typeof this.nativeCallers.get(params.threadId).thread.cwd !== 'string')
        throw new RpcError('Session tool call does not belong to the active turn', -32602);
      const lifetime = managed ? active.controller?.signal : turn.controller.signal;
      const result = await sessionCall(this, params, signal && lifetime ? AbortSignal.any([signal, lifetime]) : signal ?? lifetime);
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    } catch (error) { return { success: false, contentItems: [{ type: 'inputText', text: error.message }] }; }
  }
  async nativeNotification(method, params, origin) {
    // First and synchronous: the turn a connection reports is recorded before anything it sends afterwards (a tool call) can be handled.
    if (origin) {
      this.trackHistory(method, params, origin);
      if (method === 'thread/settings/updated') this.observeSettingsSelection(origin, params);
      else if (method === 'thread/tokenUsage/updated') this.observeNativeWindow(origin, params);
    }
    const record = this.records.get(params.threadId);
    // A turn native has already started cannot be refused here. Desktop requests
    // that could start work are refused before dispatch (rpc.mjs). If this turn can be
    // neither recorded nor invalidated, the logger's process signal makes the
    // guard report unverified immediately (logging.mjs markUnsafe).
    if (!record && ['turn/started', 'turn/completed'].includes(method))
      this.log(method === 'turn/started' ? 'turn.started' : 'turn.finished', { threadId: params.threadId,
        turnId: params.turn?.id, status: params.turn?.status, provider: 'native', ...(params.turn?.error ? errorMetadata(params.turn.error) : {}) });
    const caller = record ? undefined : this.nativeCallers.get(params.threadId);
    if (caller && method === 'turn/started' && typeof params.turn?.id === 'string') this.beginCallerTurn(caller, params.turn.id);
    if (caller && method === 'turn/completed' && params.turn?.id === caller.turn?.id) this.endCallerTurn(caller, 'The calling turn ended');
    if (caller && method === 'thread/closed') this.endCallerTurn(caller, 'The calling chat was closed');
    if (this.internalReverts.has(params.threadId) && ['thread/reverted', 'thread/closed', 'thread/status/changed'].includes(method)) {
      if (method === 'thread/reverted') this.internalReverts.get(params.threadId)();
      return;
    }
    if (method === 'thread/closed') {
      this.loaded.delete(params.threadId);
      if (this.closeWaiters.has(params.threadId)) { this.closeWaiters.get(params.threadId)(); return; }
    }
    if (record && ['thread/archived', 'thread/unarchived'].includes(method)) {
      record.archived = method === 'thread/archived'; this.save(record);
    }
    if (record && record.provider === 'native' && (method.startsWith('turn/') || method.startsWith('item/')))
      await captureNative(this, record, method, params);
    if (record && (method === 'thread/project/updated' || method === 'thread/name/updated')) {
      if (method === 'thread/project/updated') record.thread.projectId = params.projectId;
      else record.thread.name = params.threadName ?? null;
      this.save(record);
    }
    if (method === 'mcpServer/startupStatus/updated') this.log('capability.status', {
      threadId: params.threadId, server: params.name, status: params.status,
      ...(params.error ? errorMetadata(params.error) : {}),
    });
    if (method === 'thread/settings/updated') {
      const settings = params.threadSettings;
      if (caller && settings) {
        Object.assign(caller, { sandbox: settings.sandboxPolicy, approvalPolicy: settings.approvalPolicy,
          activePermissionProfile: settings.activePermissionProfile ?? null, disabledPluginIds: settings.disabledPluginIds ?? caller.disabledPluginIds });
        // A native-confirmed workspace applies to later turns. Calls still in a
        // turn of the previous workspace end rather than continue across it.
        if (typeof settings.cwd === 'string' && settings.cwd !== caller.cwd) {
          caller.cwd = settings.cwd;
          if (caller.turn) this.endCallerTurn(caller, 'The calling chat’s workspace changed');
        }
      }
      if (record && settings) {
        record.nativeSettings = clone(settings); record.nativeModel = settings.model; record.nativeEffort = settings.effort;
        record.sandbox = settings.sandboxPolicy; record.approvalPolicy = settings.approvalPolicy;
        record.options.approvalPolicy = settings.approvalPolicy;
        record.approvalsReviewer = settings.approvalsReviewer;
        if (settings.approvalsReviewer) record.options.approvalsReviewer = settings.approvalsReviewer;
        record.activePermissionProfile = settings.activePermissionProfile;
        record.disabledPluginIds = settings.disabledPluginIds ?? record.disabledPluginIds;
        record.options.permissions = settings.activePermissionProfile?.id;
        delete record.options.sandbox;
        this.settingsWaiters.get(params.threadId)?.(settings); this.save(record);
        params = { ...params, threadSettings: this.settingsView(record, settings) };
      }
      if (!record && this.localResponses) try {
        params = this.localResponses.notification(method, params);
        if (params === null) return;
      } catch (error) { this.log('models.custom_settings_failed', errorMetadata(error)); return; }
    }
    this.emit(method, params);
  }
  async updatePermissions(record, params, selection) {
    if (params.permissions && params.sandboxPolicy) throw new RpcError('permissions cannot be combined with sandboxPolicy', -32602);
    const currentProfile = record.activePermissionProfile?.id ?? record.options.permissions;
    const current = this.hostSettings(record);
    const hostModel = selection?.provider === 'native' ? selection.model : record.nativeModel ?? selection?.model;
    const updates = {};
    if (selection && (!record.nativeModel || (selection.provider === 'native' && hostModel !== current.model))) updates.model = hostModel;
    if (selection && (!record.nativeModel || selection.provider === 'native') && selection.effort !== current.effort) updates.effort = selection.effort;
    if (selection && params.collaborationMode) updates.collaborationMode = { ...params.collaborationMode,
      settings: { ...params.collaborationMode.settings, model: hostModel,
        reasoning_effort: selection.provider === 'native' ? selection.effort : current.effort } };
    if (updates.collaborationMode && isDeepStrictEqual(updates.collaborationMode, current.collaborationMode)) delete updates.collaborationMode;
    if (params.permissions && params.permissions !== currentProfile) updates.permissions = params.permissions;
    if (params.sandboxPolicy && !isDeepStrictEqual(params.sandboxPolicy, record.sandbox)) updates.sandboxPolicy = params.sandboxPolicy;
    for (const key of ['disabledPluginIds', 'approvalPolicy', 'approvalsReviewer'])
      if (params[key] != null && !isDeepStrictEqual(params[key], record[key])) updates[key] = params[key];
    if (!Object.keys(updates).length) {
      // Claude-only selection is bridge-owned. A native no-op emits no event,
      // so waiting for one would time out even though no host change is needed.
      if (selection) {
        this.applySelection(record, selection);
        if (params.collaborationMode) record.modeInstructions = params.collaborationMode.settings.developer_instructions;
        this.save(record);
        this.emit('thread/settings/updated', { threadId: record.thread.id, threadSettings: this.settingsView(record, current) });
      }
      return;
    }
    // Update the live thread. Resuming a just-created thread requires a rollout
    // that does not yet exist. Wait for native resolution before any Claude tool.
    let timer;
    const applied = new Promise((resolve, reject) => {
      this.settingsWaiters.set(record.thread.id, settings => {
        const matches = Object.entries(updates).every(([key, value]) => key === 'permissions'
          ? settings.activePermissionProfile?.id === value
          : key === 'sandboxPolicy' ? Object.entries(value).every(([k, v]) => isDeepStrictEqual(settings.sandboxPolicy?.[k], v))
          : key === 'collaborationMode' ? settings.collaborationMode?.mode === value.mode
            && settings.collaborationMode?.settings?.model === value.settings.model
            && settings.collaborationMode?.settings?.reasoning_effort === value.settings.reasoning_effort
            && (value.settings.developer_instructions == null || settings.collaborationMode.settings.developer_instructions === value.settings.developer_instructions)
          : isDeepStrictEqual(settings[key], value));
        if (matches) {
          if (selection) {
            this.applySelection(record, selection);
            if (params.collaborationMode) record.modeInstructions = settings.collaborationMode?.settings?.developer_instructions;
          }
          resolve();
        }
      });
      timer = setTimeout(() => reject(new RpcError('Native settings update timed out')), 5000);
    });
    applied.catch(() => {});
    try {
      await this.native.request('thread/settings/update', { threadId: record.thread.id, ...updates });
      await applied;
    } finally { clearTimeout(timer); this.settingsWaiters.delete(record.thread.id); }
  }
  async ensureLoaded(record) {
    if (this.loaded.has(record.thread.id)) return;
    const result = await this.native.request('thread/resume', { ...record.options, threadId: record.thread.id,
      model: record.provider === 'native' ? record.model : record.nativeModel ?? record.model,
      modelProvider: record.hostProvider ?? record.options.modelProvider ?? 'claude_code', excludeTurns: true });
    record = this.records.get(record.thread.id) ?? record;
    record.sandbox = result.sandbox; record.approvalPolicy = result.approvalPolicy;
    record.nativeModel = result.model ?? record.nativeModel; record.nativeEffort = result.reasoningEffort ?? record.nativeEffort;
    record.activePermissionProfile = result.activePermissionProfile;
    record.disabledPluginIds = result.disabledPluginIds;
    if (Array.isArray(result.runtimeWorkspaceRoots)) record.runtimeWorkspaceRoots = result.runtimeWorkspaceRoots;
    this.loaded.add(record.thread.id);
  }
  // The workspace roots native confirms for a managed chat's OWN host thread, asked of its owning provider (no provider parameter, so nothing changes).
  // Remembered once known; null when native does not report them.
  async managedRoots(id) {
    const record = this.records.get(id); if (!record) return null;
    if (Array.isArray(record.runtimeWorkspaceRoots)) return record.runtimeWorkspaceRoots;
    // The Thread saved from the host's own start response may already carry the CONFIRMED environment roots (a cold metadata read reports none: environments null
    // while not loaded, which is "unknown", never "empty"). Only roots that were actually saved count; nothing is inferred from the cwd.
    const saved = record.thread?.environments?.[0]?.runtimeWorkspaceRoots;
    if (Array.isArray(saved) && saved.every(r => typeof r === 'string')) { record.runtimeWorkspaceRoots = saved; return saved; }
    // A thread/resume cannot be used for this: native 0.167 checks the provider the APP-SERVER is configured with, whatever provider or config override
    // the request names, so it refuses a claude_code thread from a process configured for another provider. The public thread/read is read-only,
    // needs no provider, and reports the environments of a loaded thread, primary first, each with its workspace roots (a Thread itself has none).
    // The read must confirm the thread's ID and that its OWN provider is the one the record names; anything else is no evidence.
    const provider = record.hostProvider ?? record.options?.modelProvider ?? record.thread?.modelProvider;
    if (typeof provider !== 'string') return null; // the owner cannot be verified from the record: nothing is guessed
    const read = await this.native.request('thread/read', { threadId: id });
    const thread = read?.thread, roots = Array.isArray(thread?.environments) ? thread.environments[0]?.runtimeWorkspaceRoots : undefined;
    if (thread?.id !== id || thread.modelProvider !== provider || !Array.isArray(roots) || !roots.every(r => typeof r === 'string')) return null;
    // Remembered in memory only: discovering it must not rewrite the old record (the source of a handoff is never modified).
    record.runtimeWorkspaceRoots = roots; return record.runtimeWorkspaceRoots;
  }
  // internal is only for in-process callers (never desktop or native RPC): for
  // turn/start, admit() runs synchronously after the last await of turn
  // preparation, immediately before the message is accepted, and refuses it by throwing.
  async request(method, params = {}, internal = {}) {
    // A route to a harness that does not execute here is refused before any router, host or SDK sees it (see harnesses.mjs).
    if (['thread/start', 'thread/resume', 'thread/fork', 'thread/settings/update', 'turn/start'].includes(method)) {
      const asked = [params.collaborationMode?.settings?.model, params.model].find(isHarnessModel);
      if (asked !== undefined) throw new RpcError(harnessRefusal(parseHarnessModelId(asked) ?? { harness: null }).message, -32602);
    }
    if (this.localResponses && !internal.localRouted)
      return this.localResponses.request(method, params, (m, p) => this.request(m, p, { ...internal, localRouted: true }));
    if (['thread/start', 'thread/resume', 'thread/fork', 'thread/settings/update', 'turn/start'].includes(method)
      && (this.records.has(params.threadId) || isClaude(params.model))
      && params.approvalsReviewer != null && params.approvalsReviewer !== 'user')
      throw new RpcError('Claude approval requests can only be reviewed by the user; automatic approval review is not implemented.', -32602);
    if (method === 'model/list') {
      // Bounded local catalog diagnostics, never arbitrary request/result bodies.
      // Retains the desktop's own flags so a cached/hidden picker can be diagnosed
      // from an actual desktop request instead of a fresh-client approximation.
      this.log('models.requested', { includeHidden: params.includeHidden === true,
        limit: Number.isSafeInteger(params.limit) ? params.limit : undefined, cursorPresent: typeof params.cursor === 'string' && params.cursor.length > 0 });
      let list = []; let cursor;
      const pickerRefresh = this.localResponses?.registry.pickerRefresh();
      const refreshClaude = pickerRefresh?.kind === 'claude' && pickerRefresh.revision > (this.localResponses.registry.pickerCatalog().requestRevision ?? 0);
      try {
        do {
          const page = await this.native.request(method, { includeHidden: this.localResponses ? true : params.includeHidden, limit: 100, ...(cursor ? { cursor } : {}) });
          list.push(...page.data); cursor = page.nextCursor;
        } while (cursor);
      } catch (error) {
        if (this.localResponses) try {
          const registry = this.localResponses.registry, retained = registry.pickerCatalog().models.map(m => ({ ...m, available: false }));
          registry.observePickerModels(retained, pickerRefresh.revision, { nativeFailed: true });
        } catch (bindingError) { this.log('models.observation_failed', errorMetadata(bindingError)); }
        throw error; // retain the real native RPC failure; never fake a catalog
      }
      const nativeIds = new Set(list.map(m => m.id)); let offeredClaude = []; let claudeAvailable = false, claudeCatalogFailed = false;
      try {
        const { policy } = this.claudeState(); claudeAvailable = policy.enabled;
        // A disabled or unreadable connection offers nothing and starts no SDK. includeHidden may
        // show what is retained, from the last validated catalog only.
        const catalog = policy.enabled ? await (refreshClaude ? this.refreshCatalog() : this.catalog()) : (this.localResponses || params.includeHidden === true) ? this.catalogList ?? storedModels(this.connectionRoot) ?? [] : [];
        claudeAvailable = claudeAvailable && !this.pickerClaudeCatalogFailed;
        const merged = mergeClaudeModels(list, codexModels(catalog), policy, this.localResponses ? true : params.includeHidden === true);
        for (const model of merged.collisions) this.log('models.collision', { model });
        list = merged.models;
        // Recorded while disabled too (an empty offer), as what model/list last offered; an unreadable store is not repaired.
        offeredClaude = merged.offered;
        if (!this.localResponses && this.connectionRoot) try { recordOffered(this.connectionRoot, offeredClaude, { wait: false }); } catch (error) { this.log('connections.record_failed', errorMetadata(error)); }
      } catch (error) { claudeCatalogFailed = true; this.log('models.failed', errorMetadata(error)); }
      if (this.localResponses) {
        const retained = claudeCatalogFailed ? this.localResponses.registry.pickerCatalog().models.filter(m => m.kind === 'claude' && !nativeIds.has(m.id)).map(m => ({ ...m, available: false })) : [];
        this.localResponses.registry.observePickerModels([...list.map(m => ({ id: m.id, name: m.displayName ?? m.model ?? m.id,
          kind: nativeIds.has(m.id) ? 'native' : 'claude', defaultVisible: m.hidden !== true, available: nativeIds.has(m.id) || claudeAvailable,
          capabilities: Object.fromEntries(['supportedReasoningEfforts', 'defaultReasoningEffort', 'inputModalities', 'supportsPersonality'].filter(k => m[k] !== undefined).map(k => [k, m[k]])) })), ...retained], pickerRefresh.revision);
      }
      if (this.localResponses) try {
        const merged = this.localResponses.mergeModels(list, params.includeHidden === true);
        for (const model of merged.collisions) this.log('models.collision', { model });
        list = merged.models;
      } catch (error) { this.log('models.custom_failed', errorMetadata(error)); }
      if (this.localResponses) {
        list = this.localResponses.registry.filterPicker(list, params.includeHidden === true);
        if (this.connectionRoot) try { recordOffered(this.connectionRoot, offeredClaude.filter(id => list.some(m => m.id === id)), { wait: false }); } catch (error) { this.log('connections.record_failed', errorMetadata(error)); }
      }
      const result = this.page(list, params), slots = this.localResponses?.registry.slots();
      this.log('models.listed', { catalogRows: list.length, returnedRows: result.data.length,
        hiddenRows: result.data.filter(m => m.hidden === true).length, selectedRows: slots?.models?.length,
        slotsRevision: slots?.revision });
      // IDs only, not names, endpoint URLs, auth/config or chat data. The logger
      // allowlist also bounds and validates each ID; at most 16 rows are sampled.
      result.data.slice(0, 16).forEach((m, rowIndex) => this.log('models.row', { rowIndex, model: m.id, hidden: m.hidden === true }));
      return result;
    }
    if (method === 'thread/start') {
      const requested = params.model ?? (await this.native.request('config/read', { cwd: params.cwd, includeLayers: false })).config.model;
      if (!isClaude(requested)) {
        // Every new native thread (a desktop start and a hand-off target alike) is given the read-only history namespace beside whatever dynamic
        // tools the request already carried. The pinned thread/resume has no dynamicTools, so a chat created before this existed simply does not
        // have it and stays full (nothing here migrates it).
        if (!this.coordinateNative) return this.native.request(method, withHistoryTools(params));
        // Primary mode: a new GPT chat stays native and GPT-owned, and also
        // receives the public session tools so it can start and steer Claude chats.
        const result = await this.native.request(method, withHistoryTools(withSessionTools(params)));
        this.trackCaller(result, params.config);
        return result;
      }
      const model = await this.selectModel(requested);
      const config = (await this.native.request('config/read', { cwd: params.cwd, includeLayers: false })).config;
      const hostModel = isClaude(config.model) ? undefined : config.model;
      const options = withSessionTools({ ...params, model: model.value, modelProvider: config.model_provider ?? 'openai' });
      const result = await this.native.request(method, { ...options, model: hostModel });
      const record = { thread: result.thread, options, sandbox: result.sandbox,
        instructionSources: result.instructionSources, disabledPluginIds: result.disabledPluginIds, model: model.value,
        approvalPolicy: result.approvalPolicy, activePermissionProfile: result.activePermissionProfile,
        effort: model.supportsEffort ? 'high' : 'none', turns: [], updatedAt: now(), archived: false,
        provider: 'claude', nativeModel: result.model ?? hostModel, nativeProvider: result.modelProvider ?? options.modelProvider,
        nativeEffort: result.reasoningEffort, approvalsReviewer: result.approvalsReviewer,
        hostProvider: result.modelProvider ?? options.modelProvider, neutralNativeSeed: true, nativeServiceTier: result.serviceTier ?? null, nativeMultiAgentMode: result.multiAgentMode,
        ...(Array.isArray(result.runtimeWorkspaceRoots) ? { runtimeWorkspaceRoots: result.runtimeWorkspaceRoots } : {}) };
      this.records.set(result.thread.id, record); this.loaded.add(result.thread.id); this.save(record);
      this.log('thread.created', { threadId: record.thread.id, model: model.value, provider: 'claude_code', dynamicToolCount: options.dynamicTools?.length ?? 0 });
      return { ...result, thread: this.thread(record), model: model.value, modelProvider: 'claude_code', reasoningEffort: record.effort };
    }
    if (this.adopting.has(params.threadId)) throw new RpcError('Wait for the current chat change to finish');
    let record = this.records.get(params.threadId);
    if (!record && ['turn/start', 'thread/resume', 'thread/settings/update'].includes(method)
      && isClaude(params.collaborationMode?.settings?.model ?? params.model)) {
      await this.selectModel(params.collaborationMode?.settings?.model ?? params.model);
      this.adopting.add(params.threadId);
      try { record = await adoptNativeThread(this, params); }
      finally { this.adopting.delete(params.threadId); }
    }
    if (method === 'thread/list') {
      const page = await this.native.request(method, { ...params, modelProviders: params.modelProviders ?? [] });
      return { ...page, data: page.data.map(thread => {
        const saved = this.records.get(thread.id);
        if (!saved) return thread;
        this.metadata(saved, thread); return this.thread(saved, false);
      }) };
    }
    if (record) {
      if (method.startsWith('thread/queue/')) return queueRequest(this, record, method, params, internal);
      if (method === 'thread/resume' && this.resuming.has(record.thread.id)) return this.resume(record, params);
      if (this.changing.has(record.thread.id) && ['turn/start', 'thread/revert', 'thread/resume', 'thread/settings/update', 'thread/unload', 'thread/unsubscribe', 'thread/archive', 'thread/unarchive'].includes(method))
        throw new RpcError('Wait for the current chat change to finish');
      if (this.reverting.has(record.thread.id) && ['turn/start', 'thread/revert', 'thread/resume', 'thread/unload', 'thread/unsubscribe', 'thread/archive', 'thread/unarchive'].includes(method))
        throw new RpcError('Wait for the history edit to finish before changing this chat');
      if (method === 'thread/revert') return this.revert(record, params);
      if (method === 'turn/start') return this.begin(record, params, internal);
      if (method === 'turn/interrupt') {
        const running = this.active.get(params.threadId);
        if (!running && this.starting.has(params.threadId))
          throw new RpcError('The turn is still starting; interrupt using the turn ID returned by turn/start.', -32602);
        if (running && params.turnId !== running.turn.id) throw new RpcError('Turn is no longer active', -32602);
        if (running?.native) {
          const result = await this.native.request(method, params);
          running.controller?.abort(); return result;
        }
        running?.controller.abort(); running?.query?.close(); return {};
      }
      if (method === 'turn/steer') return steerTurn(this, record, params);
      if (method === 'thread/settings/update') return this.exclusive(record, async () => {
        this.checkWorkspace(record, params);
        // The current public protocol ignores these deprecated fields, but the
        // desktop still includes multiAgentMode when changing native models.
        const ignored = new Set(['multiAgentMode', 'personality']);
        const supported = new Set(['threadId', 'cwd', 'model', 'effort', 'collaborationMode', 'permissions', 'sandboxPolicy', 'approvalPolicy', 'approvalsReviewer', 'disabledPluginIds']);
        for (const [key, value] of Object.entries(params)) if (value != null) {
          if (ignored.has(key)) this.log('settings.ignored', { threadId: params.threadId, reason: key });
          else if (!supported.has(key)) {
            this.log('settings.unsupported', { threadId: params.threadId, reason: 'unsupported_field' });
            throw new RpcError(`${key} is not supported in Claude thread settings`, -32602);
          }
        }
        const selection = await this.selection(record, params);
        if (selection.provider === 'native') await reloadNativeHost(this, record, selection.model);
        await this.ensureLoaded(record);
        await this.updatePermissions(record, params, selection);
        return {};
      });
      if (method === 'thread/resume') return this.resume(record, params);
      if (method === 'thread/read') return { thread: this.thread(record, !!params.includeTurns) };
      if (method === 'thread/turns/list') {
        return this.turnPage(record, params);
      }
      if (method === 'thread/items/list') {
        let entries = record.turns.filter(t => !params.turnId || t.id === params.turnId)
          .flatMap(t => t.items.map(item => ({ turnId: t.id, item })));
        if (params.sortDirection === 'desc') entries.reverse();
        if (params.cursor && typeof params.cursor === 'object') {
          if (!params.turnId || params.cursor.type !== 'item' || !params.cursor.itemId)
            throw new RpcError('An item anchor requires turnId and itemId', -32602);
          params = { ...params, cursor: `after:${params.cursor.itemId}` };
        }
        return this.historyPage(entries, params, entry => entry.item.id);
      }
      if (method === 'thread/name/set') {
        const result = await this.native.request(method, params);
        record.thread.name = params.name; this.save(record); return result;
      }
      if (method === 'thread/metadata/update') {
        const result = await this.native.request(method, params);
        this.metadata(record, result.thread);
        return { ...result, thread: this.thread(record, false) };
      }
      if (method === 'thread/unload' || method === 'thread/unsubscribe') {
        return this.exclusive(record, async () => {
          const result = await this.native.request(method, params); this.loaded.delete(params.threadId); return result;
        });
      }
      if (method === 'thread/archive' || method === 'thread/unarchive') {
        return this.exclusive(record, async () => {
          const result = await this.native.request(method, params);
          record.archived = method === 'thread/archive';
          if (!this.active.has(params.threadId)) this.loaded.delete(params.threadId);
          this.metadata(record, result.thread); this.save(record);
          this.log(record.archived ? 'thread.archived' : 'thread.unarchived', { threadId: params.threadId });
          return result.thread ? { ...result, thread: this.thread(record, false) } : result;
        }, true);
      }
      if (method === 'thread/fork') return this.exclusive(record, () => forkThread(this, record, params), true);
      if (method === 'thread/delete') throw new RpcError('Thread deletion is not implemented; archive the thread instead.', -32601);
      if (['review/start', 'thread/compact/start', 'thread/rollback'].includes(method)) throw new RpcError(`${method} is not implemented for Claude chats.`, -32601);
      // These native routes own/execute turns that are absent from Claude's
      // history. Passing them through would acknowledge a different operation.
      if (['thread/inject_items', 'turn/addUserMessage', 'turn/settings/update',
        'thread/shellCommand', 'thread/prediction/request', 'thread/goal/set'].includes(method)
        || (method.startsWith('thread/realtime/') && method !== 'thread/realtime/listVoices'))
        throw new RpcError(`${method} is not implemented for Claude chats; the native turn was not started or changed.`, -32601);
    }
    // Stopping, unloading or archiving an unmanaged GPT chat ends its coordination
    // at once, before native reports the turn's completion.
    const caller = record ? undefined : this.nativeCallers.get(params.threadId);
    if (caller && ((method === 'turn/interrupt' && params.turnId === caller.turn?.id) || ['thread/unload', 'thread/unsubscribe', 'thread/archive'].includes(method)))
      this.endCallerTurn(caller, 'The calling turn was stopped');
    // The same for the history tool's caller of this (main native) thread.
    if (!record && this.historyCallers.get(params.threadId)?.peer === this.native && ((method === 'turn/interrupt' && params.turnId === this.historyCallers.get(params.threadId).turnId) || ['thread/unload', 'thread/unsubscribe', 'thread/archive'].includes(method)))
      this.endHistoryCaller(params.threadId, 'The calling turn was stopped');
    // The main native process owns this thread. A model or level change asked of it is made durable as an INTENT first (see stageIntent), and a turn goes through the dispatch boundary
    // (reconciliation, first-request budget, transition note) immediately before it is sent.
    if (method === 'thread/settings/update' && !record && typeof params.threadId === 'string') {
      const known = this.selections.get(params.threadId);
      // (the same one-level rule as a turn: see beforeTurn)
      { const named = params.collaborationMode?.settings?.model ?? params.model ?? known?.now.model; if (known?.kind === 'native' || typeof named === 'string') params = await normalizeNativeEffort(this, params, named, known?.now.effort); }
      const asked = params.collaborationMode?.settings, model = typeof asked?.model === 'string' && asked.model ? asked.model : typeof params.model === 'string' && params.model ? params.model : null, effort = params.effort ?? asked?.reasoning_effort;
      if ((model || effort !== undefined) && known?.kind === 'native' && !this.stageIntent(params.threadId, { peer: this.native, kind: 'native', to: { model: model ?? known.now.model, effort: effort === undefined ? known.now.effort : effort ?? null } }))
        throw this.contextRefusal('context_state_unwritable', 'Model Bridge could not save its record for this chat, so the change was not made. Try again.');
    }
    let turn = null;
    if (method === 'turn/start' && !record) turn = await this.beforeTurn({ physical: params.threadId, peer: this.native, kind: 'native', params });
    let result;
    try { result = await this.native.request(method, turn?.params ?? params); } catch (error) { turn?.failed(error); throw error; }
    turn?.accepted(result);
    if (method === 'initialize') { this.nativeInitialization = clone(params); this.mirror?.start(); }
    // A reopened or forked unmanaged GPT chat keeps any session tools native gave it.
    if (['thread/resume', 'thread/fork'].includes(method)) this.trackCaller(result, params.config ?? this.nativeCallers.get(params.threadId)?.options.config);
    if (method === 'mcpServerStatus/list') for (const server of result.data ?? []) this.log('capability.catalog', {
      threadId: params.threadId, server: server.name, status: server.runtimeStatus ?? 'unknown',
      toolCount: Object.keys(server.tools ?? {}).length,
      ...(server.toolsError ? errorMetadata(server.toolsError) : {}),
    });
    return result;
  }
  // An unmanaged GPT chat's coordination state. cwd is its latest native-confirmed
  // workspace (response-level cwd first); thread.cwd is the workspace of its
  // current turn. Without a known workspace it gets no coordination.
  trackCaller(result, config) {
    const thread = result?.thread;
    if (!this.coordinateNative || !thread?.id || this.records.has(thread.id)) return;
    const previous = this.nativeCallers.get(thread.id), cwd = result.cwd ?? thread.cwd;
    if (typeof cwd !== 'string') {
      if (previous) { this.endCallerTurn(previous, 'The calling chat’s workspace is unknown'); this.nativeCallers.delete(thread.id); }
      return;
    }
    const caller = { thread: { id: thread.id, cwd, ephemeral: !!thread.ephemeral, name: thread.name ?? null }, cwd,
      options: { config: config ?? {} }, sandbox: result.sandbox, approvalPolicy: result.approvalPolicy,
      activePermissionProfile: result.activePermissionProfile ?? null, disabledPluginIds: result.disabledPluginIds ?? [], turn: null };
    if (previous?.turn) {
      // A reopened chat keeps its running turn only in that turn's workspace.
      if (previous.thread.cwd === cwd) caller.turn = previous.turn;
      else this.endCallerTurn(previous, 'The calling chat’s workspace changed');
    }
    this.nativeCallers.set(thread.id, caller);
  }
  beginCallerTurn(caller, id) {
    this.endCallerTurn(caller, 'A newer turn started in the calling chat');
    caller.thread.cwd = caller.cwd;
    caller.turn = { id, controller: new AbortController() };
  }
  endCallerTurn(caller, reason) {
    caller.turn?.controller.abort(new RpcError(reason));
    caller.turn = null;
  }
  async resume(record, params) {
    const threadId = record.thread.id;
    this.checkWorkspace(record, params);
    const { path, history, ...resumeParams } = params;
    const hasPath = path != null && path !== '';
    const matchingPath = typeof path === 'string' && (path === record.thread.path || record.resumePaths?.includes(path));
    this.log('thread.resume_requested', { threadId,
      reason: history != null ? 'alternate_history' : hasPath ? matchingPath ? 'matching_path' : 'alternate_path' : 'thread_id' });
    if (history != null || (hasPath && !matchingPath)) throw new RpcError('Resume Claude chats by threadId; alternative history/path is not supported.', -32602);
    if (this.active.has(params.threadId) && Object.entries(params).some(([key, value]) =>
      ['model', 'config', 'baseInstructions', 'developerInstructions', 'permissions', 'sandbox', 'approvalPolicy'].includes(key)
      && value != null && !isDeepStrictEqual(value, key === 'model' ? record.model : record.options[key])))
      throw new RpcError('Wait for the active Claude turn before changing resume settings');
    // Desktop can reopen one chat from two views at once, e.g. after unarchive.
    // An identical request shares the in-flight native resume; only the
    // requested turn view differs. Any other request still waits its turn.
    const key = Object.fromEntries(Object.entries(resumeParams)
      .filter(([name, value]) => value != null && name !== 'excludeTurns' && name !== 'initialTurnsPage'));
    const view = result => {
      const current = this.records.get(threadId) ?? record;
      return { ...result, model: current.model, modelProvider: provider(current), reasoningEffort: current.effort,
        ...(result.collaborationMode ? { collaborationMode: this.settingsView(current, result).collaborationMode } : {}),
        thread: this.thread(current, !params.excludeTurns && !params.initialTurnsPage),
        turnsBackwardsCursor: current.turns.length ? `at:${current.turns.at(-1).id}` : null, itemsBackwardsCursor: null,
        initialTurnsPage: params.initialTurnsPage ? this.turnPage(current, params.initialTurnsPage) : null };
    };
    const pending = this.resuming.get(threadId);
    if (pending) {
      if (!isDeepStrictEqual(pending.key, key)) throw new RpcError('Wait for the current chat change to finish');
      this.log('thread.resume_joined', { threadId });
      return view(await pending.promise);
    }
    const promise = this.exclusive(record, async () => {
      // A true reopen names the chat's own Claude model (or none): it keeps the retained model and
      // effort, asks the SDK nothing and starts no model work. Any other selection is a new choice
      // and takes the normal admission, so resume cannot change a chat's model around hide or disable.
      const requested = params.collaborationMode?.settings?.model ?? params.model ?? record.model;
      const reopen = (record.provider ?? 'claude') === 'claude' && requested === record.model;
      const selected = reopen ? { model: record.model, effort: record.effort, provider: 'claude' } : await this.selection(record, params);
      const model = selected.model;
      // Desktop echoes the native rollout path when opening a fork. Accept
      // that known identity hint, but always resume the host by threadId.
      const options = mergeOptions(record.options, resumeParams);
      delete options.path; delete options.history;
      if (selected.provider === 'native') await reloadNativeHost(this, record, model);
      const result = await this.native.request('thread/resume', { ...options,
        model: selected.provider === 'native' ? model : record.nativeModel ?? model,
        modelProvider: record.hostProvider ?? record.options.modelProvider ?? 'claude_code', excludeTurns: true });
      this.applySelection(record, selected); record.options = { ...options, model, approvalPolicy: result.approvalPolicy };
      this.loaded.add(threadId);
      record.sandbox = result.sandbox; record.disabledPluginIds = result.disabledPluginIds;
      record.approvalPolicy = result.approvalPolicy;
      record.activePermissionProfile = result.activePermissionProfile;
      record.nativeModel = result.model ?? record.nativeModel; record.nativeEffort = result.reasoningEffort ?? record.nativeEffort;
      record.instructionSources = result.instructionSources ?? record.instructionSources; this.save(record);
      this.metadata(record, result.thread);
      return result;
    }, true);
    this.resuming.set(threadId, { key, promise });
    try { return view(await promise); }
    finally { if (this.resuming.get(threadId)?.promise === promise) this.resuming.delete(threadId); }
  }
  async revert(record, params) {
    const threadId = record.thread.id;
    if (record.thread.ephemeral) throw new RpcError('Ephemeral Claude chats do not support history editing', -32602);
    if (this.active.has(threadId) || this.starting.has(threadId) || this.pendingSteers.has(threadId)) throw new RpcError('Interrupt the active Claude turn before editing history');
    const index = record.turns.findIndex(t => t.id === params.beforeTurnId);
    if (index < 0) throw new RpcError('Turn not found in this Claude chat', -32602);
    this.reverting.add(threadId);
    try {
      const claudeSessionId = record.provider === 'native' || record.turns[index - 1]?.provider === 'native' ? undefined : await this.history.before(record, index);
      const next = { ...record, claudeSessionId, turns: record.turns.slice(0, index), updatedAt: now(), loadedTools: [], nativeResetRequired: true,
        thread: { ...record.thread, preview: index ? record.thread.preview : '' } };
      // Commit bridge-owned conversation history only after the SDK succeeds.
      // The native thread remains the same workspace/tool host; it has never
      // owned these Claude turn IDs. Files and external tool effects are unchanged.
      this.save(next); this.records.set(threadId, next);
      this.log('thread.reverted', { threadId, turnId: params.beforeTurnId,
        retainedTurns: index, removedTurns: record.turns.length - index, sessionId: claudeSessionId });
      this.emit('thread/reverted', { threadId });
      return { thread: this.thread(next, false),
        turnsBackwardsCursor: next.turns.length ? `at:${next.turns.at(-1).id}` : null, itemsBackwardsCursor: null };
    } finally { this.reverting.delete(threadId); }
  }
  page(values, params) {
    if (params.cursor && !/^\d+$/.test(params.cursor)) throw new RpcError('Unsupported cursor', -32602);
    const offset = Number(params.cursor ?? 0), limit = Math.min(params.limit ?? 100, 1000);
    if (!Number.isSafeInteger(offset) || !Number.isInteger(limit) || limit < 1) throw new RpcError('Invalid page size or cursor', -32602);
    return { data: values.slice(offset, offset + limit), nextCursor: offset + limit < values.length ? String(offset + limit) : null };
  }
  turnPage(record, params) {
    const turns = record.turns.map(t => params.itemsView === 'notLoaded' ? envelope(t) : clone(publicTurn(t)));
    if (params.sortDirection !== 'asc') turns.reverse();
    return this.historyPage(turns, params, t => t.id);
  }
  historyPage(values, params, id) {
    let offset = 0;
    if (params.cursor) {
      const match = /^(at|after):(.+)$/.exec(params.cursor);
      offset = match ? values.findIndex(v => id(v) === match[2]) : -1;
      if (offset < 0) throw new RpcError('Unknown history cursor', -32602);
      if (match[1] === 'after') offset++;
    }
    const page = this.page(values, { ...params, cursor: String(offset) });
    return { data: page.data, nextCursor: page.nextCursor ? `after:${id(page.data.at(-1))}` : null,
      backwardsCursor: page.data.length ? `at:${id(page.data[0])}` : null };
  }
  async begin(record, params, internal = {}) {
    const pendingSteer = [...(this.pendingSteers.get(record.thread.id) ?? [])].find(s => s.params.clientUserMessageId === params.clientUserMessageId && params.clientUserMessageId);
    if (pendingSteer) {
      if (!isDeepStrictEqual(pendingSteer.params.input, params.input)) throw new RpcError('This clientUserMessageId already belongs to a different message.', -32602);
      const { turnId } = await pendingSteer.promise;
      return { turn: envelope(record.turns.find(t => t.id === turnId)) };
    }
    const acceptedInput = submission(record, params.clientUserMessageId);
    const previous = acceptedInput?.turn;
    const pending = this.pendingStarts.get(record.thread.id);
    const duplicate = acceptedInput?.input
      ?? (params.clientUserMessageId && pending?.params.clientUserMessageId === params.clientUserMessageId ? pending.params.input : undefined);
    if (duplicate) {
      if (!isDeepStrictEqual(duplicate, params.input)) throw new RpcError('This clientUserMessageId already belongs to a different message.', -32602);
      if (!previous) return pending.promise;
      if (acceptedInput.steer?.status === 'uncertain') throw new RpcError('Steering delivery is uncertain; inspect this turn before sending a new message.');
      this.log('turn.replayed', { threadId: record.thread.id, turnId: previous.id });
      return { turn: envelope(previous) };
    }
    if (record.archived) throw new RpcError('Unarchive this chat before starting another turn.', -32602);
    if (this.changing.has(record.thread.id) || this.reverting.has(record.thread.id) || this.pendingSteers.has(record.thread.id)) throw new RpcError('Wait for the current chat change to finish');
    if (this.active.has(record.thread.id) || this.starting.has(record.thread.id)) throw new RpcError('A turn is already running. Queue the message or interrupt before starting another.', -32602);
    this.starting.add(record.thread.id);
    if (this.log('turn.preparing', { threadId: record.thread.id, queuedSubmissionId: params.queuedSubmissionId }) === false) {
      // The idle guard could still read an older idle record. Admit no work.
      this.starting.delete(record.thread.id);
      this.log('turn.prepared', { threadId: record.thread.id, status: 'failed' });
      throw new RpcError(unsafeActivity);
    }
    const promise = this.prepareTurn(record, params, internal);
    this.pendingStarts.set(record.thread.id, { params, promise });
    let accepted;
    try { accepted = await promise; return accepted; }
    finally {
      this.starting.delete(record.thread.id); this.pendingStarts.delete(record.thread.id);
      this.log('turn.prepared', { threadId: record.thread.id, status: accepted ? 'accepted' : 'failed' });
      if (accepted && !this.active.has(record.thread.id)) continueQueue(this, record, record.turns.at(-1)?.status);
    }
  }
  async prepareTurn(record, params, { admit } = {}) {
    if (!Array.isArray(params.input) || !params.input.length) throw new RpcError('input must be non-empty', -32602);
    // An earlier query of this chat whose model may or may not have received the model-change note is settled (from the SDK's public record) or HELD here, before anything is changed or dispatched.
    await this.resolveNoticeAttempt(record);
    await this.resolveNativeAttempt(record);
    const mode = params.collaborationMode?.settings;
    const selection = await this.selection(record, params);
    this.checkWorkspace(record, params);
    await this.mirror?.refresh();
    await finishQueueMigration(this, record);
    if (selection.provider === 'native') await reloadNativeHost(this, record, selection.model);
    await this.ensureLoaded(record);
    await this.updatePermissions(record, params);
    // A Claude turn is accepted below without another await, so this is its last
    // check. A native turn first resets its history; beginNative checks again
    // after that, immediately before dispatch.
    admit?.();
    // The last check before a Claude turn is accepted: a change made while it was being prepared still applies.
    if (selection.provider === 'claude') {
      const denied = this.claudeDenied({ model: selection.model, continuing: (record.provider ?? 'claude') === 'claude' && selection.model === record.model });
      if (denied) throw denied;
    }
    this.applySelection(record, selection);
    if (params.approvalPolicy) record.approvalPolicy = params.approvalPolicy;
    if (mode) record.modeInstructions = mode.developer_instructions;
    if (record.provider === 'native') return beginNative(this, record, params, admit);
    // What the model receives beyond the request. A session that already exists resumes with its own context: nothing of the history is repeated. Only a FIRST query carries the handed-over
    // history: the whole visible history, or - after a reduced hand-off whose stored context is still valid for this very history - the reduction, checked with the real request now.
    // A model-change note the model has not yet seen: trusted application context, consumed by the system instructions, cleared once its query has really started. It is part of what the query
    // carries, so it is added BEFORE any budget check.
    const notice = validNotice(record.transitionNotice) && record.transitionNotice.pending === true ? record.transitionNotice : null;
    const carried = notice ? { ...params.additionalContext, bridge_transition: noticeContext(notice) } : params.additionalContext;
    let additionalContext = carried;
    if (!record.claudeSessionId && record.turns.length) {
      // The real request: its input and, when given, its output schema (the instructions and tool schemas are the reserved estimates of planBudget).
      const requestTokens = estimateTokens([params.input ?? null, params.outputSchema ?? null]), budget = this.budgets.get('claude', record.model);
      if (validContext(record.contextHandoff, record.turns)) {
        additionalContext = claudeContext(record.contextHandoff, record.turns, carried);
        const check = budget && fitsAtDispatch({ budget, handoffTokens: contextTokens(additionalContext), requestTokens });
        if (!check?.fits) throw new RpcError(budget ? `This message is too large to send together with the shortened context carried to this model (about ${check.needed} of ${check.window} tokens, an estimate). Nothing was sent and nothing was shortened. Send it in smaller parts.` : 'The context window of this model is no longer known, so the shortened context cannot be checked against this message. Nothing was sent.', -32602);
      } else {
        additionalContext = handoffContext(record.turns, carried);
        // A known window and a stored reduction that is no longer valid for this history, or a full history that does not fit: never silently the whole history over a window it may not fit.
        const check = budget && fitsAtDispatch({ budget, handoffTokens: contextTokens(additionalContext), requestTokens });
        if (check && !check.fits) throw new RpcError(`The conversation carried to this model does not fit its known context window together with this message (about ${check.needed} of ${check.window} tokens, an estimate), and no valid shortened context exists for this history. Nothing was sent. Use the earlier model or start the change again.`, -32602);
      }
    }
    const turn = { id: randomUUID(), claudePromptId: randomUUID(), status: 'inProgress', startedAt: now(), completedAt: null, error: null,
      items: [{ id: params.clientUserMessageId ?? randomUUID(), type: 'userMessage', content: params.input }], itemsView: 'full', provider: 'claude', ...(notice ? { noticeId: notice.id } : {}) };
    // historyScope: the workspace (real path) and permission state this turn starts under; the history tool must find them unchanged on every read.
    const running = { turn, model: record.model, controller: new AbortController(), query: null, steeringInput: messageStream(), historyScope: this.sdkScopeKey(record), notice: notice ? clone(notice) : null };
    const queued = acceptQueued(record, params, turn);
    record.turns.push(turn); record.updatedAt = now();
    record.thread.preview ||= params.input.filter(p => p.type === 'text').map(p => p.text).join(' ').slice(0, 200);
    this.active.set(record.thread.id, running); this.save(record);
    if (queued) {
      this.emit('thread/queue/changed', { threadId: record.thread.id });
      this.log('queue.accepted', { threadId: record.thread.id, turnId: turn.id, queuedSubmissionId: turn.queuedSubmissionId, queueLength: record.queue.length });
    }
    setImmediate(() => this.run(record, running, { ...params, additionalContext }));
    return { turn: envelope(turn) };
  }
  async run(record, running, params) {
    const { turn, controller } = running, threadId = record.thread.id;
    let stage = 'persist';
    this.log('turn.started', { threadId, turnId: turn.id, model: record.model, provider: 'claude', effort: record.effort, resuming: !!record.claudeSessionId });
    const openItems = new Map();
    const item = (phase, value) => {
      if (running.finished) return;
      if (phase === 'started') { turn.items.push(value); openItems.set(value.id, value); }
      else if (!openItems.delete(value.id)) return;
      // Persist before dispatch so crash recovery can report an uncertain action.
      if (phase === 'started' && value.type === 'mcpToolCall') this.save(record);
      if (phase === 'started' && value.type === 'mcpToolCall') this.log('tool.started', { threadId, turnId: turn.id, server: value.server, tool: value.tool });
      if (phase === 'completed' && value.type === 'mcpToolCall') this.log('tool.finished', {
        threadId, turnId: turn.id, server: value.server, tool: value.tool, status: value.status, durationMs: value.durationMs,
        ...(value.error ? errorMetadata(value.error) : value.result?.isError
          ? errorMetadata(value.result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n')) : {}),
      });
      this.emit(`item/${phase}`, { threadId, turnId: turn.id, item: value });
    };
    this.emit('turn/started', { threadId, turn: envelope(turn) });
    // Announce the turn's own message, as steering does for steered ones. A
    // queued or session-started turn has no bubble the desktop drew itself;
    // clientId lets the desktop reconcile one it did draw.
    const [{ id: messageId, content }] = turn.items;
    const message = { type: 'userMessage', id: messageId, clientId: params.clientUserMessageId ?? null, content };
    this.emit('item/started', { threadId, turnId: turn.id, item: message });
    this.emit('item/completed', { threadId, turnId: turn.id, item: message });
    this.emit('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } });
    const partial = new Map(); let latestMessageId; let receivedResult = false;
    // The session this query resumed (none for a first query): a window is only taken from a result of THAT session.
    const resumedFrom = record.claudeSessionId ?? null;
    try {
      controller.signal.throwIfAborted();
      // Materialize native persistence without invoking its model.
      if (!record.nativePersisted) {
        await this.native.request('thread/inject_items', { threadId, items: [{ type: 'message', role: 'user',
          content: [{ type: 'input_text', text: '[Bridge tool host. Conversation is supplied when needed.]' }] }] }, 60_000, controller.signal);
        record.nativePersisted = true; this.save(record);
      }
      stage = 'instructions';
      const systemPrompt = await instructions(this.native, record, params.additionalContext);
      this.log('context.prepared', { threadId, turnId: turn.id, instructionCharacters: systemPrompt.length,
        contextOverrideCount: Object.keys(record.options.config ?? {}).length, dynamicToolCount: record.options.dynamicTools?.length ?? 0 });
      controller.signal.throwIfAborted();
      // The last safe point before the model is asked, now that the ACTUAL system instructions are known (they carry the handed-over history, the application and untrusted context and the note):
      // the first query of a chat that was handed history is measured with them, the request's input and output schema, and the reserve for tool schemas (a heuristic estimate, never a measurement).
      // A known window it does not fit is refused here: nothing is sent to the model, the turn fails with the reason, and the note stays pending.
      if (!resumedFrom && record.turns.length > 1) {
        const budget = this.budgets.get('claude', record.model);
        // ONE combined check of everything this query really carries: the actual system instructions (which already hold the trusted application context), the UNTRUSTED context that
        // claude.inputContent serializes beside the input (the carried history), the input and the output schema, plus the reserves for tool schemas, output and margin. Nothing is counted twice.
        const untrusted = contextFragments(params.additionalContext, 'untrusted');
        const fit = budget && fitsAtDispatch({ budget, handoffTokens: estimateTokens(systemPrompt) + (untrusted.length ? estimateTokens(untrusted) : 0), requestTokens: estimateTokens([params.input ?? null, params.outputSchema ?? null]), reserves: { instructionsTokens: 0 } });
        if (fit && !fit.fits) throw new Error(`The conversation carried to this model does not fit its known context window together with its instructions and this message (about ${fit.needed} of ${fit.window} tokens, an estimate). Nothing was sent to the model and nothing was shortened. Use the earlier model, or start a new chat.`);
      }
      const mcp = makeTools({ native: this.native, desktop: { request: (...args) => this.toolRequest(...args) }, record, turn, item, signal: controller.signal,
        archiveSelf: () => this.request('thread/archive', { threadId }), history: this.sdkHistory(record, running, turn, controller.signal) });
      running.mcp = mcp;
      stage = 'claude_query';
      // The attempt is written BEFORE the query exists: exactly which record, session, prompt, turn, model and note it carries. It is settled only by the model's own answer (noticeAck), by the SDK's public
      // record (resolveNoticeAttempt), or - when its prompt was provably never handed to the SDK - by being dropped (the note stays owed).
      if (running.notice) { record.noticeAttempt = { threadId: record.thread.id, noticeId: running.notice.id, notice: running.notice, sessionId: record.claudeSessionId ?? null, promptId: turn.claudePromptId, turnId: turn.id, model: record.model, cwd: record.thread.cwd, handed: false, state: 'dispatched' }; this.save(record); }
      const query = this.runQuery({ record, input: params.input, additionalContext: params.additionalContext,
        promptId: turn.claudePromptId, systemPrompt, mcp, controller, outputSchema: params.outputSchema, steeringInput: running.steeringInput,
        // the provider's own compaction of THIS query, observed (never requested): see captureCompaction
        onCompact: input => this.captureCompaction(record, running, turn, input),
        // the prompt is about to be handed to the SDK: from here a failure without an answer is NOT proof that the note was not received
        onPrompt: () => { const attempt = record.noticeAttempt; if (attempt && attempt.turnId === turn.id && attempt.promptId === turn.claudePromptId && this.active.get(threadId) === running && !running.finished && !attempt.handed) { attempt.handed = true; this.save(record); } } });
      running.query = query;
      for await (const message of query) {
        controller.signal.throwIfAborted();
        if (message.session_id && turn.claudeSessionId !== message.session_id) {
          // The runtime attached a session. That is NOT the model having received the note: the session is only recorded on the attempt (see noticeAttempt); the note is consumed only by the model's own answer.
          const attempt = record.noticeAttempt;
          if (attempt && attempt.turnId === turn.id && attempt.sessionId == null) { attempt.sessionId = message.session_id; this.save(record); }
          if (record.claudeSessionId !== message.session_id) this.log('session.attached', { threadId, turnId: turn.id, sessionId: message.session_id });
          // An ephemeral query cannot resume this SDK id on the next turn.
          // Keep using the in-memory visible transcript as its continuation.
          if (!record.thread.ephemeral) record.claudeSessionId = message.session_id;
          turn.claudeSessionId = message.session_id; this.save(record);
        }
        // The model's OWN answer to THIS query consumes the note (see noticeAck): only for the current attempt of this very turn and prompt, while the turn is the live one.
        { const attempt = record.noticeAttempt;
          if (attempt && attempt.turnId === turn.id && attempt.promptId === turn.claudePromptId && this.active.get(threadId) === running && !running.finished && noticeAck(message, attempt)) this.settleNoticeAttempt(record); }
        if (message.type === 'stream_event') {
          const event = message.event;
          if (event.type === 'message_start') latestMessageId = event.message.id;
          if (event.type === 'content_block_start' && event.content_block.type === 'text') {
            const value = { id: `${latestMessageId}-${event.index}`, type: 'agentMessage', text: '', phase: null };
            partial.set(`${latestMessageId}-${event.index}`, value); item('started', value);
          }
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            const value = partial.get(`${latestMessageId}-${event.index}`);
            if (value) { value.text += event.delta.text; this.emit('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: value.id, delta: event.delta.text }); }
          }
          if (event.type === 'content_block_stop') {
            const value = partial.get(`${latestMessageId}-${event.index}`); if (value) item('completed', value);
          }
        }
        if (message.type === 'assistant' && ![...partial.keys()].some(k => k.startsWith(message.message.id))) {
          for (const block of message.message.content) if (block.type === 'text') {
            const value = { id: randomUUID(), type: 'agentMessage', text: block.text }; item('started', value); item('completed', value);
          }
        }
        if (message.type === 'result') {
          receivedResult = true;
          // the owner query's terminal result (exact turn, prompt and session): recorded as a fact; it settles nothing by itself (see resolveNoticeAttempt)
          { const attempt = record.noticeAttempt;
            if (attempt && attempt.turnId === turn.id && attempt.promptId === turn.claudePromptId && this.active.get(threadId) === running && !running.finished && ownResult(message, attempt)) {
              attempt.terminal = { subtype: typeof message.subtype === 'string' ? message.subtype : 'unknown', error: message.is_error === true || (typeof message.subtype === 'string' && message.subtype.startsWith('error')) }; this.save(record); } }
          if (message.modelUsage && (!resumedFrom || message.session_id === resumedFrom)) this.observeSdkUsage(record, running, turn, message);
          if (message.is_error || message.subtype !== 'success') throw new Error(message.errors?.join('\n') || message.result || message.subtype);
          if (message.structured_output != null) {
            const value = { id: randomUUID(), type: 'agentMessage', text: JSON.stringify(message.structured_output), phase: 'final_answer' };
            item('started', value); item('completed', value);
          }
        }
        steeringResult(this, record, running, message);
      }
      controller.signal.throwIfAborted();
      if (!receivedResult || turn.steering?.some(s => s.status !== 'delivered')) throw new Error('Claude stopped without a result for every accepted message');
      turn.status = 'completed';
    } catch (error) {
      this.log('turn.error', { threadId, turnId: turn.id, stage, ...errorMetadata(error) });
      turn.status = controller.signal.aborted ? 'interrupted' : 'failed';
      if (turn.status === 'failed') turn.error = { message: error.message, codexErrorInfo: /limit|quota|rate.?limit/i.test(error.message) ? 'usageLimitExceeded' : 'other' };
    } finally {
      // The turn is over. An attempt the model never answered is either provably unsent (its prompt was never handed to the SDK: dropped, the note stays owed) or UNKNOWN (handed, no answer seen: the
      // note stays owed AND the attempt stays recorded; the next dispatch settles it from the SDK's public record or is held - see resolveNoticeAttempt).
      // A query that reached its terminal result (exact owner turn, prompt and session) and has finished is CLOSED: there is no running or transport-uncertain query any more. The first delivery stays
      // honestly UNKNOWN in the audit on the turn itself (the model may or may not have seen the note); it is not "consumed" and not "not sent".
      { const attempt = record.noticeAttempt;
        if (attempt && attempt.turnId === turn.id) {
          if (attempt.handed) { attempt.state = attempt.terminal ? 'closed' : 'unknown'; turn.noticeAudit = { noticeId: attempt.noticeId, delivery: 'unknown', ...(attempt.terminal ? { terminal: attempt.terminal.subtype } : {}) }; }
          else delete record.noticeAttempt;
          this.save(record);
        } }
      running.acceptingSteering = false; running.steeringInput.close();
      try { running.query?.close(); await running.mcp?.instance.close(); }
      catch (error) { this.log('turn.cleanup_failed', { threadId, turnId: turn.id, ...errorMetadata(error) }); }
      // The query's own child must be gone before the chat is released: the next turn, a queued one or an immediate resend resumes the SAME
      // session, and the checkpoint below reads what that child wrote. Bounded (killed after a grace); an unconfirmed exit is logged.
      try { const exit = await running.query?.exited?.(); if (exit && exit.state !== 'none' && exit.state !== 'exited') this.log('turn.child_exit', { threadId, turnId: turn.id, status: exit.state }); }
      catch (error) { this.log('turn.cleanup_failed', { threadId, turnId: turn.id, ...errorMetadata(error) }); }
      try { turn.claudeCheckpoint = await this.history.checkpoint(record); }
      catch (error) { this.log('history.checkpoint_failed', { threadId, turnId: turn.id, ...errorMetadata(error) }); }
      for (const value of openItems.values()) {
        if (value.type === 'mcpToolCall') Object.assign(value, { status: 'failed', error: { message: 'Turn ended before the tool result was received; an external action may already have run.' } });
        item('completed', value);
      }
      running.finished = true;
      // A dispatched tool can settle after cancellation. Detach its mutable
      // view so late completion cannot rewrite the already-finalized transcript.
      turn.items = clone(turn.items);
      turn.completedAt = now(); turn.durationMs = (turn.completedAt - turn.startedAt) * 1000;
      settleSteering(this, record, turn);
      record.updatedAt = now(); this.active.delete(threadId); this.save(record);
      this.log('turn.finished', { threadId, turnId: turn.id, status: turn.status, durationMs: turn.durationMs });
      this.emit('turn/completed', { threadId, turn: envelope(turn) });
      this.emit('thread/status/changed', { threadId, status: { type: 'idle' } });
      continueQueue(this, record, turn.status);
    }
  }
}

// On-demand stdio peers of the SAME official executable, selected by launch
// overrides. Codex >=0.166 checks the launch provider at resume/input: a
// per-thread override on the GPT process is insufficient. No config is written,
// no model server is started, and the native policy check remains authoritative.
function providerToml(value) {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(providerToml).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).map(([k, v]) => JSON.stringify(k) + '=' + providerToml(v)).join(',') + '}';
  throw new RpcError('Invalid native provider launch definition');
}
// The main native connection, wired the way the bridge runs it. `origin` is the transport identity the history tool trusts: it names the connection
// kind and holds the actual Peer object, and it is the only thing forwarded with a server request (item/tool/call) or a notification from that peer.
export function connectNative(bridgeOf, input, output, { log = () => {}, close } = {}) {
  const origin = { kind: 'native', connectionId: null, peer: null };
  const peer = new Peer(input, output, { name: 'native', log, close,
    request: (method, params) => bridgeOf().toolRequest(method, params, undefined, undefined, origin),
    notify: (method, params) => bridgeOf().nativeNotification(method, params, origin),
    observe: (phase, method, params, result) => bridgeOf()?.observeNative(origin, phase, method, params, result) });
  origin.peer = peer; Object.freeze(origin);
  return peer;
}
export class ProviderNativePool {
  // request / notify / observe receive the creating connection's origin as their LAST argument (see connectNative).
  constructor({ executable, args, overrides = [], env, initialization, request, notify, observe, log = () => {}, spawnProcess = spawn }) {
    Object.assign(this, { executable, args, overrides, env, initialization, request, notify, observe, log, spawnProcess });
    this.entries = new Map(); this.closed = false;
  }
  async get(connection, definition) {
    if (this.closed) throw new RpcError('Custom provider runtime is stopped');
    if (!/^[a-f0-9]{32}$/.test(connection.connectionId)) throw new RpcError('Invalid native provider identity');
    const id = 'bridge_custom_' + connection.connectionId, fingerprint = JSON.stringify(definition);
    const existing = this.entries.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new RpcError('Custom provider launch binding changed; restart only when idle');
      const peer = await existing.ready;
      if (peer.closed) throw new RpcError('Custom provider runtime closed; input was not retried');
      return peer;
    }
    if (this.entries.size >= 16) throw new RpcError('Custom provider runtime limit reached');
    const initialize = this.initialization();
    if (!initialize) throw new RpcError('Initialize Bridge before using a custom provider');
    // Last CLI overrides win, only on this child. Original permissions, home,
    // executable and app-server flags are retained. No shell or literal key.
    const scopedArgs = this.args.includes('--no-daemon') ? this.args : ['--no-daemon', ...this.args];
    const argv = [...this.overrides, ...scopedArgs, '-c', 'model_provider=' + providerToml(id),
      '-c', 'model_providers.' + id + '=' + providerToml(definition)];
    const entry = { fingerprint, child: null, peer: null, ready: null };
    this.entries.set(id, entry);
    entry.ready = (async () => {
      const child = this.spawnProcess(this.executable, argv, { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] }); entry.child = child;
      // The origin names THIS connection and holds THIS Peer object; it exists only here, so no connection name from a model or a thread can stand in for it.
      const origin = { kind: 'custom', connectionId: connection.connectionId, peer: null };
      const peer = new Peer(child.stdout, child.stdin, { name: 'custom-native', log: this.log,
        request: (method, params) => this.request(method, params, origin), notify: (method, params) => this.notify(method, params, origin),
        observe: (phase, method, params, result) => this.observe?.(phase, method, params, result, origin), close: () => this.stopChild(child) });
      origin.peer = peer; Object.freeze(origin); entry.peer = peer;
      child.stderr?.on('data', bytes => this.log('process.custom_stderr', { byteCount: bytes.length }));
      child.once('error', error => { this.log('process.custom_error', errorMetadata(error)); peer.end(); });
      child.once('exit', (exitCode, signal) => { this.log('process.custom_exit', { exitCode, signal }); peer.end(); });
      try { await peer.request('initialize', initialize, 10000); peer.notify('initialized', {}); }
      catch (error) { peer.end(); this.stopChild(child); throw error; }
      if (this.closed || peer.closed) { peer.end(); this.stopChild(child); throw new RpcError('Custom provider runtime closed during initialization'); }
      return peer;
    })();
    return entry.ready;
  }
  notifyThread(connectionId, method, params) {
    const entry = this.entries.get('bridge_custom_' + connectionId);
    if (!entry?.peer || entry.peer.closed) throw new RpcError('Custom provider runtime is not connected');
    entry.peer.notify(method, params);
  }
  stopChild(child) {
    child.stdin?.end(); child.kill();
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
    timer.unref();
  }
  stop() {
    this.closed = true;
    for (const entry of this.entries.values()) { entry.peer?.end(); if (entry.child) this.stopChild(entry.child); }
  }
}

let runtimeLog = () => {};
async function main() {
  const executable = process.env.BRIDGE_REAL_CODEX;
  if (!executable) throw new Error('Launch with launch.py; BRIDGE_REAL_CODEX is required.');
  const args = process.argv.slice(2);
  if (!args.includes('app-server') || args.includes('--print-startup-config') || args.some(a => a.startsWith('generate-'))) {
    const result = spawnSync(executable, args, { stdio: 'inherit' }); process.exit(result.status ?? 1);
  }
  if (args.some(a => a.startsWith('unix://') || a.startsWith('ws://'))) throw new Error('This bridge currently supports desktop stdio transport only.');
  const log = createLogger(join(dirname(process.env.BRIDGE_STATE), 'logs'), { runtimeDirectory: join(dirname(process.env.BRIDGE_STATE), 'runtime') });
  runtimeLog = log;
  process.on('uncaughtExceptionMonitor', error => log('process.failed', errorMetadata(error)));
  log('process.started', { version: JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version });
  const overrides = ['-c', 'thread_unload_delay_secs=0', '-c', 'model_providers.claude_code={name="Claude Code bridge",base_url="http://127.0.0.1:1/disabled",wire_api="responses",requires_openai_auth=false}'];
  const child = spawn(executable, [...overrides, ...args], { env: { ...process.env, CODEX_CLI_PATH: executable }, stdio: ['pipe', 'pipe', 'inherit'] });
  let bridge, providerPool, stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    log('process.stopping', { activeTurns: bridge?.active.size ?? 0 });
    bridge?.mirror?.stop();
    for (const r of bridge?.active.values() ?? []) { r.controller?.abort(); r.query?.close(); }
    providerPool?.stop(); child.kill(); desktop.end(); process.stdin.destroy();
  };
  const desktop = new Peer(process.stdin, process.stdout, {
    name: 'desktop', log,
    request: (method, params) => bridge.request(method, params),
    notify: (method, params) => {
      const owner = desktopNotificationOwner(bridge, params, log);
      if (!owner) return;
      if (owner.route) providerPool.notifyThread(owner.route.connectionId, method, owner.params); else native.notify(method, owner.params);
    }, close: stop,
  });
  const native = connectNative(() => bridge, child.stdout, child.stdin, { log, close: () => desktop.end() });
  providerPool = new ProviderNativePool({ executable, args, overrides, env: { ...process.env, CODEX_CLI_PATH: executable },
    initialization: () => bridge?.nativeInitialization, request: (method, params, origin) => bridge.toolRequest(method, params, undefined, undefined, origin),
    notify: (method, params, origin) => bridge.nativeNotification(method, params, origin),
    observe: (phase, method, params, result, origin) => bridge?.observeNative(origin, phase, method, params, result), log });
  bridge = new Bridge({ native, desktop, providerNative: (connection, definition) => providerPool.get(connection, definition), statePath: process.env.BRIDGE_STATE, log, coordinateNative: process.env.BRIDGE_COORDINATOR === '1',
    connectionRoot: dirname(process.env.BRIDGE_STATE), credentialBindings: process.env.BRIDGE_PROVIDER_CREDENTIAL_BINDINGS ?? null });
  if (process.env.BRIDGE_SOURCE_CODEX_HOME && process.env.BRIDGE_MIRROR !== '0') bridge.mirror = configurationMirror({
    native, source: process.env.BRIDGE_SOURCE_CODEX_HOME, state: dirname(process.env.BRIDGE_STATE), log,
    notify: (method, params) => desktop.notify(method, params),
  });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  child.on('error', error => { log('process.native_error', errorMetadata(error)); stop(); process.exitCode = 1; });
  child.on('exit', (code, signal) => { log('process.native_exit', { exitCode: code, signal }); stop(); process.exitCode = code ?? 0; });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  runtimeLog('process.failed', errorMetadata(error));
  process.stderr.write('Bridge startup failed. Check the local diagnostic log.\n'); process.exitCode = 1;
});
