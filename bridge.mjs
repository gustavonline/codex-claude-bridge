#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { EventEmitter } from 'node:events';
import { Peer, RpcError } from './rpc.mjs';
import { createLogger, errorMetadata } from './logging.mjs';
import { models, codexModels, startQuery } from './claude.mjs';
import { instructions, makeTools } from './capabilities.mjs';
import { sessionHistory } from './history.mjs';
import { queueRequest, acceptQueued, continueQueue } from './queue.mjs';
import { forkThread } from './fork.mjs';
import { configurationMirror } from './mirror.mjs';
import { beginNative, captureNative } from './native-turns.mjs';
import { isClaude, provider, nativeSelection, adoptNativeThread, finishQueueMigration, reloadNativeHost, handoffContext } from './providers.mjs';
import { sessionCall, sessionNamespace, withSessionTools } from './sessions.mjs';
import { messageStream, submission, steerTurn, steeringResult, settleSteering } from './steering.mjs';

const now = () => Math.floor(Date.now() / 1000);
const clone = value => structuredClone(value);
const publicTurn = ({ claudePromptId, claudeSessionId, claudeCheckpoint, queuedSubmissionId, provider, clientUserMessageId, submittedInput, steering, nativeUserMessageId, ...turn }) => turn;
const envelope = turn => ({ ...publicTurn(turn), items: [], itemsView: 'notLoaded' });
const workspacePath = path => { try { return realpathSync(path); } catch { return resolve(path); } };
const mergeOptions = (previous, params) => {
  const next = { ...previous, ...Object.fromEntries(Object.entries(params).filter(([, value]) => value != null)) };
  if (params.permissions) delete next.sandbox;
  if (params.sandbox) delete next.permissions;
  return next;
};

export class Bridge {
  constructor({ native, desktop, statePath, getModels = models, runQuery = startQuery, history = sessionHistory(), log = () => {} }) {
    Object.assign(this, { native, desktop, statePath, getModels, runQuery, history, log });
    this.records = new Map(); this.active = new Map(); this.loaded = new Set(); this.starting = new Set();
    this.reverting = new Set();
    this.changing = new Set(); this.pendingStarts = new Map(); this.pendingSteers = new Map();
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
  async catalog() {
    this.modelPromise ??= this.getModels().catch(error => { this.modelPromise = null; throw error; });
    return this.modelPromise;
  }
  async selectModel(value = 'opus') {
    const list = await this.catalog();
    const selected = list.find(m => m.value === value || m.resolvedModel === value);
    if (selected) return selected;
    throw new RpcError(`Claude Code does not advertise model ${value}`, -32602);
  }
  async selection(record, params) {
    const mode = params.collaborationMode?.settings;
    if (!isClaude(mode?.model ?? params.model ?? record.model)) return nativeSelection(this, record, params);
    const model = await this.selectModel(mode?.model ?? params.model ?? record.model);
    const levels = model.supportedEffortLevels ?? [];
    const inherited = levels.includes(record.effort) ? record.effort : levels.includes('high') ? 'high' : levels[0];
    const effort = mode?.reasoning_effort ?? params.effort ?? inherited;
    if (model.supportsEffort && !levels.includes(effort)) throw new RpcError(`Unsupported effort ${effort} for ${model.value}`, -32602);
    return { model: model.value, effort: model.supportsEffort ? effort : 'none', provider: 'claude' };
  }
  applySelection(record, selected) {
    const changedProvider = (record.provider ?? 'claude') !== selected.provider;
    if (changedProvider || record.model !== selected.model || record.effort !== selected.effort)
      this.log('model.changed', { threadId: record.thread.id, previousModel: record.model, previousProvider: record.provider ?? 'claude',
        previousEffort: record.effort, model: selected.model, provider: selected.provider, effort: selected.effort });
    if (changedProvider) {
      if (selected.provider === 'claude') record.claudeSessionId = undefined;
      record.nativeResetRequired = true;
    }
    Object.assign(record, selected); record.options.model = record.model;
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
    // Native owns project/title/workspace metadata. The bridge owns the visible
    // Claude transcript, preview and activity, never the native seed turns.
    const { turns, preview, status, model, modelProvider, reasoningEffort, updatedAt, ...metadata } = thread;
    record.thread = { ...record.thread, ...metadata,
      ...(record.bridgeForkedFromId ? { forkedFromId: record.bridgeForkedFromId } : {}) };
    record.updatedAt = Math.max(record.updatedAt ?? 0, updatedAt ?? 0);
    this.save(record);
  }
  settingsView(record, settings) {
    return { ...settings, model: record.model, modelProvider: provider(record), effort: record.effort,
      ...(settings.collaborationMode ? { collaborationMode: { ...settings.collaborationMode,
        settings: { ...settings.collaborationMode.settings, model: record.model, reasoning_effort: record.effort } } } : {}) };
  }
  hostSettings(record) {
    return { ...record.nativeSettings, cwd: record.thread.cwd, model: record.nativeModel ?? record.model,
      modelProvider: record.hostProvider ?? record.options.modelProvider ?? 'openai',
      effort: record.nativeEffort ?? null, approvalPolicy: record.approvalPolicy,
      approvalsReviewer: record.approvalsReviewer ?? 'user', sandboxPolicy: record.sandbox,
      activePermissionProfile: record.activePermissionProfile ?? null, disabledPluginIds: record.disabledPluginIds ?? [],
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
  emit(method, params) { this.desktop.notify(method, params); this.sessionEvents.emit('change', method, params); }
  async toolRequest(method, params, timeout, signal) {
    if (method !== 'item/tool/call' || params.namespace !== sessionNamespace)
      return this.desktop.request(method, params, timeout, signal);
    try {
      const active = this.active.get(params.threadId);
      if (!active || params.turnId !== active.turn.id) throw new RpcError('Session tool call does not belong to the active turn', -32602);
      const result = await sessionCall(this, params, signal ?? this.active.get(params.threadId)?.controller?.signal);
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    } catch (error) { return { success: false, contentItems: [{ type: 'inputText', text: error.message }] }; }
  }
  async nativeNotification(method, params) {
    const record = this.records.get(params.threadId);
    if (!record && ['turn/started', 'turn/completed'].includes(method))
      this.log(method === 'turn/started' ? 'turn.started' : 'turn.finished', { threadId: params.threadId,
        turnId: params.turn?.id, status: params.turn?.status, provider: 'native', ...(params.turn?.error ? errorMetadata(params.turn.error) : {}) });
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
    this.loaded.add(record.thread.id);
  }
  async request(method, params = {}) {
    if (['thread/start', 'thread/resume', 'thread/fork', 'thread/settings/update', 'turn/start'].includes(method)
      && (this.records.has(params.threadId) || isClaude(params.model))
      && params.approvalsReviewer != null && params.approvalsReviewer !== 'user')
      throw new RpcError('Claude approval requests can only be reviewed by the user; automatic approval review is not implemented.', -32602);
    if (method === 'model/list') {
      const list = []; let cursor;
      do {
        const page = await this.native.request(method, { includeHidden: params.includeHidden, limit: 100, ...(cursor ? { cursor } : {}) });
        list.push(...page.data); cursor = page.nextCursor;
      } while (cursor);
      try { list.push(...codexModels(await this.catalog()).filter(m => !list.some(n => n.model === m.model)).map(m => ({ ...m, isDefault: false }))); }
      catch (error) { this.log('models.failed', errorMetadata(error)); }
      return this.page(list, params);
    }
    if (method === 'thread/start') {
      const requested = params.model ?? (await this.native.request('config/read', { cwd: params.cwd, includeLayers: false })).config.model;
      if (!isClaude(requested)) return this.native.request(method, params);
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
        hostProvider: result.modelProvider ?? options.modelProvider, neutralNativeSeed: true };
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
      if (method.startsWith('thread/queue/')) return queueRequest(this, record, method, params);
      if (this.changing.has(record.thread.id) && ['turn/start', 'thread/revert', 'thread/resume', 'thread/settings/update', 'thread/unload', 'thread/unsubscribe', 'thread/archive', 'thread/unarchive'].includes(method))
        throw new RpcError('Wait for the current chat change to finish');
      if (this.reverting.has(record.thread.id) && ['turn/start', 'thread/revert', 'thread/resume', 'thread/unload', 'thread/unsubscribe', 'thread/archive', 'thread/unarchive'].includes(method))
        throw new RpcError('Wait for the history edit to finish before changing this chat');
      if (method === 'thread/revert') return this.revert(record, params);
      if (method === 'turn/start') return this.begin(record, params);
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
        const supported = new Set(['threadId', 'cwd', 'model', 'effort', 'collaborationMode', 'permissions', 'sandboxPolicy', 'approvalPolicy', 'approvalsReviewer', 'disabledPluginIds']);
        for (const [key, value] of Object.entries(params)) if (value != null && !supported.has(key))
          throw new RpcError(`${key} is not supported in Claude thread settings`, -32602);
        const selection = await this.selection(record, params);
        if (selection.provider === 'native') await reloadNativeHost(this, record, selection.model);
        await this.ensureLoaded(record);
        await this.updatePermissions(record, params, selection);
        return {};
      });
      if (method === 'thread/resume') {
        this.checkWorkspace(record, params);
        if (params.history != null || params.path) throw new RpcError('Resume Claude chats by threadId; alternative history/path is not supported.', -32602);
        if (this.active.has(params.threadId) && Object.entries(params).some(([key, value]) =>
          ['model', 'config', 'baseInstructions', 'developerInstructions', 'permissions', 'sandbox', 'approvalPolicy'].includes(key)
          && value != null && !isDeepStrictEqual(value, key === 'model' ? record.model : record.options[key])))
          throw new RpcError('Wait for the active Claude turn before changing resume settings');
        return this.exclusive(record, async () => {
        const selected = await this.selection(record, params);
        const model = selected.model;
        const options = mergeOptions(record.options, params);
        if (selected.provider === 'native') await reloadNativeHost(this, record, model);
        const result = await this.native.request(method, { ...options,
          model: selected.provider === 'native' ? model : record.nativeModel ?? model,
          modelProvider: record.hostProvider ?? record.options.modelProvider ?? 'claude_code', excludeTurns: true });
        this.applySelection(record, selected); record.options = { ...options, model, approvalPolicy: result.approvalPolicy };
        this.loaded.add(record.thread.id);
        record.sandbox = result.sandbox; record.disabledPluginIds = result.disabledPluginIds;
        record.approvalPolicy = result.approvalPolicy;
        record.activePermissionProfile = result.activePermissionProfile;
        record.nativeModel = result.model ?? record.nativeModel; record.nativeEffort = result.reasoningEffort ?? record.nativeEffort;
        record.instructionSources = result.instructionSources ?? record.instructionSources; this.save(record);
        this.metadata(record, result.thread);
        return { ...result, model: record.model, modelProvider: provider(record), reasoningEffort: record.effort,
          ...(result.collaborationMode ? { collaborationMode: this.settingsView(record, result).collaborationMode } : {}),
          thread: this.thread(record, !params.excludeTurns && !params.initialTurnsPage),
          turnsBackwardsCursor: record.turns.length ? `at:${record.turns.at(-1).id}` : null, itemsBackwardsCursor: null,
          initialTurnsPage: params.initialTurnsPage ? this.turnPage(record, params.initialTurnsPage) : null };
        }, true);
      }
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
    const result = await this.native.request(method, params);
    if (method === 'initialize') this.mirror?.start();
    if (method === 'mcpServerStatus/list') for (const server of result.data ?? []) this.log('capability.catalog', {
      threadId: params.threadId, server: server.name, status: server.runtimeStatus ?? 'unknown',
      toolCount: Object.keys(server.tools ?? {}).length,
      ...(server.toolsError ? errorMetadata(server.toolsError) : {}),
    });
    return result;
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
  async begin(record, params) {
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
    if (this.changing.has(record.thread.id) || this.reverting.has(record.thread.id) || this.pendingSteers.has(record.thread.id)) throw new RpcError('Wait for the current chat change to finish');
    if (this.active.has(record.thread.id) || this.starting.has(record.thread.id)) throw new RpcError('A turn is already running. Queue the message or interrupt before starting another.', -32602);
    this.starting.add(record.thread.id);
    this.log('turn.preparing', { threadId: record.thread.id, queuedSubmissionId: params.queuedSubmissionId });
    const promise = this.prepareTurn(record, params);
    this.pendingStarts.set(record.thread.id, { params, promise });
    let accepted;
    try { accepted = await promise; return accepted; }
    finally {
      this.starting.delete(record.thread.id); this.pendingStarts.delete(record.thread.id);
      this.log('turn.prepared', { threadId: record.thread.id, status: accepted ? 'accepted' : 'failed' });
      if (accepted && !this.active.has(record.thread.id)) continueQueue(this, record, record.turns.at(-1)?.status);
    }
  }
  async prepareTurn(record, params) {
    if (!Array.isArray(params.input) || !params.input.length) throw new RpcError('input must be non-empty', -32602);
    const mode = params.collaborationMode?.settings;
    const selection = await this.selection(record, params);
    this.checkWorkspace(record, params);
    await this.mirror?.refresh();
    await finishQueueMigration(this, record);
    if (selection.provider === 'native') await reloadNativeHost(this, record, selection.model);
    await this.ensureLoaded(record);
    await this.updatePermissions(record, params);
    this.applySelection(record, selection);
    if (params.approvalPolicy) record.approvalPolicy = params.approvalPolicy;
    if (mode) record.modeInstructions = mode.developer_instructions;
    if (record.provider === 'native') return beginNative(this, record, params);
    const additionalContext = !record.claudeSessionId && record.turns.length ? handoffContext(record.turns, params.additionalContext) : params.additionalContext;
    const turn = { id: randomUUID(), claudePromptId: randomUUID(), status: 'inProgress', startedAt: now(), completedAt: null, error: null,
      items: [{ id: params.clientUserMessageId ?? randomUUID(), type: 'userMessage', content: params.input }], itemsView: 'full', provider: 'claude' };
    const running = { turn, controller: new AbortController(), query: null, steeringInput: messageStream() };
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
    this.emit('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } });
    const partial = new Map(); let latestMessageId; let receivedResult = false;
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
      const mcp = makeTools({ native: this.native, desktop: { request: (...args) => this.toolRequest(...args) }, record, turn, item, signal: controller.signal });
      running.mcp = mcp;
      stage = 'claude_query';
      const query = this.runQuery({ record, input: params.input, additionalContext: params.additionalContext,
        promptId: turn.claudePromptId, systemPrompt, mcp, controller, outputSchema: params.outputSchema, steeringInput: running.steeringInput });
      running.query = query;
      for await (const message of query) {
        controller.signal.throwIfAborted();
        if (message.session_id && turn.claudeSessionId !== message.session_id) {
          if (record.claudeSessionId !== message.session_id) this.log('session.attached', { threadId, turnId: turn.id, sessionId: message.session_id });
          // An ephemeral query cannot resume this SDK id on the next turn.
          // Keep using the in-memory visible transcript as its continuation.
          if (!record.thread.ephemeral) record.claudeSessionId = message.session_id;
          turn.claudeSessionId = message.session_id; this.save(record);
        }
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
      running.acceptingSteering = false; running.steeringInput.close();
      try { running.query?.close(); await running.mcp?.instance.close(); }
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

let runtimeLog = () => {};
async function main() {
  const executable = process.env.BRIDGE_REAL_CODEX;
  if (!executable) throw new Error('Launch with launch.py; BRIDGE_REAL_CODEX is required.');
  const args = process.argv.slice(2);
  if (!args.includes('app-server') || args.some(a => a.startsWith('generate-'))) {
    const result = spawnSync(executable, args, { stdio: 'inherit' }); process.exit(result.status ?? 1);
  }
  if (args.some(a => a.startsWith('unix://') || a.startsWith('ws://'))) throw new Error('This bridge currently supports desktop stdio transport only.');
  const log = createLogger(join(dirname(process.env.BRIDGE_STATE), 'logs'), { runtimePath: join(dirname(process.env.BRIDGE_STATE), 'runtime.json') });
  runtimeLog = log;
  process.on('uncaughtExceptionMonitor', error => log('process.failed', errorMetadata(error)));
  log('process.started', { version: JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version });
  const overrides = ['-c', 'thread_unload_delay_secs=0', '-c', 'model_providers.claude_code={name="Claude Code bridge",base_url="http://127.0.0.1:1/disabled",wire_api="responses",requires_openai_auth=false}'];
  const child = spawn(executable, [...overrides, ...args], { env: { ...process.env, CODEX_CLI_PATH: executable }, stdio: ['pipe', 'pipe', 'inherit'] });
  let bridge, stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    log('process.stopping', { activeTurns: bridge?.active.size ?? 0 });
    bridge?.mirror?.stop();
    for (const r of bridge?.active.values() ?? []) { r.controller?.abort(); r.query?.close(); }
    child.kill(); desktop.end(); process.stdin.destroy();
  };
  const desktop = new Peer(process.stdin, process.stdout, {
    name: 'desktop', log,
    request: (method, params) => bridge.request(method, params),
    notify: (method, params) => native.notify(method, params), close: stop,
  });
  const native = new Peer(child.stdout, child.stdin, {
    name: 'native', log,
    request: (method, params) => bridge.toolRequest(method, params),
    notify: (method, params) => bridge.nativeNotification(method, params), close: () => desktop.end(),
  });
  bridge = new Bridge({ native, desktop, statePath: process.env.BRIDGE_STATE, log });
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
