// Requests that cannot produce a thread's own history (reads, listings, settings and metadata changes): the only ones that leave birth evidence in place (see bornEmpty).
const BIRTH_SAFE = new Set(['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/queue/list', 'thread/settings/update', 'thread/resume', 'thread/name/set', 'thread/metadata/update', 'thread/archive', 'thread/unarchive']);
// Explicit custom Responses connections. Catalog discovery is
// HTTP GET only. Inference, tool execution, streams and history remain native
// app-server responsibilities; this module is not a model API translator.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';
import { NativeSecrets } from './native-secrets.mjs';
import { claudeDecision } from './connection-policy.mjs';
import { randomBytes, createHash } from 'node:crypto';
import { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, writeFileSync, readFileSync, closeSync, fsyncSync, renameSync, unlinkSync, mkdirSync, opendirSync, readdirSync, linkSync, existsSync } from 'node:fs';
import { join, dirname, isAbsolute, normalize, basename, relative } from 'node:path';

export const localFile = 'local-responses.json';
export const localPrefix = 'bridge-responses/';
const maxBytes = 512 * 1024;
const maxCatalogBytes = 2 * 1024 * 1024, maxCatalogModels = 1024;
// Normalization repeats bounded IDs in models/details. Storage has its own
// finite bound, checked before publication as well as when opening the file.
const maxProviderBytes = 4 * 1024 * 1024;
// Slots have no fixed UI count. Explicit settings remain bounded at4096 IDs
// and4MiB; each of16 provider catalogs is separately bounded at1024 models.
const maxSlotBytes = 4 * 1024 * 1024;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keys = (x, list) => object(x) && Object.keys(x).sort().join() === [...list].sort().join();
const providerMessages = {
  "local_requires_new_thread": "This chat can't switch to that connection. No message was sent. Start a new chat to use it; this chat keeps its model and history.",
  "cross_provider_switch_requires_new_thread": "This chat can only use models from its own connection. No message was sent. Start a new chat to use another one; this chat keeps its model and history.",
  "model_not_available": "That model is no longer offered by this connection. No message was sent. Refresh the connection in Model Bridge, or choose another of its models.",
  "model_change_pending": "Another model change for this chat is still finishing. Try again in a moment.",
  "native_runtime_stale": "This chat's model was changed elsewhere, and this window can't safely switch to it. No message was sent and nothing was changed. To keep working now, start a new chat.",
  "native_selection_not_confirmed": "Couldn't confirm the model change, so this chat may still be on its previous model. No message was sent or retried. Choose the model again.",
  "native_permissions_changed": "This chat's permissions changed during the model switch. No message was sent. Check its permissions and model, then send again.",
  "model_change_requires_idle": "Wait for the current reply to finish, or stop it, before switching models.",
  "reasoning_levels_unconfirmed": "Model Bridge couldn't confirm which reasoning levels that model offers, and this request's reasoning level settings disagree, so the chat wasn't switched. No message was sent and nothing was created; this chat keeps its model and history. Choose the reasoning level again.",
  "unsupported_reasoning_effort": "This model doesn't offer that reasoning level. No message was sent. Choose one of the levels listed for it.",
  "provider_disabled": "This chat's connection is disconnected. No message was sent. Reconnect it in Model Bridge › Connections.",
  "catalog_not_fresh": "This connection's model list needs a refresh. No message was sent. Refresh it in Model Bridge › Connections, then try again.",
  "free_model_required": "This connection allows free models only. No message was sent. Choose a free model.",
  "connection_changed": "This chat's connection was edited or removed, so it can't continue here. No message was sent. Its history stays readable; start a new chat to keep working.",
  "custom_provider_queue_not_qualified": "Messages can't be queued on this connection yet. Your message wasn't queued; send it after the current reply finishes.",
  "handoff_queue_pending": "This chat still has queued messages, so it wasn't switched to that model. No message was sent and the queued messages are unchanged. Let them run or remove them, then choose the model again.",
  "route_publication_uncertain": "Model Bridge couldn't confirm whether this chat's model change was saved, so it won't send anything from this chat until that's resolved. No message was sent by this change, and the chat's history is kept. This needs a technical repair; to keep working now, start a new chat.",
  // Hand-off refusals (Opus-approved text). Each is raised before anything is created or sent, so "no message was sent" is true.
  "handoff_content_unsupported": "This chat has content that can't yet be carried to that model, so it wasn't switched. No message was sent; this chat keeps its model and history. Keep working here, or start a new chat to use that model.",
  "handoff_attachment_unsupported": "This chat has an attachment that can't yet be carried to that model, so it wasn't switched. No message was sent; this chat keeps its model and history.",
  "handoff_context_too_large": "This chat is too long to carry to that model in full, so it wasn't switched. Nothing was shortened and no message was sent; this chat keeps its model and history. Keep working here, or start a new chat to use that model.",
  "handoff_history_unreadable": "Model Bridge couldn't read this chat's full history, so it wasn't switched. No message was sent and nothing was changed. Keep working here, or start a new chat to use that model.",
  "handoff_nothing_transferable": "None of this chat's visible messages can be carried to that model, so it wasn't switched. No message was sent; this chat keeps its model and history. Start a new chat to use that model.",
  "thread_list_too_large": "This workspace has more saved chat records, including internal ones, than Model Bridge can list at once, so it isn't showing an incomplete list. Your saved chats are kept and no message was sent.",
  "thread_list_unreadable": "Model Bridge couldn't read the complete chat list, so it isn't showing a partial one. Your saved chats are kept and no message was sent.",
  "invalid_cursor": "This page of the chat list doesn't match the current view, so it wasn't loaded. Your saved chats are kept and no message was sent.",
  "invalid_limit": "The chat list was asked for an invalid page size, so nothing was listed. Your saved chats are kept and no message was sent.",
  "invalid_model_providers": "The chat list's connection filter isn't in a form Model Bridge accepts, so nothing was listed. Your saved chats are kept and no message was sent.",
  "link_capacity_reached": "Model Bridge can't record another model switch for this chat without losing details of earlier ones, so it wasn't switched. No message was sent; this chat keeps its model and history. Keep working here, or start a new chat to use that model.",
  "native_permissions_unconfirmed": "Model Bridge couldn't confirm this chat's workspace access for that model, so it wasn't switched. No message was sent; this chat keeps its model and history.",
  "link_invalid": "Model Bridge can't read which model this chat is linked to, so it stopped instead of guessing. No message was sent and nothing was changed. This needs a technical repair; to keep working now, start a new chat.",
  "context_state_unavailable": "Model Bridge couldn't save the record it needs to keep this chat's context safe, so the model wasn't changed. No message was sent; this chat keeps its model and history. Try again, or start a new chat to use that model."
};
const fail = code => { throw Object.assign(new Error(providerMessages[code] ?? 'Model Bridge stopped this request (' + code + ').'), { code }); };
const hash = x => createHash('sha256').update(x).digest('hex');
const validModel = x => typeof x === 'string' && x.length > 0 && Buffer.byteLength(x) <= 512 && !/[\s\x00-\x1f\x7f]/u.test(x);
const id = x => typeof x === 'string' && /^[a-f0-9]{32}$/.test(x);
const threadId = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(x);
// thread/list folding: native is read in pages of LIST_PAGE up to LIST_CAP rows; beyond that the list fails explicitly instead of being cut.
const LIST_PAGE = 100, LIST_PAGES = 60, LIST_CAP = 5000;
// A link is read with an 8192-byte bound; every alias of its chain is kept (never truncated), so a chain that would not fit is refused up front.
const LINK_MAX = 8000;
// The confirmed workspace roots a native start/resume RESPONSE reports (a Thread does not carry them): a sorted list of strings, or null when unknown.
const workspaceRoots = x => Array.isArray(x?.runtimeWorkspaceRoots) && x.runtimeWorkspaceRoots.every(r => typeof r === 'string') ? [...x.runtimeWorkspaceRoots].sort() : null;
// Codex's own default title, given to a new EMPTY private child so native persists it (metadata only). It is never shown and never sent to a model.
const PRIVATE_NAME = 'New chat';
// `source` is the ORIGIN thread's own session source (the pinned 0.167 SessionSource): the conversation keeps its logical source kind whatever runtime child it moves to.
const ORIGIN_FIELDS = ['name', 'preview', 'createdAt', 'path', 'forkedFromId', 'cwd', 'sessionId', 'projectId', 'source'];
// ThreadSourceKind of the pinned 0.167 schema. An omitted, null or empty `sourceKinds` selects the interactive sources; a non-empty list selects exactly those kinds.
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const INTERACTIVE_KINDS = ['cli', 'vscode'];
// Does the documented sourceKinds filter select a conversation whose origin native does not list, from the origin's VERIFIED recorded source? true/false when that is
// decided; thread_list_unreadable when it cannot be (no recorded source, a custom or otherwise unstructured source, a specific sub-agent kind): never guessed, never included.
const sourceSelected = (source, kinds) => {
  const asked = kinds == null ? [] : kinds;
  if (!Array.isArray(asked) || !asked.every(k => SOURCE_KINDS.includes(k))) fail('thread_list_unreadable');
  const wanted = asked.length ? asked : INTERACTIVE_KINDS;
  if (typeof source === 'string' && SOURCE_KINDS.includes(source) && !source.startsWith('subAgent')) return wanted.includes(source);
  if (object(source) && Object.keys(source).length === 1 && 'subAgent' in source) {
    if (wanted.includes('subAgent')) return true;
    if (wanted.some(k => k.startsWith('subAgent'))) fail('thread_list_unreadable');
    return false;
  }
  return fail('thread_list_unreadable');
};
const LIVE_FIELDS = ['model', 'modelProvider', 'reasoningEffort', 'updatedAt', 'recencyAt', 'status'];
// The conversation's row keeps its own identity, title, creation, path and ancestry; only what describes the CURRENT runtime comes from its live thread.
const withLive = (row, live) => ({ ...row, ...Object.fromEntries(LIVE_FIELDS.filter(k => k in live).map(k => [k, live[k]])) });
const HELD_METHODS = new Set(['thread/started', 'thread/status/changed', 'thread/settings/updated', 'thread/name/updated']);
// Requests that cannot change a conversation: they stay available while its provider is being switched.
const SWITCH_SAFE = new Set(['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/list', 'thread/loaded/list', 'thread/queue/list', 'thread/resume', 'turn/interrupt',
  'thread/goal/get', 'thread/search', 'thread/searchOccurrences', 'thread/timeline/list', 'thread/items/read', 'thread/backgroundTerminals/list', 'thread/memory/read']);
const isClaudeModel = x => typeof x === 'string' && (/^claude-/.test(x) || ['opus', 'sonnet', 'haiku'].includes(x));
// Native reports realpath'd workspace roots on some calls (/private/var vs /var); compare what they resolve to.
const samePath = (a, b) => { if (a === b) return true; if (typeof a !== 'string' || typeof b !== 'string') return false; try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
const rolloutPath = x => x === null || typeof x === 'string' && x.length <= 4096 && isAbsolute(x) && normalize(x) === x && !/[\x00-\x1f\x7f]/.test(x);

export function endpointUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\?#\x00-\x1f\x7f]/u.test(value)) fail('endpoint_invalid');
  const literal = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})(?:\/|$)/.exec(value);
  let u; try { u = new URL(value); } catch { fail('endpoint_invalid'); }
  if (u.username || u.password || u.search || u.hash || /%|\/\.|\/\//.test(u.pathname)) fail('endpoint_invalid');
  let canonical;
  if (u.protocol === 'http:') {
    if (!literal || Number(literal[2]) > 65535) fail('endpoint_invalid');
    canonical = 'http://' + literal[1] + ':' + literal[2] + u.pathname.replace(/\/$/, '');
  } else {
    // Canonical IDNA/path encoding may expand a valid raw input. The canonical
    // value must pass the same bound before any provider directory is created.
    if (u.protocol !== 'https:' || !u.hostname || !/^https:\/\//.test(value)) fail('endpoint_invalid');
    canonical = u.origin + u.pathname.replace(/\/$/, '');
  }
  if (canonical.length > 2048) fail('endpoint_invalid');
  return canonical;
}
export function rootOk(root) {
  const s = lstatSync(root);
  if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700 || realpathSync(root) !== root) fail('unsafe_root');
}
// The raw text of a damaged private file, for REFUSAL only (which IDs it names): the same guards as readPrivate (no symlink, a regular file we own,
// mode 0600, one link, within the bound, never blocking), checked BEFORE anything is read; anything unsafe yields '' and is simply not evidence.
export function readPrivateText(path, limit = 65536) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return ''; }
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > limit) return '';
    const bytes = Buffer.alloc(s.size); let n = 0, count;
    while (n < bytes.length && (count = readSync(fd, bytes, n, bytes.length - n, null))) n += count;
    return bytes.subarray(0, n).toString('utf8');
  } catch { return ''; } finally { closeSync(fd); }
}
export function readPrivate(path, limit = maxBytes) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (e.code === 'ENOENT') return null; fail('unsafe_file'); }
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > limit) fail('unsafe_file');
    const bytes = Buffer.alloc(limit + 1); let n = 0, count;
    while (n < bytes.length && (count = readSync(fd, bytes, n, bytes.length - n, null))) n += count;
    if (n > limit) fail('file_too_large');
    try { return JSON.parse(bytes.subarray(0, n)); } catch { fail('invalid_store'); }
  } finally { closeSync(fd); }
}
export function localModelId(connectionId, model) {
  if (!id(connectionId) || !validModel(model)) fail('model_invalid');
  return localPrefix + connectionId + '/' + Buffer.from(model).toString('base64url');
}
function modelSlot(value) {
  if (typeof value !== 'string' || value.length > 800) fail('slot_invalid');
  const match = /^bridge-responses\/([a-f0-9]{32})\/([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) fail('slot_invalid');
  const model = Buffer.from(match[2], 'base64url').toString('utf8');
  if (localModelId(match[1], model) !== value) fail('slot_invalid');
  return { providerId: match[1], model };
}
function pickerId(value) {
  if (typeof value !== 'string' || !value || value.length > 800 || /[\x00-\x1f\x7f]/.test(value)) fail('slot_invalid');
}
function validatePickerCatalog(value) {
  if (!object(value) || Object.keys(value).some(k => !['version', 'revision', 'models', 'requestRevision', 'nativeFailed'].includes(k))
    || value.requestRevision !== undefined && (!Number.isSafeInteger(value.requestRevision) || value.requestRevision < 0)
    || value.nativeFailed !== undefined && typeof value.nativeFailed !== 'boolean' || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.models)) fail('catalog_invalid');
  if (value.models.length > 4096 || new Set(value.models.map(m => m.id)).size !== value.models.length
    || Buffer.byteLength(JSON.stringify(value)) > maxSlotBytes) fail('catalog_invalid');
  for (const m of value.models) {
    pickerId(m.id);
    if (!keys(m, ['id', 'name', 'kind', 'defaultVisible', 'available', 'capabilities']) || !['native', 'claude'].includes(m.kind)
      || typeof m.name !== 'string' || m.name.length > 512 || typeof m.defaultVisible !== 'boolean' || typeof m.available !== 'boolean'
      || !object(m.capabilities) || JSON.stringify(m.capabilities).length > 8192) fail('catalog_invalid');
  }
}
function validate(s) {
  if (Buffer.byteLength(JSON.stringify(s)) + 1 > maxProviderBytes) fail('provider_record_too_large');
  if (!(keys(s, ['version', 'revision', 'connectionId', 'baseUrl', 'catalog', 'selected', 'name', 'protocol', 'enabled', 'authRef']) || keys(s, ['version', 'revision', 'connectionId', 'baseUrl', 'catalog', 'selected', 'name', 'protocol', 'enabled', 'authRef', 'freeOnly']) && s.freeOnly === true) || s.version !== 2 || !Number.isSafeInteger(s.revision) || s.revision < 0
    || !id(s.connectionId) || endpointUrl(s.baseUrl) !== s.baseUrl) fail('invalid_store');
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 80 || /[\x00-\x1f\x7f]/.test(s.name) || s.protocol !== 'responses' || typeof s.enabled !== 'boolean'
    || !(s.authRef === null || (typeof s.authRef === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s.authRef)))) fail('invalid_store');
  if (s.catalog !== null && (!(keys(s.catalog, ['status', 'at', 'models', 'error']) || keys(s.catalog, ['status', 'at', 'models', 'error', 'details'])) || !Array.isArray(s.catalog.models) || !['fresh', 'stale'].includes(s.catalog.status)
    || !Number.isSafeInteger(s.catalog.at) || s.catalog.at < 0 || ![null, 'catalog_failed', 'catalog_auth_required', 'catalog_rate_limited', 'catalog_unreachable', 'catalog_protocol_unsupported'].includes(s.catalog.error))) fail('invalid_store');
  if (s.catalog !== null) {
    catalogModels({ data: s.catalog.models.map(id => ({ id })) });
    if (s.catalog.details !== undefined && (!Array.isArray(s.catalog.details) || s.catalog.details.length !== s.catalog.models.length
      || s.catalog.details.some((m, i) => !object(m) || !keys(m, ['id', 'free', 'parameters', ...(m.reasoning === undefined ? [] : ['reasoning'])]) || m.reasoning !== undefined && JSON.stringify(reasoningMetadata(m.reasoning)) !== JSON.stringify(m.reasoning) || m.id !== s.catalog.models[i] || typeof m.free !== 'boolean'
        || !Array.isArray(m.parameters) || m.parameters.length > 64 || m.parameters.some(p => typeof p !== 'string' || p.length > 80)))) fail('invalid_store');
  }
  if (s.selected !== null && (!s.catalog || !s.catalog.models.some(m => localModelId(s.connectionId, m) === s.selected))) fail('invalid_store');
  return s;
}
export function readLocal(root) {
  rootOk(root);
  const s = readPrivate(join(root, localFile), maxProviderBytes);
  if (s === null) return null;
  return validate(s);
}
// Every durable write ends in sync(). Production never replaces it. It is exported only so a test process that is
// forbidden to call fsync (Node's Permission Model) can substitute a no-op for ITS OWN writes; nothing in the product does.
export const durability = { sync: fd => fsyncSync(fd) };
// A test module installs its own substitute for the duration of its own tests and gets back a function that restores the
// real one. `undefined` changes nothing, so a module can opt in only where it must (the permission runner forbids fsync).
export function useDurability(sync) {
  const previous = durability.sync; if (typeof sync === 'function') durability.sync = sync;
  return () => { durability.sync = previous; };
}
function exclusiveWrite(path, value) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); durability.sync(fd); } finally { closeSync(fd); }
}
function newLocal(url, { name = 'Custom Responses', authRef = null, connectionId = randomBytes(16).toString('hex'), freeOnly = false } = {}) {
  const baseUrl = endpointUrl(url);
  // The browser preset's free-only contract also applies when its exact origin
  // is added through the generic form; selecting the same reference cannot bypass it.
  freeOnly ||= baseUrl === 'https://openrouter.ai/api/v1';
  return validate({ version: 2, revision: 0, connectionId, baseUrl, catalog: null, selected: null, name, authRef, enabled: true, protocol: 'responses', ...(freeOnly ? { freeOnly: true } : {}) });
}
export function createLocal(root, url, options) {
  rootOk(root); const s = newLocal(url, options);
  exclusiveWrite(join(root, localFile), s); return localStatus(s);
}
function update(root, expectedRevision, change) {
  rootOk(root);
  const lock = join(root, 'local-responses.lock');
  const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    const s = readLocal(root); if (!s || s.revision !== expectedRevision) fail('stale_revision');
    if (s.revision === Number.MAX_SAFE_INTEGER) fail('revision_exhausted');
    change(s); s.revision++; validate(s);
    const temp = join(root, 'local-responses-' + randomBytes(8).toString('hex') + '.tmp');
    exclusiveWrite(temp, s); renameSync(temp, join(root, localFile)); return s;
  } finally { closeSync(fd); unlinkSync(lock); }
}
export function catalogModels(value) {
  if (!object(value) || !Array.isArray(value.data) || value.data.length > maxCatalogModels) fail('catalog_invalid');
  const models = value.data.map(m => { if (!object(m) || !validModel(m.id)) fail('catalog_invalid'); return m.id; });
  if (new Set(models).size !== models.length) fail('catalog_invalid');
  return models;
}
const gatewayEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function reasoningMetadata(value) {
  if (value == null) return undefined;
  if (!object(value)) fail('catalog_invalid');
  const result = {};
  if (Object.hasOwn(value, 'supported_efforts')) {
    const efforts = value.supported_efforts;
    if (efforts !== null && (!Array.isArray(efforts) || !efforts.length || efforts.length > gatewayEfforts.length || new Set(efforts).size !== efforts.length || efforts.some(e => !gatewayEfforts.includes(e)))) fail('catalog_invalid');
    result.supported_efforts = efforts === null ? null : efforts.slice();
  }
  if (Object.hasOwn(value, 'default_effort')) {
    if (value.default_effort !== null && !gatewayEfforts.includes(value.default_effort)) fail('catalog_invalid');
    result.default_effort = value.default_effort;
  }
  for (const key of ['default_enabled', 'mandatory', 'supports_max_tokens']) if (Object.hasOwn(value, key)) {
    if (typeof value[key] !== 'boolean') fail('catalog_invalid'); result[key] = value[key];
  }
  return result;
}
function advertisedEfforts(s, model) {
  // This capability schema is documented by OpenRouter; do not interpret an
  // arbitrary endpoint's extra fields as a native Codex capability contract.
  if (s.baseUrl !== 'https://openrouter.ai/api/v1') return [];
  const metadata = s.catalog?.details?.find(m => m.id === model)?.reasoning;
  if (!metadata || !Object.hasOwn(metadata, 'supported_efforts')) return [];
  return (metadata.supported_efforts === null ? gatewayEfforts : metadata.supported_efforts).filter(e => !metadata.mandatory || e !== 'none');
}
export function modelReasoning(s, model) {
  const efforts = advertisedEfforts(s, model);
  const advertisedDefault = s.catalog?.details?.find(m => m.id === model)?.reasoning?.default_effort;
  return { supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })),
    ...(efforts.includes(advertisedDefault) ? { defaultReasoningEffort: advertisedDefault } : {}) };
}
export function catalogDetails(value) {
  const ids = catalogModels(value), zero = x => typeof x === 'number' ? x === 0 : typeof x === 'string' && /^(?:0+(?:\.0*)?|\.0+)$/.test(x);
  return ids.map((id, i) => {
    const m = value.data[i], pricing = m.pricing;
    const reasoning = reasoningMetadata(m.reasoning);
    return { id, ...(reasoning === undefined ? {} : { reasoning }), free: object(pricing) && zero(pricing.prompt) && zero(pricing.completion) && Object.values(pricing).every(zero),
      parameters: Array.isArray(m.supported_parameters) ? [...new Set(m.supported_parameters.filter(p => typeof p === 'string' && p.length <= 80))].slice(0, 64) : [] };
  });
}
export const freeOnly = s => s.freeOnly === true || s.baseUrl === 'https://openrouter.ai/api/v1';
export function selectable(s, model) {
  return !freeOnly(s) || s.catalog?.status === 'fresh' && s.catalog.details?.some(m => m.id === model && m.free === true);
}
export function discoverLocal(url, { request = url.startsWith('https:') ? httpsRequest : httpRequest, timeoutMs = 5000, authorization = null, withMetadata = false } = {}) {
  const target = endpointUrl(url) + '/models';
  if (authorization !== null && (typeof authorization !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(authorization))) fail('credential_invalid');
  return new Promise((resolve, reject) => {
    let req, response, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      response?.destroy(); req?.destroy(); error ? reject(error) : resolve(value);
    };
    const bad = (code = 'catalog_failed') => finish(Object.assign(new Error('Local Responses: ' + code), { code }));
    timer = setTimeout(bad, timeoutMs);
    try {
      // node:http does not follow redirects or use proxy/env credentials. Never
      // pass headers supplied by a caller or a provider key from the environment.
      req = request(target, { method: 'GET', agent: false, headers: { Accept: 'application/json', ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}) } }, res => {
        response = res;
        if (res.statusCode !== 200) { bad([401, 403].includes(res.statusCode) ? 'catalog_auth_required' : res.statusCode === 429 ? 'catalog_rate_limited' : 'catalog_failed'); return; }
        const chunks = []; let n = 0;
        res.on('data', b => { n += b.length; if (n > maxCatalogBytes) bad(); else chunks.push(b); });
        res.on('error', () => bad('catalog_unreachable')); res.on('aborted', () => bad('catalog_unreachable'));
        res.on('end', () => { try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); finish(null, withMetadata ? { models: catalogModels(v), details: catalogDetails(v) } : catalogModels(v)); } catch { bad('catalog_protocol_unsupported'); } });
      });
      req.on('error', () => bad('catalog_unreachable')); req.end();
    } catch { bad(); }
  });
}
export async function refreshLocal(root, options) {
  const before = readLocal(root); if (!before) fail('not_configured');
  let models, details;
  try {
    // The trusted registry may resolve credentials here. Resolution and HTTP
    // failures share one expected-revision stale transition, never a retry.
    const resolved = typeof options === 'function' ? await options(before) : options;
    ({ models, details } = await discoverLocal(before.baseUrl, { ...resolved, withMetadata: true }));
  }
  catch (e) {
    const code = ['catalog_auth_required', 'catalog_rate_limited', 'catalog_unreachable', 'catalog_protocol_unsupported'].includes(e.code) ? e.code : 'catalog_failed';
    update(root, before.revision, s => { s.catalog = { status: 'stale', at: s.catalog?.at ?? 0, models: s.catalog?.models ?? [], ...(s.catalog?.details ? { details: s.catalog.details } : {}), error: code }; });
    fail(code);
  }
  return localStatus(update(root, before.revision, s => {
    s.catalog = { status: 'fresh', at: Date.now(), models, details, error: null };
    if (!models.some(m => localModelId(s.connectionId, m) === s.selected)) s.selected = null;
  }));
}
export function selectLocal(root, model) {
  const before = readLocal(root); if (!before || before.catalog?.status !== 'fresh' || !before.catalog.models.some(m => localModelId(before.connectionId, m) === model)) fail('model_not_available');
  if (!selectable(before, before.catalog.models.find(m => localModelId(before.connectionId, m) === model))) fail('free_model_required');
  return localStatus(update(root, before.revision, s => { s.selected = model; }));
}
export function localStatus(s) {
  if (!s) return { configured: false };
  return { configured: true, connectionId: s.connectionId, name: s.name, baseUrl: s.baseUrl, protocol: s.protocol, authRef: s.authRef, enabled: s.enabled, revision: s.revision, selected: s.selected,
    catalog: s.catalog && { ...s.catalog, format: 'openai-model-ids', models: s.catalog.models.map(m => ({ id: localModelId(s.connectionId, m), endpointModel: m })) },
    capabilities: { responses: 'unverified', tools: 'unverified', inference: 'unverified', nativePicker: 'unverified' },
    activation: 'explicit helper-attached thread only; no GPT default/config changes' };
}

// These are operator-owned references, never tokens or commands in a tool
// argument/store. The native helper runs outside model-tool access; an actual
// host must separately prove that its sandbox cannot read the file or invoke
// the helper with enough access. Same-UID mode bits alone do not prove that.
function credentialBindings(path) {
  if (!isAbsolute(path)) fail('credential_binding_invalid');
  rootOk(dirname(path)); const b = readPrivate(path, 16384);
  if (!keys(b, ['version', 'references']) || b.version !== 1 || !Array.isArray(b.references) || b.references.length > 16) fail('credential_binding_invalid');
  const seen = new Set();
  for (const r of b.references) {
    if (!keys(r, ['id', 'baseUrl', 'credentialFile']) || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.id) || seen.has(r.id)
      || endpointUrl(r.baseUrl) !== r.baseUrl || typeof r.credentialFile !== 'string' || r.credentialFile.length > 4096 || !isAbsolute(r.credentialFile) || r.credentialFile.includes('\0')) fail('credential_binding_invalid');
    seen.add(r.id);
  }
  return b.references;
}
export function credentialToken(path, reference, baseUrl) {
  const r = credentialBindings(path).find(x => x.id === reference && x.baseUrl === endpointUrl(baseUrl));
  if (!r) fail('credential_endpoint_mismatch');
  rootOk(dirname(r.credentialFile));
  const fd = openSync(r.credentialFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > 4098) fail('credential_invalid');
    const bytes = Buffer.alloc(4099); const n = readSync(fd, bytes, 0, bytes.length, 0);
    if (n !== s.size || n > 4098) fail('credential_invalid');
    const token = bytes.subarray(0, n).toString('utf8').replace(/\r?\n$/, '');
    if (!/^[\x21-\x7e]{1,4096}$/.test(token)) fail('credential_invalid');
    return token;
  } finally { closeSync(fd); }
}
const credentialHelper = fileURLToPath(new URL('./credential-helper.mjs', import.meta.url));
export class CredentialBroker {
  constructor(path = null, root = null) { this.path = path; this.secrets = root ? new NativeSecrets(root) : null; }
  references() {
    const refs = [...(this.path ? credentialBindings(this.path).map(({ id, baseUrl }) => ({ id, baseUrl })) : []), ...(this.secrets?.records() ?? [])];
    if (new Set(refs.map(r => r.id)).size !== refs.length) fail('credential_binding_invalid');
    return refs;
  }
  isNative(reference, baseUrl) { return this.secrets?.records().some(r => r.id === reference && r.baseUrl === baseUrl) === true; }
  check(reference, baseUrl) {
    if (reference === null) return;
    if (!this.references().some(r => r.id === reference && r.baseUrl === baseUrl)) fail('credential_endpoint_mismatch');
  }
  auth(reference, baseUrl) {
    this.check(reference, baseUrl);
    return { command: process.execPath, args: [credentialHelper, ...(this.isNative(reference, baseUrl) ? ['--native-root', this.secrets.root] : ['--bindings', this.path]), '--reference', reference, '--endpoint', baseUrl],
      cwd: dirname(credentialHelper), timeout_ms: 3000, refresh_interval_ms: 0 };
  }
  async token(reference, baseUrl) {
    // The trusted catalog control plane consumes only the selected URL-bound
    // reference in memory. Inference still uses auth() and the fixed native
    // helper, never an environment token inherited by model tools.
    this.check(reference, baseUrl); return this.isNative(reference, baseUrl) ? this.secrets.get(reference, baseUrl) : credentialToken(this.path, reference, baseUrl);
  }
}

export class ProviderRegistry {
  constructor(root, bindings = null, { secrets } = {}) { this.root = root; this.broker = new CredentialBroker(bindings, root); if (secrets) this.broker.secrets = secrets; }
  slots() {
    rootOk(this.root); const value = readPrivate(join(this.root, 'model-slots.json'), maxSlotBytes);
    if (value === null) return { version: 1, revision: 0, models: null };
    if (!keys(value, ['version', 'revision', 'models']) || ![1, 2].includes(value.version) || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !Array.isArray(value.models) || value.models.length > 16 * 256 || new Set(value.models).size !== value.models.length) fail('slot_invalid');
    value.models.forEach(value.version === 1 ? modelSlot : pickerId); return value;
  }
  saveSlots(models, expectedRevision) {
    if (!Array.isArray(models) || models.length > 16 * 256 || new Set(models).size !== models.length) fail('slot_invalid');
    const parsed = models.map(modelSlot); rootOk(this.root);
    const lock = join(this.root, 'model-slots.lock');
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const before = this.slots();
      if (before.version === 2) fail('picker_scope_required');
      if (before.revision !== expectedRevision) fail('stale_revision');
      if (before.revision === Number.MAX_SAFE_INTEGER) fail('revision_exhausted');
      const providers = this.all();
      parsed.forEach((slot, i) => {
        // Retained unavailable slots may be kept or removed, never silently
        // discarded. A NEW slot must name an enabled/fresh discovered model.
        if (before.models?.includes(models[i])) return;
        const p = providers.find(p => p.connectionId === slot.providerId);
        if (!p?.enabled || p.catalog?.status !== 'fresh' || !p.catalog.models.includes(slot.model)) fail('slot_model_unavailable');
      });
      const value = { version: 1, revision: before.revision + 1, models: [...models] };
      if (Buffer.byteLength(JSON.stringify(value) + '\n') > maxSlotBytes) fail('slot_invalid');
      const temp = join(this.root, 'model-slots-' + randomBytes(8).toString('hex') + '.tmp');
      exclusiveWrite(temp, value); renameSync(temp, join(this.root, 'model-slots.json')); return value;
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  // The Bridge publishes only public model catalog metadata, never settings,
  // auth or histories. Home reads this same explicit connectionRoot; it does
  // not independently locate a profile or start the SDK/native process.
  pickerCatalog() {
    rootOk(this.root); const value = readPrivate(join(this.root, 'picker-catalog.json'), maxSlotBytes);
    if (value === null) return { version: 1, revision: 0, models: [] };
    validatePickerCatalog(value);
    return value;
  }
  pickerRefresh() {
    rootOk(this.root); const v = readPrivate(join(this.root, 'picker-refresh.json'), 512);
    if (v === null) return { version: 1, revision: 0, kind: null };
    if (!keys(v, ['version', 'revision', 'kind']) || v.version !== 1 || !Number.isSafeInteger(v.revision) || v.revision < 1 || !['native', 'claude'].includes(v.kind)) fail('catalog_invalid');
    return v;
  }
  requestPickerRefresh(kind, expectedRevision) {
    if (!['native', 'claude'].includes(kind)) fail('catalog_invalid'); rootOk(this.root);
    const lock = join(this.root, 'picker-refresh.lock'); const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const before = this.pickerRefresh();
      if (before.revision !== expectedRevision) fail('stale_revision');
      if (before.revision > (this.pickerCatalog().requestRevision ?? 0)) fail('catalog_refresh_pending');
      if (before.revision === Number.MAX_SAFE_INTEGER) fail('revision_exhausted');
      const value = { version: 1, revision: before.revision + 1, kind };
      const temp = join(this.root, 'picker-refresh-' + randomBytes(8).toString('hex') + '.tmp');
      exclusiveWrite(temp, value); renameSync(temp, join(this.root, 'picker-refresh.json')); return value;
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  observePickerModels(models, requestRevision = 0, { nativeFailed = false } = {}) {
    const lock = join(this.root, 'picker-catalog.lock'); rootOk(this.root);
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const before = this.pickerCatalog();
      if (JSON.stringify(models) === JSON.stringify(before.models) && requestRevision === (before.requestRevision ?? 0) && nativeFailed === (before.nativeFailed ?? false)) return before;
      if (before.revision === Number.MAX_SAFE_INTEGER) fail('revision_exhausted');
      const value = { version: 1, revision: before.revision + 1, models, requestRevision, nativeFailed };
      // Validate before publication with the same schema used on read.
      validatePickerCatalog(value);
      const temp = join(this.root, 'picker-catalog-' + randomBytes(8).toString('hex') + '.tmp');
      exclusiveWrite(temp, value); renameSync(temp, join(this.root, 'picker-catalog.json')); return value;
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  reservedPickerModels() { return [...new Set([...nativeClaims(this.root), ...this.pickerCatalog().models.map(m => m.id)])]; }
  pickerChoices() {
    const builtin = this.pickerCatalog().models.filter(m => m.available && (m.kind !== 'claude' || claudeDecision(this.root).policy.enabled)).map(m => m.id);
    const reserved = new Set(this.reservedPickerModels());
    const custom = this.all().filter(p => p.enabled && p.catalog?.status === 'fresh')
      .flatMap(p => p.catalog.models.filter(m => selectable(p, m) && !reserved.has(localModelId(p.connectionId, m))).map(m => localModelId(p.connectionId, m)));
    return [...new Set([...builtin, ...custom])];
  }
  savePickerSlots(models, expectedRevision, catalogRevision) {
    if (!Array.isArray(models) || models.length > 4096 || new Set(models).size !== models.length) fail('slot_invalid');
    models.forEach(pickerId); rootOk(this.root);
    const fd = openSync(join(this.root, 'model-slots.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const before = this.slots(), catalog = this.pickerCatalog();
      if (catalog.revision === 0) fail('native_catalog_unknown');
      if (before.revision !== expectedRevision || catalog.revision !== catalogRevision) fail('stale_revision');
      if (before.revision === Number.MAX_SAFE_INTEGER) fail('revision_exhausted');
      const available = this.pickerChoices();
      if (!models.some(m => available.includes(m))) fail('picker_empty');
      for (const m of models) if (!available.includes(m) && !before.models?.includes(m)) fail('slot_model_unavailable');
      const value = { version: 2, revision: before.revision + 1, models: [...models] };
      if (Buffer.byteLength(JSON.stringify(value)) > maxSlotBytes) fail('slot_invalid');
      const temp = join(this.root, 'model-slots-' + randomBytes(8).toString('hex') + '.tmp');
      exclusiveWrite(temp, value); renameSync(temp, join(this.root, 'model-slots.json')); return value;
    } finally { closeSync(fd); unlinkSync(join(this.root, 'model-slots.lock')); }
  }
  resetPickerSlots(expectedRevision, catalogRevision) {
    const catalog = this.pickerCatalog();
    // Recovery is an explicit save of the current advertised defaults, never
    // deletion of settings or automatic migration of the legacy custom policy.
    const reserved = new Set(this.reservedPickerModels());
    const defaults = catalog.models.filter(m => m.available && m.defaultVisible && (m.kind !== 'claude' || claudeDecision(this.root).policy.enabled)).map(m => m.id);
    for (const p of this.all()) if (p.enabled && p.catalog?.status === 'fresh') defaults.push(...p.catalog.models.filter(m => selectable(p, m) && !reserved.has(localModelId(p.connectionId, m))).map(m => localModelId(p.connectionId, m)));
    return this.savePickerSlots(defaults, expectedRevision, catalogRevision);
  }
  filterPicker(models, includeHidden = false) {
    const slots = this.slots();
    if (slots.version === 1 && includeHidden) return models;
    if (slots.version === 1) return models.filter(m => m.hidden !== true);
    // Custom rows here have already passed mergeModels' enabled/fresh/free
    // checks. Do not reread all custom stores and turn unrelated corruption
    // into disappearance of selected native rows.
    const builtin = new Map(this.pickerCatalog().models.map(m => [m.id, m]));
    const claudeEnabled = claudeDecision(this.root).policy.enabled, selected = new Set(slots.models);
    const available = m => !builtin.has(m.id) || builtin.get(m.id).available && (builtin.get(m.id).kind !== 'claude' || claudeEnabled);
    return models.flatMap(m => selected.has(m.id) && available(m) ? [m.hidden === true ? { ...m, hidden: false } : m] : includeHidden ? [{ ...m, hidden: true }] : []);
  }
  all() {
    rootOk(this.root); const dir = join(this.root, 'responses-providers'); let handle;
    const legacy = readLocal(this.root), values = legacy ? [legacy] : [];
    try { rootOk(dir); handle = opendirSync(dir); } catch (e) { if (e.code === 'ENOENT') return values; throw e; }
    try {
      let entry;
      while ((entry = handle.readSync())) {
        if (values.length >= 16 || !id(entry.name) || !entry.isDirectory()) fail('provider_registry_invalid');
        const s = readLocal(join(dir, entry.name)); if (!s || s.connectionId !== entry.name || values.some(v => v.connectionId === s.connectionId)) fail('provider_registry_invalid'); values.push(s);
      }
    } finally { handle.closeSync(); }
    return values.sort((a, b) => a.connectionId.localeCompare(b.connectionId));
  }
  path(providerId) {
    if (!id(providerId)) fail('provider_invalid');
    const child = join(this.root, 'responses-providers', providerId);
    try { rootOk(child); return child; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (readLocal(this.root)?.connectionId === providerId) return this.root;
    fail('provider_missing');
  }
  read(providerId) { return readLocal(this.path(providerId)); }
  create({ name, baseUrl, authRef = null, freeOnly = false }) {
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)
      || !(authRef === null || typeof authRef === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(authRef))) fail('provider_invalid');
    const record = newLocal(baseUrl, { name, authRef, freeOnly }); baseUrl = record.baseUrl;
    this.broker.check(authRef, baseUrl); rootOk(this.root);
    const lock = join(this.root, 'responses-providers.lock');
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const all = this.all(); if (all.length >= 16) fail('provider_limit');
      if (all.some(s => s.name === name && s.baseUrl === baseUrl && s.authRef === authRef)) fail('provider_exists');
      const parent = join(this.root, 'responses-providers'); try { mkdirSync(parent, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      rootOk(parent);
      const path = join(parent, record.connectionId); mkdirSync(path, { mode: 0o700 });
      exclusiveWrite(join(path, localFile), record); return record.connectionId;
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  async refresh(providerId, options = {}) {
    return refreshLocal(this.path(providerId), async s => {
      this.broker.check(s.authRef, s.baseUrl);
      const authorization = s.authRef === null ? null : await this.broker.token(s.authRef, s.baseUrl);
      return { ...options, authorization };
    });
  }
  select(providerId, model) { return selectLocal(this.path(providerId), model); }
  enabled(providerId, enabled) {
    if (typeof enabled !== 'boolean') fail('enabled_invalid');
    const s = this.read(providerId); return update(this.path(providerId), s.revision, s => { s.enabled = enabled; });
  }
}

function nativeClaims(root) {
    rootOk(root); const saved = readPrivate(join(root, 'native-model-ownership.json'));
    if (saved === null) return [];
    if (!keys(saved, ['version', 'models']) || saved.version !== 1 || !Array.isArray(saved.models) || saved.models.length > 4096
      || saved.models.some(m => typeof m !== 'string' || !m.startsWith(localPrefix) || m.length > 800) || new Set(saved.models).size !== saved.models.length) fail('native_ownership_invalid');
    return saved.models;
  }

// Thread-scoped native override, not a global config write or a second harness.
// One model/provider per local thread in this slice. Existing GPT/Claude chats
// cannot silently become local; cross-provider switching needs a new thread.
export class ResponsesRouter {
  // continuity: { runtimeHandoff, readAllTurns, overlayHistory, pageTurns, pageItems } from the Bridge package (absent: no cross-provider continuation).
  // managedSource(id) -> { snapshot, turns } for a Bridge-managed chat; claudeTarget: Claude-side start/import/publish/archive/setEffort.
  constructor({ root, native, managed = () => false, credentialBindings = null, nativeFor = null, notify = () => {}, continuity = null, managedSource = () => null, managedRoots = null, claudeTarget = null }) {
    Object.assign(this, { root, native, managed, nativeFor, notify, continuity, managedSource, managedRoots, claudeTarget }); this.switching = new Set(); this.switchIds = new Set(); this.provisional = new Set(); this.held = []; this.abandoned = new Set(); this.unmasked = new Set(); this.ownWrites = new Map(); this.echoWaitMs = 5000; this.childOwner = new Map(); this.pendingSettings = new Map(); this.createdSnapshots = new Map(); this.freshObserved = new Map(); this.loadedModels = new WeakMap(); this.loadedByPeer = new WeakMap(); this.registry = new ProviderRegistry(root, credentialBindings);
  }
  nativeClaims() { return nativeClaims(this.root); }
  rememberNative(existing) {
    const candidates = existing.flatMap(m => [m.id, m.model]).filter(v => typeof v === 'string' && v.startsWith(localPrefix));
    if (candidates.some(v => v.length > 800)) fail('native_ownership_invalid');
    const known = this.nativeClaims();
    if (candidates.every(v => known.includes(v))) return known;
    const lock = join(this.root, 'native-model-ownership.lock');
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const models = [...new Set([...this.nativeClaims(), ...candidates])].sort(), value = { version: 1, models };
      if (models.length > 4096 || Buffer.byteLength(JSON.stringify(value) + '\n') > maxBytes) fail('native_ownership_limit');
      const temp = join(this.root, 'native-ownership-' + randomBytes(8).toString('hex') + '.tmp');
      exclusiveWrite(temp, value); renameSync(temp, join(this.root, 'native-model-ownership.json')); return models;
    } finally { closeSync(fd); unlinkSync(lock); }
  }
  async nativeOwns(model) {
    // UI lists are not an ownership oracle. Keep observed native aliases across
    // restart/list changes; on first use consult the complete hidden native
    // catalog before reading provider enabled/fresh state. No SDK/model call.
    if (this.nativeClaims().includes(model)) return true;
    const cursors = new Set(); let cursor;
    for (let pages = 0; pages < 100; pages++) {
      const page = await this.native.request('model/list', { includeHidden: true, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!object(page) || !Array.isArray(page.data) || page.data.some(m => !object(m))
        || !(page.nextCursor == null || typeof page.nextCursor === 'string')) fail('native_catalog_unverified');
      const claims = this.rememberNative(page.data);
      if (claims.includes(model)) return true;
      cursor = page.nextCursor; if (!cursor) return false;
      if (cursors.has(cursor)) fail('native_catalog_unverified'); cursors.add(cursor);
    }
    fail('native_catalog_unverified');
  }
  mergeModels(existing, includeHidden = false) {
    // Bridge presets in the public 0.162.1 Model schema, not endpoint-supplied
    // Codex metadata. Merge BEFORE Bridge pagination. Existing rows/defaults
    // win any id/model collision, including subsequent selection of that row.
    const native = this.rememberNative(existing);
    const seen = new Set([...native, ...existing.flatMap(m => [m.id, m.model]).filter(v => typeof v === 'string')]), added = [], collisions = [];
    const policy = this.registry.slots(), slots = policy.models;
    for (const s of this.registry.all()) {
      if (!s.enabled || s.catalog?.status !== 'fresh') continue;
      for (const model of s.catalog.models) {
        if (!selectable(s, model)) continue;
        const value = localModelId(s.connectionId, model);
        if (!(includeHidden && policy.version === 2) && slots !== null && !slots.includes(value)) continue;
        if (seen.has(value)) { collisions.push(value); continue; }
        seen.add(value);
        const efforts = advertisedEfforts(s, model), reasoning = s.catalog.details?.find(m => m.id === model)?.reasoning;
        const defaultEffort = efforts.includes(reasoning?.default_effort) ? reasoning.default_effort : efforts[0] ?? 'none';
        added.push({ id: value, model: value, displayName: model + ' · ' + s.name,
          description: 'Runs through ' + s.name + '. Tool support depends on the model.',
          hidden: false, isDefault: false, defaultReasoningEffort: defaultEffort, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort, description: 'Listed by ' + s.name + ' for this model.' })),
          inputModalities: ['text'], supportsPersonality: false, multiAgentVersion: 'disabled' });
      }
    }
    return { models: [...existing, ...added], collisions };
  }
  readRoute(tid) {
    if (!threadId(tid)) return null;
    const dir = join(this.root, 'local-routes');
    try { rootOk(dir); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    this.assertCertain(join(dir, tid + '.json'));
    const r = readPrivate(join(dir, tid + '.json'), 8192);
    const legacy = r?.version === 1 && keys(r, ['version', 'connectionId', 'endpointHash', 'model']);
    const current = r?.version === 2 && keys(r, ['version', 'connectionId', 'endpointHash', 'model', 'threadId', 'path', 'forkedFromId'])
      && r.threadId === tid && rolloutPath(r.path) && (r.forkedFromId === null || threadId(r.forkedFromId));
    if (r !== null && (!(legacy || current) || !id(r.connectionId) || !/^[a-f0-9]{64}$/.test(r.endpointHash) || !validModel(r.model))) fail('route_invalid');
    return r;
  }
  saveRoute(tid, r) {
    if (!threadId(tid)) fail('native_thread_identity_invalid');
    rootOk(this.root); const dir = join(this.root, 'local-routes');
    try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    rootOk(dir); this.publish(dir, tid + '.json', r, 'create');
  }
  // ---- Durable publication: ONE write-ahead intent authority ------------------------------------------------------
  // Every state file (route, link, carried history) and every compound handoff is published through the same protocol:
  //   1. an INTENT record is written and made durable (file fsync, then directory fsync) BEFORE anything is published;
  //      a failure here is a plain failure: nothing exists yet, and the error is returned, never ignored;
  //   2. for a compound handoff the carried history and the new route are written first (unreachable until the commit file exists),
  //      then the intent is moved to `committing` (durable again) BEFORE the commit file is even touched;
  //   3. the commit file (the link, or the single file) is replaced atomically; then its directory is fsynced; then the intent is removed LAST.
  // Recovery compares the file actually on disk with the exact old and new content in the intent; anything else stays blocked with
  // the intent retained. The previous valid state is never removed before its replacement is safely accepted.
  // Legacy `.uncertain` markers and `fork-receipts` are only read, as guards; they are never written, deleted or migrated.
  syncDir(dir) { const fd = openSync(dir, constants.O_RDONLY); try { durability.sync(fd); } finally { closeSync(fd); } }
  intentPath(final) { return final.replace(/\.json$/, '') + '.intent'; }
  tempIn(dir, name) { return join(dir, name + '.' + randomBytes(8).toString('hex') + '.tmp'); }
  // A fresh temporary file with `value`, data fsynced. Nothing is at any final name yet; a failure removes the temp and propagates.
  writeTemp(dir, name, value) {
    const temp = this.tempIn(dir, name);
    try { exclusiveWrite(temp, value); } catch (error) { try { unlinkSync(temp); } catch { /* never created */ } throw error; }
    return temp;
  }
  // create: the final name must not exist (hard link); replace: atomic rename over it. Failure leaves the final name as it was.
  place(temp, final, mode) {
    try { if (mode === 'create') linkSync(temp, final); else renameSync(temp, final); }
    catch (error) { try { unlinkSync(temp); } catch { /* already gone */ } throw error; }
    if (mode === 'create') try { unlinkSync(temp); } catch { /* the final name is the only link that matters */ }
  }
  writeAtomic(final, value, mode) { this.place(this.writeTemp(dirname(final), basename(final), value), final, mode); }
  uncertainError(cause) { return Object.assign(new Error(providerMessages.route_publication_uncertain), { code: 'route_publication_uncertain', uncertain: true, cause }); }
  sameState(a, b) { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
  readState(final) { return readPrivate(final, 6 * 1024 * 1024 + 4096); } // null when absent; an unreadable file throws (blocked, never guessed)
  hasIntent(final) { return existsSync(this.intentPath(final)); }
  readIntent(final) {
    let value; try { value = readPrivate(this.intentPath(final), 65536); } catch { throw this.uncertainError('intent_unreadable'); }
    if (value === null) return null;
    if (!(object(value) && value.version === 1 && ['prepared', 'committing', 'aborted', 'archive_pending'].includes(value.phase) && typeof value.key === 'string')) throw this.uncertainError('intent_malformed');
    return value;
  }
  // Written exclusively (an existing intent is an unresolved outcome) and durably. A failure leaves nothing behind that could be mistaken for progress.
  beginIntent(final, record) {
    const path = this.intentPath(final), dir = dirname(path), temp = this.writeTemp(dir, basename(path), record);
    try { linkSync(temp, path); } catch (error) { try { unlinkSync(temp); } catch { /* gone */ } if (error.code === 'EEXIST') throw this.uncertainError('intent_exists'); throw error; }
    try { unlinkSync(temp); } catch { /* the intent name is what matters */ }
    try { this.syncDir(dir); } catch (error) { try { unlinkSync(path); } catch { /* it stays, and blocks, if even this fails */ } throw error; }
  }
  updateIntent(final, record) { const path = this.intentPath(final), dir = dirname(path); this.place(this.writeTemp(dir, basename(path), record), path, 'replace'); this.syncDir(dir); }
  // Removed LAST, only after the commit it guards was already made durable (its own directory was synced first). If the removal itself
  // cannot be made durable, the intent is put back again (data fsynced, then the directory) and the error is returned. Nothing here is
  // claimed to be durable that was not proven: whichever way a crash then falls, the state is one that is recognised, and none of them
  // drops accepted history or removes a block that is still needed:
  //   - the intent is present: it is `committing` (or `aborted`) with the exact old/new content, so recovery stays blocked until reconciled;
  //   - the intent is absent: the commit it guarded was durable before this call, so the accepted state stands.
  // If even the put-back fails, the live process is left unblocked, which is safe for the same reason (the commit is durable).
  clearIntent(final) {
    const path = this.intentPath(final); let saved = null; try { saved = readPrivate(path, 65536); } catch { /* unreadable: nothing to put back */ }
    unlinkSync(path);
    try { this.syncDir(dirname(path)); }
    catch (error) {
      if (saved !== null) try { this.place(this.writeTemp(dirname(path), basename(path), saved), path, 'create'); this.syncDir(dirname(path)); } catch { /* see above: either outcome is recognised */ }
      throw error;
    }
  }
  // One state file. The intent is `committing` from the start (old and new content inside); the final name is only touched after it is durable.
  publish(dir, name, value, mode, previous = null) {
    const final = join(dir, name); this.assertCertain(final);
    this.beginIntent(final, { version: 1, key: name.replace(/\.json$/, ''), phase: 'committing', commit: { file: relative(this.root, final), old: previous, next: value, mode } });
    try { this.writeAtomic(final, value, mode); }
    catch (error) {
      // The final name is untouched by a failed write or an atomic placement that did not happen: withdraw the intent. If the actual
      // content is anything but the old content, or the intent cannot be withdrawn, it stays and blocks (uncertain).
      let actual; try { actual = this.readState(final); } catch { throw this.uncertainError(error); }
      if (!this.sameState(actual, previous)) throw this.uncertainError(error);
      try { this.clearIntent(final); } catch { throw this.uncertainError(error); }
      throw error;
    }
    try { this.syncDir(dir); } catch (error) { throw this.uncertainError(error); }
    try { this.clearIntent(final); } catch (error) { throw this.uncertainError(error); }
  }
  assertCertain(final) { if (this.hasIntent(final) || existsSync(final + '.uncertain')) fail('route_publication_uncertain'); }
  // Atomic reconciliation of one state file: keep 'next' (what was being published) or restore 'previous'. The intent is removed LAST,
  // the old content is put back by an atomic rename (never unlink first), and a failure at any step keeps the intent and the accepted file.
  reconcile(final, keep) {
    const intent = this.readIntent(final); if (!intent) return;
    const c = intent.commit; if (!c || intent.child) throw this.uncertainError('compound_intent'); // compound intents are reconciled by reconcileIntent
    const actual = this.readState(final), dir = dirname(final);
    if (keep === 'next') { if (!this.sameState(actual, c.next)) throw this.uncertainError('actual_is_not_next'); this.syncDir(dir); this.clearIntent(final); return; }
    if (!this.sameState(actual, c.old)) {
      if (!this.sameState(actual, c.next)) throw this.uncertainError('actual_is_neither'); // no guessing
      if (c.old !== null) this.writeAtomic(final, c.old, 'replace'); else unlinkSync(final); // the only thing removed is the unaccepted new file
    }
    this.syncDir(dir); this.clearIntent(final);
  }
  reconcileRoute(tid, keep) { this.reconcile(join(this.root, 'local-routes', tid + '.json'), keep); }
  // ---- A compound handoff (new child thread + carried history + route + link) under the same intent ------------------------
  // key = the conversation's logical ID inside a conversation, otherwise the child's ID. The intent lives at links/<key>.intent and names
  // the child, the exact old and new content of the ONE commit file, and the orphan files this handoff wrote (with their hashes, so a
  // file that was not written by this handoff is never removed).
  intentBase(key) { return join(this.root, 'local-routes', 'links', key + '.json'); }
  absolute(rel) { const path = join(this.root, rel); if (!path.startsWith(this.root + '/')) throw this.uncertainError('path_outside_root'); return path; }
  async commitHandoff(plan, steps) {
    this.ensureDirs('links');
    const base = this.intentBase(plan.key), record = { version: 1, key: plan.key, phase: 'prepared', sourceId: plan.sourceId, logical: plan.logical, child: plan.child, commit: plan.commit, orphans: plan.orphans };
    this.beginIntent(base, record); // durable BEFORE anything is published; a failure is a plain one (nothing exists), and is returned
    let phase = 'prepared';
    try {
      await steps.orphans(); // carried history and new route: unreachable until the commit file exists
      this.updateIntent(base, { ...record, phase: 'committing' }); phase = 'committing'; // durable BEFORE the commit file is touched
      await steps.commit();
    } catch (error) {
      if (error.uncertain) throw error;
      throw this.afterFailure(base, record, error, phase);
    }
    if (plan.commit.file) try { this.syncDir(dirname(this.absolute(plan.commit.file))); } catch (error) { throw this.uncertainError(error); }
    try { this.clearIntent(base); } catch (error) { throw this.uncertainError(error); }
  }
  // What a failure before the commit is allowed to mean: only an actual commit file equal to the exact OLD content makes it a plain,
  // abortable failure (a durable `aborted` first, so cleanup can never meet a maybe-published child). Anything else stays uncertain.
  afterFailure(base, record, error, phase) {
    const c = record.commit; let state = 'unknown';
    if (c.file) { try { const actual = this.readState(this.absolute(c.file)); state = this.sameState(actual, c.old) ? 'old' : this.sameState(actual, c.next) ? 'new' : 'unknown'; } catch { state = 'unknown'; } }
    if (state !== 'old') return this.uncertainError(error);
    try { this.updateIntent(base, { ...record, phase: 'aborted' }); }
    catch (update) { return Object.assign(update, { deferCleanup: true, originalCause: error }); } // the intent stays: recovery archives later; nothing is cleaned now
    record.phase = 'aborted';
    return Object.assign(error, { aborted: true });
  }
  // After a durable `aborted` and a successful archive: remove only the orphans this handoff wrote (hash-checked), then the intent, last.
  finishAbort(base, intent) {
    for (const orphan of Object.values(intent.orphans ?? {})) {
      if (!orphan) continue;
      try { const file = this.absolute(orphan.file), actual = this.readState(file); if (actual !== null && createHash('sha256').update(JSON.stringify(actual)).digest('hex') === orphan.sha) unlinkSync(file); } catch { /* not ours, or already gone */ }
    }
    this.clearIntent(base);
  }
  async archiveChild(child) {
    if (child.kind === 'claude') return this.claudeTarget.archive(child.id);
    if (child.kind === 'custom') { const s = this.registry.all().find(x => x.connectionId === child.connectionId); if (!s) throw this.uncertainError('connection_missing'); return (await this.nativeForConnection(s, child.model)).request('thread/archive', { threadId: child.id }); }
    return this.native.request('thread/archive', { threadId: child.id });
  }
  // Archive the child of an `aborted` intent and finish. Returns false (intent kept, as archive_pending) when the archive fails.
  async finishAbortFlow(base, intent) {
    if (!intent.archived) { // an archive that already succeeded is never repeated by a retry of the cleanup that follows it
      try { await this.archiveChild(intent.child); }
      catch { try { this.updateIntent(base, { ...intent, phase: 'archive_pending' }); } catch { /* 'aborted' is already durable and blocks a second switch */ } return false; }
      intent = { ...intent, archived: true }; try { this.updateIntent(base, intent); } catch { /* at worst the archive is requested again */ }
    }
    (this.abandoned ??= new Set()).add(intent.child.id);
    try { this.finishAbort(base, intent); } catch { return false; }
    return true;
  }
  lockLive(name) {
    let owner; try { owner = readPrivate(join(this.root, 'local-routes', name + '.lock'), 512); } catch { return true; } // unreadable: treated as held, never as free
    if (owner === null) return false;
    try { process.kill(owner.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
  }
  // What the next request for a conversation must know about an intent: { intent, blocked, oldLink, inFlight, archivePending }.
  // Recovery here is only ever in the abort direction and only when the commit file is exactly the OLD content; a commit that may
  // have happened (new or unknown) stays blocked, with the intent retained, until reconcileIntent decides.
  async settleIntent(key) {
    const base = this.intentBase(key); if (!this.hasIntent(base)) return { intent: null, blocked: false };
    let intent; try { intent = this.readIntent(base); } catch { return { intent: null, blocked: true, oldLink: undefined }; }
    if (!intent) return { intent: null, blocked: false };
    const oldLink = intent.commit?.old ?? null;
    if (this.lockLive(key + '.switch')) return { intent, blocked: false, inFlight: true, oldLink: intent.phase === 'committing' ? oldLink : undefined };
    return this.recoverIntent(base, intent);
  }
  async recoverIntent(base, intent) {
    const c = intent.commit, oldLink = c?.old ?? null, blocked = { intent, blocked: true, oldLink };
    try {
      if (intent.phase === 'aborted' || intent.phase === 'archive_pending') {
        return await this.finishAbortFlow(base, intent) ? { intent: null, blocked: false } : { intent: { ...intent, phase: 'archive_pending' }, blocked: false, archivePending: true };
      }
      if (!c?.file || !this.sameState(this.readState(this.absolute(c.file)), c.old)) return blocked;
      const aborted = { ...intent, phase: 'aborted' }; this.updateIntent(base, aborted);
      return await this.finishAbortFlow(base, aborted) ? { intent: null, blocked: false } : { intent: aborted, blocked: false, archivePending: true };
    } catch { return blocked; }
  }
  // Atomic operator reconciliation of a conversation's intent (a single file or a compound handoff). The accepted state is never removed
  // before its replacement is safely accepted; the intent is removed LAST; a failure anywhere keeps the intent and the accepted file.
  async reconcileIntent(key, keep) {
    const base = this.intentBase(key), intent = this.readIntent(base); if (!intent) return;
    if (!intent.child) return this.reconcile(base, keep);
    const c = intent.commit; if (!c?.file) throw this.uncertainError('commit_cannot_be_verified');
    const final = this.absolute(c.file), actual = this.readState(final);
    if (keep === 'next') { if (!this.sameState(actual, c.next)) throw this.uncertainError('actual_is_not_next'); this.syncDir(dirname(final)); this.clearIntent(base); return; }
    if (!this.sameState(actual, c.old)) {
      if (!this.sameState(actual, c.next)) throw this.uncertainError('actual_is_neither');
      if (c.old !== null) this.writeAtomic(final, c.old, 'replace'); else unlinkSync(final);
    }
    this.syncDir(dirname(final));
    const aborted = { ...intent, phase: 'aborted' }; this.updateIntent(base, aborted);
    if (!(await this.finishAbortFlow(base, aborted))) throw this.uncertainError('archive_pending');
  }
  reconcileLink(logical, keep) { return this.reconcileIntent(logical, keep); }
  // A cleanup that could not archive the child: the intent (one record) becomes/starts as archive_pending. Never swallowed.
  markArchivePending(r, ctx, child) {
    this.ensureDirs('links'); const key = ctx ? ctx.logical : r.forkId, base = this.intentBase(key), existing = this.readIntent(base);
    if (existing) { this.updateIntent(base, { ...existing, phase: 'archive_pending' }); return; }
    this.beginIntent(base, { version: 1, key, phase: 'archive_pending', sourceId: r.sourceId, logical: ctx?.logical ?? null, child, commit: null, orphans: {} });
  }
  // An unresolved handoff of this source or conversation (any intent, or a legacy receipt) forbids another one: no blind retry.
  pendingHandoff(tid, ctx) {
    let names = []; try { names = readdirSync(join(this.root, 'local-routes', 'links')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const name of names.filter(n => n.endsWith('.intent'))) {
      let intent; try { intent = this.readIntent(this.intentBase(name.slice(0, -7))); } catch { return true; }
      if (intent && (intent.sourceId === tid || (ctx && intent.logical === ctx.logical))) return true;
    }
    return this.unresolvedForkReceipt(tid);
  }
  connection(r) {
    const all = this.registry.all(), s = r ? all.find(s => s.connectionId === r.connectionId) : all.length === 1 ? all[0] : null;
    if (!s || (r && hash(s.baseUrl + '\0' + (s.authRef ?? '')) !== r.endpointHash)) fail('connection_changed');
    return s;
  }
  providerId(s) { return 'bridge_custom_' + s.connectionId; }
  routeFor(s, model, thread) {
    if (!threadId(thread?.id) || !rolloutPath(thread.path ?? null) || !(thread.forkedFromId == null || threadId(thread.forkedFromId))) fail('native_thread_identity_invalid');
    return { version: 2, connectionId: s.connectionId, endpointHash: hash(s.baseUrl + '\0' + (s.authRef ?? '')), model,
      threadId: thread.id, path: thread.path ?? null, forkedFromId: thread.forkedFromId ?? null };
  }
  historyParameters(params, r) {
    const { path, history, ...rest } = params;
    if (history != null || path != null && path !== '' && (typeof path !== 'string' || r.version !== 2 || path !== r.path)) fail('alternate_history_refused');
    // Even a verified matching rollout hint is never forwarded: native must
    // choose the saved thread ID rather than a caller-selected rollout/history.
    return rest;
  }
  verifyHistory(method, answer, params, r) {
    const t = answer.thread;
    if (!threadId(t?.id) || !rolloutPath(t.path ?? null)) fail('native_thread_identity_invalid');
    if (method === 'thread/resume') {
      if (t.id !== params.threadId || r.version === 2 && (r.path !== null && t.path !== r.path || (t.forkedFromId ?? null) !== r.forkedFromId)) fail('native_thread_identity_invalid');
    } else if (t.id === params.threadId || t.forkedFromId !== params.threadId || r.path != null && t.path === r.path) fail('native_thread_identity_invalid');
  }
  parameters(params, s, model, configure) {
    const wanted = localModelId(s.connectionId, model), mode = params.collaborationMode?.settings;
    if ((params.model != null && ![wanted, model, 'bridge-responses/selected'].includes(params.model))
      || (mode?.model != null && ![wanted, model].includes(mode.model))
      || (params.modelProvider != null && params.modelProvider !== this.providerId(s))) fail('cross_provider_switch_requires_new_thread');
    if (params.config != null && (!object(params.config) || Object.keys(params.config).some(k => /^(model|model_provider|model_providers|openai_base_url|model_catalog_json)(\.|$)/.test(k)))) fail('provider_override_refused');
    const efforts = advertisedEfforts(s, model), effort = mode?.reasoning_effort ?? params.effort;
    if (efforts.length && effort != null && !efforts.includes(effort)) fail('unsupported_reasoning_effort');
    const p = { ...params, ...(params.model != null || configure ? { model } : {}), ...(mode ? { collaborationMode: { ...params.collaborationMode, settings: { ...mode, model } } } : {}) };
    if (configure) Object.assign(p, { modelProvider: this.providerId(s), config: { ...params.config,
      ['model_providers.' + this.providerId(s)]: { name: s.name, base_url: s.baseUrl, wire_api: 'responses',
        ...(s.authRef === null ? { requires_openai_auth: false } : { auth: this.registry.broker.auth(s.authRef, s.baseUrl) }),
        supports_websockets: false, http_headers: {}, env_http_headers: {}, query_params: {}, request_max_retries: 0, stream_max_retries: 0 } } });
    return p;
  }
  async nativeForConnection(s, model) {
    if (!this.nativeFor) return this.native; // Existing injected/pre-0.166 fixture contract.
    const config = this.parameters({}, s, model, true).config;
    return this.nativeFor(s, config['model_providers.' + this.providerId(s)]);
  }
  loaded(peer) {
    if (!this.loadedByPeer.has(peer)) this.loadedByPeer.set(peer, new Set());
    return this.loadedByPeer.get(peer);
  }
  routeLock(tid, kind = '') {
    // local-routes must exist with the right permissions; nothing else is created by taking a lock (no receipt directory)
    rootOk(this.root); try { mkdirSync(join(this.root, 'local-routes'), { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } rootOk(join(this.root, 'local-routes'));
    const path = join(this.root, 'local-routes', tid + kind + '.lock');
    const owner = { pid: process.pid, token: randomBytes(16).toString('hex') };
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
    try { exclusiveWrite(path, owner); }
    catch (e) {
      // A lock this call created but could not make durable is removed again (only if it is still exactly ours): a failed
      // acquisition must never leave a lock that would later look like a live concurrent change.
      if (e.code !== 'EEXIST') { try { if (JSON.stringify(readPrivate(path, 512)) === JSON.stringify(owner)) unlinkSync(path); } catch { /* not ours, or gone */ } throw e; }
      const previous = readPrivate(path, 512);
      if (!keys(previous, ['pid', 'token']) || !Number.isInteger(previous.pid) || previous.pid <= 0 || !/^[a-f0-9]{32}$/.test(previous.token) || alive(previous.pid)) fail('model_change_pending');
      // A dead process cannot still complete its RPC. Serialize reclamation;
      // malformed/unknown recovery ownership fails closed for operator review.
      const recovery = path + '.recover'; exclusiveWrite(recovery, owner);
      try {
        if (JSON.stringify(readPrivate(path, 512)) !== JSON.stringify(previous)) fail('model_change_pending');
        unlinkSync(path); exclusiveWrite(path, owner);
      } finally { unlinkSync(recovery); }
    }
    return () => { if (JSON.stringify(readPrivate(path, 512)) !== JSON.stringify(owner)) fail('model_change_pending'); unlinkSync(path); };
  }
  replaceRoute(tid, expected, next) {
    const path = join(this.root, 'local-routes', tid + '.json');
    if (JSON.stringify(this.readRoute(tid)) !== JSON.stringify(expected)) fail('stale_revision');
    this.publish(join(this.root, 'local-routes'), tid + '.json', next, 'replace', expected); return next;
  }
  unchangedConnection(s) {
    const current = this.connection({ connectionId: s.connectionId, endpointHash: hash(s.baseUrl + '\0' + (s.authRef ?? '')) });
    if (current.revision !== s.revision || current.enabled !== s.enabled) fail('stale_revision');
  }
  selectedModel(s, requested) {
    const model = s.catalog?.models.find(m => requested === m || requested === localModelId(s.connectionId, m));
    if (!model) fail(typeof requested === 'string' && requested.startsWith(localPrefix + s.connectionId + '/') ? 'model_not_available' : 'cross_provider_switch_requires_new_thread');
    if (!s.enabled) fail('provider_disabled');
    if (s.catalog.status !== 'fresh') fail('catalog_not_fresh');
    if (!selectable(s, model)) fail('free_model_required');
    return model;
  }
  // `pin`: name the route's own saved model in the resume. Used for the FIRST load of a thread by a native process (see ensureProviderThread); the caller compares the answer.
  async actualSettings(peer, s, r, tid, { pin = false } = {}) {
    const params = { threadId: tid, excludeTurns: true };
    const execution = this.parameters(params, s, r.model, true); if (!pin) delete execution.model;
    let answer;
    try { answer = await peer.request('thread/resume', execution); this.createdSnapshots.delete(tid); }
    catch (error) {
      const created = this.createdSnapshots.get(tid);
      if (!created || !this.loadedModels.get(peer)?.has(tid) || error.code !== -32600 || error.message !== 'no rollout found for thread id ' + tid) throw error;
      // Native reserves a fresh thread before its first rollout is published.
      // Read that loaded thread; never create a seed turn just to resume it.
      const read = await peer.request('thread/read', { threadId: tid });
      const observed = this.pendingSettings.get(tid)?.notification?.threadSettings ?? this.freshObserved.get(tid);
      answer = observed ? { ...created, model: observed.model, modelProvider: observed.modelProvider, reasoningEffort: observed.effort,
        cwd: observed.cwd, sandbox: observed.sandboxPolicy, approvalPolicy: observed.approvalPolicy,
        approvalsReviewer: observed.approvalsReviewer, activePermissionProfile: observed.activePermissionProfile } : { ...created };
      if (read.thread?.model !== answer.model || read.thread?.modelProvider !== answer.modelProvider || read.thread?.reasoningEffort !== answer.reasoningEffort) fail('native_selection_not_confirmed');
      answer.thread = read.thread;
    }
    if (answer.modelProvider !== this.providerId(s) || !validModel(answer.model)) fail('native_selection_not_confirmed');
    this.verifyHistory('thread/resume', answer, params, r); this.unchangedConnection(s);
    return answer;
  }
  markLoaded(peer, tid, model) {
    this.loaded(peer).add(tid);
    if (!this.loadedModels.has(peer)) this.loadedModels.set(peer, new Map());
    this.loadedModels.get(peer).set(tid, model);
  }
  async ensureProviderThread(peer, s, r, tid) {
    const remembered = this.loadedModels.get(peer)?.get(tid);
    // Another controller committed a different route. A cached native thread
    // is not an oracle for newer persisted settings; never write its old model
    // back over the newer route. Unsubscribe alone does not prove that a cached native writer was replaced.
    if (remembered !== undefined && remembered !== r.model) fail('native_runtime_stale');
    if (!this.nativeFor || this.loaded(peer).has(tid)) return r;
    // The FIRST load of this thread by a native process. A native process answers a resume that names no model with ITS OWN configured default (it does not restore the model
    // the thread last ran on), and that unpinned load would itself leave the thread running the wrong model. So the thread is loaded WITH its own saved model: the route is the
    // committed, durable choice (re-read under the lock by the caller, and a newer route or a different loaded model is refused above), and what comes back must be it.
    // A different model of THIS connection is still evidence of a change made elsewhere (a loaded thread keeps its own model) and is recovered into the route as before;
    // anything else (the process default, a model of no connection) is not confirmed: refused, nothing sent, the route untouched.
    const wanted = await this.firstLoadModel(peer, s, r, tid);
    const answer = await this.actualSettings(peer, s, { ...r, model: wanted }, tid, { pin: true });
    if (answer.model !== r.model) {
      if (!s.catalog?.models.includes(answer.model)) fail('native_selection_not_confirmed');
      this.selectedModel(s, answer.model); r = this.replaceRoute(tid, r, this.routeFor(s, answer.model, answer.thread));
    }
    this.markLoaded(peer, tid, r.model); return r;
  }
  // The model a thread's FIRST load by this native process names. The public thread/read of a thread that is not loaded is read-only and reports what native itself persisted for it
  // (its ID, provider and model); it is observed BEFORE anything is resumed, so a resume can neither restore a stale route over a newer persisted selection nor fall to the
  // process default. The persisted model is named when it is one of THIS connection's models (a selection made elsewhere is recovered, as before); when native reports none, or one of
  // no model of this connection, the route's own saved model is named (the route is the durable choice) and the answer to the resume is still compared exactly by the caller.
  // A read that shows another thread or another provider is no evidence: refused. A read that fails (no rollout yet) is simply no observation.
  async firstLoadModel(peer, s, r, tid) {
    let read; try { read = await peer.request('thread/read', { threadId: tid }); } catch { return r.model; }
    const thread = object(read) ? read.thread : null; if (!object(thread)) return r.model;
    if (thread.id !== tid || (thread.modelProvider != null && thread.modelProvider !== this.providerId(s))) fail('native_selection_not_confirmed');
    return typeof thread.model === 'string' && s.catalog?.models.includes(thread.model) ? thread.model : r.model;
  }
  modelChangeEffort(s, model, params, inherited) {
    const levels = advertisedEfforts(s, model); if (!levels.length) return params;
    const metadata = s.catalog.details.find(m => m.id === model).reasoning;
    const wanted = params.collaborationMode?.settings?.reasoning_effort ?? params.effort ?? inherited;
    const effort = levels.includes(wanted) ? wanted : levels.includes(metadata.default_effort) ? metadata.default_effort : levels[0];
    return { ...params, effort, ...(params.collaborationMode?.settings ? { collaborationMode: { ...params.collaborationMode, settings: { ...params.collaborationMode.settings, reasoning_effort: effort } } } : {}) };
  }
  async changeModel(peer, s, r, params, model) {
    const tid = params.threadId, before = await this.actualSettings(peer, s, r, tid);
    params = this.modelChangeEffort(s, model, params, before.reasoningEffort);
    if (before.thread.status?.type !== 'idle') fail('model_change_requires_idle');
    if (this.createdSnapshots.has(tid)) this.createdSnapshots.set(tid, before);
    const pending = { route: this.routeFor(s, model, before.thread), notification: null };
    this.pendingSettings.set(tid, pending); let committed = false;
    try {
      // The change is made durable as an INTENT before the runtime is asked (false: it could not be written, so the runtime is not asked and nothing changes). Whatever then happens - an answer lost,
      // a readback that fails after the runtime accepted - the intent stays, and the next dispatch settles it from the runtime's public readback rather than guessing.
      const intent = this.continuity?.context?.intend;
      if (intent && !intent({ peer, kind: 'custom', connectionId: s.connectionId, id: tid, from: { model: r.model, effort: before.reasoningEffort ?? null },
        to: { model, effort: params.collaborationMode?.settings?.reasoning_effort ?? params.effort ?? before.reasoningEffort ?? null }, hadTurn: !this.createdSnapshots.has(tid) })) fail('context_state_unavailable');
      await peer.request('thread/settings/update', this.parameters(params, s, model, false));
      const after = await this.actualSettings(peer, s, r, tid);
      if (after.model !== model) fail('native_selection_not_confirmed');
      const effort = params.collaborationMode?.settings?.reasoning_effort ?? params.effort;
      if (effort != null && after.reasoningEffort !== effort) fail('native_selection_not_confirmed');
      for (const key of ['cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'activePermissionProfile'])
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) fail('native_permissions_changed');
      if (!pending.notification) fail('native_selection_not_confirmed');
      const next = this.replaceRoute(tid, r, pending.route); this.markLoaded(peer, tid, next.model);
      if (this.createdSnapshots.has(tid)) this.createdSnapshots.set(tid, after);
      committed = true; this.notify('thread/settings/updated', this.result(pending.notification, next));
      // The selection is now COMMITTED (readback confirmed, route replaced): the model of this thread is told once (see Bridge.acceptSelection).
      this.continuity?.context?.accepted?.({ peer, kind: 'custom', connectionId: s.connectionId, id: tid, model, effort: after.reasoningEffort ?? null });
      return {};
    } finally { this.pendingSettings.delete(tid); if (!committed) this.loaded(peer).delete(tid); }
  }
  result(value, r) {
    if (!object(value)) return value;
    const model = localModelId(r.connectionId, r.model);
    return { ...value, ...(value.model === r.model ? { model } : {}),
      ...(value.collaborationMode?.settings?.model === r.model ? { collaborationMode: { ...value.collaborationMode, settings: { ...value.collaborationMode.settings, model } } } : {}),
      ...(value.thread ? { thread: this.result(value.thread, r) } : {}),
      ...(value.threadSettings ? { threadSettings: this.result(value.threadSettings, r) } : {}) };
  }
  notification(method, params) {
    if (method !== 'thread/settings/updated') return params;
    if (object(params?.threadSettings) && typeof params.threadId === 'string' && (this.provisional?.has(params.threadId) || this.createdSnapshots.has(params.threadId) || this.pendingSettings.has(params.threadId))) this.captureSettings(params.threadId, params.threadSettings);
    const pending = this.pendingSettings.get(params.threadId), r = pending?.route ?? this.readRoute(params.threadId), settings = params.threadSettings;
    if (!r) {
      // Initial notifications can precede route confirmation. Never expose a
      // raw custom slug then; the confirmed RPC reply carries the snapshot.
      if (typeof settings?.modelProvider === 'string' && settings.modelProvider.startsWith('bridge_custom_')
        && !this.nativeClaims().includes(settings.model)) fail('custom_settings_unbound');
      return params;
    }
    const model = localModelId(r.connectionId, r.model);
    if (!object(settings) || settings.model != null && ![r.model, model].includes(settings.model)
      || settings.collaborationMode?.settings?.model != null && ![r.model, model].includes(settings.collaborationMode.settings.model)
      || settings.modelProvider != null && settings.modelProvider !== 'bridge_custom_' + r.connectionId) fail('native_selection_not_confirmed');
    if (this.createdSnapshots.has(params.threadId)) {
      const baseline = this.createdSnapshots.get(params.threadId);
      const pairs = [['cwd', 'cwd'], ['sandboxPolicy', 'sandbox'], ['approvalPolicy', 'approvalPolicy'], ['approvalsReviewer', 'approvalsReviewer'], ['activePermissionProfile', 'activePermissionProfile']];
      if (!pending || pairs.every(([field, key]) => JSON.stringify(settings[field]) === JSON.stringify(baseline[key]))) this.freshObserved.set(params.threadId, settings);
    }
    if (pending) { pending.notification = params; return null; }
    return this.result(params, r);
  }
  // A native thread is bound to the provider that created it: same-ID resume on
  // another provider is refused by native (modelProviderMismatch). The documented
  // native route across providers is thread/fork, which creates a NEW thread ID
  // that retains forkedFromId and the source's persisted history without
  // replaying a prompt. The new ID is returned to the caller (never presented as
  // the source ID) and the source thread, route and history are left untouched.
  // Returns null when this is not a cross-provider fork, so existing paths apply.
  // ctx (picker switch inside one logical conversation): { logical, link } - the conversation's stable ID and its current link or null.
  async crossFork(params, r, requested, customRequested, forward, ctx = null) {
    const kit = this.continuity;
    const tid = params.threadId, claude = isClaudeModel(requested);
    if (!kit || !threadId(tid) || (this.managed(tid) && r)) return null;
    const managedSource = this.managed(tid) && !r;
    const target = customRequested ? this.registry.all().find(s => requested.startsWith(localPrefix + s.connectionId + '/')) : null;
    if (customRequested && !target) return null;
    const toCustom = !!target && !(r && r.connectionId === target.connectionId);
    // A managed chat whose native host is the legacy claude_code provider reaches GPT only as a new physical thread (never a same-ID resume).
    const legacyHost = managedSource && this.managedSource(tid)?.legacyHost === true;
    // A managed chat that Bridge's SDK actually EXECUTES (not merely a record) keeps a private placeholder user message in its native host thread (it only materializes the host and
    // is never meant for any model). Moving that same host thread to a GPT model would run the placeholder as model input, so it too reaches GPT only as a NEW physical thread.
    const sdkHost = managedSource && this.managedSource(tid)?.sdkHost === true;
    const toNative = !customRequested && !claude && (!!r || legacyHost || sdkHost) && requested != null && !String(requested).startsWith(localPrefix);
    const toClaude = claude && (!!r || !!ctx) && !!this.claudeTarget;
    // A managed Claude chat leaving for GPT/Claude keeps Bridge's own paths (fresh hosts and ordinary native model changes included);
    // custom targets, a legacy claude_code host leaving for GPT, and a legacy host that native cannot load (continuing as a NEW neutral Claude chat)
    // are the new-physical-thread cases.
    if (!(toCustom || toNative || toClaude) || (managedSource && !toCustom && !toNative && !(toClaude && legacyHost))) return null;
    const { path, history, ...rest } = params;
    if (history != null || (path != null && path !== '')) fail('alternate_history_refused'); // never an alternate history or rollout source
    if (rest.config != null && (!object(rest.config) || Object.keys(rest.config).some(k => /^(model|model_provider|model_providers|openai_base_url|model_catalog_json)(\.|$)/.test(k)))) fail('provider_override_refused');
    let release = () => {};
    if (r) release = this.routeLock(tid);
    try {
      if (r && JSON.stringify(this.readRoute(tid)) !== JSON.stringify(r)) fail('stale_revision');
      // The source's own settings snapshot: idle state, identity and the permission baseline the new thread must keep.
      let before, turns, freshProof = null, owner = null, managedInfo = null; // freshProof: the birth evidence an empty own history was read from (re-checked in the final revalidation)
      if (managedSource) {
        const m = this.managedSource(tid); if (!m) fail('ambiguous_thread_owner');
        before = m.snapshot; turns = m.turns; managedInfo = m;
        // An old record may never have recorded its workspace roots. They are then discovered from the OWNING provider's own public resume
        // (no provider change, nothing inferred from the target or the cwd); if native does not report them the switch is refused.
        if (!workspaceRoots(before) && this.managedRoots) { const found = await this.managedRoots(tid); if (Array.isArray(found)) before = { ...before, runtimeWorkspaceRoots: found }; }
      } else {
        before = r ? await this.sourceSnapshot(r, tid) : await forward('thread/resume', { threadId: tid, excludeTurns: true });
        // The canonical history: whatever an earlier continuation carried here, then this thread's own turns.
        // A routed custom thread lives in (and is loaded by) its OWN connection's native process: its turns are asked of that same owning peer (the one the snapshot above just used), never of the
        // main process, which does not hold a thread that has no rollout yet. A failing owner is an explicit failure; nothing is assumed empty.
        owner = r ? await this.nativeForConnection(this.connection(r), r.model) : null;
        // The ONE exception to "an owner failure is a failure": native's exact "no first user message yet" answers, on the FIRST page only (no page has been read, so no history is known), for a thread
        // with positive birth evidence (provenFreshEmpty). Every other error, a later page, a cold or unproven thread, stays an explicit failure.
        let pagesRead = 0;
        const own = await kit.readAllTurns(async page => {
          if (!owner) return forward('thread/turns/list', { threadId: tid, ...page });
          try { const answer = await owner.request('thread/turns/list', { threadId: tid, ...page }); pagesRead++; return answer; }
          catch (error) {
            if (pagesRead === 0 && !page?.cursor && this.unmaterialized(error, tid) && await this.provenFreshEmpty(owner, r, tid, before)) { freshProof = this.bornMap.get(tid); return { data: [], nextCursor: null, backwardsCursor: null }; }
            throw error;
          }
        });
        // Native reports an unmaterialized thread's createdAt/updatedAt as the CURRENT clock, not as history. When the empty own history rests on the positive birth evidence, the thread's REAL dates are
        // the ones its own start answer reported (known in process, never guessed): they replace the synthetic ones in this snapshot, so the logical origin keeps the true creation and the
        // idle/updatedAt baseline is the birth's. Without birth dates the snapshot is left as it is.
        if (freshProof && Number.isFinite(freshProof.createdAt)) before = { ...before, thread: { ...before.thread, createdAt: freshProof.createdAt, ...(Number.isFinite(freshProof.updatedAt) ? { updatedAt: freshProof.updatedAt } : {}) } };
        const carriedBefore = this.readHandoff(tid)?.turns ?? [], seen = new Set(own.map(t => t?.id));
        turns = [...carriedBefore.filter(t => !seen.has(t.id)), ...own];
      }
      // A queued message belongs to the old runtime. The public API cannot carry it without replaying it, and replaying could run it
      // twice, so a conversation with a pending queue is not switched: the entry stays where it is, intact.
      const stateOf = async snapshot => {
        let queued = 0;
        if (managedSource) queued = snapshot.queue?.length ?? 0;
        else {
          const asked = r ? (await this.nativeForConnection(this.connection(r), r.model)).request('thread/queue/list', { threadId: tid, limit: 100 }) : forward('thread/queue/list', { threadId: tid, limit: 100 });
          const page = await asked; queued = Array.isArray(page?.data) ? page.data.length : 0;
        }
        return { idle: snapshot.thread?.status?.type === 'idle', queued, updatedAt: snapshot.thread?.updatedAt };
      };
      const start = await stateOf(before);
      if (start.queued) fail('handoff_queue_pending');
      // The workspace-access boundary needs the SOURCE's confirmed roots (a start/resume response carries them, a thread does not): without
      // them nothing is created. Changed or missing roots on the new thread are refused the same way (see permissionsKept).
      if (!workspaceRoots(before)) fail('native_permissions_unconfirmed');
      if (ctx) { // the conversation's link must still fit its read bound with one more physical thread: refused BEFORE anything is created
        const probe = this.nextLink(ctx, 'x'.repeat(128), 'x'.repeat(512), before, requested, { kind: 'custom', connectionId: 'x'.repeat(32), privateId: 'x'.repeat(128) }); // worst-case ID; a typical path (re-checked exactly at publication)
        if (Buffer.byteLength(JSON.stringify(probe)) > LINK_MAX) fail('link_capacity_reached');
      }
      let s = target, model, provider = null, wanted = rest.collaborationMode?.settings?.reasoning_effort ?? rest.effort ?? null;
      // Opening an old chat only repairs its HOST: the SDK selection it already has (the same model, the effort it is already on) is never changed by that. The new neutral
      // chat is therefore read back on the source's own effort (set and confirmed like any explicit one, or the open is refused), never on an implicit default.
      // An explicit effort of the request wins; another model is a new choice with its own defaults. "The same model" is decided on what the new chat turned out to
      // be (its model as the SDK normalizes it), so the model asked for by an alias or by its resolved name keeps the selection alike.
      const inheritEffort = managedSource && toClaude && typeof before.reasoningEffort === 'string' && before.reasoningEffort !== 'none';
      const base = this.startBase(rest, before);
      let peer = null, adapterStart, nativeEffort = null;
      if (s) {
        if (!s.enabled) fail('provider_disabled');
        if (s.catalog?.status !== 'fresh') fail('catalog_not_fresh');
        model = s.catalog.models.find(m => localModelId(s.connectionId, m) === requested);
        if (!model) fail('model_not_available');
        if (!selectable(s, model)) fail('free_model_required');
        this.parameters(rest, s, model, true); // validates provider/model/effort
        if (advertisedEfforts(s, model).length) wanted = this.modelChangeEffort(s, model, rest, before.reasoningEffort).effort;
        const execution = this.parameters(this.historyTools({ ...base, model: requested }), s, model, true);
        adapterStart = async () => {
          peer = await this.nativeForConnection(s, model);
          const started = await peer.request('thread/start', execution);
          // Native reserves a new thread before its first rollout exists; remember what it reported so readback never needs a seed turn.
          if (threadId(started?.thread?.id) && started.thread.id !== tid) { this.createdSnapshots.set(started.thread.id, started); this.markLoaded(peer, started.thread.id, model); }
          return started;
        };
      } else if (toClaude) {
        adapterStart = () => this.claudeTarget.start({ ...base, model: requested }, rest);
      } else {
        const config = (await forward('config/read', { ...(typeof rest.cwd === 'string' ? { cwd: rest.cwd } : {}), includeLayers: false })).config;
        provider = rest.modelProvider ?? config?.model_provider ?? 'openai';
        if (typeof provider !== 'string' || provider.startsWith('bridge_custom_')) fail('provider_override_refused');
        adapterStart = () => forward('thread/start', { ...base, model: requested, modelProvider: provider });
        // The GPT target's level is decided from what the runtime advertises for THAT model (the Bridge's kit asks model/list), never from the source's default or a stale client 'none': the first
        // requested level the model offers; a stale 'none' alone is no choice, and the target's own started level stands only if it is offered (else the advertised default, see wantedEffort below).
        // Any other level the model does not offer is refused before anything is created. A runtime that lists no levels for the model decides nothing (nothing is invented).
        if (kit.context?.nativeEffort) {
          try { nativeEffort = await kit.context.nativeEffort({ model: requested, explicit: [rest.collaborationMode?.settings?.reasoning_effort, rest.effort] }); }
          catch (error) { if (error?.code === -32602) fail('unsupported_reasoning_effort'); nativeEffort = null; }
          if (nativeEffort) wanted = nativeEffort.effort;
          else {
            // The target's levels could not be established (the list was unreadable, or the exact row is missing or advertises none). Two explicit levels that DISAGREE then cannot be settled: refused
            // BEFORE any thread is created (never guessed, never applied). One level, or none, is not contradictory and goes as it always did.
            const named = [rest.collaborationMode?.settings?.reasoning_effort, rest.effort].filter(v => v != null);
            if (named.length > 1 && named.some(v => v !== named[0])) fail('reasoning_levels_unconfirmed');
          }
        }
      }
      // The new child is PROVISIONAL from the moment it exists: nothing about it (a new chat, a new model) is shown until its link is accepted.
      const startThread = adapterStart;
      adapterStart = async () => { const started = await startThread(); if (threadId(started?.thread?.id) && started.thread.id !== tid) { this.provisional.add(started.thread.id); this.childOwner.set(started.thread.id, ctx?.logical ?? tid); } return started; };
      const expectedProvider = s ? this.providerId(s) : toClaude ? 'claude_code' : provider, expectedModel = s ? model : requested;
      const via = peer2 => ({ request: (m, p) => peer2 ? peer2.request(m, p) : forward(m, p) });
      let route = null, plan = null, privateId = null, announce = null, noticeDelivered = null;
      const ctxKit = kit.context ?? null; // the Bridge's context kit (reduced hand-off decision, budgets, notice builders); a router without it behaves exactly as before
      const childOf = id => ({ id, kind: toClaude ? 'claude' : s ? 'custom' : 'native', ...(s ? { connectionId: s.connectionId, model } : {}) });
      // The staged target's authoritative settings, read back (and, for a mode the person asked for, first APPLIED to it) before anything is committed.
      const askedMode = ctx && object(rest.collaborationMode) && object(rest.collaborationMode.settings) && typeof rest.collaborationMode.mode === 'string' ? rest.collaborationMode : null;
      const readTarget = async (created, answer, update, targetRoute) => {
        if (toClaude) return this.claudeTarget.settings ? await this.claudeTarget.settings(created, update) : null; // the managed chat's own settings view
        const pending = s ? { route: targetRoute, notification: null } : null; // (a custom child's settings event is held for this call, as in setEffort)
        if (pending) this.pendingSettings.set(created, pending);
        try {
          if (update) await via(peer).request('thread/settings/update', { threadId: created, ...update });
          return s ? await this.actualSettings(peer, s, targetRoute, created) : await forward('thread/resume', { threadId: created, excludeTurns: true });
        } finally { this.pendingSettings.delete(created); }
      };
      const settle = async (created, merged, targetRoute) => {
        const update = askedMode ? { collaborationMode: { mode: askedMode.mode, settings: { model: s ? model : merged.model, reasoning_effort: merged.reasoningEffort ?? null, developer_instructions: askedMode.settings.developer_instructions ?? null } } } : undefined;
        const read = await readTarget(created, merged, update, targetRoute);
        // The FINAL readback is the evidence, and it must CARRY every required field itself (a native/custom ThreadResumeResponse and a managed chat's settings view differ in shape):
        // identity, model, provider, effort, cwd, sandbox, approval policy and reviewer, permission profile, disabled plugins and the workspace roots. A field that is absent is never
        // completed from the start answer, the source or the created ID, and never read as an implicit null (only an explicitly present nullable null is a value): the switch is refused.
        const own = (o, k) => object(o) && Object.hasOwn(o, k), text = v => typeof v === 'string' && v !== '', evidence = object(read) ? read : {};
        const reportedId = toClaude ? evidence.threadId : evidence.thread?.id, reportedSandbox = toClaude ? evidence.sandboxPolicy : evidence.sandbox, effortKey = toClaude ? 'effort' : 'reasoningEffort';
        if (!text(reportedId) || !text(evidence.model) || !text(evidence.modelProvider) || !own(evidence, effortKey) || !Array.isArray(evidence.disabledPluginIds) || (toClaude && !own(evidence, 'collaborationMode'))) fail('native_selection_not_confirmed');
        if (!text(evidence.cwd) || !object(reportedSandbox) || evidence.approvalPolicy == null || !text(evidence.approvalsReviewer) || !own(evidence, 'activePermissionProfile') || !Array.isArray(evidence.runtimeWorkspaceRoots)) fail('native_permissions_unconfirmed');
        const settings = this.settingsFor(created, merged, read, targetRoute), reportedModel = evidence.model;
        if (reportedId !== created || evidence.modelProvider !== expectedProvider || settings.modelProvider !== expectedProvider || (toClaude ? reportedModel !== merged.model : reportedModel !== expectedModel) || settings.effort !== (merged.reasoningEffort ?? null)) fail('native_selection_not_confirmed');
        // The roots are the FINAL readback's own (the managed chat's staged roots travel beside its settings view).
        const reportedRoots = evidence.runtimeWorkspaceRoots;
        const finalState = { thread: { id: created, cwd: settings.cwd }, cwd: settings.cwd, sandbox: settings.sandboxPolicy, approvalPolicy: settings.approvalPolicy, approvalsReviewer: settings.approvalsReviewer, activePermissionProfile: settings.activePermissionProfile,
          runtimeWorkspaceRoots: Array.isArray(reportedRoots) ? reportedRoots : undefined };
        if (!this.permissionsKept(before, finalState)) fail('native_permissions_changed');
        // The mode the person chose is announced only if the target itself reports it (instructions left null mean the mode's built-in ones, so they are not compared).
        if (askedMode && (settings.collaborationMode.mode !== askedMode.mode || (askedMode.settings.developer_instructions != null && settings.collaborationMode.settings.developer_instructions !== askedMode.settings.developer_instructions))) fail('native_selection_not_confirmed');
        this.childSettings?.delete(created); return settings;
      };
      const adapter = {
        pending: () => this.pendingHandoff(tid, ctx),
        checkOverrides: snapshot => this.permissionOverridesKept(rest, snapshot),
        start: adapterStart,
        // Exact provider and exact model: a different one is never accepted as "compatible". (A Claude alias may resolve to its full name.)
        confirm: answer => threadId(answer?.thread?.id) && answer.thread.id !== tid && answer.modelProvider === expectedProvider && (toClaude ? answer.model != null : answer.model === expectedModel),
        permissionsKept: (source, answer) => this.permissionsKept(source, answer),
        // A NATIVE GPT target (neither custom nor Claude) is started unmaterialized: it cannot be resumed until it has metadata or items. The level is applied at once through the public settings
        // update, and read back (the public resume) only after the delivery and the private naming (see runtimeHandoff). Custom targets read back from the start snapshot, Claude through its own record.
        ...(!toClaude && !s ? {
          applyEffort: async (created, effort) => { await via(peer).request('thread/settings/update', { threadId: created, effort }); },
          readEffort: async created => forward('thread/resume', { threadId: created, excludeTurns: true }),
        } : {}),
        setEffort: async (created, effort, answer) => {
          if (toClaude) return this.claudeTarget.setEffort(created, effort);
          const pending = s ? { route: this.routeFor(s, model, answer.thread), notification: null } : null;
          if (pending) this.pendingSettings.set(created, pending);
          try {
            await via(peer).request('thread/settings/update', { threadId: created, effort });
            return s ? await this.actualSettings(peer, s, pending.route, created) : await forward('thread/resume', { threadId: created, excludeTurns: true });
          } finally { this.pendingSettings.delete(created); }
        },
        // A managed Claude target takes the canonical turns as ONE whole import (it refuses a second import into a non-empty chat); Native and custom targets
        // receive the plain items in chunks of 100, as always.
        ...(toClaude ? { deliverAll: (created, transfer) => this.claudeTarget.import(created, transfer, before) }
          : { deliver: async (created, items) => { await via(peer).request('thread/inject_items', { threadId: created, items }); } }),
        // The model INPUT of the target (never the canonical history): full, or - only with a known window of that exact target, a provider-written summary that matches this very
        // history and a reachable history tool - a reduction. A known window the history does not fit in, without such a summary, REFUSES (handoff_context_too_large); an unknown
        // window carries the full history within the transport limits and claims no fit.
        ...(ctxKit ? { reduce: async (transfer, started) => {
          const kind = toClaude ? 'claude' : s ? null : 'native', budget = kind && typeof started?.model === 'string' ? ctxKit.budgetFor(kind, started.model) : null;
          const carried = this.readHandoff(tid)?.context?.summary ?? null;
          // Every candidate (this chat's own compaction, the summary carried by an earlier full or reduced hand-off) is re-qualified against the exact history now; the one that covers the most wins.
          const summary = [managedInfo?.compaction, managedInfo?.contextSummary, carried].filter(c => c && ctxKit.validSummary(c, transfer.turns).ok).sort((a, b) => b.coverage.count - a.coverage.count)[0] ?? null;
          // The refs read back in the scope of the chat that RECEIVES the history: inside a conversation its logical ID, otherwise (a public cross-provider fork) the new thread's own ID - never the source's.
          return ctxKit.decide({ transfer, summary, budget, claude: toClaude, reachable: !!workspaceRoots(started) && !!kit.withHistoryTools,
            refs: ctxKit.refs({ logical: ctx ? ctx.logical : started?.thread?.id ?? tid, cwd: before.cwd ?? before.thread?.cwd }) });
        } } : {}),
        // ONE note for the receiving model, from the FINAL confirmed selection (the readback `settle` just made), staged in the still-unpublished private target. Native and custom threads get
        // it as a trusted developer-role item (public thread/inject_items: no visible turn, in the model input); a Claude chat keeps it as pending application context. Never a user item.
        ...(ctxKit && ctx ? { deliverNotice: async (created, { transfer }) => {
          if (!announce) fail('native_selection_not_confirmed');
          const handoff = transfer.handoff, cov = handoff?.context?.coverage;
          const context = handoff?.mode === 'reduced' ? { mode: 'reduced', recentTurns: cov.recentWhole, deltaTurns: cov.deltaTurns, omittedTurns: cov.summarizedNotRepeated } : { mode: 'full' };
          const from = { route: managedSource ? { kind: 'claude' } : r ? { kind: 'custom', connectionId: r.connectionId } : { kind: 'native' }, model: r ? r.model : before.model, effort: before.reasoningEffort ?? null };
          const to = { route: toClaude ? { kind: 'claude' } : s ? { kind: 'custom', connectionId: s.connectionId } : { kind: 'native' }, model: s ? model : announce.model, effort: announce.effort ?? null };
          const notice = ctxKit.notice.build({ id: ctxKit.notice.id([ctx.logical, tid, created]), from, to, backend: null, context });
          if (toClaude) await this.claudeTarget.notice?.(created, notice);
          else await via(peer).request('thread/inject_items', { threadId: created, items: [ctxKit.notice.item(notice)] });
          noticeDelivered = notice.id;
        } } : {}),
        // A genuinely empty conversation leaves a new runtime thread that native does not persist (no rollout) until it has metadata. The public
        // thread/name/set on the NEW private child persists it with no history item, turn or model call. The label is Codex's own default, is
        // never shown (a physical thread is hidden; the conversation keeps its own title, null included) and never reaches a model. The source is never renamed.
        persistPrivate: async created => {
          if (!ctx) return;
          // The runtime ID is remembered as "named by Bridge" (in the accepted link) and its one echo is expected, so only THIS write is ever hidden.
          if (toClaude && !this.claudeTarget.persistPrivate) return;
          const own = this.expectOwnWrite(created);
          try {
            if (toClaude) await this.claudeTarget.persistPrivate(created); else await via(peer).request('thread/name/set', { threadId: created, name: PRIVATE_NAME });
            // The setter's answer is NOT the echo. The child stays provisional and unpublished until its own name event has been observed at the notification path:
            // no echo within the bound means its identity is unconfirmed, and the handoff is withdrawn (the child is archived, nothing is published).
            await own.waitEcho();
          } finally { own.settle(); } // confirmed, failed or timed out: nothing stays pending
          privateId = created;
        },
        settle: async (created, merged) => { if (ctx) announce = await settle(created, merged, s ? this.routeFor(s, model, merged.thread) : null); },
        revalidate: async () => {
          // The source must still be what the transfer was built from: idle, no queued entry, no activity since the snapshot.
          let fresh = managedSource ? this.managedSource(tid)?.snapshot : r ? await this.sourceSnapshot(r, tid) : await forward('thread/resume', { threadId: tid, excludeTurns: true });
          // A source whose empty history rested on the positive birth proof: native answers an unmaterialized thread's two dates with the CURRENT clock, so they may differ between two reads without any
          // history. They are set aside ONLY when the SAME proof is still live, native's current metadata still confirms it (idle, top-level readState null, no turns - read again, after the target's
          // last await) and EVERYTHING else of the snapshot (identity, model, provider, effort, cwd, permissions, roots, name, path ...) is exactly what it was. Anything else keeps the ordinary guards.
          if (freshProof && fresh && this.bornMap?.get(tid) === freshProof) {
            const canon = value => JSON.stringify(value, (k, x) => object(x) ? Object.fromEntries(Object.keys(x).sort().map(y => [y, x[y]])) : x), undated = snap => ({ ...snap, thread: { ...snap.thread, createdAt: null, updatedAt: null, ...('recencyAt' in (snap.thread ?? {}) ? { recencyAt: null } : {}) } }); // native's three synthetic clock fields of an unmaterialized thread (recencyAt only where it is reported: its presence must still match)
            if (!(await this.provenFreshEmpty(owner, r, tid, fresh))) fail('stale_revision');
            if (canon(undated(fresh)) !== canon(undated(before))) fail('stale_revision');
            fresh = { ...fresh, thread: { ...fresh.thread, createdAt: before.thread?.createdAt, updatedAt: before.thread?.updatedAt } };
          }
          const now = await stateOf(fresh ?? {});
          if (!now.idle) fail('model_change_requires_idle'); if (now.queued) fail('handoff_queue_pending'); if (now.updatedAt !== start.updatedAt) fail('stale_revision');
          if (s) this.unchangedTarget(s, model);
          if (r && JSON.stringify(this.readRoute(tid)) !== JSON.stringify(r)) fail('stale_revision');
          // "Still zero turns": an empty own history that rested on birth evidence is only still true if THAT SAME evidence is live now (idle, the queue and the second-resolution timestamp cannot show it).
          if (freshProof && this.bornMap?.get(tid) !== freshProof) fail('stale_revision');
          if (ctx && JSON.stringify(this.readLink(ctx.logical)) !== JSON.stringify(ctx.link)) fail('stale_revision');
        },
        publish: async (answer, confirmed, transfer, record) => {
          const id = answer.thread.id, kind = toClaude ? 'claude' : s ? 'custom' : 'native';
          // A reduced hand-off's first real request is measured against the window again: that requirement is made DURABLE (the Bridge's own state) before anything is committed, so a cold restart
          // between the commit and the first request still checks it. (If the commit then fails, the entry belongs to a withdrawn child whose ID is never used; it is bounded and harmless.)
          // Both are OBLIGATIONS, not hints: a gate or a baseline that could not be made durable (disk failure, damaged file, no room that is not an unfinished obligation) refuses the hand-off HERE,
          // before anything is committed: only the new private child is withdrawn, the source and its link are unchanged.
          if (ctxKit && !toClaude) {
            if (transfer.context?.mode === 'reduced' && !ctxKit.reduced(id, transfer.context, { kind: s ? 'custom' : 'native', model: s ? model : answer.model })) fail('context_state_unavailable');
            // What the new thread's model last saw is the selection the hand-off announced: a later turn-level or settings change is announced from it, also after a cold start.
            if (ctxKit.seed && !ctxKit.seed({ peer: s ? peer : undefined, kind, connectionId: s?.connectionId ?? null, id, model: s ? model : answer.model, effort: confirmed?.reasoningEffort ?? answer.reasoningEffort ?? null })) fail('context_state_unavailable');
          }
          // Every alias of the chain is kept (no truncation); a link that would not fit its read bound is refused here, before any commit.
          const link = ctx ? this.nextLink(ctx, id, answer.thread?.path ?? null, before, toClaude ? answer.model : requested, { kind, connectionId: s?.connectionId, privateId }) : null;
          if (link && Buffer.byteLength(JSON.stringify(link)) > LINK_MAX) fail('link_capacity_reached');
          // ONE intent authority covers the whole compound: the intent is durable before anything is published; the carried history
          // and the new route are written first (unreachable); `committing` is durable before the commit file is touched; the commit
          // file is the link inside a conversation, otherwise the route (custom), the carried history (native) or the Claude record.
          const rel = file => relative(this.root, file), sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
          const handoffFile = join(this.root, 'local-routes', 'handoffs', id + '.json'), routeFile = join(this.root, 'local-routes', id + '.json');
          // The carried canonical turns stay COMPLETE; beside them (never inside them) the reduction's own record when the model input was reduced, and the audit of the note that was staged.
          const handoffValue = toClaude ? null : { ...record, turns: transfer.turns, ...(transfer.context ? { context: transfer.context } : {}), ...(noticeDelivered ? { notice: { id: noticeDelivered } } : {}) };
          if (handoffValue && Buffer.byteLength(JSON.stringify(handoffValue)) > 6 * 1024 * 1024) fail('handoff_context_too_large'); // before anything exists
          route = s ? this.routeFor(s, model, answer.thread) : null;
          // The settings the desktop will be told, proven from the confirmed readback BEFORE anything is committed (a field it cannot prove refuses the switch here).
          if (ctx && !announce) fail('native_selection_not_confirmed'); // (proven by `settle`, before the source was validated again)
          const orphans = { handoff: handoffValue && (ctx || s) ? { file: rel(handoffFile), sha: sha(handoffValue) } : null, route: ctx && route ? { file: rel(routeFile), sha: sha(route) } : null };
          const commit = ctx ? { file: rel(this.linkPath(ctx.logical)), old: ctx.link, next: link, mode: 'replace' }
            : s ? { file: rel(routeFile), old: null, next: route, mode: 'create' } : handoffValue ? { file: rel(handoffFile), old: null, next: handoffValue, mode: 'create' } : { record: true };
          plan = { key: ctx ? ctx.logical : id, sourceId: tid, logical: ctx?.logical ?? null, child: childOf(id), commit, orphans };
          try {
            await this.commitHandoff(plan, {
              orphans: async () => {
                this.ensureDirs('handoffs');
                if (orphans.handoff) { this.writeAtomic(handoffFile, handoffValue, 'create'); this.syncDir(dirname(handoffFile)); }
                if (orphans.route) { this.writeAtomic(routeFile, route, 'create'); this.syncDir(dirname(routeFile)); }
                if (toClaude && ctx) await this.claudeTarget.publish(id, record);
              },
              commit: async () => {
                if (ctx) this.writeAtomic(this.linkPath(ctx.logical), link, 'replace');
                else if (s) this.writeAtomic(routeFile, route, 'create');
                else if (handoffValue) { this.ensureDirs('handoffs'); this.writeAtomic(handoffFile, handoffValue, 'create'); }
                else await this.claudeTarget.publish(id, record);
              },
            });
          } catch (error) {
            // Uncertainty and deferred cleanup keep their own code and tag through every wrapper: nothing is archived, deleted or unloaded
            // once the commit may have happened. A certainly-aborted publication is reported as not saved, with the intent already `aborted`.
            if (error.uncertain || error.deferCleanup) throw error;
            if (error.aborted) { try { fail('native_thread_created_but_route_not_saved'); } catch (saved) { saved.aborted = true; throw saved; } }
            throw error;
          }
          if (s) this.markLoaded(peer, id, route.model);
          // A committed reduction: the target's FIRST real request is measured against its window again with the real input.
          /* the first-request gate of a reduced hand-off was made durable BEFORE the commit (see publish) */
        },
        // Allowed only before the intent exists, or after a durable `aborted`: the runtime handoff never calls it for an uncertain publication.
        archive: async created => {
          try { if (toClaude) await this.claudeTarget.archive(created); else await via(peer).request('thread/archive', { threadId: created }); }
          catch { return false; }
          this.createdSnapshots.delete(created); if (peer) this.loaded(peer).delete(created); this.abandoned.add(created);
          if (plan) try { const base = this.intentBase(plan.key), intent = this.readIntent(base); if (intent?.phase === 'aborted' && intent.child?.id === created) this.finishAbort(base, intent); } catch { /* the aborted intent stays and is finished by recovery */ }
          return true;
        },
        // The cleanup could not archive the child: the single intent records that (never swallowed); a second handoff is refused until resolved.
        receipt: receipt => this.markArchivePending(receipt, ctx, plan?.child ?? childOf(receipt.forkId)),
      };
      const done = await kit.runtimeHandoff({ sourceId: tid, before, turns, adapter, fail, wantedEffort: wanted ?? (nativeEffort ? answer => (nativeEffort.levels.includes(answer?.reasoningEffort) ? null : nativeEffort.fallback) : inheritEffort ? answer => (answer?.model === before.model ? before.reasoningEffort : null) : null) });
      const continuation = { fromThreadId: tid, fromProvider: before.modelProvider ?? null, fromModel: before.model ?? null, toThreadId: done.created, transferredTurns: done.transfer.report.turns, omitted: done.transfer.report.omitted,
        ...(ctx ? { logicalThreadId: ctx.logical } : {}) };
      const answered = toClaude ? { ...done.answer, thread: this.claudeTarget.thread(done.created) } : kit.overlayHistory('thread/resume', {}, done.answer, done.transfer.turns) ?? done.answer;
      return { ...(route ? this.result(answered, route) : answered), bridgeContinuation: continuation, ...(announce ? { bridgeSettings: announce } : {}) };
    } finally {
      release();
      if (!ctx && !this.switching.size) { this.releaseHeld(); this.provisional.clear(); } // an explicit fork decides here; a conversation switch decides in request()
    }
  }
  // Every new custom-provider thread (a desktop start and a hand-off target alike) is created with the read-only history namespace beside the
  // dynamic tools the request already carried (the reserved-namespace guard is the kit's). Without the kit (a router used on its own) nothing is added.
  historyTools(params) { return this.continuity?.withHistoryTools ? this.continuity.withHistoryTools(params) : params; }
  // The start parameters of the new thread: exactly the source's workspace and permissions, nothing broader.
  startBase(overrides, before) {
    const modes = { readOnly: 'read-only', workspaceWrite: 'workspace-write', dangerFullAccess: 'danger-full-access' };
    const profile = before.activePermissionProfile?.id, mode = modes[before.sandbox?.type];
    if (!profile && !mode) fail('native_permissions_changed');
    const extra = Object.fromEntries(['serviceTier', 'baseInstructions', 'developerInstructions'].filter(k => overrides[k] != null).map(k => [k, overrides[k]]));
    // The SOURCE's confirmed workspace roots are asked for explicitly (never more, never inferred): without them native would give the new thread only its own default.
    // What the new thread reports back is still compared with them (permissionsKept).
    return { ...extra, cwd: before.cwd ?? before.thread.cwd, ...(workspaceRoots(before) ? { runtimeWorkspaceRoots: [...before.runtimeWorkspaceRoots] } : {}), ...(before.approvalPolicy != null ? { approvalPolicy: before.approvalPolicy } : {}),
      ...(before.approvalsReviewer != null ? { approvalsReviewer: before.approvalsReviewer } : {}), ...(profile ? { permissions: profile } : { sandbox: mode }) };
  }
  // The link that replaces ctx.link (or the first one). It carries the whole chain of earlier physical IDs, the recorded rollout paths this
  // conversation owns (identity hints the desktop may echo back) and, from the FIRST hop only, a snapshot of the origin thread's own identity
  // (title including null, creation, path, ancestry) so the conversation can still be listed if native no longer lists the origin.
  nextLink(ctx, id, path, before, model, { kind, connectionId, privateId }) {
    const old = ctx.link, thread = before?.thread;
    // Nothing of the origin is shortened to fit: a link that cannot hold it is refused by the capacity check (link_capacity_reached).
    // A later hop refreshes the TITLE from the thread being left (a rename of the conversation lives on its current thread), never with the private label.
    const origin = old ? (old.origin && thread?.name != null && !(thread.name === PRIVATE_NAME && this.isPrivate(old, thread.id)) ? { ...old.origin, name: thread.name } : old.origin)
      : Number.isFinite(thread?.createdAt) ? { ...Object.fromEntries(ORIGIN_FIELDS.filter(k => thread[k] !== undefined).map(k => [k, thread[k]])), name: thread.name ?? null, originKnown: true } : undefined;
    const paths = [old?.path, ...(old?.paths ?? [])].filter(p => typeof p === 'string');
    return { version: 1, logicalId: ctx.logical, physicalId: id, kind, ...(connectionId ? { connectionId } : {}), model, previous: old ? [old.physicalId, ...(old.previous ?? [])] : [ctx.logical],
      path: path ?? null, ...(paths.length ? { paths } : {}), ...(origin ? { origin } : {}), ...(privateId ? { private: [privateId] } : {}), archived: false }; // the person is switching it: it is active
  }
  ownedPaths(link) { return new Set([link?.origin?.path, link?.path, ...(link?.paths ?? [])].filter(p => typeof p === 'string' && p !== '')); }
  removeRoute(tid) { try { unlinkSync(join(this.root, 'local-routes', tid + '.json')); } catch { /* nothing was written */ } }
  // ---- One logical conversation, several physical runtime threads ------------------------------------------------
  // The conversation keeps the ID the desktop knows (the logical ID). A provider change inside it starts a NEW physical
  // thread (thread/start + plain items; never a fork, never a claimed native ancestry) and records the link
  // logical -> physical here. Every request for the logical ID goes to its physical thread, and every answer,
  // notification and server request from that thread is shown under the logical ID.
  linkPath(logical) { return join(this.root, 'local-routes', 'links', logical + '.json'); }
  readLink(logical, opts = {}) {
    if (!threadId(logical)) return null;
    // A missing link is null. An existing link that is unreadable or malformed is an explicit failure: the conversation
    // must never fall back to its old provider (which would be a silent, wrong continuation).
    // The approved text for every unreadable-link case is the same; the code keeps naming the actual cause.
    const unreadable = error => Object.assign(new Error(providerMessages.link_invalid), { code: error.code ?? 'link_invalid' });
    let value;
    // `ignoreIntent` is for callers that already settled the intent (routing a read from the intent's old link, listing): the legacy
    // `.uncertain` guard still applies to them.
    try {
      if (!opts.ignoreIntent) this.assertCertain(this.linkPath(logical)); else if (existsSync(this.linkPath(logical) + '.uncertain')) fail('route_publication_uncertain');
      value = readPrivate(this.linkPath(logical), 8192);
    } catch (error) { throw unreadable(error); }
    if (value === null) return null;
    if (!(value?.version === 1 && value.logicalId === logical && threadId(value.physicalId) && ['custom', 'native', 'claude'].includes(value.kind)
      && (value.previous === undefined || Array.isArray(value.previous) && value.previous.every(threadId))
      && (value.origin === undefined || object(value.origin)) && (value.path === undefined || value.path === null || typeof value.path === 'string')
      && (value.paths === undefined || Array.isArray(value.paths) && value.paths.every(p => typeof p === 'string'))
      && (value.private === undefined || Array.isArray(value.private) && value.private.every(threadId))
      && (value.archived === undefined || typeof value.archived === 'boolean'))) throw unreadable({ code: 'link_invalid' });
    return value;
  }
  // An atomic replace: a reader sees the old link or the new one. `previous` is the link this one replaces (kept if the
  // outcome turns out uncertain, so the last known valid link can be restored).
  writeLink(link, previous = null) {
    this.ensureDirs('links');
    this.publish(join(this.root, 'local-routes', 'links'), link.logicalId + '.json', link, 'replace', previous);
  }
  // Every link on disk RIGHT NOW: logical -> link, and physical -> logical for the CURRENT physical thread and every earlier one
  // in its chain. Disk is the only authority and nothing is cached: another controller (a second router, a restart) may commit a
  // link at any moment, and routing, notifications and listing must follow it at once. Few links exist, so this stays cheap.
  // Intents are honoured here: while a link is being committed (phase `committing`) the OLD link is what is shown and routed for reads,
  // and every child named by an intent is `hidden` (never a chat of its own, never shown as the new model) until its link is accepted.
  // `tolerant` (notifications and server requests only) does not throw on a damaged link or intent: it records it in `corrupt` with its raw text, so a
  // caller can tell which thread IDs are PROVABLY tied to it (the text names them) and fail closed for exactly those, while every other chat goes on.
  index({ tolerant = false } = {}) {
    const links = new Map(), hidden = new Set(), corrupt = [], dir = join(this.root, 'local-routes', 'links'); let names = [];
    try { names = readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const rawText = name => readPrivateText(join(dir, name), 65536); // guarded and bounded like every other private read
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let link;
      try { link = this.readLink(name.slice(0, -5), { ignoreIntent: true }); } // a corrupt link fails explicitly here too
      catch (error) { if (!tolerant) throw error; corrupt.push({ logical: name.slice(0, -5), text: rawText(name) }); continue; }
      if (link) links.set(link.logicalId, link);
    }
    for (const name of names) {
      if (!name.endsWith('.intent')) continue;
      let intent = null; try { intent = readPrivate(join(dir, name), 65536); } catch { if (tolerant) corrupt.push({ logical: name.slice(0, -7), text: rawText(name) }); continue; } // an unreadable intent blocks requests elsewhere; it cannot name a child here
      if (!object(intent)) continue;
      if (typeof intent.child?.id === 'string') { hidden.add(intent.child.id); this.childOwner.set(intent.child.id, typeof intent.logical === 'string' ? intent.logical : name.slice(0, -7)); }
      // The conversation whose link is the commit file: a compound handoff names it; a plain link publication is `links/<key>.json`.
      const logical = typeof intent.logical === 'string' ? intent.logical : intent.commit?.file === 'local-routes/links/' + intent.key + '.json' ? intent.key : null;
      if (logical && intent.phase === 'committing') { if (intent.commit?.old) links.set(logical, intent.commit.old); else links.delete(logical); }
    }
    const physicals = new Map();
    for (const link of links.values()) for (const physical of [link.physicalId, ...(link.previous ?? [])]) if (physical !== link.logicalId) physicals.set(physical, link.logicalId);
    // What this process has seen of which conversation owns which child is kept ONLY to refuse (never to route): once a link turns unreadable, a child
    // seen earlier under it is still known to belong to it, though the damaged file no longer says so.
    for (const link of links.values()) for (const physical of [link.physicalId, ...(link.previous ?? [])]) if (physical !== link.logicalId) this.childOwner.set(physical, link.logicalId);
    return { links, physicals, hidden, corrupt, ambiguous: id => corrupt.some(c => c.logical === id || c.logical === this.childOwner.get(id) || (typeof id === 'string' && c.text.split(/[^A-Za-z0-9_-]+/).includes(id))) };
  }
  logicalOf(id) { return threadId(id) ? this.index().physicals.get(id) ?? id : id; }
  // Replaces the physical ID by the logical ID at the protocol's own thread-identity positions ONLY: a request or
  // notification's top-level threadId and an answer's thread.id / thread.sessionId. Everything else (turns, items, tool
  // arguments and results, user text) is business data whose bytes are never touched, even if it contains the same string.
  toLogical(value, physical, logical) {
    if (physical === logical || !object(value)) return value;
    const out = { ...value };
    if (out.threadId === physical) out.threadId = logical;
    if (object(out.thread)) {
      out.thread = { ...out.thread };
      for (const key of ['id', 'sessionId']) if (out.thread[key] === physical) out.thread[key] = logical;
    }
    return out;
  }
  // The thread/list rows of a conversation: earlier physical threads are hidden, and the conversation's row shows the
  // model, provider, effort and activity of its CURRENT physical thread when that row is in the same page.
  // This maps ONE complete set of rows; request('thread/list') feeds it the whole filtered native listing (see listThreads), never a single
  // page, so a conversation is never lost or shown with its old provider because its rows fell on different pages.
  canonicalList(data) {
    const byId = new Map(data.map(t => [t?.id, t])), { links, physicals, hidden } = this.index(); // one read of the current links for the whole page
    return data.filter(t => !physicals.has(t?.id) && !hidden.has(t?.id) && !this.abandoned?.has(t?.id)).map(t => {
      const link = links.get(t?.id), live = link && byId.get(link.physicalId);
      return live ? withLive(t, live) : t;
    });
  }
  // thread/list for a Bridge that has linked conversations (or children not yet accepted). Native lists PHYSICAL threads; the desktop must
  // see CONVERSATIONS. So the filtered native listing is read to its end (bounded: over the cap is an explicit failure, never a quietly
  // partial list), folded into conversations (original ID/title/creation/ancestry, the current physical thread's model, provider, effort
  // and activity), and only then filtered by logical provider, sorted and paged with cursors Bridge issues itself. Nothing is written.
  async listThreads(params, forward) {
    params = object(params) ? params : {};
    const { links, physicals, hidden } = this.index();
    if (!links.size && !hidden.size && !this.abandoned?.size) return this.dispatch('thread/list', params, forward); // nothing aliased: native's own pages
    const invalid = code => fail(code); // the approved list copy, at the actual throw site
    const { cursor, limit, modelProviders, ...native } = params;
    if (limit != null && !(Number.isInteger(limit) && limit > 0)) throw invalid('invalid_limit');
    if (modelProviders != null && !(Array.isArray(modelProviders) && modelProviders.every(p => typeof p === 'string'))) throw invalid('invalid_model_providers');
    const stable = value => JSON.stringify(value, (k, v) => object(v) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
    const filterKey = hash(stable({ ...native, modelProviders: modelProviders ?? null })).slice(0, 16); // a cursor only continues the listing it came from
    let after = null;
    if (cursor != null) {
      const match = typeof cursor === 'string' && /^bridge-list:([A-Za-z0-9_-]{1,1024})$/.exec(cursor); let value = null;
      try { value = match ? JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) : null; } catch { /* not ours */ }
      if (!object(value) || value.f !== filterKey || typeof value.id !== 'string' || !Number.isFinite(value.v)) throw invalid('invalid_cursor'); // never guessed at
      after = value;
    }
    // A parent/ancestor/attachment named by the conversation's ID is asked for under every physical ID of its chain, then merged.
    let variants = [native];
    for (const key of ['parentThreadId', 'ancestorThreadId', 'attachedToThreadId']) {
      const value = native[key], logical = typeof value === 'string' ? (links.has(value) ? value : physicals.get(value)) : undefined, link = logical && links.get(logical);
      if (link) variants = [...new Set([logical, link.physicalId, ...(link.previous ?? [])])].map(chainId => ({ ...native, [key]: chainId }));
    }
    const fetchRows = async variantList => {
      const found = [], seen = new Set();
      for (const variant of variantList) {
        const cursors = new Set(); let next, pages = 0;
        do {
          if (++pages > LIST_PAGES) fail('thread_list_too_large');
          const answer = await this.dispatch('thread/list', { ...variant, limit: LIST_PAGE, ...(next ? { cursor: next } : {}) }, forward); // modelProviders is applied below, to the LOGICAL provider
          if (!object(answer) || !Array.isArray(answer.data)) fail('thread_list_unreadable');
          for (const row of answer.data) if (object(row) && typeof row.id === 'string' && !seen.has(row.id)) { seen.add(row.id); found.push(row); }
          if (found.length > LIST_CAP) fail('thread_list_too_large');
          next = typeof answer.nextCursor === 'string' && answer.nextCursor ? answer.nextCursor : null;
          if (next && cursors.has(next)) fail('thread_list_unreadable'); if (next) cursors.add(next);
        } while (next);
      }
      return found;
    };
    const rows = await fetchRows(variants);
    const byId = new Map(rows.map(t => [t.id, t])), conversations = [];
    // A conversation whose ORIGIN thread native no longer lists (an old unmaterialized host after a cold start) is still the person's chat: it is
    // rebuilt from the origin snapshot recorded in its link, with the current thread's runtime on top. Membership follows its current thread
    // (which carries the shared filters); a title search is matched against the ORIGIN title, never the private name of the current thread.
    const absent = [...links.values()].filter(link => !byId.has(link.logicalId) && !hidden.has(link.logicalId) && !this.abandoned?.has(link.logicalId) && !native.excludedThreadIds?.includes(link.logicalId));
    // Membership of such an origin is decided from what is VERIFIED: its recorded identity (title, direct parent) and whether its current thread passes
    // every other filter native applies (archived, cwd, source kinds ...). A filter that neither can decide (a section or project assignment, an ancestor
    // or an attachment of an origin native no longer lists) is an explicit failure, never a partial view presented as complete.
    // A conversation whose origin native DOES list but left out of this view is simply not in it (native decided, whatever the filter); only an origin
    // native does not list at all needs rebuilding, and only that can need a filter native cannot answer for it.
    const undecided = ['sectionId', 'projectId', 'ancestorThreadId', 'attachedToThreadId'].filter(k => native[k] !== undefined);
    let wide = byId, wideRows = false;
    if (absent.length && (native.searchTerm != null || native.parentThreadId != null || undecided.length)) {
      const { searchTerm, parentThreadId, sectionId, projectId, ancestorThreadId, attachedToThreadId, ...unnarrowed } = native;
      wide = new Map((await fetchRows([unnarrowed])).map(t => [t.id, t])); wideRows = true;
    }
    const synthesized = [], liveFor = new Map(); let anywhere = null;
    // A runtime child may be of another source kind than its conversation (an original CLI chat continued on a vscode host): the child's OWN kind never decides the
    // conversation's membership (the origin's recorded source does), so its lookups name every documented kind and keep every shared filter (archived, cwd ...).
    // (Only an explicit, non-empty list can leave a child out for its kind: the default interactive view asks native exactly what it always asked.)
    const explicitKinds = Array.isArray(native.sourceKinds) && native.sourceKinds.length > 0;
    const everywhere = async () => anywhere ??= new Map((await fetchRows([explicitKinds ? { sourceKinds: SOURCE_KINDS } : {}])).map(t => [t.id, t]));
    let filteredAnyKind = null;
    const anyKind = async () => {
      if (!explicitKinds) return new Map();
      if (!filteredAnyKind) { const { searchTerm, parentThreadId, sectionId, projectId, ancestorThreadId, attachedToThreadId, ...shared } = native; filteredAnyKind = new Map((await fetchRows([{ ...shared, sourceKinds: SOURCE_KINDS }])).map(t => [t.id, t])); }
      return filteredAnyKind;
    };
    const readLive = async link => { try { const read = await this.dispatch('thread/read', { threadId: link.physicalId }, forward); return object(read?.thread) ? read.thread : null; } catch { return null; } };
    for (const link of absent) {
      if (wideRows && wide.has(link.logicalId)) continue; // listed by native, and excluded by native itself
      const origin = link.origin; if (!object(origin)) fail('thread_list_unreadable'); // an owned conversation with no recorded origin is never invented, never silently dropped
      // The documented source-kind filter is decided by the ORIGIN's own recorded source (never the new runtime child's, whose kind may differ); what that cannot decide is refused.
      if (!sourceSelected(origin.source, native.sourceKinds)) continue;
      if (undecided.some(k => k !== 'projectId') || (native.projectId !== undefined && !('projectId' in origin))) fail('thread_list_unreadable'); // an unlisted origin's section, ancestors or attachments are unknown
      if (native.projectId !== undefined && origin.projectId !== native.projectId) continue; // the recorded project assignment decides
      let current = wide.get(link.physicalId) ?? byId.get(link.physicalId) ?? (await anyKind()).get(link.physicalId);
      if (!current) {
        // Not in the filtered listing. If native lists it at all, the shared filters excluded it. If native does NOT enumerate it (a new private child is
        // not listed before its first turn, whatever its metadata), its own read is the evidence; what that cannot prove is refused, never assumed.
        if ((await everywhere()).has(link.physicalId)) continue;
        current = await readLive(link); if (!current) fail('thread_list_unreadable');
        // Native does not enumerate it, so native cannot place it in the active or the archived view: the archive state Bridge recorded in the link does. A link that
        // never recorded one cannot be placed, and is refused rather than assumed active.
        if (typeof link.archived !== 'boolean') fail('thread_list_unreadable');
        if (link.archived !== (native.archived === true)) continue;
        if (native.cwd != null && !(Array.isArray(native.cwd) ? native.cwd : [native.cwd]).includes(current.cwd)) continue;
      }
      liveFor.set(link.logicalId, current);
      if (native.parentThreadId != null) { if (!('forkedFromId' in origin)) fail('thread_list_unreadable'); if (origin.forkedFromId !== native.parentThreadId) continue; }
      if (native.searchTerm != null && !(typeof origin.name === 'string' && origin.name.toLowerCase().includes(String(native.searchTerm).toLowerCase()))) continue;
      synthesized.push(link);
    }
    for (const t of [...rows, ...synthesized.map(link => ({ synthesizedFrom: link }))]) {
      const link0 = t.synthesizedFrom;
      if (!link0 && (physicals.has(t.id) || hidden.has(t.id) || this.abandoned?.has(t.id))) continue; // a physical thread of a conversation is not a chat of its own
      let row = t; const link = link0 ?? links.get(t.id);
      if (link) {
        let live = liveFor.get(link.logicalId) ?? (link0 ? wide : byId).get(link.physicalId) ?? byId.get(link.physicalId);
        if (!live) live = await readLive(link); // filtered out of the listing (e.g. by a title search), or not enumerated by native at all
        if (!live) fail('thread_list_unreadable'); // never the old provider's row presented as current
        if (link0) { if (!live) fail('thread_list_unreadable'); const { originKnown, ...identity } = link.origin; row = withLive({ ...live, ...identity, id: link.logicalId }, live); }
        else if (live) row = withLive(row, live);
      }
      // A genuine native fork of one physical thread descends from the conversation; Bridge never invents ancestry for a thread/start.
      if (row.forkedFromId != null && physicals.has(row.forkedFromId)) row = { ...row, forkedFromId: physicals.get(row.forkedFromId) };
      conversations.push(row);
    }
    const wanted = modelProviders?.length ? new Set(modelProviders) : null, shown = wanted ? conversations.filter(row => wanted.has(row.modelProvider)) : conversations;
    const field = { created_at: 'createdAt', updated_at: 'updatedAt' }[native.sortKey ?? 'created_at'], sign = field && native.sortDirection !== 'asc' ? -1 : 1;
    const decorated = shown.map((row, i) => ({ row, id: row.id, v: field ? (Number.isFinite(row[field]) ? row[field] : 0) : i })); // an unknown sort key keeps native's own order
    const order = (a, b) => sign * (a.v - b.v) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    decorated.sort(order);
    const start = after ? decorated.findIndex(d => order(d, after) > 0) : 0, size = limit ?? LIST_PAGE;
    const page = start < 0 ? [] : decorated.slice(start, start + size), more = start >= 0 && start + size < decorated.length, last = page.at(-1);
    return { data: page.map(d => d.row), nextCursor: more ? 'bridge-list:' + Buffer.from(JSON.stringify({ f: filterKey, v: last.v, id: last.id })).toString('base64url') : null, backwardsCursor: null };
  }
  // The thread (as the desktop names it) a notification or request is about, and the thread that actually runs it.
  physicalOf(logical) { return threadId(logical) ? this.index().links.get(logical)?.physicalId ?? logical : logical; }
  // How the desktop may see a notification: null when it must not be shown (held while a switch is in flight, a child that is not yet
  // accepted or was abandoned), otherwise the params under the conversation's logical ID.
  desktopView(method, params) {
    const id = params?.threadId ?? params?.thread?.id;
    this.noticeHistory(method, params); // the RAW physical notice first: before any logical mapping, hold or drop
    try {
      // Bridge's OWN private label write is settled FIRST, by runtime ID and its pending write, before any generic hold or provisional suppression can queue
      // or drop it: the write happens while the child is still provisional, and a pending count left behind would swallow a person's later "New chat".
      if (method === 'thread/name/updated' && typeof id === 'string' && this.consumeOwnWrite(id, params?.threadName)) return null;
      if (this.abandoned?.has(id) || this.holds(method, params)) return null;
      if (typeof id !== 'string') return params;
      // Disk is the authority and a damaged link or intent does not silence unrelated chats: only an ID that is a known unaccepted child, or that the
      // damaged record itself names (so its identity cannot be proven), is withheld. Anything unexpected also withholds: never a raw physical ID.
      const idx = this.index({ tolerant: true });
      if (idx.hidden.has(id) || idx.ambiguous(id)) return null;
      if (method === 'thread/name/updated' && typeof params?.threadName === 'string') {
        // Any other rename of the conversation's current thread (or of the conversation itself) is a genuine rename: shown, and it is the new title.
        const link = [...idx.links.values()].find(l => l.physicalId === id || l.logicalId === id);
        if (link) { try { this.recordTitle(link, params.threadName, link.physicalId === id ? id : null); } catch { /* the in-memory end of the marker stands; the request path reports failures */ } }
      }
      if (method === 'thread/archived' || method === 'thread/unarchived') {
        const link = [...idx.links.values()].find(l => l.physicalId === id || l.logicalId === id);
        if (link) { try { this.recordArchived(link, method === 'thread/archived'); } catch { /* the request path reports failures */ } }
      }
      const logical = idx.physicals.get(id);
      // An EARLIER runtime thread of a conversation speaks for a model the conversation has left: its settings are history. Shown under the conversation's ID they would
      // overwrite the desktop's current model, provider and mode with stale ones, so only the CURRENT physical thread's settings are ever passed on.
      if (method === 'thread/settings/updated' && logical && idx.links.get(logical)?.physicalId !== id) return null;
      // The conversation's first runtime thread carries the conversation's own ID: once the conversation lives on another thread, a settings event under that ID can only be
      // the router's own announcement (marked while it is sent) or the old thread speaking for a model the conversation has left.
      if (method === 'thread/settings/updated') { const own = idx.links.get(id); if (own && own.physicalId !== id && params?.threadSettings !== this.announcing) return null; }
      return logical ? this.toLogical(params, id, logical) : params;
    } catch { return null; }
  }
  // While a switch is in flight, notifications that could expose a provisional child (a new chat, a new model) are HELD, then released
  // in order after the outcome, minus everything about the child. Nothing about an unaccepted runtime reaches the desktop.
  holds(method, params) {
    const id = params?.threadId ?? params?.thread?.id;
    if (this.provisional?.has(id)) { if (method === 'thread/settings/updated' && object(params?.threadSettings)) this.captureSettings(id, params.threadSettings); this.held.push({ method, params }); return true; }
    if (!this.switching.size || !HELD_METHODS.has(method) || this.switchIds.has(id)) return false;
    this.held.push({ method, params }); return true;
  }
  releaseHeld() {
    const held = this.held.splice(0);
    for (const { method, params } of held) {
      const id = params?.threadId ?? params?.thread?.id;
      if (this.provisional.has(id) || this.abandoned?.has(id)) continue;
      try { this.notify(method, params); } catch { /* a listener failure must not undo a decided switch */ }
    }
  }
  // For the Bridge: a notification or server request params object, shown under the conversation's logical ID.
  // A server request (an approval, a tool call) is only ever forwarded under an identity that is PROVEN: a provisional or unaccepted child, or an ID tied to a
  // damaged link, is refused explicitly BEFORE anything is asked of the desktop; it is never passed on as a raw physical ID or as another chat.
  toLogicalParams(params) {
    const physical = params?.threadId; if (typeof physical !== 'string') return params;
    if (this.provisional?.has(physical)) fail('model_change_pending');
    let idx; try { idx = this.index({ tolerant: true }); } catch { fail('link_invalid'); }
    if (this.abandoned?.has(physical) || idx.hidden.has(physical)) fail('route_publication_uncertain');
    if (idx.ambiguous(physical)) fail('link_invalid');
    const logical = idx.physicals.get(physical);
    return logical && logical !== physical ? this.toLogical(params, physical, logical) : params;
  }
  classify(requested, nativeOwned) {
    if (typeof requested !== 'string') return null;
    if (isClaudeModel(requested)) return { kind: 'claude' };
    if (requested.startsWith(localPrefix) && !nativeOwned) {
      const s = this.registry.all().find(x => requested.startsWith(localPrefix + x.connectionId + '/'));
      return s ? { kind: 'custom', connectionId: s.connectionId } : null;
    }
    return { kind: 'native' };
  }
  // Does this request ask for a provider the conversation's current physical thread cannot serve by itself?
  needsSwitch(current, target) {
    if (!target) return false;
    if (target.kind === 'custom') return !(current.kind === 'custom' && current.connectionId === target.connectionId);
    // A managed chat whose native host is on the claude_code provider while the app-server is configured for another one (`stranded`) cannot be loaded in place
    // (native binds a thread to its provider): it continues as a NEW neutral Claude chat under the same conversation (the existing hand-off), never a same-ID resume.
    if (target.kind === 'claude') return current.kind === 'custom' || (current.kind === 'native' && current.linked) || (current.kind === 'claude' && current.stranded === true);
    return current.kind === 'custom' || (current.kind === 'claude' && (current.legacyHost === true || current.sdkHost === true)); // native target
  }
  async request(method, params, forward) {
    const logical = params?.threadId, kit = this.continuity;
    if (method === 'thread/list') return this.listThreads(params, forward); // conversations, not physical threads (see listThreads)
    if (!kit || !threadId(logical)) return this.dispatch(method, params, forward);
    // While a provider switch of this conversation is in flight (here or in another controller), anything that could change
    // the conversation is refused, so the snapshot the switch carries cannot go stale and no late mutation reaches the old runtime.
    // Reads and interrupt are safe and stay available.
    if (!SWITCH_SAFE.has(method) && this.switchPending(logical)) fail('model_change_pending');
    // An unresolved intent for this conversation: recovered in the abort direction only; anything that may have been committed blocks
    // every mutation (route_publication_uncertain) while reads keep using the OLD link, so history stays honest and viewable.
    const gate = await this.settleIntent(logical);
    if (gate.blocked && !SWITCH_SAFE.has(method)) fail('route_publication_uncertain');
    let link = gate.blocked || gate.oldLink !== undefined ? gate.oldLink ?? null : this.readLink(logical, { ignoreIntent: !!gate.intent });
    // The desktop echoes back the rollout path a list or read returned (the conversation's origin path) when it reopens or forks. A path this
    // conversation recorded as its own (origin, current or earlier physical thread) is only an identity hint: it is dropped here, so the CURRENT
    // thread is addressed and no earlier history is ever loaded in its place. Any other path, and any history, stays refused.
    const ownEcho = () => {
      if (link && (params.history != null || (params.path != null && params.path !== ''))) {
        if (params.history != null || typeof params.path !== 'string' || !this.ownedPaths(link).has(params.path)) fail('alternate_history_refused');
        const { path: echoed, ...withoutPath } = params; params = withoutPath;
      }
    };
    ownEcho();
    // INITIAL OPEN of an old managed chat whose native host thread is on the claude_code provider while the app-server is configured for another one: native binds a
    // thread to its provider, so the host cannot be resumed in place (no same-ID resume, no provider override is guessed, the owner is never asked the wrong thing).
    // Opening (thread/resume) or continuing it with a Claude turn therefore continues the SAME conversation on a NEW neutral Claude chat through the existing hand-off
    // (the old record is only read, its visible history is carried whole and once, nothing is loaded or marked loaded that is not). Read and list never get here.
    const legacy = !link && ['thread/resume', 'thread/settings/update', 'turn/start'].includes(method) && this.managed(logical) && !this.readRoute(logical) ? this.managedSource?.(logical) : null;
    let stranded = false, wrongOwner = false;
    if (legacy?.legacyHost === true) {
      const asked = params.collaborationMode?.settings?.model ?? params.model;
      const configured = async () => (await forward('config/read', { ...(typeof params.cwd === 'string' ? { cwd: params.cwd } : {}), includeLayers: false }))?.config?.model_provider;
      if (asked == null || isClaudeModel(asked)) {
        const provider = await configured();
        stranded = typeof provider === 'string' ? provider !== 'claude_code' : true;
      } else if (method === 'thread/resume') wrongOwner = true; // a GPT (or custom) target asked on the open of a legacy host: never the main resume of the old host; the existing new-physical-thread hand-off, or a refusal
      // An explicit provider is only ever the one the target itself is (what Bridge shows for a Claude chat, the configured one for GPT): anything else is a foreign override, refused before anything is created.
      if ((stranded || wrongOwner) && params.modelProvider != null && params.modelProvider !== (stranded ? 'claude_code' : await configured())) fail('provider_override_refused');
    }
    // An open that names a model of another runtime is a switch like any other: it takes the same guarded hand-off (or its refusal), never Bridge's in-place flip.
    const resumeAsks = method === 'thread/resume' && typeof (params.collaborationMode?.settings?.model ?? params.model) === 'string';
    if (['thread/settings/update', 'turn/start'].includes(method) || resumeAsks || stranded || wrongOwner) {
      const requested = params.collaborationMode?.settings?.model ?? params.model ?? (stranded ? legacy.snapshot.model : undefined), source = link?.physicalId ?? logical;
      const route = this.readRoute(source), managed = this.managed(source);
      const owned = typeof requested === 'string' && requested.startsWith(localPrefix) && !route ? await this.nativeOwns(requested) : false;
      const target = this.classify(requested, owned);
      // A managed chat is classified by what it actually is: `legacyHost` marks an old chat whose native host thread lives on the
      // non-executing claude_code provider (it cannot be moved to a GPT model in place; see legacyClaudeHost in providers.mjs).
      const current = route ? { kind: 'custom', connectionId: route.connectionId } : managed ? { kind: 'claude', legacyHost: this.managedSource?.(source)?.legacyHost === true, sdkHost: this.managedSource?.(source)?.sdkHost === true, stranded } : { kind: 'native', linked: !!link };
      if (this.needsSwitch(current, target)) {
        if (this.switching.has(logical)) fail('model_change_pending');
        if (gate.intent) fail('route_publication_uncertain'); // an unresolved earlier handoff (e.g. archive_pending) forbids another: no blind retry
        this.switching.add(logical); this.switchIds.add(logical); this.switchIds.add(link?.physicalId ?? logical);
        let release = () => {};
        try {
          release = this.routeLock(logical, '.switch'); // across controllers: one switch of a conversation at a time
          link = this.readLink(logical); // under the lock: the link as it really is now
          // The rollout path an opening desktop echoes is the old chat's own (identity hint only): it is not an alternate history source.
          const { path: echoed, ...unechoed } = params, offered = (stranded || wrongOwner) && echoed != null && echoed === legacy.snapshot.thread?.path ? unechoed : params;
          const done = await this.crossFork({ ...offered, threadId: link?.physicalId ?? logical }, this.readRoute(link?.physicalId ?? logical), requested, target.kind === 'custom', forward, { logical, link });
          if (!done) fail('cross_provider_switch_requires_new_thread');
          const settings = done.bridgeSettings; if (!settings) fail('native_selection_not_confirmed'); // (never reduced: see settingsFor)
          // An open carries its settings in its own answer; every other change announces them.
          if (method !== 'thread/resume') { this.announcing = settings; try { this.notify('thread/settings/updated', { threadId: logical, threadSettings: settings }); } finally { this.announcing = null; } }
          if (method === 'thread/settings/update') return {};
        } finally {
          release(); this.switching.delete(logical); this.switchIds.delete(logical);
          if (!this.switching.size) { this.releaseHeld(); this.provisional.clear(); this.switchIds.clear(); }
        }
        link = this.readLink(logical); // the turn that asked for the new model now runs on it
        ownEcho(); // the rollout path the desktop echoes back is the conversation's own origin path: an identity hint, dropped like any other
      }
    }
    if (!link) return this.dispatch(method, params, forward);
    const physical = link.physicalId, answer = await this.dispatch(method, { ...params, threadId: physical }, forward);
    // The conversation is archived, unarchived or renamed as a whole: its earlier physical thread follows, best effort.
    if (['thread/archive', 'thread/unarchive', 'thread/name/set'].includes(method)) await this.dispatch(method, params, forward).catch(() => {});
    if (method === 'thread/archive' || method === 'thread/unarchive') this.recordArchived(link, method === 'thread/archive');
    if (method === 'thread/name/set') this.recordTitle(link, params.name, physical); // a person's rename: the private label is gone, whatever the words, and the title is the conversation's
    return this.maskPrivate(this.toLogical(answer, physical, logical), link, physical);
  }
  // The private label of an empty child is never the conversation's title: while it is still the child's name, the conversation shows its own (null included).
  // Masked only for a host Bridge ITSELF named privately (its runtime ID is in the accepted link's `private` marker) and only while no other write has
  // renamed it: the words alone prove nothing, so a person's own "New chat" title is an ordinary title.
  isPrivate(link, id) { return !!link?.private?.includes(id) && !this.unmasked.has(id); }
  maskPrivate(answer, link, physical) {
    return this.isPrivate(link, physical) && object(answer) && object(answer.thread) && answer.thread.name === PRIVATE_NAME ? { ...answer, thread: { ...answer.thread, name: link?.origin?.name ?? null } } : answer;
  }
  // The conversation's archive state, as the person (or native) last set it THROUGH Bridge, recorded in the same accepted link. Native does not report it on a
  // thread and may not enumerate a private child at all, so a conversation native does not list is placed in the active or the archived view by THIS record
  // (a link that never recorded it is refused in that situation, never assumed active).
  recordArchived(link, archived) {
    const current = this.readLink(link.logicalId); if (!current || current.archived === archived) return;
    const next = { ...current, archived };
    if (Buffer.byteLength(JSON.stringify(next)) > LINK_MAX) fail('link_capacity_reached');
    this.writeLink(next, current);
  }
  // Bridge's own pending private-label write, by runtime ID (not by text): its single echo is the only name event that is hidden.
  // One pending record per private write, scoped by runtime ID and the write itself. Native may deliver the echo BEFORE the answer, AFTER it, or late (the
  // notification callback runs on its own): so the answer alone proves nothing, and the new child stays unpublished (and provisional) until THIS write's echo has
  // really been seen at the notification path (consumeOwnWrite) or the bounded wait ends. `settle` always removes whatever is still pending, so no counter is ever
  // left behind to swallow a later, genuine event. The wait is a promise resolved BY the notification path: nothing waits inside a notification callback.
  expectOwnWrite(id) {
    let resolve; const echoed = new Promise(r => { resolve = r; }), entry = { resolve, seen: false };
    this.ownWrites.set(id, [...(this.ownWrites.get(id) ?? []), entry]);
    const settle = () => { const rest = (this.ownWrites.get(id) ?? []).filter(e => e !== entry); if (rest.length) this.ownWrites.set(id, rest); else this.ownWrites.delete(id); };
    const waitEcho = async () => {
      let timer; const limit = new Promise(r => { timer = setTimeout(() => r(false), this.echoWaitMs); });
      try { if (!(await Promise.race([echoed.then(() => true), limit]))) fail('native_selection_not_confirmed'); } finally { clearTimeout(timer); }
    };
    return { settle, waitEcho };
  }
  consumeOwnWrite(id, name) {
    const entry = name === PRIVATE_NAME ? (this.ownWrites.get(id) ?? []).find(e => !e.seen) : undefined; if (!entry) return false;
    entry.seen = true; entry.resolve();
    const rest = this.ownWrites.get(id).filter(e => e !== entry); if (rest.length) this.ownWrites.set(id, rest); else this.ownWrites.delete(id); return true;
  }
  // A genuine rename of the conversation (by a person through the router, or any other write native reports for its current thread or the conversation) is
  // the conversation's new title: it ends the private marker and becomes the origin title, in ONE write of the same accepted link (the single authority).
  // Called for every such rename, also the second and third. Nothing here runs for a read or a list. A failed write is RETURNED (never swallowed) by the
  // caller that can report it; the in-memory end of the marker stays in force, so a stale mask is never shown from this process.
  recordTitle(link, name, id) {
    if (id && link?.private?.includes(id)) this.unmasked.add(id);
    const current = this.readLink(link.logicalId); if (!current) return;
    const next = { ...current }; let changed = false;
    if (current.origin && (typeof name === 'string' || name === null) && current.origin.name !== name) { next.origin = { ...current.origin, name }; changed = true; }
    if (id && current.private?.includes(id)) { next.private = current.private.filter(x => x !== id); if (!next.private.length) delete next.private; changed = true; }
    if (!changed) return;
    if (Buffer.byteLength(JSON.stringify(next)) > LINK_MAX) fail('link_capacity_reached'); // a title that no longer fits the link's read bound is refused, not cut
    this.writeLink(next, current);
  }
  // What the desktop is told about the conversation's settings after a provider change (the confirmed readback of the new thread).
  // The desktop's own consumer of thread/settings/updated (read from the installed app, early-bootstrap-815-e030c49be4b9c405.js) destructures {threadId, threadSettings} and
  // then, in its state callback, reads `latestCollaborationMode.settings.model` of its PREVIOUS state and `threadSettings.collaborationMode.settings.model` of the
  // INCOMING one, copying model, modelProvider, effort, collaborationMode and cwd into the state. So the event must be the pinned v2 ThreadSettings in full:
  //   disabledPluginIds, cwd, approvalPolicy, approvalsReviewer, sandboxPolicy, activePermissionProfile, model, modelProvider, serviceTier, effort, summary,
  //   collaborationMode {mode, settings {model, reasoning_effort, developer_instructions}}, multiAgentMode, personality.
  // Every value comes from the CONFIRMED readback of the new thread, taken after it was named privately and before anything is committed: a public thread/resume of a native or
  // custom child (its ThreadResumeResponse carries collaborationMode, disabledPluginIds, serviceTier and multiAgentMode, not summary or personality), or the managed Claude chat's own
  // settings view (already the pinned shape). Nothing the person requested or the desktop last saw is claimed as the target's state: a requested mode is APPLIED to the target and
  // must read back (see `settle`), otherwise the switch is refused. What no readback carries comes from the child's own native settings event when it sent one, otherwise it is the
  // contract's nullable null (summary, personality) or its documented constant (multiAgentMode). The mode's MODEL and effort are the target's confirmed ones, never the source's.
  // A readback that cannot prove a required field refuses the switch BEFORE publication (the new thread is withdrawn), so a reduced event can never be sent.
  settingsFor(created, merged, read, route) {
    const text = value => typeof value === 'string' && value !== '', must = (value, ok) => ok(value) ? value : fail('native_selection_not_confirmed');
    const view = object(read) && 'sandboxPolicy' in read && 'collaborationMode' in read ? read : null, src = view ?? { ...merged, ...(object(read) ? read : {}) }, observed = this.childSettings?.get(created);
    const nativeModel = view ? view.model : src.model, model = must(route ? localModelId(route.connectionId, route.model) : nativeModel, text), effort = (view ? view.effort : src.reasoningEffort) ?? null;
    const collab = (view ? view.collaborationMode : src.collaborationMode) ?? observed?.collaborationMode ?? null;
    return {
      disabledPluginIds: must(view ? view.disabledPluginIds : src.disabledPluginIds, Array.isArray), cwd: must(view ? view.cwd : src.cwd ?? src.thread?.cwd, text),
      approvalPolicy: must(view ? view.approvalPolicy : src.approvalPolicy, x => x != null), approvalsReviewer: must(view ? view.approvalsReviewer : src.approvalsReviewer, text),
      sandboxPolicy: must(view ? view.sandboxPolicy : src.sandbox, object), activePermissionProfile: (view ? view.activePermissionProfile : src.activePermissionProfile) ?? null,
      model, modelProvider: must(src.modelProvider, text), serviceTier: src.serviceTier ?? observed?.serviceTier ?? null, effort, summary: view?.summary ?? observed?.summary ?? null,
      collaborationMode: { mode: text(collab?.mode) ? collab.mode : 'default', settings: { model, reasoning_effort: effort, developer_instructions: collab?.settings?.developer_instructions ?? null } },
      multiAgentMode: src.multiAgentMode ?? observed?.multiAgentMode ?? 'explicitRequestOnly', personality: view?.personality ?? observed?.personality ?? null,
    };
  }
  // The child's OWN native settings event, when it sent one while it was still provisional (bounded): the source of what a resume does not expose.
  captureSettings(id, settings) {
    this.childSettings ??= new Map(); this.childSettings.delete(id); this.childSettings.set(id, structuredClone(settings));
    while (this.childSettings.size > 64) this.childSettings.delete(this.childSettings.keys().next().value);
  }
  handoffPath(tid) { return join(this.root, 'local-routes', 'handoffs', tid + '.json'); }
  writeHandoff(tid, value) {
    if (!threadId(tid)) fail('native_thread_identity_invalid');
    this.ensureDirs('handoffs');
    const size = Buffer.byteLength(JSON.stringify(value)); if (size > 6 * 1024 * 1024) fail('handoff_context_too_large');
    this.publish(join(this.root, 'local-routes', 'handoffs'), tid + '.json', value, 'create');
  }
  // Puts a continued chat's carried visible turns in front of what native lists for it (see custom-turns.mjs).
  async carried(method, params, produce) {
    const kit = this.continuity;
    const carried = kit && ['thread/read', 'thread/turns/list', 'thread/items/list', 'thread/resume'].includes(method) ? this.readHandoff(params?.threadId)?.turns : null;
    if (!carried?.length) return produce(params);
    if (method === 'thread/turns/list') return kit.pageTurns(params, carried, page => produce(page));
    if (method === 'thread/items/list') return kit.pageItems(params, carried) ?? produce(params);
    const answer = await produce(params);
    return kit.overlayHistory(method, params, answer, carried) ?? answer;
  }
  ensureDirs(name) {
    rootOk(this.root);
    for (const dir of [join(this.root, 'local-routes'), join(this.root, 'local-routes', name)]) {
      try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      rootOk(dir);
    }
  }
  removeHandoff(tid) { try { unlinkSync(this.handoffPath(tid)); } catch { /* nothing was written */ } }
  // The carried visible turns of a continued chat, or null. Never throws: a damaged sidecar shows no extra turns.
  readHandoff(tid) {
    if (!threadId(tid)) return null;
    // Missing is null (a chat nothing was carried into). Present but unreadable is an explicit failure, never a quietly shorter history.
    this.assertCertain(this.handoffPath(tid));
    const value = readPrivate(this.handoffPath(tid), 6 * 1024 * 1024 + 4096);
    if (value === null) return null;
    if (!(value?.version === 1 && Array.isArray(value.turns))) fail('handoff_history_unreadable');
    return value;
  }
  // In-process birth evidence of custom threads started EMPTY through this router: id -> { peer, connectionId, provider }. It is only ever revoked, never restored.
  get born() { return this.bornMap ??= new Map(); }
  revokeBirth(tid) { this.bornMap?.delete(tid); this.createdSnapshots.delete(tid); }
  // A raw native notice about a thread: anything that is not known to be harmless (birth notice, names, settings, archive state, an idle status, startup status) may be history or a
  // lifecycle change, so it ends the birth evidence (and the unmaterialized-snapshot fallback) BEFORE anything else looks at it.
  noticeHistory(method, params) {
    const id = params?.threadId ?? params?.thread?.id;
    if (typeof id !== 'string' || !(this.bornMap?.has(id) || this.createdSnapshots.has(id))) return;
    const harmless = ['thread/started', 'thread/name/updated', 'thread/settings/updated', 'thread/archived', 'thread/unarchived', 'thread/project/updated', 'mcpServer/startupStatus/updated'];
    if (harmless.includes(method) || (method === 'thread/status/changed' && params?.status?.type === 'idle')) return;
    this.revokeBirth(id);
  }
  // Native's two exact answers for a thread that has no first user message yet (measured on the pinned 0.167): the list is unavailable before materialization / not supported yet.
  // EXACT messages only (the thread's own ID in the first one): a different ID, a prefix or suffix, or any other wording is not this answer.
  unmaterialized(error, tid) {
    const message = typeof error?.message === 'string' ? error.message : null;
    return (error?.code === -32600 && message === 'thread ' + tid + ' is not materialized yet; thread/turns/list is unavailable before first user message') || (error?.code === -32601 && message === 'list_turns is not supported yet');
  }
  // May an unmaterialized answer be read as "no own turns"? Only with the positive evidence: this thread was started EMPTY by this router, on this same owning peer and provider, nothing that
  // could produce history has happened since (any such request or notice revoked the evidence), and native's CURRENT metadata read still says idle, same ID and provider, no turns and readState null.
  async provenFreshEmpty(owner, r, tid, before) {
    const birth = this.bornMap?.get(tid); if (!birth) return false;
    const s = this.connection(r);
    if (birth.peer !== owner || birth.connectionId !== r.connectionId || birth.provider !== this.providerId(s) || before?.modelProvider !== birth.provider || before.thread?.id !== tid || before.thread?.status?.type !== 'idle') return false;
    let read; try { read = await owner.request('thread/read', { threadId: tid }); } catch { return false; }
    // native's ThreadReadResponse is { thread, readState }: readState is TOP LEVEL beside the thread (a Thread has none), and must be present and exactly null.
    const t = object(read) ? read.thread : null;
    return object(read) && Object.hasOwn(read, 'readState') && read.readState === null
      && object(t) && t.id === tid && t.modelProvider === birth.provider && t.status?.type === 'idle' && Array.isArray(t.turns) && t.turns.length === 0
      && this.bornMap?.get(tid) === birth; // and nothing revoked it while that read was in flight
  }
  async sourceSnapshot(r, tid) {
    const s = this.connection(r), peer = await this.nativeForConnection(s, r.model);
    // The same stale-runtime guard as ensureProviderThread, BEFORE any native request: a loaded writer remembered on another model than the committed route is an older runtime (another controller
    // committed a newer selection); it is never read as if it were the current one, never refreshed from the newer route and never switched in place.
    const remembered = this.loadedModels.get(peer)?.get(tid);
    if (remembered !== undefined && remembered !== r.model) fail('native_runtime_stale');
    if (!this.nativeFor || this.loaded(peer).has(tid)) return this.actualSettings(peer, s, r, tid); // a thread this process already holds reports its loaded selection
    // A thread this native process has NOT loaded yet: an unpinned resume would itself load it on the process default and leave it there (asking for a snapshot must never change
    // the thread's model). So it is loaded exactly like the first load of a public resume (see ensureProviderThread): its persisted selection is observed read-only first, then the
    // resume names that model and must be answered with it. The route is never rewritten here (a snapshot is a read); the thread is remembered as loaded only when it is on the route's
    // own model, otherwise the next real use takes the ordinary first-load path and recovers the newer selection under the route lock.
    const wanted = await this.firstLoadModel(peer, s, r, tid), answer = await this.actualSettings(peer, s, { ...r, model: wanted }, tid, { pin: true });
    if (answer.model !== wanted) fail('native_selection_not_confirmed');
    if (answer.model === r.model) this.markLoaded(peer, tid, r.model);
    return answer;
  }
  permissionOverridesKept(overrides, before) {
    const mode = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
    const kept = (overrides.cwd == null || samePath(overrides.cwd, before.cwd ?? before.thread.cwd))
      && (overrides.approvalPolicy == null || JSON.stringify(overrides.approvalPolicy) === JSON.stringify(before.approvalPolicy))
      && (overrides.approvalsReviewer == null || overrides.approvalsReviewer === before.approvalsReviewer)
      && (overrides.sandbox == null || mode[overrides.sandbox] === before.sandbox?.type)
      && (overrides.permissions == null || overrides.permissions === before.activePermissionProfile?.id)
      && (overrides.sandboxPolicy == null || JSON.stringify(overrides.sandboxPolicy) === JSON.stringify(before.sandbox));
    if (!kept) fail('native_permissions_changed'); // a provider change never changes permissions
  }
  permissionsKept(before, after) {
    // Workspace access is part of the boundary: BOTH sides must report their confirmed roots (undefined is never "equal"), and they must be the same set.
    const was = workspaceRoots(before), now = workspaceRoots(after);
    if (!was || !now) fail('native_permissions_unconfirmed');
    if (JSON.stringify(was) !== JSON.stringify(now)) return false;
    return samePath(before.cwd ?? before.thread?.cwd, after.cwd ?? after.thread?.cwd) && ['sandbox', 'approvalPolicy', 'approvalsReviewer', 'activePermissionProfile']
      .every(key => JSON.stringify(before[key] ?? null) === JSON.stringify(after[key] ?? null));
  }
  unchangedTarget(s, model) {
    const current = this.registry.all().find(x => x.connectionId === s.connectionId);
    if (!current || hash(current.baseUrl + '\0' + (current.authRef ?? '')) !== hash(s.baseUrl + '\0' + (s.authRef ?? '')) || current.revision !== s.revision
      || current.enabled !== s.enabled || current.catalog?.status !== 'fresh' || !current.catalog.models.includes(model)) fail('connection_changed');
  }
  // A created-but-unrouted fork leaves a receipt next to the routes. An unarchived one blocks another
  // cross-provider fork of the same source until an operator resolves it.
  forkReceiptDir() { return join(this.root, 'local-routes', 'fork-receipts'); }
  writeForkReceipt(receipt) {
    try {
      this.ensureDirs('fork-receipts');
      try { exclusiveWrite(join(this.forkReceiptDir(), receipt.forkId + '.json'), receipt); }
      catch (e) { if (e.code !== 'EEXIST') throw e; const path = join(this.forkReceiptDir(), receipt.forkId + '.json'); unlinkSync(path); exclusiveWrite(path, receipt); } // the later outcome replaces an earlier uncertain one
    } catch { /* the thrown Bridge error still reports the partial publication */ }
  }
  unresolvedForkReceipt(tid) {
    let dir; try { dir = readdirSync(this.forkReceiptDir()); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    return dir.some(name => { try { const x = readPrivate(join(this.forkReceiptDir(), name), 4096); return x?.sourceId === tid && x.archived !== true; } catch { return true; } });
  }
  // True while this controller, or another one on the same state, is switching the conversation's provider.
  switchPending(logical) {
    if (this.switching.has(logical)) return true;
    const path = join(this.root, 'local-routes', logical + '.switch.lock');
    let owner; try { owner = readPrivate(path, 512); } catch { return true; } // an unreadable lock is treated as held, never as free
    if (owner === null) return false;
    try { process.kill(owner.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } // a dead owner's lock is reclaimed by the next switch
  }
  // One request for one physical thread (a plain thread, a routed custom thread or a Bridge-managed chat).
  async dispatch(method, params, forward) {
    const requested = params.collaborationMode?.settings?.model ?? params.model;
    let r = this.readRoute(params.threadId);

    const prefixed = typeof requested === 'string' && requested.startsWith(localPrefix);
    const nativeRequested = !r && prefixed && (['thread/start', 'thread/resume'].includes(method) ? await this.nativeOwns(requested) : this.nativeClaims().includes(requested));
    const customRequested = prefixed && !nativeRequested;
    if (method === 'thread/fork') { const forked = await this.crossFork(params, r, requested, customRequested, forward); if (forked) return forked; }
    if (method === 'thread/start' && customRequested) {
      const found = this.registry.all().find(s => requested.startsWith(localPrefix + s.connectionId + '/'));
      const s = found ?? this.connection(), selected = requested === 'bridge-responses/selected' ? s.selected : requested;
      if (!s.enabled) fail('provider_disabled');
      if (s.catalog?.status !== 'fresh') fail('catalog_not_fresh');
      const model = s.catalog.models.find(m => localModelId(s.connectionId, m) === selected);
      if (!model) fail('model_not_available');
      if (!selectable(s, model)) fail('free_model_required');
      const executionParams = this.parameters(this.historyTools(params), s, model, true);
      const peer = await this.nativeForConnection(s, model);
      const answer = await peer.request(method, executionParams);
      if (answer.modelProvider !== this.providerId(s) || answer.model !== model) fail('native_selection_not_confirmed');
      const route = this.routeFor(s, model, answer.thread);
      try { this.saveRoute(answer.thread?.id, route); } catch { fail('native_thread_created_but_route_not_saved'); }
      this.markLoaded(peer, answer.thread.id, route.model); this.createdSnapshots.set(answer.thread.id, answer);
      // Positive birth evidence of a genuinely empty thread: native's own start answer says it is idle with no turns, from THIS owning peer. (Metadata alone is never proof of an empty
      // history; this only lets a later "unavailable before the first user message" answer be read as empty - see provenFreshEmpty.)
      if (Array.isArray(answer.thread?.turns) && answer.thread.turns.length === 0 && answer.thread.status?.type === 'idle') this.born.set(answer.thread.id, { peer, connectionId: s.connectionId, provider: answer.modelProvider, createdAt: answer.thread.createdAt, updatedAt: answer.thread.updatedAt }); // (the start answer's own dates: the thread's REAL creation)
      return this.result(answer, route);
    }
    if (!r && customRequested) fail('local_requires_new_thread');
    if (!r && typeof params.modelProvider === 'string' && params.modelProvider.startsWith('bridge_custom_')) fail('local_requires_new_thread');
    if (r) {
      if (this.managed(params.threadId)) fail('ambiguous_thread_owner');
      // History is native-readable across provider selection. An unavailable
      // execution child or disabled/changed endpoint must not hide saved chats.
      // This is NOT an execution fallback or an alternate-history resume.
      if (['thread/read', 'thread/turns/list', 'thread/items/list'].includes(method))
        return this.carried(method, params, async page => this.result(await forward(method, page), r));
      const release = this.routeLock(params.threadId);
      try {
      const lockedRoute = this.readRoute(params.threadId);
      if (JSON.stringify(lockedRoute) !== JSON.stringify(r)) fail('stale_revision');
      r = lockedRoute;
      // Queue add/start belong to the owning native peer exactly like turn/start: the same enabled, free-model and
      // loaded-writer checks apply, and the queue itself lives in (and is run by) that peer.
      if (['turn/start', 'thread/resume', 'thread/fork', 'thread/settings/update', 'thread/queue/add', 'thread/queue/start'].includes(method)) {
        const s = this.connection(r), configure = ['thread/resume', 'thread/fork'].includes(method);
        if (!s.enabled && method !== 'thread/resume') fail('provider_disabled');
        const initialModel = requested != null && ![r.model, localModelId(s.connectionId, r.model)].includes(requested) ? this.selectedModel(s, requested) : r.model;
        this.parameters(configure ? this.historyParameters(params, r) : initialModel !== r.model ? this.modelChangeEffort(s, initialModel, params) : params, s, initialModel, configure);
        const peer = await this.nativeForConnection(s, r.model);
        r = await this.ensureProviderThread(peer, s, r, params.threadId);
        if (method === 'thread/settings/update' && requested != null && ![r.model, localModelId(s.connectionId, r.model)].includes(requested)) {
          const model = this.selectedModel(s, requested); return await this.changeModel(peer, s, r, params, model);
        }
        if (['turn/start', 'thread/queue/add', 'thread/queue/start'].includes(method) && !selectable(s, r.model)) fail('free_model_required');
        const guarded = configure ? this.historyParameters(params, r) : params;
        const selected = this.parameters(guarded, s, r.model, configure);
        if (this.nativeFor && method === 'thread/resume' && params.model == null && params.collaborationMode?.settings?.model == null) delete selected.model;

        // The ACTUAL physical boundary: birth evidence (see born) and the unmaterialized-snapshot fallback end right before a request that could produce this thread's own history is sent to its owner -
        // whatever its outcome (failure and unknown outcome included) - and are never restored. (A logical request that is only a hand-off to another runtime never gets here for the old source.)
        if (!BIRTH_SAFE.has(method)) this.revokeBirth(params.threadId);
        // The validated physical boundary of a custom TURN: the selection actually mapped (the route's model, the level the request really carries), the peer that owns the thread and the readback
        // it can be asked for, handed to the Bridge, which settles any earlier uncertain dispatch or change, measures the first request after a reduced hand-off against the model that receives it,
        // and attaches the model-change note to THIS turn. A refusal there is raised before anything is sent.
        const turn = method === 'turn/start' ? await this.continuity?.context?.beforeTurn?.({ physical: params.threadId, peer, kind: 'custom', connectionId: s.connectionId, model: r.model, params: selected, readback: () => this.actualSettings(peer, s, r, params.threadId) }) : null;
        let answer;
        try { answer = await peer.request(method, turn?.params ?? selected); } catch (error) { turn?.failed(error); throw error; }
        turn?.accepted(answer);
        if (configure && (answer.modelProvider !== this.providerId(s) || answer.model !== r.model)) fail('native_selection_not_confirmed');
        if (configure) { this.verifyHistory(method, answer, params, r); this.markLoaded(peer, answer.thread.id, r.model); }
        if (method === 'thread/fork') this.saveRoute(answer.thread.id, this.routeFor(s, r.model, answer.thread));
        return this.carried(method, params, async () => this.result(answer, r));
      }
      // Native owns queue/interrupt/tool/history operations, unchanged.
      const s = this.connection(r); let selected = this.parameters(params, s, r.model, false);
      if (!this.nativeFor) return this.result(await forward(method, params), r);
      const peer = await this.nativeForConnection(s, r.model);
      if (method === 'turn/steer') { if (!s.enabled) fail('provider_disabled'); if (!selectable(s, r.model)) fail('free_model_required'); r = await this.ensureProviderThread(peer, s, r, params.threadId); selected = this.parameters(params, s, r.model, false); }
      if (!BIRTH_SAFE.has(method)) this.revokeBirth(params.threadId);
      const answer = await peer.request(method, selected);
      if (['thread/unload', 'thread/unsubscribe'].includes(method)) this.loaded(peer).delete(params.threadId);
      return this.result(answer, r);
      } finally { release(); }
    }
    const answer = await this.carried(method, params, page => forward(method, page));
    if (method === 'thread/list' && Array.isArray(answer.data)) return { ...answer, data: answer.data.map(t => {
      const route = this.readRoute(t.id); return route ? this.result({ thread: t }, route).thread : t;
    }) };
    return answer;
  }
}

// Retained source-level alias for the intermediate fixture entrypoint.
export { ResponsesRouter as LocalResponsesRouter };
