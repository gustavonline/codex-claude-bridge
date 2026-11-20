// Runs INSIDE the harness sandbox (see harness-sandbox.mjs): relays loopback TCP ports to Unix sockets that Bridge serves outside, then runs
// the harness with inherited stdio and exits with it. Usage: node harness-relay.mjs <port>=<socket>... -- <command> <args...>
import { createServer, connect } from 'node:net';
import { spawn } from 'node:child_process';

const split = process.argv.indexOf('--');
const forwards = process.argv.slice(2, split).map(f => { const i = f.indexOf('='); return { port: Number(f.slice(0, i)), socket: f.slice(i + 1) }; });
const [command, ...args] = process.argv.slice(split + 1);
await Promise.all(forwards.map(({ port, socket }) => new Promise((resolve, reject) => {
  const server = createServer(c => { const u = connect(socket); c.pipe(u); u.pipe(c); u.on('error', () => c.destroy()); c.on('error', () => u.destroy()); });
  server.once('error', reject); server.listen(port, '127.0.0.1', resolve);
})));
const child = spawn(command, args, { stdio: 'inherit' });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
child.on('error', () => process.exit(127));
