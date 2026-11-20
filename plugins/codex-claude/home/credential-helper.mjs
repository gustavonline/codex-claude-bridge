// Fixed native bearer-token command. No shell/command API, environment fallback
// or log. Only Root/operator supplies the protected reference-file argument.
import { NativeSecrets } from './native-secrets.mjs';
import { credentialToken, endpointUrl } from './providers.mjs';
const a = process.argv.slice(2);
try {
  if (a.length !== 6 || !['--bindings', '--native-root'].includes(a[0]) || a[2] !== '--reference' || a[4] !== '--endpoint') throw new Error();
  if (endpointUrl(a[5]) !== a[5]) throw new Error();
  process.stdout.write((a[0] === '--native-root' ? new NativeSecrets(a[1]).get(a[3], a[5]) : credentialToken(a[1], a[3], a[5])) + '\n');
} catch {
  process.stderr.write('Provider credential unavailable.\n'); process.exitCode = 90;
}
