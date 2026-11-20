// Whole-process boundary for an agent harness that runs its own tools (Linux: bubblewrap). Everything the harness and anything it starts
// (its shell, hooks, plugins, MCP children) can do is bounded by the OS, not by the harness's own permission prompts:
//  - the filesystem is read-only, the workspace included; only the harness's own state directories and a private /tmp are writable;
//  - there is no network: the process sees loopback only. Outbound HTTPS leaves through a Bridge-side CONNECT proxy that admits exact
//    host:443 pairs (the provider's own endpoints), and Bridge's MCP endpoint is reachable on loopback. Both are relayed over Unix sockets;
//  - it has its own PID namespace, so every child it started dies with it, and closing stdin or killing the sandbox ends the whole tree.
// macOS has no bubblewrap: this boundary is Linux-only, and a harness that needs it is refused elsewhere.
import { spawn, execFileSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtempSync, rmSync, accessSync, constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const relay = fileURLToPath(new URL('./harness-relay.mjs', import.meta.url));
export const bwrapPath = '/usr/bin/bwrap';
export function sandboxAvailable({ platform = process.platform, path = bwrapPath } = {}) {
  if (platform !== 'linux') return false;
  try { accessSync(path, constants.X_OK); execFileSync(path, ['--ro-bind', '/', '/', '--unshare-net', '--unshare-pid', '--die-with-parent', '--', '/bin/true'], { stdio: 'ignore', timeout: 5000 }); return true; }
  catch { return false; }
}

// An HTTPS CONNECT proxy on a Unix socket that admits only `allow` (exact "host:443" strings) and reports every decision (host only, never data).
// When the host itself must reach the internet through a configured proxy (`upstream`, e.g. its HTTPS_PROXY), an admitted tunnel is chained
// through it with its own CONNECT; the allowlist is applied first either way. TLS stays end to end between the harness and the provider.
export function upstreamProxy(env = process.env) {
  const value = env.HTTPS_PROXY ?? env.https_proxy; if (!value) return null;
  try { const u = new URL(value); return u.protocol === 'http:' && !u.username ? { host: u.hostname, port: Number(u.port || 80) } : null; } catch { return null; }
}
export function allowlistProxy(socketPath, allow, { onDecision = () => {}, connectTcp = connect, upstream = null } = {}) {
  const allowed = new Set(allow);
  const server = createServer(client => {
    let head = Buffer.alloc(0);
    const onData = chunk => {
      head = Buffer.concat([head, chunk]); const end = head.indexOf('\r\n\r\n');
      if (end < 0) { if (head.length > 8192) client.destroy(); return; }
      client.off('data', onData);
      const [method, target] = head.subarray(0, end).toString('latin1').split('\r\n')[0].split(' ');
      const ok = method === 'CONNECT' && allowed.has(target);
      onDecision({ target: String(target).slice(0, 200), allowed: ok });
      if (!ok) { client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return; }
      const [host, port] = target.split(':'), rest = head.subarray(end + 4);
      // Our reply always precedes any tunnel bytes (`early` are bytes the upstream sent right after its own 200).
      const join = (remote, early = null) => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (early?.length) client.write(early); if (rest.length) remote.write(rest); client.pipe(remote); remote.pipe(client); };
      const remote = upstream ? connectTcp({ host: upstream.host, port: upstream.port }) : connectTcp({ host, port: Number(port) });
      remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy());
      if (!upstream) { remote.once('connect', () => join(remote)); return; }
      remote.once('connect', () => remote.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let reply = Buffer.alloc(0);
      const onReply = b => {
        reply = Buffer.concat([reply, b]); const e = reply.indexOf('\r\n\r\n'); if (e < 0) { if (reply.length > 8192) remote.destroy(); return; }
        remote.off('data', onReply);
        if (!/^HTTP\/1\.[01] 200/.test(reply.subarray(0, e).toString('latin1'))) { client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'); remote.destroy(); return; }
        join(remote, reply.subarray(e + 4));
      };
      remote.on('data', onReply);
    };
    client.on('data', onData); client.on('error', () => {});
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => resolve(server)); });
}

// The bubblewrap argument list. `writable` are the harness's own state directories (absolute, created by the caller); nothing else is writable.
export function bwrapArgs({ writable = [], runDir, cwd, env }) {
  for (const p of [...writable, runDir, cwd]) if (!isAbsolute(p ?? '')) throw Object.assign(new Error('Sandbox paths must be absolute'), { code: 'sandbox_invalid' });
  // A writable directory that contains the workspace would make the workspace writable again: refused.
  const inside = (dir, path) => path === dir || path.startsWith(dir.endsWith('/') ? dir : dir + '/');
  if ([...writable, runDir].some(dir => inside(dir, cwd))) throw Object.assign(new Error('A writable sandbox directory may not contain the workspace'), { code: 'sandbox_invalid' });
  // The private /tmp is mounted first; the workspace (read-only) and the writable directories are bound after it, so a path under /tmp stays visible.
  return ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--ro-bind', cwd, cwd,
    ...writable.flatMap(p => ['--bind', p, p]), '--bind', runDir, runDir,
    '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session', '--die-with-parent', '--clearenv',
    ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, String(v)]), '--chdir', cwd];
}

// A private, short run directory for the sandbox's Unix sockets (a socket path is limited to about 104-108 bytes).
export const sandboxRunDir = () => mkdtempSync(join(tmpdir(), 'bridge-sbx-'));
const socketOk = path => Buffer.byteLength(path) <= 100;
// Starts `command args` inside the boundary. `allow` are the CONNECT targets; `mcpSocket`, when given, is exposed inside as http://127.0.0.1:<port>.
// Returns the child (stdio piped, for ACP), the inner MCP port, the proxy decisions, and close() that ends the whole tree and removes the run dir.
export async function startSandboxed({ command, args, cwd, env = {}, writable = [], allow = [], mcpSocket = null, runDir = null, upstream = upstreamProxy(), bwrap = bwrapPath, node = process.execPath }) {
  runDir ??= sandboxRunDir(); const proxySocket = join(runDir, 'proxy.sock'), decisions = [];
  if (!socketOk(proxySocket) || (mcpSocket && !socketOk(mcpSocket))) throw Object.assign(new Error('The sandbox run directory path is too long for its sockets'), { code: 'sandbox_invalid' });
  const proxy = await allowlistProxy(proxySocket, allow, { onDecision: d => decisions.push(d), upstream });
  const proxyPort = 18080, mcpPort = 18081; // loopback inside the sandbox's own network namespace: nothing else listens there
  const inner = { ...env, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, https_proxy: `http://127.0.0.1:${proxyPort}`, HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, http_proxy: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  const forwards = [`${proxyPort}=${proxySocket}`, ...(mcpSocket ? [`${mcpPort}=${mcpSocket}`] : [])];
  if (mcpSocket && !mcpSocket.startsWith(runDir + '/')) throw Object.assign(new Error('The MCP socket must live in the sandbox run directory'), { code: 'sandbox_invalid' });
  const child = spawn(bwrap, [...bwrapArgs({ writable, runDir, cwd, env: inner }), '--', node, relay, ...forwards, '--', command, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = null;
  const close = () => closed ??= (async () => {
    child.stdin.end();
    const gone = await Promise.race([new Promise(r => child.exitCode !== null || child.signalCode ? r(true) : child.once('exit', () => r(true))), new Promise(r => setTimeout(() => r(false), 3000))]);
    if (!gone) { child.kill('SIGKILL'); await new Promise(r => child.exitCode !== null || child.signalCode ? r() : child.once('exit', r)); }
    proxy.close(); rmSync(runDir, { recursive: true, force: true });
    return { state: gone ? 'exited' : 'killed' };
  })();
  return { child, runDir, mcpUrl: mcpSocket ? `http://127.0.0.1:${mcpPort}/mcp` : null, decisions, close };
}
