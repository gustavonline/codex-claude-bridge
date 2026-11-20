// Explicit opt-in (--run): a REAL GPT-first Codex chat (the real native app-server under Bridge, on a copy of this machine's own Codex login
// in a disposable profile) uses Bridge's session tools to create a REAL Gemini child through Antigravity, reads its mailbox question, replies,
// and reads its answer. Desktop GUI and browser are not involved. Test budget: the GPT model must be a Luna model the runtime advertises, at
// low effort; Gemini via Antigravity is cost-exempt. Prints a report with every model call counted.
// Usage: node scripts/live-orchestration.mjs --run --gpt-model gpt-6-luna [--codex <codex>] [--agy agy] [--source <CODEX_HOME with auth.json>]
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Peer } from '../rpc.mjs';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, 'gpt-model': { type: 'string' }, codex: { type: 'string', default: 'codex' }, agy: { type: 'string', default: 'agy' }, source: { type: 'string' } } });
if (!values.run) throw new Error('This sends a few real GPT (cheapest tier) and Gemini turns. Pass --run.');
const gptModel = values['gpt-model'];
if (!/^gpt-[\w.]+-luna$/.test(gptModel ?? '')) throw new Error('Live tests run only on the cheapest GPT tier: pass --gpt-model gpt-<version>-luna as advertised by model/list.');
const source = values.source ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
if (!existsSync(join(source, 'auth.json'))) throw new Error(`No Codex login at ${source}`);
const root = mkdtempSync(join(tmpdir(), 'bridge-live-orch-')), home = join(root, 'codex'), state = join(root, 'state'), ws = join(root, 'workspace');
for (const d of [home, state, ws]) mkdirSync(d, { recursive: true, mode: 0o700 });
copyFileSync(join(source, 'auth.json'), join(home, 'auth.json')); chmodSync(join(home, 'auth.json'), 0o600);
writeFileSync(join(home, 'config.toml'), `model = "${gptModel}"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "read-only"\n`, { mode: 0o600 });
writeFileSync(join(ws, 'README.txt'), 'synthetic orchestration workspace\n');
const report = { gptModel, gptEffort: 'low', gptTurns: 0, geminiTurns: 0, steps: [] }, events = [], waiters = new Set();
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE|OPENAI_API|GEMINI_|GOOGLE_)/.test(k)));
const child = spawn(process.execPath, [fileURLToPath(new URL('../bridge.mjs', import.meta.url)), 'app-server'], { cwd: ws, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...env, CODEX_HOME: home, BRIDGE_REAL_CODEX: values.codex, BRIDGE_STATE: join(state, 'bridge'), BRIDGE_COORDINATOR: '1', BRIDGE_MIRROR: '0', BRIDGE_AGY: values.agy } });
let stderr = ''; child.stderr.on('data', b => { stderr = (stderr + b).slice(-4000); });
const peer = new Peer(child.stdout, child.stdin, {
  request: async method => { throw new Error(`This test approves nothing and offers no desktop tools (${method})`); },
  notify: (method, params) => { const e = { method, params }; events.push(e); for (const w of waiters) if (w.p(e)) { waiters.delete(w); clearTimeout(w.t); w.r(e); } },
});
const waitFor = (p, ms = 300_000) => new Promise((r, j) => { const old = events.find(p); if (old) return r(old); const w = { p, r, t: setTimeout(() => { waiters.delete(w); j(new Error('timed out')); }, ms) }; waiters.add(w); });
async function gpt(threadId, text) {
  report.gptTurns++;
  const t = await peer.request('turn/start', { threadId, model: gptModel, effort: 'low', clientUserMessageId: randomUUID(), input: [{ type: 'text', text }] });
  const done = await waitFor(e => e.method === 'turn/completed' && e.params.turn.id === t.turn.id);
  const view = await peer.request('thread/read', { threadId, includeTurns: true }), turn = view.thread.turns.find(x => x.id === t.turn.id);
  const tools = turn.items.filter(i => i.type === 'dynamicToolCall').map(i => `${i.tool}:${i.success === false ? 'failed' : 'ok'}`);
  return { status: done.params.turn.status, text: turn.items.filter(i => i.type === 'agentMessage').map(i => i.text).join(' ').trim(), tools };
}
try {
  await peer.request('initialize', { clientInfo: { name: 'bridge-live-orchestration', version: '1' }, capabilities: { experimentalApi: true } }); peer.notify('initialized', {});
  const list = (await peer.request('model/list', {})).data;
  if (!list.some(m => m.id === gptModel)) throw new Error(`${gptModel} is not advertised by model/list; no model was called.`);
  const parent = (await peer.request('thread/start', { cwd: ws, model: gptModel, approvalPolicy: 'never', sandbox: 'read-only' })).thread.id;
  report.parent = parent;
  const one = await gpt(parent, 'This is a synthetic integration test of the codex_bridge_sessions tools. Do exactly this, using only those tools: '
    + '1) Call manage with operation create, model "antigravity/gemini-3.8-flash", requestId "gpt-gemini-000001" and text: '
    + '"Use the codex_bridge_sessions mailbox tool (find it with find_tools) with operation report, kind question, requestId ask-number-0001 and text: Which number should I double? Then reply WAITING." '
    + '2) Call read with operation wait, threadId = the created threadId, timeoutMs 60000. 3) Call mailbox with operation inbox and ack true. '
    + 'Then reply with only: CHILD=<the created threadId> QUESTION=<the question text you received>.');
  report.steps.push({ step: 'create+wait+inbox', ...one });
  const childId = /CHILD=([0-9a-f-]{36})/.exec(one.text)?.[1]; report.child = childId;
  if (!childId) throw new Error('GPT did not report the child: ' + one.text.slice(0, 300));
  for (let i = 0; i < 600; i++) { const v = await peer.request('thread/read', { threadId: childId, includeTurns: true }); if (v.thread.status?.type !== 'active') break; await new Promise(r => setTimeout(r, 500)); }
  report.geminiTurns++;
  const two = await gpt(parent, `Using only the codex_bridge_sessions tools: call manage with operation send, threadId "${childId}", requestId "gpt-reply-0000001" and text "Double 21. Reply with only the number.", `
    + `then call read with operation wait, threadId "${childId}", timeoutMs 60000, and reply with only: ANSWER=<the child's latest reply>.`);
  report.steps.push({ step: 'send+wait', ...two }); report.geminiTurns++;
  const childView = await peer.request('thread/read', { threadId: childId, includeTurns: true });
  report.child = { id: childId, modelProvider: childView.thread.modelProvider, turns: childView.thread.turns.map(t => ({ status: t.status, reply: t.items.filter(i => i.type === 'agentMessage').map(i => i.text).join(' ').trim().slice(0, 120) })) };
  report.passed = /which number/i.test(one.text) && /42/.test(two.text) && report.child.turns.at(-1)?.reply.includes('42');
} catch (error) { report.error = error.message; report.stderr = stderr.slice(-1500); }
finally { child.stdin.end(); await new Promise(r => setTimeout(r, 1500)); child.kill(); rmSync(root, { recursive: true, force: true }); }
report.modelCalls = { gpt: `${report.gptTurns} turn(s) on ${gptModel} at low effort`, gemini: `${report.geminiTurns} turn(s) on gemini-3.8-flash (cost-exempt)` };
console.log(JSON.stringify(report, null, 1));
