import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const logContext = new AsyncLocalStorage();

// Never serialize requests, results, prompts, commands, environment or raw errors.
export function errorMetadata(error) {
  const message = String(error?.message ?? error ?? '');
  const category = error?.code === -32601 ? 'unsupported_method'
    : /Wait for the current turn or chat change|Wait for the current chat change|Wait for the history edit|Wait for the source chat change/i.test(message) ? 'busy_thread'
    : /steering.*uncertain|steering.*confirmed/i.test(message) ? 'steering_delivery'
    : /no longer active|no longer accepting|different message or turn/i.test(message) ? 'stale_turn'
    : /previous_response_id|previous response.*not found/i.test(message) ? 'response_cache'
    : /environment variable.*(?:missing|not set)|missing.*environment variable/i.test(message) ? 'provider_environment'
    : /no rollout found/i.test(message) ? 'rollout_not_found'
    : /code.signing.identity/i.test(message) ? 'code_signing'
    : /kernel.*exit|trusted Node process.*exit|bridge startup failed/i.test(message) ? 'helper_startup'
    : /reauthentication|oauth|authentication required|not authenticated/i.test(message) ? 'authentication'
    : /no such file or directory|ENOENT|os error 2\b/i.test(message) ? 'file_not_found'
    : /timed out|timeout/i.test(message) ? 'timeout'
    : /limit|quota/i.test(message) ? 'usage_limit'
    : /closed|disconnect/i.test(message) ? 'connection_closed'
    : /permission|approval|denied|declined/i.test(message) ? 'permission'
    : /abort|interrupt/i.test(message) ? 'interrupted' : 'other';
  return { errorCategory: category, errorCode: typeof error?.code === 'number' ? error.code : undefined,
    errorFingerprint: createHash('sha256').update(message).digest('hex').slice(0, 16) };
}

const words = new Set(['peer', 'direction', 'method', 'stage', 'status', 'model', 'provider', 'previousModel', 'previousProvider', 'effort', 'previousEffort', 'server', 'tool', 'errorCategory', 'signal', 'reason', 'version']);
const ids = new Set(['rpcId', 'traceId', 'runId', 'threadId', 'sourceThreadId', 'turnId', 'sessionId', 'queuedSubmissionId']);
const numbers = new Set(['durationMs', 'errorCode', 'exitCode', 'dynamicToolCount', 'restoredThreads', 'toolCount', 'instructionCharacters', 'contextOverrideCount', 'retainedTurns', 'removedTurns', 'changedEntries', 'queueLength', 'activeTurns', 'pendingCalls']);

// The same allowlist is applied again when exporting older/on-disk logs.
export function safeFields(fields = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (numbers.has(key) && Number.isFinite(value)) safe[key] = value;
    else if (words.has(key) && typeof value === 'string' && /^[\w./:-]{1,120}$/.test(value)) safe[key] = value;
    else if (ids.has(key) && typeof value === 'string' && /^(?:[\da-f-]{8,80}|bridge-\d+)$/.test(value)) safe[key] = value;
    else if (key === 'rpcId' && Number.isSafeInteger(value)) safe[key] = value;
    else if (key === 'errorFingerprint' && typeof value === 'string' && /^[\da-f]{16}$/.test(value)) safe[key] = value;
    else if (['resuming', 'legacy'].includes(key) && typeof value === 'boolean') safe[key] = value;
  }
  return safe;
}

export function safeEntry(entry) {
  if (!entry || typeof entry.event !== 'string' || !/^[a-z][a-z\d_.]{0,79}$/.test(entry.event)
    || typeof entry.time !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(entry.time) || !Number.isFinite(Date.parse(entry.time))) return null;
  return { time: entry.time, ...(Number.isSafeInteger(entry.pid) ? { pid: entry.pid } : {}), event: entry.event,
    level: entry.errorCategory || entry.status === 'failed' || /failed|\.error$|invalid_json/.test(entry.event) ? 'error'
      : /slow|paused|recovered|unmatched|interrupted/.test(entry.event) ? 'warn' : 'info', ...safeFields(entry) };
}

export function createLogger(directory, { maxBytes = 1024 * 1024, runtimePath } = {}) {
  const path = join(directory, `bridge-${process.pid}.jsonl`);
  const runId = randomUUID();
  const active = new Map(), starting = new Map(), preparing = new Set();
  let bytes = 0, warned = false;
  const warning = () => {
    if (!warned) process.stderr.write('Bridge diagnostic log could not be written; request handling continues.\n');
    warned = true;
  };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
    const old = readdirSync(directory).filter(n => /^bridge-\d+\.jsonl(?:\.1)?$/.test(n))
      .map(n => ({ path: join(directory, n), modified: statSync(join(directory, n)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified);
    for (const file of old.slice(8)) unlinkSync(file.path);
    bytes = existsSync(path) ? statSync(path).size : 0;
    if (bytes) {
      const fd = openSync(path, 'r'), last = Buffer.alloc(1);
      try { readSync(fd, last, 0, 1, bytes - 1); } finally { closeSync(fd); }
      if (last[0] !== 10) { appendFileSync(path, '\n'); bytes++; }
    }
  } catch { warning(); }
  const log = (event, fields = {}) => {
    const safe = safeEntry({ ...logContext.getStore(), ...fields, time: new Date().toISOString(), pid: process.pid, event, runId });
    if (!safe) return;
    try {
      let changed = event === 'process.started' || event === 'process.stopping';
      if (event === 'turn.started') { active.set(safe.threadId, safe.turnId); changed = true; }
      if (event === 'turn.finished' && active.get(safe.threadId) === safe.turnId) { active.delete(safe.threadId); changed = true; }
      if (event === 'turn.preparing') { preparing.add(safe.threadId); changed = true; }
      if (event === 'turn.prepared') { preparing.delete(safe.threadId); changed = true; }
      if (safe.direction === 'inbound' && ['turn/start', 'turn/steer', 'thread/queue/start'].includes(safe.method)) {
        const key = `${safe.peer}:${safe.rpcId}`;
        if (event === 'rpc.start') { starting.set(key, safe.threadId); changed = true; }
        if (event === 'rpc.finish') { starting.delete(key); changed = true; }
      }
      if (runtimePath && changed) {
        const snapshot = { pid: process.pid, runId, updatedAt: safe.time, stopping: event === 'process.stopping',
          activeThreads: [...active.keys()].filter(Boolean), startingThreads: [...new Set([...starting.values(), ...preparing])].filter(Boolean), pendingStarts: starting.size + preparing.size };
        writeFileSync(runtimePath + '.tmp', JSON.stringify(snapshot), { mode: 0o600 });
        renameSync(runtimePath + '.tmp', runtimePath);
      }
      const line = JSON.stringify(safe) + '\n';
      if (bytes && bytes + Buffer.byteLength(line) > maxBytes) {
        renameSync(path, path + '.1'); bytes = 0;
      }
      appendFileSync(path, line, { mode: 0o600 }); chmodSync(path, 0o600); bytes += Buffer.byteLength(line);
    } catch { warning(); }
  };
  log.path = path;
  log.runId = runId;
  return log;
}
