// Explicit opt-in. Uses official logins and a disposable profile/workspace.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, chmodSync, writeFileSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { deleteSession } from '@anthropic-ai/claude-agent-sdk';
import { Peer } from '../rpc.mjs';
import { errorMetadata } from '../logging.mjs';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, scenario: { type: 'string' }, app: { type: 'string' }, source: { type: 'string' }, report: { type: 'string' } } });
if (!values.run) throw new Error('This test consumes Claude and Codex quota. Pass --run to authorize synthetic test turns.');
if (values.scenario && values.scenario !== 'native') throw new Error('Unknown scenario');
const root = mkdtempSync(join(tmpdir(), 'bridge-live-')), source = join(root, 'source'), state = join(root, 'state');
mkdirSync(source, { mode: 0o700 });
writeFileSync(join(source, 'config.toml'), 'model_provider = "openai"\n', { mode: 0o600 });
const auth = join(values.source ?? join(homedir(), '.codex'), 'auth.json');
if (existsSync(auth)) { copyFileSync(auth, join(source, 'auth.json')); chmodSync(join(source, 'auth.json'), 0o600); }
const report = { checkedAt: new Date().toISOString(), checks: [], modelCalls: 0, guiVerified: false };
let child, peer, exited, events, waiters, allSessionIds = new Set();
const expect = (name, value) => { assert.ok(value, name); report.checks.push(name); console.log(`PASS ${name}`); };
function waitFor(predicate) {
  const old = events.find(predicate); if (old) return Promise.resolve(old);
  return new Promise((resolve, reject) => {
    const entry = { predicate, resolve, timer: setTimeout(() => { waiters.delete(entry); reject(new Error('Live notification timed out')); }, 90000) };
    waiters.add(entry);
  });
}
async function connect() {
  events = []; waiters = new Set();
  child = spawn('python3', [fileURLToPath(new URL('../launch.py', import.meta.url)), '--stdio', '--source', source, '--state', state,
    '--app', values.app ?? '/Applications/ChatGPT.app'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BRIDGE_MIRROR: '0' } });
  child.stderr.resume(); exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  peer = new Peer(child.stdout, child.stdin, {
    request: async () => { throw new Error('This test cannot approve tools or access the desktop'); },
    notify: (method, params) => {
      const event = { method, params }; events.push(event);
      for (const w of waiters) if (w.predicate(event)) { clearTimeout(w.timer); waiters.delete(w); w.resolve(event); }
    },
  });
  await peer.request('initialize', { clientInfo: { name: 'bridge-live-test', version: '1' }, capabilities: { experimentalApi: true } });
  peer.notify('initialized', {});
}
async function disconnect() {
  for (const w of waiters ?? []) clearTimeout(w.timer);
  if (!child) return;
  child.stdin.end(); const timer = setTimeout(() => child.kill(), 2000);
  await exited; clearTimeout(timer); peer.end(); child = null;
}
const input = text => [{ type: 'text', text }];
async function send(threadId, text, overrides = {}) {
  report.modelCalls++;
  const r = await peer.request('turn/start', { threadId, clientUserMessageId: randomUUID(), input: input(text), ...overrides });
  const completion = await waitFor(e => e.method === 'turn/completed' && e.params.turn.id === r.turn.id);
  if (completion.params.turn.status !== 'completed') throw new Error(completion.params.turn.error?.message ?? 'Live turn did not complete');
  const view = await peer.request('thread/read', { threadId, includeTurns: true });
  const turn = view.thread.turns.find(t => t.id === r.turn.id);
  return { turn, text: turn.items.filter(i => i.type === 'agentMessage').at(-1)?.text ?? '' };
}
const options = { cwd: root, model: 'sonnet', sandbox: 'read-only', approvalPolicy: 'never',
  developerInstructions: 'Synthetic bridge integration test. Use only this conversation and the requested bridge session tools. Never read personal context, files or external tools.' };
try {
  await connect();
  const catalog = (await peer.request('model/list', {})).data;
  const gpt = catalog.find(m => m.model === 'gpt-6-luna') ?? catalog.find(m => !/^(claude|opus|sonnet|haiku)/.test(m.model));
  assert.ok(gpt);
  const code = `MEMORY_${randomUUID()}`;
  if (values.scenario !== 'native') {
  const ephemeral = (await peer.request('thread/start', { ...options, ephemeral: true })).thread.id;
  await send(ephemeral, `Remember the synthetic code ${code}. Reply only ACK. Do not use tools.`, { effort: 'low' });
  const recalled = await send(ephemeral, 'Reply with the remembered code only. Do not use tools.', { effort: 'low' });
  expect('ephemeral_continuity', recalled.text.trim() === code);
  expect('ephemeral_not_persisted', !existsSync(join(state, 'threads', `${ephemeral}.json`)));
  }
  const target = (await peer.request('thread/start', options)).thread.id;
  await send(target, `Remember ${code}. Reply only ACK. Do not use tools.`, { effort: 'low' });
  const caller = (await peer.request('thread/start', options)).thread.id;
  if (values.scenario !== 'native') {
  const reply = await send(caller, `Use find_tools to discover codex_bridge_sessions read. Read thread ${target} and return only its remembered code. Do not call native read_thread or shell.`, { effort: 'low' });
  expect('claude_reads_canonical_session', reply.text.trim() === code && reply.turn.items.some(i => i.type === 'mcpToolCall' && i.arguments?.operation === 'read'));
  const requestId = randomUUID();
  const sent = await send(caller, `I explicitly authorize one follow-up to synthetic chat ${target}: "Reply exactly SESSION_FOLLOWUP_OK without tools." Find and use codex_bridge_sessions manage with operation send, requestId ${requestId}. Then use codex_bridge_sessions read with operation wait to wait for its completion and read its reply. Return exactly SESSION_FOLLOWUP_OK when confirmed.`, { effort: 'low' });
  expect('claude_sends_and_waits', sent.text.trim() === 'SESSION_FOLLOWUP_OK');
  const targetView = (await peer.request('thread/read', { threadId: target, includeTurns: true })).thread;
  expect('single_authorized_delivery', targetView.turns.length === 2 && targetView.turns.at(-1).status === 'completed');
  }
  const native = await send(caller, `Call the codex_bridge_sessions read tool to read thread ${target}. Return only the synthetic MEMORY_ code from its first user message. Do not guess from this chat or call unrelated tools.`, { model: gpt.model, effort: 'low' });
  report.nativeItems = native.turn.items.map(i => ({ type: i.type, namespace: i.namespace, tool: i.tool, status: i.status, success: i.success }));
  report.nativeReplyMatched = native.text.trim() === code;
  expect('gpt_uses_same_session_adapter', report.nativeReplyMatched && native.turn.items.some(i => i.type === 'dynamicToolCall' && i.namespace === 'codex_bridge_sessions' && i.success));
  await disconnect(); await connect();
  await peer.request('thread/resume', { threadId: caller, excludeTurns: true });
  const resumedNative = await send(caller, `Use codex_bridge_sessions read to read ${target} again after this restart. Return only the MEMORY_ code from that thread. Do not use any other tool.`, { effort: 'low' });
  expect('native_session_tools_survive_restart', resumedNative.text.trim() === code && resumedNative.turn.items.some(i => i.type === 'dynamicToolCall' && i.namespace === 'codex_bridge_sessions' && i.success));
  await peer.request('thread/resume', { threadId: target, excludeTurns: true });
  const restored = await send(target, 'Return only the remembered code. Do not use tools.', { effort: 'low' });
  expect('persisted_continuity_after_restart', restored.text.trim() === code);
  report.passed = true;
} catch (error) {
  report.passed = false; Object.assign(report, errorMetadata(error)); console.error('Live test failed:', report.errorCategory); process.exitCode = 1;
} finally {
  await disconnect();
  const directory = join(state, 'threads');
  for (const name of existsSync(directory) ? readdirSync(directory) : []) {
    const record = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    for (const id of [record.claudeSessionId, ...record.turns.map(t => t.claudeSessionId)]) if (id) allSessionIds.add(id);
  }
  let cleanupFailures = 0;
  for (const id of allSessionIds) try { await deleteSession(id, { dir: root }); } catch { cleanupFailures++; }
  report.cleanupFailures = cleanupFailures;
  rmSync(root, { recursive: true, force: true });
  if (values.report) writeFileSync(values.report, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
