// Antigravity (Google's official `agy acp`) as a Bridge harness: one ACP session inside the whole-process boundary of harness-sandbox.mjs.
// Layers, outermost first: the OS boundary (read-only filesystem except agy's own state, no network but Google's endpoints, own PID namespace);
// an MCP-only main agent (`tools: []`, so agy has no native file, shell or web tools); and the permission answer, which admits only the exact
// Codex MCP tools Bridge serves. Every effect therefore goes through Codex's own tools, its sandbox and its approvals, as for Claude Code.
// The catalog is what the signed-in account's session reports; nothing is added. Linux only: elsewhere `open` refuses before starting anything.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { sandboxAvailable, sandboxRunDir, startSandboxed } from './harness-sandbox.mjs';
import { antigravityLaunch } from './plugins/codex-claude/home/harnesses.mjs';

export const googleEndpoints = Object.freeze(['daily-cloudcode-pa.googleapis.com:443', 'oauth2.googleapis.com:443']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

// The MCP-only main agent definition agy loads with --agent (written by the caller into agy's own config/agents, never into a workspace).
export const agentDefinition = name => `---\nname: ${name}\ndescription: Model Bridge main agent. It may use only the Codex tools Bridge supplies.\nmainAgent: true\nsubagent: false\ntools: []\n---\nYou are running beneath the Codex desktop app. Use only the tools you have; every action goes through them.\n`;

// The permission answer: allow exactly the Codex MCP tools Bridge serves (agy titles them "Run mcp_codex_<tool>"), deny everything else.
export function permissionAnswer(request, codexTools) {
  const title = request?.toolCall?.title ?? '', options = Array.isArray(request?.options) ? request.options : [];
  const tool = /^Run mcp_codex_([A-Za-z0-9_.-]{1,128})$/.exec(title)?.[1];
  const allow = tool !== undefined && codexTools.has(tool);
  const pick = allow ? options.find(o => o.kind === 'allow_once') : options.find(o => o.kind === 'reject_once') ?? options.find(o => String(o.kind).startsWith('reject'));
  return { allowed: allow && !!pick, outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } };
}

// The session's own catalog: models and thinking levels exactly as the account reports them (config options `model` and `thought_level`).
export function catalogOf(session) {
  const options = Array.isArray(session?.configOptions) ? session.configOptions : [];
  const values = id => (options.find(o => o.id === id && o.type === 'select')?.options ?? []).flatMap(o => 'value' in o ? [{ id: o.value, name: o.name ?? o.value }] : (o.options ?? []).map(x => ({ id: x.value, name: x.name ?? x.value })));
  return { models: values('model'), levels: values('thought_level').map(l => l.id), current: { model: options.find(o => o.id === 'model')?.currentValue ?? null, level: options.find(o => o.id === 'thought_level')?.currentValue ?? null } };
}

// A JSON-RPC client over the harness's stdio (newline-delimited, bounded lines), answering agent requests through `onRequest`.
export function acpClient(child, { onRequest, onNotification, maxLine = 8 * 1024 * 1024 }) {
  let buffer = '', id = 0, closed = false; const waiting = new Map();
  const send = message => { if (!closed) child.stdin.write(JSON.stringify(message) + '\n'); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk; if (buffer.length > maxLine && !buffer.includes('\n')) { buffer = ''; return; }
    let n;
    while ((n = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id != null && !m.method) { const w = waiting.get(m.id); waiting.delete(m.id); w?.(m); }
      else if (m.method && m.id != null) Promise.resolve().then(() => onRequest(m.method, m.params)).then(result => send({ jsonrpc: '2.0', id: m.id, result }), () => send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Not supported by Model Bridge' } }));
      else if (m.method) onNotification(m.method, m.params);
    }
  });
  const end = () => { closed = true; for (const w of waiting.values()) w({ error: { code: -32000, message: 'Antigravity ended' } }); waiting.clear(); };
  child.once('exit', end); child.stdin.on('error', end);
  const request = (method, params, ms = 120_000) => new Promise((resolve, reject) => {
    if (closed) { reject(Object.assign(new Error('Antigravity ended'), { code: 'harness_exited' })); return; }
    const i = ++id, timer = setTimeout(() => { waiting.delete(i); reject(Object.assign(new Error(`Antigravity did not answer ${method} in time`), { code: 'harness_timeout' })); }, ms);
    waiting.set(i, m => { clearTimeout(timer); m.error ? reject(Object.assign(new Error(`${method}: ${m.error.message}`), { code: 'harness_error', rpc: m.error })) : resolve(m.result); });
    send({ jsonrpc: '2.0', id: i, method, params });
  });
  return { request, notify: (method, params) => send({ jsonrpc: '2.0', method, params }) };
}

// Opens one Antigravity session. `mcpHandler(req, res)` serves Bridge's Codex MCP tools over HTTP; `codexTools` are their names; `onEvent`
// receives { type: 'text', text } | { type: 'tool', id, title, status } | { type: 'permission', title, allowed }. `start` is injectable for tests.
export async function open({ executable, cwd, home, agentName, mcpHandler, codexTools, onEvent = () => {}, env = process.env, start = startSandboxed, available = sandboxAvailable, resume = null, resumeMethod = 'session/resume' }) {
  if (!(await available())) fail('harness_boundary_unavailable', 'Antigravity needs Model Bridge\'s process sandbox, which is not available on this system, so nothing was started.');
  const runDir = sandboxRunDir(), mcpSocket = join(runDir, 'mcp.sock'), http = createServer(mcpHandler);
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(mcpSocket, resolve); });
  // The real install path: the sandbox mounts the runtime's own directory, so a symlinked `agy` is resolved first.
  const spec = antigravityLaunch({ executable: realpathSync(executable), logDir: runDir, env });
  let box;
  try { box = await start({ command: spec.command, args: [...spec.args, '--agent', agentName], cwd, env: { ...spec.env, TMPDIR: '/tmp' }, writable: [join(home, '.gemini')], allow: googleEndpoints, mcpSocket, runDir }); }
  catch (error) { http.close(); throw error; }
  let sessionId = null;
  const acp = acpClient(box.child, {
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission' || params?.sessionId !== sessionId) throw new Error('unsupported');
      const answer = permissionAnswer(params, codexTools); onEvent({ type: 'permission', title: String(params.toolCall?.title ?? '').slice(0, 200), allowed: answer.allowed });
      return { outcome: answer.outcome };
    },
    onNotification: (method, params) => {
      if (method !== 'session/update' || params?.sessionId !== sessionId) return;
      const u = params.update ?? {};
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') onEvent({ type: 'text', text: u.content.text });
      else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') onEvent({ type: 'tool', id: u.toolCallId, title: u.title ?? null, status: u.status ?? null });
    },
  });
  const close = async () => { const r = await box.close(); http.close(); return r; };
  try {
    await acp.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'model-bridge', version: '0.3.0' } });
    await acp.request('authenticate', { methodId: spec.authMethod });
    // A follow-up turn continues the chat's own agy session (resume: no history replay); a new chat gets a new session.
    const mcpServers = [{ type: 'http', name: 'codex', url: box.mcpUrl, headers: [] }];
    if (resume) sessionId = resume;
    const session = resume ? { sessionId: resume, ...(await acp.request(resumeMethod, { sessionId: resume, cwd, mcpServers })) } : await acp.request('session/new', { cwd, mcpServers });
    sessionId = session.sessionId;
    return {
      sessionId, catalog: catalogOf(session), decisions: box.decisions,
      // Model and thinking level are chosen from the session's own options; anything else is refused before it is sent.
      async configure({ model, level }) {
        const catalog = catalogOf(session);
        if (model != null) { if (!catalog.models.some(m => m.id === model)) fail('model_not_available', 'That model is not offered by this Antigravity account.'); await acp.request('session/set_config_option', { sessionId, configId: 'model', value: model }); }
        if (level != null) { if (!catalog.levels.includes(level)) fail('unsupported_reasoning_effort', 'That thinking level is not offered for this model.'); await acp.request('session/set_config_option', { sessionId, configId: 'thought_level', value: level }); }
      },
      // A prompt that outlives its bound is cancelled in the agent too, not only abandoned here.
      prompt: async (text, { timeoutMs = 30 * 60_000 } = {}) => {
        try { return await acp.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, timeoutMs); }
        catch (error) { if (error.code === 'harness_timeout') acp.notify('session/cancel', { sessionId }); throw error; }
      },
      cancel: () => acp.notify('session/cancel', { sessionId }),
      close,
    };
  } catch (error) { await close(); throw error; }
}
