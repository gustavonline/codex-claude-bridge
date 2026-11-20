import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { allowlistProxy, bwrapArgs, sandboxAvailable, sandboxRunDir, startSandboxed } from '../harness-sandbox.mjs';

// The whole-process boundary for agent harnesses with their own tools. The bubblewrap case runs only where bubblewrap works (Linux).
const temp = () => mkdtempSync(join(tmpdir(), 'bridge-sbxt-'));
// Opens a CONNECT tunnel; resolves with the status and everything the tunnel delivered (the reply and the payload can share one chunk).
const tunnel = (socket, target) => new Promise(resolve => {
  const c = connect(socket, () => c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`)); let b = '';
  c.on('data', d => { b += d; }); c.on('error', () => resolve({ status: 'error', body: '' }));
  c.on('close', () => { const e = b.indexOf('\r\n\r\n'); resolve({ status: b.split(' ')[1] ?? 'closed', body: e >= 0 ? b.slice(e + 4) : '' }); });
});

test('the boundary never makes the workspace writable: it is bound read-only after the private /tmp, and a writable directory containing it is refused', () => {
  const args = bwrapArgs({ readable: ['/opt/agy'], writable: ['/state'], runDir: '/run/x', cwd: '/work/repo', env: { PATH: '/bin' } });
  const at = (flag, path) => args.findIndex((a, i) => a === flag && args[i + 1] === path);
  assert.equal(at('--ro-bind', '/'), -1, 'the root is never mounted whole: only an allowlist');
  const mounted = args.flatMap((a, i) => ['--ro-bind', '--bind'].includes(a) ? [args[i + 1]] : []);
  assert.deepEqual(mounted.filter(p => !['/usr', '/etc'].includes(p)), ['/opt/agy', '/work/repo', '/state', '/run/x'], 'system, runtime, workspace, state and run dir only');
  assert.ok(at('--tmpfs', '/tmp') < at('--ro-bind', '/work/repo'), 'workspace bound read-only after /tmp');
  assert.ok(!args.some((a, i) => a === '--bind' && args[i + 1] === '/work/repo'));
  for (const flag of ['--unshare-net', '--unshare-pid', '--die-with-parent', '--clearenv', '--new-session']) assert.ok(args.includes(flag), flag);
  for (const writable of [['/work'], ['/work/repo'], ['/']]) assert.throws(() => bwrapArgs({ writable, runDir: '/run/x', cwd: '/work/repo', env: {} }), { code: 'sandbox_invalid' }, String(writable));
  assert.throws(() => bwrapArgs({ writable: [], runDir: '/work', cwd: '/work/repo', env: {} }), { code: 'sandbox_invalid' });
  assert.throws(() => bwrapArgs({ writable: ['relative'], runDir: '/run/x', cwd: '/work/repo', env: {} }), { code: 'sandbox_invalid' });
});

test('the CONNECT proxy admits only exact host:port pairs, records each decision without data, and chains through a configured upstream proxy', async () => {
  const dir = sandboxRunDir(), target = createServer(s => s.end('pong')); await new Promise(r => target.listen(0, '127.0.0.1', r)); const port = target.address().port;
  const decisions = [], proxy = await allowlistProxy(join(dir, 'p.sock'), [`127.0.0.1:${port}`], { onDecision: d => decisions.push(d) }); let upstream, chained;
  try {
  const ok = await tunnel(join(dir, 'p.sock'), `127.0.0.1:${port}`); assert.deepEqual([ok.status, ok.body], ['200', 'pong']);
  for (const denied of [`127.0.0.1:${port + 1}`, `localhost:${port}`, 'example.com:443']) assert.equal((await tunnel(join(dir, 'p.sock'), denied)).status, '403', denied);
  assert.deepEqual(decisions.map(d => d.allowed), [true, false, false, false]);
  // chained: the upstream receives its own CONNECT for the admitted target only
  const seen = []; upstream = createServer(s => s.once('data', d => { seen.push(d.toString().split('\r\n')[0]); s.write('HTTP/1.1 200 OK\r\n\r\n'); s.end('via-upstream'); }));
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  chained = await allowlistProxy(join(dir, 'q.sock'), ['provider.example:443'], { upstream: { host: '127.0.0.1', port: upstream.address().port } });
  const via = await tunnel(join(dir, 'q.sock'), 'provider.example:443'); assert.deepEqual([via.status, via.body], ['200', 'via-upstream']);
  assert.equal((await tunnel(join(dir, 'q.sock'), 'other.example:443')).status, '403');
  assert.deepEqual(seen, ['CONNECT provider.example:443 HTTP/1.1']);
  } finally { for (const s of [target, proxy, upstream, chained]) s?.close(); }
});

test('inside bubblewrap the whole tree is read-only except its own state and /tmp, has no network, reaches only admitted targets, and dies with the sandbox', { skip: !(await sandboxAvailable()) && 'bubblewrap is not available here' }, async () => {
  const root = temp(), ws = join(root, 'ws'), state = join(root, 'state'), outside = join(process.cwd(), 'sbx-outside-probe-' + process.pid); mkdirSync(ws); mkdirSync(state); writeFileSync(join(ws, 'README'), 'r'); // `outside` is on disk, outside /tmp and the workspace
  const target = createServer(s => s.end('pong')); await new Promise(r => target.listen(0, '127.0.0.1', r)); const port = target.address().port;
  // A host Unix socket and a credential-like file in a home directory, as another tool would leave them: both must be unreachable inside.
  const homeDir = mkdtempSync(join(homedir(), '.cache', 'bridge-sbxtest-')), hostSocket = join(homeDir, 'host.sock'), secret = join(homeDir, 'credentials.json');
  writeFileSync(secret, '{"synthetic":true}'); const host = createServer(c => c.end('host')); await new Promise(r => host.listen(hostSocket, r));
  const probe = `
    const fs = require('node:fs'), net = require('node:net'), { spawn } = require('node:child_process');
    const out = {}; const tryWrite = p => { try { fs.writeFileSync(p, 'x'); return 'written'; } catch (e) { return e.code; } };
    out.workspace = tryWrite('${ws}/w'); out.outside = tryWrite('${outside}'); out.state = tryWrite('${state}/s'); out.tmp = tryWrite('/tmp/t'); out.read = fs.readFileSync('${ws}/README', 'utf8');
    async function probeHost() {
      const reach = p => new Promise(r => { const c = net.connect(p); c.on('connect', () => { c.destroy(); r('connected'); }); c.on('error', e => r(e.code)); });
      const readable = p => { try { fs.readFileSync(p); return 'read'; } catch (e) { return e.code; } };
      out.hostSocket = await reach('${hostSocket}'); out.docker = await reach('/var/run/docker.sock'); out.secret = readable('${secret}');
      out.run = fs.existsSync('/run') ? fs.readdirSync('/run').length : 'absent'; out.home = fs.existsSync('${homeDir}');
    }
    const via = target => new Promise(r => { const c = net.connect(18080, '127.0.0.1', () => c.write('CONNECT ' + target + ' HTTP/1.1\\r\\n\\r\\n')); let b = ''; c.on('data', d => { b += d; if (b.includes('pong') || b.includes('403')) { c.destroy(); r(b.includes('pong') ? 'pong' : '403'); } }); c.on('error', e => r(e.code)); });
    const direct = () => new Promise(r => { const c = net.connect(${port}, '127.0.0.1'); c.on('connect', () => { c.destroy(); r('connected'); }); c.on('error', e => r(e.code)); });
    (async () => { await probeHost(); out.allowed = await via('127.0.0.1:${port}'); out.denied = await via('127.0.0.1:${port + 1}'); out.direct = await direct();
      const kid = spawn('sleep', ['3137'], { detached: true, stdio: 'ignore' }); out.kidPid = kid.pid; kid.unref(); process.stdout.write(JSON.stringify(out) + '\\n'); process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); setInterval(() => {}, 1000); })();`;
  const s = await startSandboxed({ command: process.execPath, args: ['-e', probe], cwd: ws, env: { PATH: '/usr/bin:/bin', HOME: root }, writable: [state], allow: [`127.0.0.1:${port}`], upstream: null });
  let err = ''; s.child.stderr.on('data', d => { err += d; });
  const out = JSON.parse(await new Promise((r, reject) => { let b = ''; s.child.stdout.on('data', d => { b += d; if (b.includes('\n')) r(b); }); s.child.once('exit', () => reject(new Error('sandboxed probe exited: ' + err.slice(-600)))); }));
  assert.deepEqual([out.workspace, out.state, out.tmp, out.read], ['EROFS', 'written', 'written', 'r']); assert.ok(['EROFS', 'ENOENT'].includes(out.outside), out.outside);
  assert.deepEqual([out.hostSocket, out.docker, out.secret, out.run, out.home], ['ENOENT', 'ENOENT', 'ENOENT', 'absent', false], 'no host socket, container daemon, foreign credential, /run or home is visible');
  assert.deepEqual([out.allowed, out.denied], ['pong', '403']); assert.notEqual(out.direct, 'connected', 'the host loopback is not reachable from inside');
  assert.deepEqual(s.decisions.map(d => d.allowed), [true, false]);
  assert.deepEqual(await s.close(), { state: 'exited' }); assert.equal(existsSync(s.runDir), false);
  assert.equal(existsSync(join(ws, 'w')) || existsSync(outside), false, 'nothing written outside');
  // a detached grandchild (as a hook could start) does not outlive the sandbox: its PID namespace ends with it
  const alive = (() => { try { return execFileSync('pgrep', ['-f', 'sleep 3137'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();
  assert.equal(alive, '', 'no process of the sandbox is left'); target.close(); host.close(); rmSync(homeDir, { recursive: true, force: true });
});
