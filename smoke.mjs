import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Peer } from './rpc.mjs';
import { isClaude } from './providers.mjs';
import { errorMetadata } from './logging.mjs';

// Public protocol only, separate temporary profile, no user/model prompt and no
// tool invocation. This checks protocol compatibility, not visible GUI behavior.
export async function compatibilityCheck(config, python, versions) {
  const state = mkdtempSync(join(tmpdir(), 'codex-claude-check-'));
  const child = spawn(python, [fileURLToPath(new URL('./launch.py', import.meta.url)), '--stdio', '--state', state,
    '--source', config.source, '--app', config.app], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BRIDGE_MIRROR: '0' } });
  let stderrBytes = 0;
  child.stderr.on('data', data => { stderrBytes += data.length; });
  const peer = new Peer(child.stdout, child.stdin, { request: async () => { throw new Error('Compatibility check cannot approve tools.'); } });
  let exited = false;
  const exit = new Promise(resolve => { child.once('exit', () => { exited = true; resolve(); }); child.once('error', () => { exited = true; peer.end(); resolve(); }); });
  const timer = setTimeout(() => { peer.end(); child.kill(); }, 90000);
  const checks = [];
  const expect = (name, value) => { if (!value) throw new Error(`Unsupported protocol shape: ${name}`); checks.push(name); };
  try {
    const initialized = await peer.request('initialize', { clientInfo: { name: 'codex-claude-check', version: versions.bridgeVersion }, capabilities: { experimentalApi: true } });
    expect('initialize', !!initialized);
    peer.notify('initialized', {});
    const models = await peer.request('model/list', { includeHidden: false, limit: 100 });
    const claude = models.data?.find(m => isClaude(m.model));
    const gpt = models.data?.find(m => !isClaude(m.model));
    expect('both_model_catalogs', claude && gpt);
    const options = { cwd: state, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' };
    const native = await peer.request('thread/start', { ...options, model: gpt.model });
    expect('native_thread', native.thread?.id && native.model === gpt.model);
    const managed = await peer.request('thread/start', { ...options, model: claude.model });
    expect('claude_thread', managed.thread?.id && managed.model === claude.model);
    await peer.request('thread/settings/update', { threadId: managed.thread.id, model: gpt.model });
    let view = await peer.request('thread/read', { threadId: managed.thread.id, includeTurns: true });
    expect('claude_to_native_settings', view.thread?.model === gpt.model);
    await peer.request('thread/settings/update', { threadId: managed.thread.id, model: claude.model });
    view = await peer.request('thread/read', { threadId: managed.thread.id, includeTurns: true });
    expect('native_to_claude_settings', view.thread?.model === claude.model);
    const queue = await peer.request('thread/queue/list', { threadId: managed.thread.id });
    expect('queue_contract', Array.isArray(queue.data));
    return { passed: true, checkedAt: new Date().toISOString(), versions, checks, modelCalls: 0, guiVerified: false, stderrBytes };
  } catch (error) {
    return { passed: false, checkedAt: new Date().toISOString(), versions, checks, ...errorMetadata(error), modelCalls: 0, guiVerified: false, stderrBytes };
  } finally {
    clearTimeout(timer); child.stdin.end();
    const kill = setTimeout(() => child.kill(), 5000); kill.unref();
    await exit; clearTimeout(kill); peer.end();
    if (exited) rmSync(state, { recursive: true, force: true });
  }
}
