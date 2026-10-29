import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Peer } from './rpc.mjs';
import { isClaude } from './providers.mjs';
import { errorMetadata } from './logging.mjs';

// What a passing report covers. Earlier reports have no scope: their check
// copied the owner's Codex configuration, so they are never reused as this one.
export const compatibilityScope = 'synthetic-profile/1';

// Public protocol only, no user/model prompt and no tool invocation. The Codex
// source and profile are fresh and synthetic, under one temporary directory:
// nothing is read or copied from the owner's Codex profile (config.source is not
// used). This checks that the selected app's Codex CLI, Claude Code and this
// Bridge work together; it does not check the owner's configuration, catalog,
// permissions or plugins, nor visible GUI behavior.
export async function compatibilityCheck(config, python, versions, { timeout = 90000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'codex-claude-check-'));
  const source = join(root, 'source'), state = join(root, 'state'), workspace = join(root, 'workspace');
  for (const path of [source, workspace]) mkdirSync(path, { mode: 0o700 });
  const child = spawn(python, [fileURLToPath(new URL('./launch.py', import.meta.url)), '--stdio', '--state', state,
    '--source', source, '--app', config.app, '--no-auth-copy'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, BRIDGE_MIRROR: '0' } });
  let stderrBytes = 0;
  child.stderr.on('data', data => { stderrBytes += data.length; });
  const peer = new Peer(child.stdout, child.stdin, { request: async () => { throw new Error('Compatibility check cannot approve tools.'); } });
  let exited = false;
  const exit = new Promise(resolve => { child.once('exit', () => { exited = true; resolve(); }); child.once('error', () => { exited = true; peer.end(); resolve(); }); });
  const timer = setTimeout(() => { peer.end(); child.kill(); }, timeout);
  const checks = [];
  const expect = (name, value) => { if (!value) throw new Error(`Unsupported protocol shape: ${name}`); checks.push(name); };
  const scope = { scope: compatibilityScope, modelCalls: 0, guiVerified: false, ownerProfileVerified: false };
  try {
    const initialized = await peer.request('initialize', { clientInfo: { name: 'codex-claude-check', version: versions.bridgeVersion }, capabilities: { experimentalApi: true } });
    expect('initialize', !!initialized);
    peer.notify('initialized', {});
    const models = await peer.request('model/list', { includeHidden: false, limit: 100 });
    const claude = models.data?.find(m => isClaude(m.model));
    const gpt = models.data?.find(m => !isClaude(m.model));
    expect('both_model_catalogs', claude && gpt);
    const options = { cwd: workspace, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' };
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
    // The profile the app-server used was prepared from the empty synthetic source.
    const snapshot = JSON.parse(readFileSync(join(state, 'snapshot.json'), 'utf8'));
    expect('synthetic_profile', realpathSync(snapshot.source) === realpathSync(source) && readdirSync(source).length === 0);
    expect('no_auth_copy', !existsSync(join(state, 'codex', 'auth.json')));
    return { passed: true, checkedAt: new Date().toISOString(), versions, checks, ...scope, stderrBytes };
  } catch (error) {
    return { passed: false, checkedAt: new Date().toISOString(), versions, checks, ...errorMetadata(error), ...scope, stderrBytes };
  } finally {
    clearTimeout(timer); child.stdin.end();
    const kill = setTimeout(() => child.kill(), 5000); kill.unref();
    await exit; clearTimeout(kill); peer.end();
    // Only this check's own temporary directory is removed, once its child has exited.
    if (exited) rmSync(root, { recursive: true, force: true });
  }
}
