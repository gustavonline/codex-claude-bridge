// An explicit test-only stdio entrypoint. Portable mcp.json stays unbound.
import { testControls } from './test-controls.mjs';
import { session, serveSession } from './server.mjs';
if (process.argv.length !== 4 || process.argv[2] !== '--test-binding') throw new Error('Usage: test-server.mjs --test-binding /task/home-test-binding.json');
try { serveSession(session(undefined, await testControls(process.argv[3]))); }
catch { process.stderr.write('Home synthetic test binding refused; no server started.\n'); process.exitCode = 1; }
