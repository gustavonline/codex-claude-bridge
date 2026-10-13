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

const { values } = parseArgs({ options: { run: { type: 'boolean' }, 'copy-codex-auth': { type: 'boolean' }, scenario: { type: 'string' }, app: { type: 'string' }, source: { type: 'string' }, report: { type: 'string' } } });
if (!values.run) throw new Error('This test consumes Claude and Codex quota. Pass --run to authorize synthetic test turns.');
if (!values['copy-codex-auth']) throw new Error('Live GPT checks copy Codex auth.json to disposable private state. Pass --copy-codex-auth to opt in; compatibility checks need no auth copy.');
if (values.scenario && !['native', 'steering', 'lifecycle'].includes(values.scenario)) throw new Error('Unknown scenario');
const root = mkdtempSync(join(tmpdir(), 'bridge-live-')), source = join(root, 'source'), state = join(root, 'state');
mkdirSync(source, { mode: 0o700 });
writeFileSync(join(source, 'config.toml'), 'model_provider = "openai"\n', { mode: 0o600 });
const auth = join(values.source ?? join(homedir(), '.codex'), 'auth.json');
if (existsSync(auth)) {
  const profile = join(state, 'codex'); mkdirSync(profile, { recursive: true, mode: 0o700 });
  copyFileSync(auth, join(profile, 'auth.json')); chmodSync(join(profile, 'auth.json'), 0o600);
}
const report = { checkedAt: new Date().toISOString(), checks: [], modelCalls: 0, guiVerified: false };
let child, peer, exited, events, waiters, allSessionIds = new Set();
const toolGates = new Map();
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
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
    request: async (method, params) => {
      const gate = toolGates.get(params.threadId);
      if (method === 'item/tool/call' && params.tool === 'steering_gate' && gate) {
        gate.entered.resolve(); await gate.release.promise;
        if (gate.archiveOnRelease) {
          try {
            await peer.request('thread/archive', { threadId: params.threadId });
            gate.archived = true;
          } finally { gate.archiveFinished.resolve(); }
        }
        return { success: true, contentItems: [{ type: 'inputText', text: 'Synthetic gate released. Follow the latest user instruction.' }] };
      }
      throw new Error('This test cannot approve tools or access the desktop');
    },
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
  const submission = { threadId, clientUserMessageId: randomUUID(), input: input(text), ...overrides };
  const r = await peer.request('turn/start', submission);
  const completion = await waitFor(e => e.method === 'turn/completed' && e.params.turn.id === r.turn.id);
  if (completion.params.turn.status !== 'completed') throw new Error(completion.params.turn.error?.message ?? 'Live turn did not complete');
  const view = await peer.request('thread/read', { threadId, includeTurns: true });
  const turn = view.thread.turns.find(t => t.id === r.turn.id);
  return { turn, submission, text: turn.items.filter(i => i.type === 'agentMessage').at(-1)?.text ?? '' };
}
const options = { cwd: root, model: 'sonnet', sandbox: 'read-only', approvalPolicy: 'never',
  developerInstructions: 'Synthetic bridge integration test. Use only this conversation and the requested bridge session tools. Never read personal context, files or external tools.' };
try {
  await connect();
  const catalog = (await peer.request('model/list', {})).data;
  const gpt = catalog.find(m => m.model === 'gpt-6-luna') ?? catalog.find(m => !/^(claude|opus|sonnet|haiku)/.test(m.model));
  assert.ok(gpt);
  if (values.scenario === 'lifecycle') {
    const cases = [];
    for (const model of ['sonnet', gpt.model]) {
      const threadId = (await peer.request('thread/start', { ...options, dynamicTools: [
        { type: 'function', name: 'steering_gate', description: 'Synthetic lifecycle test gate; archives this disposable chat when released. Call once when instructed.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ] })).thread.id;
      const marker = `PREFIX_${randomUUID()}`;
      const first = await send(threadId, `Remember ${marker}. Reply only ACK. Do not use tools.`, { model, effort: 'low' });
      const gate = { entered: deferred(), release: deferred(), archiveFinished: deferred(), archiveOnRelease: true }; toolGates.set(threadId, gate);
      report.modelCalls++;
      const started = await peer.request('turn/start', { threadId, model, effort: 'low', clientUserMessageId: randomUUID(),
        input: input('Find and call steering_gate once. I authorize it to archive this synthetic chat. After it returns, reply ARCHIVED_OK. Do not use any other tools.') });
      let timer;
      try {
        await Promise.race([gate.entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Live lifecycle gate timed out')), 60000); })]);
        const fork = (await peer.request('thread/fork', { threadId })).thread;
        expect(`${model}_active_fork_retains_only_finished_prefix`, fork.turns.length === 1 && fork.turns[0].id === first.turn.id && fork.id !== threadId);
        const reopened = await peer.request('thread/resume', { threadId: fork.id, path: fork.path, initialTurnsPage: { limit: 5, sortDirection: 'asc' } });
        expect(`${model}_fork_reopens_with_native_path`, typeof fork.path === 'string' && reopened.initialTurnsPage.data.length === 1 && reopened.initialTurnsPage.data[0].id === first.turn.id);
        const parent = (await peer.request('thread/read', { threadId, includeTurns: true })).thread;
        expect(`${model}_parent_keeps_running`, parent.status.type === 'active' && parent.turns.at(-1).id === started.turn.id);
        await assert.rejects(peer.request('thread/fork', { threadId, lastTurnId: started.turn.id }));
        expect(`${model}_partial_turn_fork_rejected`, true);
        const queued = (await peer.request('thread/queue/add', { threadId, clientUserMessageId: randomUUID(), input: input('This queued input must remain paused after archive.') })).queuedSubmission;
        gate.release.resolve();
        const completed = await waitFor(e => e.method === 'turn/completed' && e.params.turn.id === started.turn.id);
        // Native archive can interrupt GPT before the archive RPC responds.
        // Completion alone is not evidence that the enclosing tool has returned.
        await gate.archiveFinished.promise;
        expect(`${model}_self_archive_acknowledged`, gate.archived === true);
        expect(`${model}_self_archive_turn_terminal`, model === 'sonnet' ? completed.params.turn.status === 'completed' : ['completed', 'interrupted'].includes(completed.params.turn.status));
        const saved = JSON.parse(readFileSync(join(state, 'threads', `${threadId}.json`), 'utf8'));
        expect(`${model}_archive_and_history_persisted`, saved.archived === true && saved.turns.length === 2);
        expect(`${model}_archive_pauses_queue`, (await peer.request('thread/queue/list', { threadId })).data[0]?.id === queued.id);
        await peer.request('thread/unarchive', { threadId });
        expect(`${model}_unarchive_keeps_queue_paused`, (await peer.request('thread/queue/list', { threadId })).data[0]?.id === queued.id);
        await peer.request('thread/queue/delete', { threadId, queuedSubmissionId: queued.id });
        const childModel = model === 'sonnet' ? gpt.model : 'sonnet';
        const child = await send(fork.id, 'Reply with the remembered PREFIX code only. Do not use tools.', { model: childModel, effort: 'low' });
        expect(`${model}_fork_handoff_memory`, child.text.includes(marker));
        cases.push({ threadId: fork.id, path: fork.path, model: childModel, marker });
      } finally { clearTimeout(timer); gate.release.resolve(); toolGates.delete(threadId); }
    }
    await disconnect(); await connect();
    for (const c of cases) {
      const reopened = await peer.request('thread/resume', { threadId: c.threadId, path: c.path, initialTurnsPage: { limit: 5, sortDirection: 'asc' } });
      expect(`${c.model}_fork_reopens_after_restart`, reopened.initialTurnsPage.data.length === 2);
      const recall = await send(c.threadId, 'Reply with the remembered PREFIX code only. Do not use tools.', { model: c.model, effort: 'low' });
      expect(`${c.model}_fork_memory_after_restart`, recall.text.includes(c.marker));
    }
  } else if (values.scenario === 'steering') {
    report.steeringSubmissions = 0;
    const cases = [];
    for (const model of ['sonnet', gpt.model]) {
      const threadId = (await peer.request('thread/start', { ...options, dynamicTools: [
        { type: 'function', name: 'steering_gate', description: 'Synthetic test gate. Call once when instructed.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      ] })).thread.id;
      const gate = { entered: deferred(), release: deferred() }; toolGates.set(threadId, gate);
      const marker = `LATEST_${randomUUID()}`;
      report.modelCalls++;
      const started = await peer.request('turn/start', { threadId, model, effort: 'low', clientUserMessageId: randomUUID(),
        input: input('Find and call steering_gate once. It is the only tool to use. After it returns, reply INITIAL unless a later user instruction changes that reply.') });
      let timer;
      try {
        await Promise.race([gate.entered.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Live steering gate timed out')), 60000); })]);
        const first = { threadId, expectedTurnId: started.turn.id, clientUserMessageId: randomUUID(), input: input('Change the final reply to INTERMEDIATE. Do not call any more tools.') };
        const queued = (await peer.request('thread/queue/add', { threadId, clientUserMessageId: randomUUID(), input: input(`Change the final reply to ${marker}. This latest instruction supersedes INTERMEDIATE. Do not call any more tools.`) })).queuedSubmission;
        const steered = await peer.request('turn/steer', first); report.steeringSubmissions++;
        const promoted = await peer.request('thread/queue/start', { threadId, queuedSubmissionId: queued.id }); report.steeringSubmissions++;
        expect(`${model}_steers_same_turn`, steered.turnId === started.turn.id && promoted.turn.id === started.turn.id);
        expect(`${model}_queue_promoted_once`, (await peer.request('thread/queue/list', { threadId })).data.length === 0);
        await assert.rejects(peer.request('turn/steer', { ...first, expectedTurnId: randomUUID() }));
        gate.release.resolve();
        const completed = await waitFor(e => e.method === 'turn/completed' && e.params.turn.id === started.turn.id);
        if (completed.params.turn.status !== 'completed') report.failedTurn = completed.params.turn;
        expect(`${model}_turn_completes`, completed.params.turn.status === 'completed');
        const view = (await peer.request('thread/read', { threadId, includeTurns: true })).thread;
        const turn = view.turns[0], reply = turn.items.filter(i => i.type === 'agentMessage').at(-1)?.text ?? '';
        expect(`${model}_latest_instruction_used`, reply.includes(marker));
        expect(`${model}_all_inputs_retained`, view.turns.length === 1 && turn.items.filter(i => i.type === 'userMessage').length === 3);
        expect(`${model}_single_lifecycle`, events.filter(e => e.method === 'turn/completed' && e.params.turn.id === started.turn.id).length === 1);
        cases.push({ threadId, first, queued, turnId: started.turn.id, marker, model });
      } finally { clearTimeout(timer); gate.release.resolve(); }
    }
    await disconnect(); await connect();
    for (const c of cases) {
      await peer.request('thread/resume', { threadId: c.threadId, excludeTurns: true });
      const a = await peer.request('turn/steer', c.first);
      const b = await peer.request('thread/queue/start', { threadId: c.threadId, queuedSubmissionId: c.queued.id });
      expect(`${c.model}_retry_after_restart`, a.turnId === c.turnId && b.turn.id === c.turnId);
      const recall = await send(c.threadId, 'Return only the exact LATEST_ code from my most recent steering instruction. Use no tools.', { effort: 'low' });
      expect(`${c.model}_steering_memory_after_restart`, recall.text.includes(c.marker));
    }
  } else {
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
  const retry = await peer.request('turn/start', native.submission);
  const retryView = (await peer.request('thread/read', { threadId: caller, includeTurns: true })).thread;
  expect('native_delivery_retry_after_restart', retry.turn.id === native.turn.id
    && retryView.turns.at(-1).id === native.turn.id && retryView.turns.at(-1).status === 'completed');
  const resumedNative = await send(caller, `Use codex_bridge_sessions read to read ${target} again after this restart. Return only the MEMORY_ code from that thread. Do not use any other tool.`, { effort: 'low' });
  expect('native_session_tools_survive_restart', resumedNative.text.trim() === code && resumedNative.turn.items.some(i => i.type === 'dynamicToolCall' && i.namespace === 'codex_bridge_sessions' && i.success));
  await peer.request('thread/resume', { threadId: target, excludeTurns: true });
  const restored = await send(target, 'Return only the remembered code. Do not use tools.', { effort: 'low' });
  expect('persisted_continuity_after_restart', restored.text.trim() === code);
  }
  report.passed = true;
} catch (error) {
  report.passed = false; Object.assign(report, errorMetadata(error)); console.error('Live test failed:', report.errorCategory); process.exitCode = 1;
} finally {
  for (const gate of toolGates.values()) gate.release.resolve();
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
