// Explicit declared-profile entrypoint; normal mcp.json remains unbound.
import { providerControls } from './provider-controls.mjs';
import { session, serveSession } from './server.mjs';
try {
  if (process.argv.length !== 4 || process.argv[2] !== '--provider-binding') throw new Error();
  const controls = providerControls(process.argv[3]);
  process.stdin.once('end', () => controls.close());
  process.once('SIGTERM', () => { controls.close(); process.exitCode = 0; process.stdin.destroy(); });
  serveSession(session(undefined, controls));
} catch { process.stderr.write('Provider Home binding refused.\n'); process.exitCode = 90; }
