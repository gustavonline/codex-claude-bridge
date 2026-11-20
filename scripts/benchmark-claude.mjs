// Explicit opt-in (--run): consumes a few small Claude turns on the official login of CLAUDE_CONFIG_DIR, in a disposable workspace.
// Compares Bridge's per-turn query (a new SDK query per turn, resuming the session) with a persistent live query (T3's pattern: one
// query, later turns pushed into its prompt stream) under the SAME prompt, model, system prompt, tools (none), MCP (none) and settings.
// It also records whether the SDK joins its answers to the prompt (user_message_uuid / user_message_uuids), which Bridge's notice
// receipt depends on. Prints one JSON report; nothing is written outside the disposable workspace and the SDK's own session store.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, sdk: { type: 'string' }, model: { type: 'string', default: 'haiku' }, rounds: { type: 'string', default: '2' }, claude: { type: 'string' } } });
if (!values.run) throw new Error('This benchmark sends real Claude turns. Pass --run to authorize a few small synthetic turns.');
const sdkDir = resolve(values.sdk ?? 'node_modules/@anthropic-ai/claude-agent-sdk');
const sdkVersion = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8')).version;
const { query, deleteSession } = await import(pathToFileURL(join(sdkDir, 'sdk.mjs')).href);
const executable = values.claude ?? process.env.BRIDGE_CLAUDE ?? execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim();
const cwd = mkdtempSync(join(tmpdir(), 'bridge-bench-'));
// The same allowlist idea as claude.mjs: only what the CLI needs, so the measuring shell's own Claude session or API keys cannot leak in.
const env = Object.fromEntries(['HOME', 'PATH', 'LANG', 'TMPDIR', 'CLAUDE_CONFIG_DIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const prompt = 'Reply with exactly the word: ok';
const now = () => performance.now();

// Resident memory of a process and all its descendants (Linux /proc; ps elsewhere), in KiB.
function treeRss(pid) {
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
    const kids = new Map(); for (const [p, pp] of rows) kids.set(pp, [...(kids.get(pp) ?? []), p]);
    const rss = new Map(rows.map(([p, , r]) => [p, r])); let total = 0, n = 0; const stack = [pid];
    while (stack.length) { const p = stack.pop(); if (!rss.has(p)) continue; total += rss.get(p); n++; stack.push(...(kids.get(p) ?? [])); }
    return { kib: total, processes: n };
  } catch { return { kib: 0, processes: 0 }; }
}
function owned() {
  const o = { child: null, spawnedAt: null, peak: 0, procs: 0, timer: null };
  o.spawn = ({ command, args, cwd: dir, env: e, signal }) => {
    o.spawnedAt = now(); o.child = spawn(command, args, { cwd: dir, env: e, signal, stdio: ['pipe', 'pipe', 'pipe'] }); o.child.stderr.resume();
    o.exit = new Promise(r => o.child.once('exit', () => r(now())));
    o.timer = setInterval(() => { const s = treeRss(o.child.pid); if (s.kib > o.peak) o.peak = s.kib; o.procs = Math.max(o.procs, s.processes); }, 25);
    return o.child;
  };
  o.stop = async () => { const t = now(); const exited = await Promise.race([o.exit, new Promise(r => setTimeout(() => r(null), 10_000))]); clearInterval(o.timer); return exited ? Math.round(exited - t) : null; };
  return o;
}
const baseOptions = o => ({ pathToClaudeCodeExecutable: executable, env, cwd, model: values.model, settingSources: [], tools: [], mcpServers: {}, includePartialMessages: true,
  systemPrompt: { type: 'custom', prompt: 'You are a terse test responder.', snapshot: false }, extraArgs: { 'strict-mcp-config': null, 'replay-user-messages': null },
  canUseTool: async () => ({ behavior: 'deny', message: 'no tools' }), spawnClaudeCodeProcess: o.spawn });
const user = (uuid, sid) => ({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text: prompt }] }, parent_tool_use_id: null, session_id: sid ?? '' });

// Reads one turn's messages from an iterator until its result; times are relative to `t0` (when the turn was asked).
async function readTurn(iterator, t0, uuid, shape) {
  const out = { initMs: null, firstTextMs: null, resultMs: null, sessionId: null, ok: false };
  for (;;) {
    const { value: m, done } = await iterator.next(); if (done) break;
    if (m.type === 'system' && m.subtype === 'init' && out.initMs === null) { out.initMs = Math.round(now() - t0); out.sessionId = m.session_id; }
    if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta' && out.firstTextMs === null) out.firstTextMs = Math.round(now() - t0);
    if (m.type === 'stream_event' && m.event?.type === 'message_start') shape.messageStartJoined ||= m.user_message_uuid === uuid || (m.user_message_uuids ?? []).includes(uuid);
    if (m.type === 'assistant' && m.parent_tool_use_id === null) { shape.assistantJoined ||= m.user_message_uuid === uuid || (m.user_message_uuids ?? []).includes(uuid); shape.assistantHasModel ||= typeof m.message?.model === 'string' && m.message.model !== '<synthetic>'; }
    if (m.type === 'user' && m.uuid === uuid) shape.replayedPrompt = true;
    if (m.type === 'result') { out.resultMs = Math.round(now() - t0); out.ok = m.subtype === 'success'; out.sessionId ??= m.session_id; break; }
  }
  return out;
}
async function perTurn(rounds) {
  const turns = [], shape = {}; let sid = null;
  for (let i = 0; i < rounds; i++) {
    const o = owned(), uuid = randomUUID(), t0 = now();
    const q = query({ prompt: (async function* () { yield user(uuid, sid); })(), options: { ...baseOptions(o), ...(sid ? { resume: sid } : {}) } });
    const r = await readTurn(q[Symbol.asyncIterator](), t0, uuid, shape); sid = r.sessionId;
    q.close(); const exitMs = await o.stop();
    turns.push({ ...r, spawnMs: Math.round(o.spawnedAt - t0), closeToExitMs: exitMs, peakTreeRssMiB: +(o.peak / 1024).toFixed(1), processes: o.procs });
  }
  return { turns, shape, sid };
}
async function live(rounds) {
  const o = owned(), shape = {}, turns = []; let push; const pending = [];
  const input = (async function* () { for (;;) { const next = pending.shift() ?? await new Promise(r => { push = r; }); if (!next) return; yield next; } })();
  const send = m => { if (push) { const p = push; push = null; p(m); } else pending.push(m); };
  const q = query({ prompt: input, options: baseOptions(o) }), it = q[Symbol.asyncIterator](); let sid = null, idle = null;
  for (let i = 0; i < rounds; i++) {
    const uuid = randomUUID(), t0 = now(); send(user(uuid, sid));
    const r = await readTurn(it, t0, uuid, shape); sid = r.sessionId;
    if (i === 0) { await new Promise(r => setTimeout(r, 500)); idle = +(treeRss(o.child.pid).kib / 1024).toFixed(1); }
    turns.push({ ...r, spawnMs: i === 0 ? Math.round(o.spawnedAt - t0) : null });
  }
  send(null); q.close(); const exitMs = await o.stop();
  return { turns, shape, sid, idleTreeRssMiB: idle, peakTreeRssMiB: +(o.peak / 1024).toFixed(1), processes: o.procs, closeToExitMs: exitMs };
}
// Stop mid-stream: abort after the first text delta, then time until the owned child has exited (the SDK's graceful close).
async function stops(rounds) {
  const out = [];
  for (let i = 0; i < rounds; i++) {
    const o = owned(), controller = new AbortController(), uuid = randomUUID();
    const q = query({ prompt: (async function* () { yield { ...user(uuid), message: { role: 'user', content: [{ type: 'text', text: 'Count from 1 to 300, one number per line, nothing else.' }] } }; })(), options: { ...baseOptions(o), abortController: controller, persistSession: false } });
    let stoppedAt = null;
    try { for await (const m of q) if (!stoppedAt && m.type === 'stream_event' && m.event?.type === 'content_block_delta') { stoppedAt = now(); controller.abort(); q.close(); } } catch { /* the aborted stream ends with an abort error */ }
    const exited = await o.exit; clearInterval(o.timer); out.push({ stopToExitMs: stoppedAt ? Math.round(exited - stoppedAt) : null });
  }
  return out;
}
// The model list (no prompt, no inference): time to the list, and to the probe child's exit after close.
async function catalog(rounds) {
  const out = [];
  for (let i = 0; i < rounds; i++) {
    const o = owned(), t0 = now();
    const q = query({ prompt: (async function* () { await new Promise(() => {}); })(), options: { ...baseOptions(o), persistSession: false } });
    const list = await q.supportedModels(); const listedMs = Math.round(now() - t0); q.close(); const exited = await o.exit; clearInterval(o.timer);
    out.push({ models: list.length, listMs: listedMs, closeToExitMs: Math.round(exited - t0 - listedMs) });
  }
  return out;
}
const rounds = Math.max(2, Number(values.rounds) || 2);
const report = { sdkVersion, cli: execFileSync(executable, ['--version'], { encoding: 'utf8', env }).trim(), model: values.model, rounds, platform: `${process.platform}-${process.arch}`, node: process.version, measuredAt: new Date().toISOString(),
  labels: 'live inference; `rounds` samples per mode; turn 1 of each mode is cold for that mode (fresh child), later turns warm; per-turn = Bridge today, live = persistent query; stop = abort after first text delta; catalog = supportedModels, no inference' };
try {
  report.perTurn = await perTurn(rounds);
  report.live = await live(rounds);
  report.stop = await stops(rounds);
  report.catalog = await catalog(rounds);
} finally {
  for (const sid of [report.perTurn?.sid, report.live?.sid]) if (sid) try { await deleteSession(sid, { dir: cwd }); } catch { /* the store keeps it; harmless synthetic text */ }
  rmSync(cwd, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
