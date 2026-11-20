// Profile-scoped connection store for the one Claude Code adapter, and the pure
// policy that the Bridge applies to its model catalog and to new Claude work.
//
// The store is one private file, connections.json, in the Bridge's own launch
// root (the parent of BRIDGE_STATE). No caller can choose its location, and
// nothing here reads or writes any other path. It holds no token, address,
// command, profile or chat content. A saved definition, an observed catalog,
// authentication, inference, what the attached Bridge offered and what the
// host picker shows are separate evidence states; only the first three are ever
// set by this code, and authentication, inference and picker stay at their
// unknown values because nothing here can observe them.
//
// Disable generation. Every enabled-to-disabled transition made through this module increments
// connection.disableGeneration, saved in the same atomic write; nothing else changes it (enabling, the
// catalog, visibility and offered evidence leave it alone). Together with the store's own storeId it
// forms the token that Claude-owned queued work is stamped with (see claudeDecision), so that a disable
// the Bridge never observed is still detected later. The counter is bounded: at limits.generation a
// further disable is refused with 'generation_exhausted' rather than wrapped or saturated.
//
// A store written before the generation existed (same version, no generation fields) is "legacy": it is
// read and enforced as before but its generation is unknown, it is never rewritten or migrated here, and
// work stamped under it can only wait for an explicit start.
//
// Absent file = the Bridge's earlier behaviour (enabled, every model visible).
// A file that cannot be read safely is never repaired or guessed at: Claude
// Code stays unavailable for new work until it is fixed, and GPT is untouched.
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, fstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const storeFile = 'connections.json';
export const lockFile = 'connections.lock';
export const adapterId = 'claude_code';
export const limits = { bytes: 256 * 1024, models: 64, id: 100, name: 200, text: 1000, levels: 8, level: 24, generation: 2 ** 31 - 1 };
const lockWaitMs = 2000;
const modelIdPattern = /^[!-~]+$/; // printable ASCII, no space
const storeIdPattern = /^[0-9a-f]{32}$/;
const legacyKeys = ['adapter', 'enabled', 'visible', 'catalog', 'evidence'];
const generationKeys = ['disableGeneration', 'storeId'];

export class ConnectionError extends Error {
  constructor(code, message) { super(message); this.name = 'ConnectionError'; this.code = code; }
}
const fail = (code, message) => { throw new ConnectionError(code, message); };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys, what) => {
  const actual = Object.keys(value).sort().join(), wanted = [...keys].sort().join();
  if (actual !== wanted) fail('invalid', `${what} has unexpected fields`);
};
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const validId = value => typeof value === 'string' && value.length <= limits.id && modelIdPattern.test(value);
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One catalog entry as the official SDK reports it, reduced to the fields kept.
// An entry that is malformed or too large is refused, never clipped.
export function normalizeModels(list) {
  if (!Array.isArray(list)) fail('catalog_invalid', 'The model catalog is not a list');
  if (list.length > limits.models) fail('catalog_invalid', `The model catalog has more than ${limits.models} models`);
  const seen = new Set();
  return list.map(entry => {
    if (!isObject(entry) || !validId(entry.value)) fail('catalog_invalid', 'A catalog model has no valid id');
    if (seen.has(entry.value)) fail('catalog_invalid', 'The model catalog repeats a model id');
    seen.add(entry.value);
    for (const [key, max] of [['displayName', limits.name], ['description', limits.text]])
      if (entry[key] !== undefined && (typeof entry[key] !== 'string' || entry[key].length > max)) fail('catalog_invalid', `A catalog model ${key} is not usable`);
    if (entry.supportsEffort !== undefined && typeof entry.supportsEffort !== 'boolean') fail('catalog_invalid', 'A catalog model supportsEffort is not a boolean');
    const levels = entry.supportedEffortLevels ?? [];
    if (!Array.isArray(levels) || levels.length > limits.levels || levels.some(level => typeof level !== 'string' || !level || level.length > limits.level))
      fail('catalog_invalid', 'A catalog model has unusable effort levels');
    return { value: entry.value, displayName: entry.displayName ?? entry.value, description: entry.description ?? '',
      supportsEffort: entry.supportsEffort ?? false, supportedEffortLevels: [...levels] };
  });
}

export function defaultStore() {
  return { version: 1, revision: 0, connections: { [adapterId]: { adapter: adapterId, enabled: true, visible: null, catalog: null,
    evidence: { catalog: 'never', authentication: 'unknown', inference: 'unverified', offered: null, picker: 'unknown' },
    disableGeneration: 0, storeId: randomBytes(16).toString('hex') } } };
}

// A connection record without either generation field is the earlier layout. Only the reader accepts it.
const isLegacyConnection = connection => isObject(connection) && generationKeys.every(key => !(key in connection));

// Strict: any extra, missing or mistyped field is invalid. Unknown versions are
// reported separately by the reader so that a newer file is preserved untouched. allowLegacy is for the
// reader only: nothing here writes the earlier layout.
export function validateStore(store, { allowLegacy = false } = {}) {
  if (!isObject(store)) fail('invalid', 'The connection store is not an object');
  // A newer layout may carry fields this code does not know: report it as unsupported, not corrupt.
  if (Number.isSafeInteger(store.version) && store.version > 1) fail('unsupported', 'The connection store has a newer version');
  exactKeys(store, ['version', 'revision', 'connections'], 'The connection store');
  if (store.version !== 1) fail('invalid', 'The connection store version is invalid');
  if (!isCount(store.revision)) fail('invalid', 'The connection revision is invalid');
  if (!isObject(store.connections)) fail('invalid', 'The connections are invalid');
  exactKeys(store.connections, [adapterId], 'The connections');
  const connection = store.connections[adapterId];
  if (!isObject(connection)) fail('invalid', 'The Claude Code connection is invalid');
  const legacy = allowLegacy && isLegacyConnection(connection);
  exactKeys(connection, legacy ? legacyKeys : [...legacyKeys, ...generationKeys], 'The Claude Code connection');
  if (connection.adapter !== adapterId || typeof connection.enabled !== 'boolean') fail('invalid', 'The Claude Code connection is invalid');
  if (!legacy && (!isCount(connection.disableGeneration) || connection.disableGeneration > limits.generation || typeof connection.storeId !== 'string' || !storeIdPattern.test(connection.storeId)))
    fail('invalid', 'The disable generation is invalid');
  const idList = value => Array.isArray(value) && value.length <= limits.models && value.every(validId) && new Set(value).size === value.length;
  if (connection.visible !== null && !idList(connection.visible)) fail('invalid', 'The visible model list is invalid');
  const catalog = connection.catalog;
  if (catalog !== null) {
    if (!isObject(catalog)) fail('invalid', 'The catalog is invalid');
    exactKeys(catalog, ['observedAt', 'revision', 'status', 'error', 'models'], 'The catalog');
    if (!isCount(catalog.observedAt) || !isCount(catalog.revision) || !['fresh', 'stale'].includes(catalog.status)
      || !(catalog.error === null || (typeof catalog.error === 'string' && /^[a-z_]{1,40}$/.test(catalog.error)))) fail('invalid', 'The catalog is invalid');
    try { normalizeModels(catalog.models); } catch { fail('invalid', 'The catalog models are invalid'); }
    if (JSON.stringify(normalizeModels(catalog.models)) !== JSON.stringify(catalog.models)) fail('invalid', 'The catalog models are not normalized');
  }
  const evidence = connection.evidence;
  if (!isObject(evidence)) fail('invalid', 'The evidence is invalid');
  exactKeys(evidence, ['catalog', 'authentication', 'inference', 'offered', 'picker'], 'The evidence');
  if (!['never', 'observed', 'failed'].includes(evidence.catalog) || evidence.authentication !== 'unknown' || evidence.inference !== 'unverified' || evidence.picker !== 'unknown')
    fail('invalid', 'The evidence is invalid');
  if (evidence.offered !== null) {
    if (!isObject(evidence.offered)) fail('invalid', 'The offered evidence is invalid');
    exactKeys(evidence.offered, ['at', 'ids'], 'The offered evidence');
    if (!isCount(evidence.offered.at) || !idList(evidence.offered.ids)) fail('invalid', 'The offered evidence is invalid');
  }
  if (connection.visible && !catalog) fail('invalid', 'Visible models need an observed catalog');
  return store;
}

// The launch root must be a real directory owned by this user that others
// cannot write to, as the launcher creates it. Nothing is followed or repaired.
function inspectRoot(root) {
  if (typeof root !== 'string' || !root.startsWith('/') || root.includes('\0')) fail('unsafe', 'The Bridge launch root is not an absolute path');
  let stat;
  try { stat = lstatSync(root); } catch { fail('unsafe', 'The Bridge launch root is not available'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('unsafe', 'The Bridge launch root is not a plain directory');
  if ((typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o022) !== 0) fail('unsafe', 'The Bridge launch root is not private to this user');
}

// { status: 'absent' | 'ok' | 'corrupt' | 'unsupported' | 'unsafe', store?, reason? }. Never repairs.
// No file is the earlier, unconfigured state however the root looks; the root and
// the file are inspected strictly only once a file exists.
export function readConnections(root) {
  if (typeof root !== 'string' || !root.startsWith('/') || root.includes('\0')) return { status: 'unsafe', reason: 'The Bridge launch root is not an absolute path' };
  const path = join(root, storeFile);
  let fd;
  // O_NONBLOCK: a FIFO or device planted at this path is then refused by the regular-file check
  // below instead of blocking the Bridge in open().
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { status: 'absent' };
    return { status: 'unsafe', reason: 'The connection store cannot be opened safely' };
  }
  try {
    try { inspectRoot(root); } catch (error) { return { status: 'unsafe', reason: error.message }; }
    const stat = fstatSync(fd);
    if (!stat.isFile() || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0)
      return { status: 'unsafe', reason: 'The connection store is not a private regular file' };
    if (stat.size > limits.bytes) return { status: 'corrupt', reason: 'The connection store is too large' };
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) { const count = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
    let value;
    try { value = JSON.parse(buffer.subarray(0, offset).toString('utf8')); } catch { return { status: 'corrupt', reason: 'The connection store is not valid JSON' }; }
    try {
      const store = validateStore(value, { allowLegacy: true });
      return isLegacyConnection(store.connections[adapterId]) ? { status: 'ok', store, legacy: true } : { status: 'ok', store };
    }
    catch (error) { return { status: error.code === 'unsupported' ? 'unsupported' : 'corrupt', reason: error.message }; }
  } finally { closeSync(fd); }
}

function acquire(root, waitMs) {
  const path = join(root, lockFile), deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeSync(fd, String(process.pid));
      return () => { closeSync(fd); try { unlinkSync(path); } catch {} };
    } catch (error) {
      if (error.code !== 'EEXIST') fail('lock_failed', 'The connection lock could not be taken');
      // Never reclaimed: a lock left by a crash is for the operator to remove.
      if (Date.now() >= deadline) fail('locked', `Another update holds ${lockFile}; it was not taken over`);
      sleep(20);
    }
  }
}

// Read-modify-write under an exclusive lock, with an optional expected revision
// so a stale writer is refused instead of overwriting a newer decision. A file
// that is not valid is left exactly as it is. wait: false takes the lock once
// without waiting (for writers on the Bridge's event loop) and fails 'locked'.
export function updateConnections(root, change, { expectedRevision, create = false, wait = true } = {}) {
  inspectRoot(root);
  const release = acquire(root, wait ? lockWaitMs : 0);
  try {
    const current = readConnections(root);
    let base;
    if (current.status === 'absent') { if (!create) fail('absent', 'There is no connection store yet'); base = defaultStore(); }
    else if (current.status === 'ok' && current.legacy) fail('legacy', 'The connection store has no disable generation (earlier layout); it is read as it is and not rewritten or migrated');
    else if (current.status === 'ok') base = current.store;
    else fail(current.status, current.reason ?? 'The connection store cannot be used');
    if (expectedRevision !== undefined && expectedRevision !== base.revision) fail('stale_revision', 'The connection changed since it was read');
    const draft = structuredClone(base), before = base.connections[adapterId];
    change(draft.connections[adapterId], draft);
    // The generation is the store's alone: a change cannot set it, and an enabled-to-disabled transition always counts.
    const after = draft.connections?.[adapterId];
    if (!isObject(after)) fail('invalid', 'The Claude Code connection is invalid');
    if (after.disableGeneration !== before.disableGeneration || after.storeId !== before.storeId) fail('invalid', 'The disable generation is set only by the store');
    if (before.enabled && !after.enabled) {
      if (before.disableGeneration >= limits.generation) fail('generation_exhausted', 'The disable generation is at its limit; Claude Code was not disabled');
      after.disableGeneration = before.disableGeneration + 1;
    }
    draft.revision = base.revision + 1;
    validateStore(draft);
    const path = join(root, storeFile), temporary = `${path}.${process.pid}.tmp`;
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify(draft)); fsyncSync(fd); } finally { closeSync(fd); }
    try { renameSync(temporary, path); } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
    return draft;
  } finally { release(); }
}

export const createConnections = root => updateConnections(root, () => {}, { create: true });
export const setEnabled = (root, enabled, options) => {
  if (typeof enabled !== 'boolean') fail('invalid', 'enabled must be true or false');
  return updateConnections(root, connection => { connection.enabled = enabled; }, options);
};
// Only models of the observed catalog can be made visible; null restores "all".
export const setVisible = (root, ids, options) => updateConnections(root, connection => {
  if (ids === null) { connection.visible = null; return; }
  if (!Array.isArray(ids) || ids.length > limits.models || new Set(ids).size !== ids.length) fail('invalid', 'Visible models must be a list without repeats');
  if (!connection.catalog) fail('no_catalog', 'Discover the models before choosing which are visible');
  for (const id of ids) if (!validId(id) || !connection.catalog.models.some(model => model.value === id)) fail('invalid', 'A chosen model is not in the observed catalog');
  connection.visible = [...ids];
}, options);

// The official SDK's catalog (or its failure) as observed by the Bridge. A failed
// refresh keeps the last valid catalog and labels it stale; it never fakes success.
// Only an existing store is touched, so an unconfigured Bridge writes nothing.
export function recordCatalog(root, outcome, { now = Date.now(), wait = true } = {}) {
  const apply = connection => {
    if (outcome.error) {
      if (connection.catalog) { connection.catalog.status = 'stale'; connection.catalog.error = outcome.error; }
      connection.evidence.catalog = 'failed';
      return;
    }
    const models = normalizeModels(outcome.models);
    connection.catalog = { observedAt: now, revision: (connection.catalog?.revision ?? 0) + 1, status: 'fresh', error: null, models };
    connection.evidence.catalog = 'observed';
    // The saved choice is kept as the person made it: a model missing from this catalog is
    // unavailable for now, not forgotten, and returns if a later catalog lists it again.
  };
  try { return updateConnections(root, apply, { wait }); }
  catch (error) { if (error.code === 'absent') return null; throw error; }
}

// What the attached Bridge's model/list actually offered, kept only when it changed.
export function recordOffered(root, ids, { now = Date.now(), wait = true } = {}) {
  const current = readConnections(root);
  if (current.status !== 'ok') return null;
  const previous = current.store.connections[adapterId].evidence.offered?.ids ?? null;
  if (previous && previous.length === ids.length && previous.every((id, index) => id === ids[index])) return current.store;
  return updateConnections(root, connection => { connection.evidence.offered = { at: now, ids: [...ids] }; }, { wait });
}

// The last validated catalog in the store, for listing a disabled connection's models without
// starting the SDK. Null when there is no readable store or no catalog yet.
export function storedModels(root) {
  const read = readConnections(root);
  return read.status === 'ok' ? read.store.connections[adapterId].catalog?.models ?? null : null;
}

// The effective decision for new Claude work, and the generation token of the same read.
// token: 'none' when no store is configured (no root, or no file), so nothing can have been disabled
// through it; `<storeId>:<generation>` for a current store; null when the generation is unknown
// (an unreadable store, or the earlier layout). Null never matches anything, so unknown provenance is
// never taken as proof that no disable happened. No root = no store configured.
export function claudeDecision(root) {
  if (!root) return { policy: { enabled: true, visible: null, state: 'default' }, token: 'none' };
  const read = readConnections(root);
  if (read.status === 'absent') return { policy: { enabled: true, visible: null, state: 'default' }, token: 'none' };
  if (read.status !== 'ok') return { policy: { enabled: false, visible: new Set(), state: 'unreadable', reason: read.reason }, token: null };
  const connection = read.store.connections[adapterId];
  return { policy: { enabled: connection.enabled, visible: connection.visible ? new Set(connection.visible) : null, state: 'store', revision: read.store.revision },
    token: read.legacy ? null : `${connection.storeId}:${connection.disableGeneration}` };
}
export const claudePolicy = root => claudeDecision(root).policy;

// The message that refuses new Claude work, or null. A hidden model only stops
// a new choice: continuing an existing chat with its known model stays allowed.
export function claudeDenial(policy, { model, continuing = false } = {}) {
  if (!policy.enabled) return policy.state === 'unreadable'
    ? 'Claude Code is unavailable: its connection settings could not be read safely. GPT is not affected.'
    : 'Claude Code is disabled in Model Bridge. Existing chats stay readable; enable it to start new Claude work.';
  if (model !== undefined && !continuing && policy.visible && !policy.visible.has(model))
    return `Claude model ${model} is hidden in Model Bridge. Make it visible to start new Claude work with it.`;
  return null;
}

// The native catalog first and unchanged, then Claude's entries under the policy.
// A hidden or disabled model is listed only when includeHidden is asked for, and
// then marked hidden. A model id that a native model already uses is not
// overwritten (reported in collisions); a malformed or repeating Claude catalog
// adds nothing and is reported as an error by the caller.
export function mergeClaudeModels(nativeList, claudeEntries, policy, includeHidden) {
  if (!Array.isArray(claudeEntries)) fail('catalog_invalid', 'The Claude catalog is not a list');
  const seen = new Set();
  for (const entry of claudeEntries) {
    if (!isObject(entry) || !validId(entry.model) || seen.has(entry.model)) fail('catalog_invalid', 'The Claude catalog has a missing or repeated model id');
    seen.add(entry.model);
  }
  const collisions = [], added = [];
  for (const entry of claudeEntries) {
    if (nativeList.some(native => native.model === entry.model)) { collisions.push(entry.model); continue; }
    const shown = policy.enabled && (!policy.visible || policy.visible.has(entry.model));
    if (shown) added.push({ ...entry, hidden: false, isDefault: false });
    else if (includeHidden) added.push({ ...entry, hidden: true, isDefault: false });
  }
  return { models: [...nativeList, ...added], collisions, offered: added.filter(entry => !entry.hidden).map(entry => entry.model) };
}
