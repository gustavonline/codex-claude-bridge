import { appendFileSync, chmodSync, constants, existsSync, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { getPriority, setPriority } from 'node:os';
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

// Each Bridge process owns one runtime record. Several app-server instances can
// share a profile; one instance's start or exit must not replace another's work.
const runtimeRecord = /^(\d+)-[\da-f-]{36}\.(?:json|tmp)$/;
// Desktop requests known to only read state. Every other desktop request may
// start or change work, including methods not listed here: while one is in
// flight it counts as starting work, and it is refused before dispatch if that
// cannot be recorded. A name that merely sounds like a read is not trusted.
const reads = new Set(['initialize', 'thread/read', 'thread/list', 'thread/turns/list', 'thread/items/list',
  'thread/queue/list', 'thread/attachment/list', 'thread/goal/get', 'model/list', 'config/read']);
// Requests that only stop or remove work are never refused because recording failed.
const cancellations = new Set(['turn/interrupt', 'command/exec/terminate', 'thread/queue/delete']);
const possibleWork = safe => safe.direction === 'inbound' && safe.peer === 'desktop'
  && !reads.has(safe.method) && !cancellations.has(safe.method);
export const unsafeActivity = 'Bridge activity could not be recorded safely, so this was not started. Check the profile runtime directory, then retry.';
const currentNice = () => { try { return getPriority(); } catch { return null; } };
function pruneRuntime(runtimeDirectory) {
  for (const name of readdirSync(runtimeDirectory)) {
    const pid = Number(runtimeRecord.exec(name.replace(/^\./, ''))?.[1]);
    if (!pid || pid === process.pid) continue;
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') unlinkSync(join(runtimeDirectory, name)); }
  }
}

export function createLogger(directory, { maxBytes = 1024 * 1024, runtimeDirectory, refreshMs = 5000 } = {}) {
  const path = join(directory, `bridge-${process.pid}.jsonl`);
  const runId = randomUUID();
  // Captured once: the idle guard matches it to the OS process start time, so a
  // recycled PID cannot inherit this record.
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);
  let record = runtimeDirectory && join(runtimeDirectory, `${process.pid}-${runId}.json`);
  const recordTemp = runtimeDirectory && join(runtimeDirectory, `.${process.pid}-${runId}.tmp`);
  // Open descriptor of the published record. Truncating it needs no directory
  // permission, so a failed publication can still invalidate older evidence.
  let published, directoryFd, directoryId, stopping = false, unsafe = false;
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
  if (record) {
    try {
      mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
      // Refuse a redirected runtime directory before any chmod, prune or write.
      directoryFd = openSync(runtimeDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      fchmodSync(directoryFd, 0o700);
      const { dev, ino } = fstatSync(directoryFd, { bigint: true }); directoryId = { dev, ino };
      pruneRuntime(runtimeDirectory);
    } catch {
      // No record: the guard treats this live process as unverified, never idle.
      record = null; warning();
      if (directoryFd !== undefined) closeSync(directoryFd);
    }
    // Exit removes only this process's record, and only inside its own directory.
    if (record) process.once('exit', () => { if (!bound() || !removeRecord()) invalidate(); });
  }
  // The checked directory stays open for the process lifetime. Every later path
  // operation first confirms the path still names that same directory, so a
  // replaced or redirected runtime directory is refused rather than written through.
  // Without openat this is a check before each operation, not OS isolation.
  function bound() {
    try {
      const { dev, ino } = lstatSync(runtimeDirectory, { bigint: true });
      return dev === directoryId.dev && ino === directoryId.ino;
    } catch { return false; }
  }
  function removeRecord() {
    try { unlinkSync(record); return true; } catch { return false; }
  }
  function invalidate() {
    try { ftruncateSync(published, 0); return true; } catch { return false; }
  }
  // When a record can be neither replaced nor invalidated, its older bytes may
  // understate work. Raising this process's own nice value (allowed without
  // privilege, never lowered here) changes a public attribute the guard reads
  // through ps: a record whose nice value no longer matches is unverified at once,
  // with no file write. Only a later successful publication records the new value.
  function markUnsafe() {
    if (unsafe) return;
    unsafe = true;
    try { if (signalling) setPriority(currentNice() + 1); } catch {}
  }
  // Qualified once at start: setting the current value again uses the same call
  // without changing priority. If the value cannot be read or set, records carry
  // no nice value, and the guard never treats this process as verified.
  const signalling = Boolean(record) && (() => {
    const nice = currentNice();
    if (nice === null) return false;
    try { setPriority(nice); return true; } catch { return false; }
  })();
  const snapshot = () => ({ pid: process.pid, runId, startedAt, updatedAt: new Date().toISOString(), stopping, nice: signalling ? currentNice() : null,
    activeThreads: [...active.keys()].filter(Boolean), startingThreads: [...new Set([...starting.values(), ...preparing])].filter(Boolean), pendingStarts: starting.size + preparing.size });
  // Returns false only when this process's work may be understated: the new
  // state was not published and the older record could not be invalidated.
  function publish(value) {
    let fd;
    try {
      if (!bound()) throw new Error('Runtime directory changed');
      // unlink removes a planted link itself, never its target; O_EXCL then
      // refuses anything recreated at this private temporary name.
      try { unlinkSync(recordTemp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fd = openSync(recordTemp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      if (!fstatSync(fd).isFile()) throw new Error('Runtime record is not a regular file');
      writeSync(fd, JSON.stringify(value));
      renameSync(recordTemp, record);
      if (published !== undefined) closeSync(published);
      published = fd; fd = undefined; unsafe = false;
      return true;
    } catch {
      warning();
      if (fd !== undefined) closeSync(fd);
      if (published === undefined || invalidate()) return true;
      markUnsafe();
      return false;
    }
  }
  // Periodic republication lets a recovered process publish trustworthy current
  // state without new events. The guard also ignores a record older than 20
  // seconds; that is a supplemental check, not the failure signal above.
  const refresh = record ? setInterval(() => publish(snapshot()), refreshMs) : undefined;
  refresh?.unref();
  const log = (event, fields = {}) => {
    const safe = safeEntry({ ...logContext.getStore(), ...fields, time: new Date().toISOString(), pid: process.pid, event, runId });
    if (!safe) return;
    let changed = event === 'process.started' || event === 'process.stopping';
    if (event === 'process.stopping') stopping = true;
    if (event === 'turn.started') { active.set(safe.threadId, safe.turnId); changed = true; }
    if (event === 'turn.finished' && active.get(safe.threadId) === safe.turnId) { active.delete(safe.threadId); changed = true; }
    if (event === 'turn.preparing') { preparing.add(safe.threadId); changed = true; }
    if (event === 'turn.prepared') { preparing.delete(safe.threadId); changed = true; }
    if (possibleWork(safe)) {
      // Internal correlation only (never written): the raw request ID, because
      // sanitizing can drop an unusual ID and merge concurrent requests.
      const key = `${safe.peer}:${typeof fields.rpcId}:${fields.rpcId}`;
      if (event === 'rpc.start') { starting.set(key, safe.threadId); changed = true; }
      if (event === 'rpc.finish') { starting.delete(key); changed = true; }
    }
    const recorded = record && changed ? publish(snapshot()) : true;
    try {
      const line = JSON.stringify(safe) + '\n';
      if (bytes && bytes + Buffer.byteLength(line) > maxBytes) {
        renameSync(path, path + '.1'); bytes = 0;
      }
      appendFileSync(path, line, { mode: 0o600 }); chmodSync(path, 0o600); bytes += Buffer.byteLength(line);
    } catch { warning(); }
    return recorded;
  };
  log.path = path;
  log.runId = runId;
  log.close = () => clearInterval(refresh);
  return log;
}
