import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { safeEntry, safeFields, errorMetadata } from './logging.mjs';

export function threadId(value) {
  if (!value) return undefined;
  const id = value.replace(/^codex:\/\/threads\//, '');
  if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(id)) throw new Error('Use a thread UUID or codex://threads/<UUID>.');
  return id;
}

export function readLogs(state, { thread, maxBytes = 12 * 1024 * 1024 } = {}) {
  const entries = [], coverage = { files: 0, invalidLines: 0, skippedFiles: 0, bytes: 0 };
  let files;
  try {
    files = readdirSync(join(state, 'logs')).filter(n => /^bridge-\d+\.jsonl(?:\.1)?$/.test(n))
      .map(name => ({ path: join(state, 'logs', name), stat: lstatSync(join(state, 'logs', name)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  } catch { return { entries, coverage }; }
  for (const file of files) {
    if (!file.stat.isFile() || coverage.bytes + file.stat.size > maxBytes) { coverage.skippedFiles++; continue; }
    let data;
    try { data = readFileSync(file.path, 'utf8'); } catch { coverage.skippedFiles++; continue; }
    coverage.files++; coverage.bytes += Buffer.byteLength(data);
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = safeEntry(JSON.parse(line));
        if (!entry) throw new Error('Invalid diagnostic event');
        entries.push(entry);
      } catch { coverage.invalidLines++; }
    }
  }
  entries.sort((a, b) => a.time.localeCompare(b.time));
  if (!thread) return { entries, coverage };
  const involved = e => e.threadId === thread || e.sourceThreadId === thread;
  const traces = new Set(entries.filter(e => involved(e) && e.traceId).map(e => e.traceId));
  return { entries: entries.filter(e => involved(e) || (!e.threadId && traces.has(e.traceId))), coverage };
}

function bridgeAlive(pid, started) {
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000 });
    if (!/bridge\.mjs(?:\s|$)/.test(command)) return false;
    // Do not mistake a recycled PID for an old bridge process.
    const time = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } });
    return !started || Date.parse(time.trim()) <= Date.parse(started) + 5000;
  } catch { return false; }
}

export function summarizeCalls(entries, runs, at = Date.now()) {
  const pending = new Map();
  const key = e => `${e.runId ?? e.pid}:${e.peer}:${e.direction}:${e.rpcId}`;
  for (const e of entries) {
    if (e.event === 'rpc.start') pending.set(key(e), e);
    if (e.event === 'rpc.finish') pending.delete(key(e));
    if (e.event === 'rpc.closed') for (const [k, value] of pending)
      if ((value.runId ?? value.pid) === (e.runId ?? e.pid) && value.peer === e.peer) pending.delete(k);
  }
  return [...pending.values()].map(e => ({ ...e, ageMs: Math.max(0, at - Date.parse(e.time)),
    status: runs.some(r => r.pid === e.pid && r.runId === e.runId && r.running) ? 'in_flight' : 'process_ended_or_log_incomplete' }));
}

const hints = {
  code_signing: 'Check the app-bundled signed Node runtime and direct native helper exec in the launcher.',
  helper_startup: 'Check installed app paths and the wrapper helper route; run doctor.',
  authentication: 'Check the official login for the affected provider.',
  provider_environment: 'Launch from an environment containing the provider key named by Codex configuration.',
  response_cache: 'Check the native history reset before retrying a managed GPT turn.',
  timeout: 'Follow the trace to the slow peer/tool; an external action may already have completed.',
  usage_limit: 'Wait for provider quota, or select another available model.',
  connection_closed: 'Check process exit events and interrupted turns before retrying.',
  permission: 'Check the chat permission profile and tool approval result.',
};

export function diagnose(state, { thread, isAlive = bridgeAlive, at = Date.now() } = {}) {
  const all = readLogs(state), selected = thread ? readLogs(state, { thread }).entries : all.entries;
  const runMap = new Map();
  for (const e of all.entries) {
    const key = e.runId ?? e.pid;
    if (!runMap.has(key)) runMap.set(key, { pid: e.pid, runId: e.runId, firstSeen: e.time });
    const run = runMap.get(key); run.lastSeen = e.time;
    if (e.event === 'process.started') { run.started = e.time; run.version = e.version; }
    if (['process.stopping', 'process.native_exit', 'process.failed'].includes(e.event)) run.ended = true;
  }
  const runs = [...runMap.values()].map(r => ({ ...r, running: !r.ended && !!r.pid && isAlive(r.pid, r.started ?? r.firstSeen) }));
  const threads = []; let unreadableStates = 0;
  let names = [];
  try { names = thread ? [`${thread}.json`] : readdirSync(join(state, 'threads')).filter(n => /^[a-f\d-]{36}\.json$/.test(n)); } catch {}
  for (const name of names) {
    try {
      const path = join(state, 'threads', name);
      if (!lstatSync(path).isFile()) throw new Error('Not a state file');
      const r = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(r.turns)) throw new Error('Invalid state');
      const last = r.turns.at(-1);
      threads.push({ ...safeFields({ threadId: r.thread?.id, model: r.model, provider: r.provider ?? 'claude', effort: r.effort,
        turnId: last?.id, status: last?.status ?? 'idle', ...(last?.error ? errorMetadata(last.error) : {}) }),
        turnCount: r.turns.length, queueLength: r.queue?.length ?? 0, activeTurns: r.turns.filter(t => t.status === 'inProgress').length,
        archived: r.archived === true, legacyHistory: r.nativeHistoryHasLegacySeeds === true || (!r.neutralNativeSeed && r.turns.length > 0) });
    } catch { unreadableStates++; }
  }
  // Report current process capability/config events separately from the chat's trace.
  const current = runs.filter(r => r.running).at(-1);
  const currentEvents = all.entries.filter(e => current && e.pid === current.pid && e.runId === current.runId);
  const capabilities = new Map();
  for (const e of currentEvents.filter(e => e.event === 'capability.status')) capabilities.set(e.server, e);
  const errors = selected.filter(e => e.level === 'error').slice(-80);
  return { schemaVersion: 1, generatedAt: new Date(at).toISOString(), scope: thread ?? 'all',
    coverage: { ...all.coverage, unreadableStates, boundedHistory: true }, runs, threads,
    pendingCalls: summarizeCalls(selected, runs, at), errors,
    capabilities: [...capabilities.values()], mirror: currentEvents.filter(e => /^config\./.test(e.event)).slice(-5),
    advice: [...new Set(errors.map(e => hints[e.errorCategory]).filter(Boolean))],
    recentEvents: selected.slice(-160) };
}

export function saveReport(path, report) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path); chmodSync(path, 0o600);
}
