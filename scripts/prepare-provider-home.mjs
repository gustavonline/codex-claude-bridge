import { prepareProviderHome } from '../plugins/codex-claude/home/provider-controls.mjs';
try {
  const a = process.argv.slice(2);
  if (!(a.length === 1 || a.length === 3 && a[1] === '--credential-bindings')) throw new Error();
  console.log(JSON.stringify(prepareProviderHome(a[0], { credentialBindings: a[2] ?? null })));
} catch { process.stderr.write('Provider Home preparation refused; retain any partial state.\n'); process.exitCode = 90; }
