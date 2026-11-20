// Whole-process boundary for an agent harness that runs its own tools (Linux: bubblewrap). Everything the harness and anything it starts
// (its shell, hooks, plugins, MCP children) can do is bounded by the OS, not by the harness's own permission prompts:
//  - only an allowlist is mounted: the system directories (/usr, /etc and their links), the harness's own runtime, the workspace (read-only)
//    and its own state (writable), plus a private /tmp. Nothing from /run, /var, /srv, other homes or credential stores is visible, so no
//    host Unix socket (a container daemon, a session bus, another tool's credentials) can be reached;
//  - there is no network: the process sees loopback only. Outbound HTTPS leaves through a Bridge-side CONNECT proxy that admits exact
//    host:443 pairs (the provider's own endpoints), and Bridge's MCP endpoint is reachable on loopback. Both are relayed over Unix sockets;
//  - it has its own PID namespace, so every child it started dies with it, and closing stdin or killing the sandbox ends the whole tree.
// Two backends behind one contract, chosen by platform (never a fallback from one to the other: a boundary that fails refuses):
//  - Linux: bubblewrap, as above (deterministic; its own PID namespace ends every descendant);
//  - macOS: Codex's own sandbox (`codex sandbox -P <generated profile>`, Seatbelt), from the desktop's bundled CLI (BRIDGE_REAL_CODEX), with a
//    generated, randomly named permission profile in a private CODEX_HOME, network only through Codex's managed proxy to exact domains, and
//    one exact Unix socket (--allow-unix-socket) for Bridge's MCP relay. macOS has no PID namespace: teardown kills the process group and then
//    every descendant it saw; a process that detached itself before that is not guaranteed to be found (documented residual).
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, accessSync, constants, lstatSync, readlinkSync, existsSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const relay = fileURLToPath(new URL('./harness-relay.mjs', import.meta.url));
export const bwrapPath = '/usr/bin/bwrap';
// Whether the boundary works here: probed once per process (asynchronously, bounded), then remembered.
let probed = null; const canaries = new Map();
export function sandboxAvailable({ platform = process.platform, path = bwrapPath, codex = process.env.BRIDGE_REAL_CODEX } = {}) {
  // macOS: the canary runs once per Codex binary identity (path, size, mtime), so a desktop CLI update re-runs it and refuses if it fails.
  if (platform === 'darwin') {
    let identity; try { const st = statSync(codex); identity = `${codex}:${st.size}:${st.mtimeMs}`; } catch { return Promise.resolve(false); }
    if (!canaries.has(identity)) canaries.set(identity, codexSandboxCanary(codex));
    return canaries.get(identity);
  }
  if (platform !== 'linux') return Promise.resolve(false);
  return probed ??= new Promise(resolve => {
    try { accessSync(path, constants.X_OK); } catch { resolve(false); return; }
    execFile(path, [...systemMounts(), '--unshare-net', '--unshare-pid', '--die-with-parent', '--', '/usr/bin/true'], { timeout: 5000 }, error => resolve(!error));
  });
}
// The system part of the allowlist: /usr and /etc read-only, and the usual top-level links into /usr (merged-usr layouts) as links.
export function systemMounts({ exists = existsSync, lstat = lstatSync, readlink = readlinkSync } = {}) {
  const args = ['--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc'];
  for (const top of ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32']) {
    if (!exists(top)) continue;
    args.push(...(lstat(top).isSymbolicLink() ? ['--symlink', readlink(top), top] : ['--ro-bind', top, top]));
  }
  return args;
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

// The bubblewrap argument list. `readable` are extra read-only paths the harness needs (its own runtime, the relay); `writable` are its own state
// directories (absolute, created by the caller). Nothing else exists inside.
export function bwrapArgs({ readable = [], writable = [], runDir, cwd, env, system = systemMounts() }) {
  for (const p of [...readable, ...writable, runDir, cwd]) if (!isAbsolute(p ?? '')) throw Object.assign(new Error('Sandbox paths must be absolute'), { code: 'sandbox_invalid' });
  // A writable directory that contains the workspace would make the workspace writable again: refused.
  const inside = (dir, path) => path === dir || path.startsWith(dir.endsWith('/') ? dir : dir + '/');
  if ([...writable, runDir].some(dir => inside(dir, cwd))) throw Object.assign(new Error('A writable sandbox directory may not contain the workspace'), { code: 'sandbox_invalid' });
  // The private /tmp is mounted first; the workspace (read-only) and the writable directories are bound after it, so a path under /tmp stays visible.
  return [...system, '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', ...readable.flatMap(p => ['--ro-bind', p, p]), '--ro-bind', cwd, cwd,
    ...writable.flatMap(p => ['--bind', p, p]), '--bind', runDir, runDir,
    '--remount-ro', '/', // the sandbox's own root (where mount points were created) is read-only too: only /tmp, the state and the run dir are writable
    '--unshare-net', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session', '--die-with-parent', '--clearenv',
    ...Object.entries(env).flatMap(([k, v]) => ['--setenv', k, String(v)]), '--chdir', cwd];
}

// A private, short run directory for the sandbox's Unix sockets (a socket path is limited to about 104-108 bytes).
export const sandboxRunDir = () => mkdtempSync(join(tmpdir(), 'bridge-sbx-'));
const socketOk = path => Buffer.byteLength(path) <= 100;
// Starts `command args` inside the boundary. `allow` are the CONNECT targets; `mcpSocket`, when given, is exposed inside as http://127.0.0.1:<port>.
// Returns the child (stdio piped, for ACP), the inner MCP port, the proxy decisions, and close() that ends the whole tree and removes the run dir.
export async function startSandboxed(options) {
  return (options.platform ?? process.platform) === 'darwin' ? startCodexSandboxed(options) : startBubblewrap(options);
}
async function startBubblewrap({ command, args, cwd, env = {}, readable = [], writable = [], allow = [], mcpSocket = null, runDir = null, upstream = upstreamProxy(), bwrap = bwrapPath, node = process.execPath }) {
  runDir ??= sandboxRunDir(); const proxySocket = join(runDir, 'proxy.sock'), decisions = [];
  if (!socketOk(proxySocket) || (mcpSocket && !socketOk(mcpSocket))) throw Object.assign(new Error('The sandbox run directory path is too long for its sockets'), { code: 'sandbox_invalid' });
  const proxy = await allowlistProxy(proxySocket, allow, { onDecision: d => decisions.push(d), upstream });
  const proxyPort = 18080; // loopback inside the sandbox's own network namespace: nothing else listens there
  const inner = { ...env, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, https_proxy: `http://127.0.0.1:${proxyPort}`, HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, http_proxy: `http://127.0.0.1:${proxyPort}`, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
  // Bridge's MCP socket (when given) lives in the run directory, which is bound inside; the harness reaches it through its own stdio relay.
  const forwards = [`${proxyPort}=${proxySocket}`];
  if (mcpSocket && !mcpSocket.startsWith(runDir + '/')) throw Object.assign(new Error('The MCP socket must live in the sandbox run directory'), { code: 'sandbox_invalid' });
  // Inside, besides the system: the harness's own runtime directory, Node and the relay (read-only).
  const inside = [...new Set([dirname(command), dirname(node), relay, ...readable])];
  const child = spawn(bwrap, [...bwrapArgs({ readable: inside, writable, runDir, cwd, env: inner }), '--', node, relay, ...forwards, '--', command, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  // stderr is drained into a bounded tail (an undrained pipe would stall the harness), and a failed spawn ends like an exit.
  let stderrTail = ''; child.stderr.on('data', b => { stderrTail = (stderrTail + b).slice(-4000); });
  child.on('error', () => { if (child.exitCode === null) child.emit('exit', 127, null); });
  let closed = null;
  const close = () => closed ??= (async () => {
    child.stdin.end();
    const gone = await Promise.race([new Promise(r => child.exitCode !== null || child.signalCode ? r(true) : child.once('exit', () => r(true))), new Promise(r => setTimeout(() => r(false), 3000))]);
    if (!gone) { child.kill('SIGKILL'); await new Promise(r => child.exitCode !== null || child.signalCode ? r() : child.once('exit', r)); }
    proxy.close(); rmSync(runDir, { recursive: true, force: true });
    return { state: gone ? 'exited' : 'killed' };
  })();
  return { child, runDir, decisions, close, stderr: () => stderrTail };
}

// ---- macOS: Codex's own sandbox --------------------------------------------------------------------------------------------------------
// The generated config of one session: a private CODEX_HOME holds only this file. The profile name is random, nothing is trusted or copied from
// the person's own Codex configuration, and the run directory is the only writable place besides the harness's own state.
const tomlKey = value => JSON.stringify(value);
export function codexSandboxConfig({ profile, readable = [], writable = [], domains = [], proxyPort = null }) {
  const lines = ['approval_policy = "never"', `default_permissions = ${tomlKey(profile)}`, '[features]', 'network_proxy = true', `[permissions.${tomlKey(profile)}.filesystem]`, '":minimal" = "read"'];
  for (const p of readable) lines.push(`${tomlKey(p)} = "read"`);
  for (const p of writable) lines.push(`${tomlKey(p)} = "write"`);
  // allow_upstream_proxy: decided explicitly. The managed proxy may chain through the host's own configured proxy (policy applies first), as
  // a corporate or VM network requires; the harness itself only ever sees the managed proxy.
  lines.push(`[permissions.${tomlKey(profile)}.network]`, 'enabled = true', ...(proxyPort ? [`proxy_url = "http://127.0.0.1:${proxyPort}"`] : []), 'enable_socks5 = false', 'allow_upstream_proxy = true', `[permissions.${tomlKey(profile)}.network.domains]`);
  for (const d of domains) lines.push(`${tomlKey(d)} = "allow"`);
  return lines.join('\n') + '\n';
}
// The files a Mac Node runtime needs beyond :minimal (measured: OpenSSL reads its system configuration before anything else runs).
export const macRuntimeReads = ['/System/Library/OpenSSL/openssl.cnf'];
export function codexSandboxArgs({ profile, cwd, mcpSocket, command, args }) {
  return ['sandbox', '-P', profile, '-C', cwd, ...(mcpSocket ? ['--allow-unix-socket', mcpSocket] : []), '--', command, ...args];
}
function descendants(root) {
  try {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
    const kids = new Map(); for (const [p, pp] of rows) kids.set(pp, [...(kids.get(pp) ?? []), p]);
    const out = [], stack = [root]; while (stack.length) for (const k of kids.get(stack.pop()) ?? []) { out.push(k); stack.push(k); }
    return out;
  } catch { return []; }
}
async function startCodexSandboxed({ command, args, cwd, env = {}, readable = [], writable = [], allow = [], mcpSocket = null, runDir = null, codex = process.env.BRIDGE_REAL_CODEX, node = process.execPath, stateRoot = null }) {
  if (!isAbsolute(codex ?? '')) throw Object.assign(new Error('The Codex sandbox needs the desktop\'s Codex CLI (BRIDGE_REAL_CODEX)'), { code: 'harness_boundary_unavailable' });
  runDir ??= sandboxRunDir();
  // The private CODEX_HOME lives under Bridge state, not a temporary directory (Codex refuses helper binaries under /tmp); 0700 and removed after.
  const homeRoot = stateRoot ?? join(dirname(runDir), 'codex-sandbox'); mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
  const codexHome = mkdtempSync(join(homeRoot, 'home-')), profile = 'bridge-' + randomBytes(8).toString('hex'), tmp = join(runDir, 'tmp'); mkdirSync(tmp, { mode: 0o700 });
  // Read-only inside: the harness's runtime, Node, the caller's extra paths (the stdio MCP relay), Codex's own binary directory (its Linux
  // sandbox re-executes it) and the few system files a runtime needs on the Mac. Nothing of the person's home, other tools or the workspace.
  const inside = [...new Set([realpathSync(dirname(command)), dirname(node), realpathSync(dirname(codex)), ...readable, ...macRuntimeReads.filter(p => existsSync(p))])];
  // Codex's managed proxy listens on a free local port of this session (the only place outbound traffic can leave, to `domains` only).
  const proxyPort = await new Promise(r => { const sv = createServer(); sv.listen(0, '127.0.0.1', () => { const { port } = sv.address(); sv.close(() => r(port)); }); });
  writeFileSync(join(codexHome, 'config.toml'), codexSandboxConfig({ profile, readable: [...inside, cwd], writable: [...writable, runDir], domains: allow.map(a => a.replace(/:443$/, '')), proxyPort }), { mode: 0o600 });
  // The supervisor may chain its managed proxy through the host's own configured proxy (the allowlist applies first); the harness itself only
  // ever sees Codex's managed proxy. Nothing else of Bridge's environment is passed.
  const upstream = Object.fromEntries(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].filter(k => typeof process.env[k] === 'string').map(k => [k, process.env[k]]));
  const child = spawn(codex, codexSandboxArgs({ profile, cwd, mcpSocket, command, args }), { cwd, env: { ...upstream, ...env, CODEX_HOME: codexHome, TMPDIR: tmp }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  let stderrTail = ''; child.stderr.on('data', b => { stderrTail = (stderrTail + b).slice(-4000); });
  child.on('error', () => { if (child.exitCode === null) child.emit('exit', 127, null); });
  let closed = null, seen = new Set();
  const watch = setInterval(() => { for (const p of descendants(child.pid)) seen.add(p); }, 500); watch.unref?.();
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const close = () => closed ??= (async () => {
    for (const p of descendants(child.pid)) seen.add(p);
    child.stdin.end();
    const gone = await Promise.race([new Promise(r => child.exitCode !== null || child.signalCode ? r(true) : child.once('exit', () => r(true))), new Promise(r => setTimeout(() => r(false), 3000))]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    for (const p of seen) try { process.kill(p, 'SIGKILL'); } catch {}
    clearInterval(watch); await new Promise(r => setTimeout(r, 100));
    const left = [...seen].filter(alive);
    rmSync(codexHome, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true });
    return { state: left.length ? 'unconfirmed' : gone ? 'exited' : 'killed', ...(left.length ? { left: left.length } : {}) };
  })();
  return { child, runDir, decisions: [], close, stderr: () => stderrTail };
}
// The Mac canary, once per process: the generated profile must start a command and must DENY reading a file outside it. Anything else refuses.
async function codexSandboxCanary(codex) {
  if (!isAbsolute(codex ?? '') || !existsSync(codex)) return false;
  const root = sandboxRunDir(), foreign = mkdtempSync(join(tmpdir(), 'bridge-canary-foreign-')), secret = join(foreign, 'canary');
  writeFileSync(secret, 'canary'); mkdirSync(join(root, 'run'));
  try {
    const box = await startCodexSandboxed({ command: '/bin/sh', args: ['-c', `cat ${JSON.stringify(secret)} >/dev/null 2>&1 && echo LEAK || echo DENIED`], cwd: root, codex, runDir: join(root, 'run'), stateRoot: join(root, 'state') });
    let out = ''; box.child.stdout.on('data', b => { out += b; }); await new Promise(r => box.child.once('exit', r)); await box.close();
    return out.trim() === 'DENIED';
  } catch { return false; }
  finally { rmSync(root, { recursive: true, force: true }); rmSync(foreign, { recursive: true, force: true }); }
}
