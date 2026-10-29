#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { diagnose, readLogs, saveReport, threadId } from './diagnose.mjs';
import { compatibilityCheck, compatibilityScope } from './smoke.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const help = `Codex + Claude ${version}

codex-claude                         Start (or reuse) the isolated Codex app
codex-claude setup                   Check setup and create a double-click launcher
codex-claude status                  Show whether this isolated app is running
codex-claude check                   Verify protocol compatibility with a synthetic profile
codex-claude stop | restart          Stop/restart only when its chats are idle
codex-claude primary [status]        Open your normal Codex app once with Claude (opt-in;
                                     refuses while Codex runs; quit Codex yourself when idle)
codex-claude primary stopped         Exit nonzero unless no Bridge from this installation runs
codex-claude doctor [chat-link]      Save a private, content-free diagnosis
codex-claude logs [chat-link]        Print the latest 160 metadata events

Options: --state PATH --source PATH --app PATH --json --report PATH
Setup remembers only these paths. Skills/plugins/settings mirror normal Codex.
No models are called by setup, status or doctor. macOS; Python >=3.11 required.
`;

export function settingsPath(home = homedir()) { return join(home, '.config/codex-claude-bridge/settings.json'); }
export function configuration(values = {}, home = homedir()) {
  let saved = {};
  try { saved = JSON.parse(readFileSync(settingsPath(home), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Bridge settings could not be read. Repair settings.json before starting.'); }
  const state = resolve(values.state ?? saved.state ?? join(home, 'Library/Application Support/Codex Claude Bridge'));
  let originalSource;
  if (values.state && !values.source && existsSync(join(state, 'snapshot.json')))
    originalSource = JSON.parse(readFileSync(join(state, 'snapshot.json'), 'utf8')).source;
  const app = values.app ?? saved.app ?? ['/Applications/Codex.app', '/Applications/ChatGPT.app', join(home, 'Applications/Codex.app')]
    .find(path => existsSync(join(path, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')));
  return { state, source: resolve(values.source ?? originalSource ?? saved.source ?? join(home, '.codex')), app: app ? resolve(app) : undefined };
}

export function findPython() {
  for (const command of ['python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', 'python3.13', 'python3.12', 'python3.11']) {
    const result = spawnSync(command, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)'], { timeout: 3000, stdio: 'ignore' });
    if (result.status === 0) return command;
  }
  throw new Error('Python >=3.11 is required (for example: brew install python).');
}

function launch(config, flags = []) {
  if (process.platform !== 'darwin') throw new Error('This bridge currently supports macOS only.');
  // Only the stopped check (used before replacing the package) needs no app.
  if (!config.app && !flags.includes('--stopped')) throw new Error('Codex desktop was not found. Select it with --app /path/to/Codex.app.');
  const result = spawnSync(findPython(), [join(root, 'launch.py'), '--state', config.state, '--source', config.source,
    ...(config.app ? ['--app', config.app] : []), ...flags],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0) {
    // No raw Python traceback/config/environment output goes into diagnostics.
    const known = result.stderr?.split('\n').findLast(line => line.startsWith('RuntimeError: '));
    throw new Error(known?.slice('RuntimeError: '.length) ?? 'Launcher failed. Run codex-claude doctor and inspect the local state.');
  }
  try { return JSON.parse(result.stdout); } catch { throw new Error('Launcher returned an incomplete response. Run codex-claude status before retrying.'); }
}

function remember(config, home = homedir()) {
  const path = settingsPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path + '.tmp', JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(path + '.tmp', path); chmodSync(path, 0o600);
}

const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
// Double-click launchers. The main-app one only opens Codex when it is not
// running; it never quits or restarts it.
export function shortcut(config, home = homedir(), { name = 'Codex + Claude', command = [] } = {}) {
  const path = join(home, `Applications/${name}.command`);
  const marker = '# Managed by codex-claude-bridge';
  if (existsSync(path) && !readFileSync(path, 'utf8').includes(marker)) throw new Error(`An unrelated ${name}.command already exists; it was left unchanged.`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${marker}\nexec ${[process.execPath, join(root, 'cli.mjs'), ...command].map(quote).join(' ')}\n`, { mode: 0o700 });
  chmodSync(path, 0o700); return path;
}
export const primaryShortcut = { name: 'Codex + Claude (main app)', command: ['primary'] };

// Runs the protocol compatibility check (fresh synthetic profile, nothing copied
// from the owner's Codex profile, no model prompts) unless the last report passed
// for the same versions and the same check scope, or when forced. A report from
// an earlier check scope, or an unreadable one, is never reused.
async function compatible(config, preflight, values, force = false) {
  const versions = { bridgeVersion: version, app: preflight.appVersion, codex: preflight.codexVersion, claude: preflight.claudeVersion,
    node: preflight.nodeVersion, sdk: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies['@anthropic-ai/claude-agent-sdk'] };
  const path = join(config.state, 'diagnostics/compatibility.json');
  let last;
  try { last = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  if (!force && last?.passed === true && last.scope === compatibilityScope && JSON.stringify(last.versions) === JSON.stringify(versions))
    return { ...last, path };
  if (!values.json) console.log('Checking Codex and Claude compatibility with a synthetic profile (no model prompts)…');
  const report = await compatibilityCheck(config, findPython(), versions);
  saveReport(path, report);
  if (!report.passed) throw new Error(`Compatibility check failed after ${report.checks.length} checks. Diagnosis: ${path}`);
  return { ...report, path };
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    state: { type: 'string' }, source: { type: 'string' }, app: { type: 'string' },
    report: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    payload: { type: 'string' },
  } });
  if (values.help) { console.log(help); return; }
  if (values.version) { console.log(version); return; }
  const [command = 'start', selected, ...extra] = positionals;
  if (!['start', 'setup', 'stop', 'restart', 'status', 'check', 'doctor', 'logs', 'primary'].includes(command) || extra.length
    || (selected && !['doctor', 'logs', 'primary'].includes(command)) || (command === 'primary' && selected && !['status', 'stopped'].includes(selected))
    || (values.payload && !(command === 'primary' && selected === 'stopped')))
    throw new Error('Unknown command or arguments. Run codex-claude --help.');
  const config = configuration(values);
  if (command === 'primary') {
    // Used by the installer before it replaces a package: exits nonzero unless no
    // Bridge from that package runs. It never stops Codex.
    if (selected === 'stopped') {
      const result = launch(config, ['--primary', '--stopped', ...(values.payload ? ['--payload', resolve(values.payload)] : [])]);
      console.log(values.json ? JSON.stringify(result) : 'No Codex + Claude Bridge from this installation is running.');
      return;
    }
    if (selected === 'status') {
      const status = launch(config, ['--primary', '--status']);
      console.log(values.json ? JSON.stringify(status) : `Codex: ${status.running === null ? 'unknown' : status.running ? 'running' : 'not running'}; Claude Bridge: ${status.bridge === null ? 'unknown' : status.bridge ? 'active' : 'not active'}.`);
      return;
    }
    const preflight = launch(config, ['--check', '--primary']);
    await compatible(config, preflight, values);
    const result = launch(config, ['--primary']);
    console.log(values.json ? JSON.stringify(result) : 'Codex opened with Claude. GPT stays the default; choose Claude in the model picker. This applies until Codex quits.');
    return;
  }
  if (command === 'logs') {
    for (const entry of readLogs(config.state, { thread: threadId(selected) }).entries.slice(-160)) console.log(JSON.stringify(entry));
    return;
  }
  if (command === 'doctor') {
    const report = diagnose(config.state, { thread: threadId(selected) });
    report.bridgeVersion = version;
    try { report.installation = launch(config, ['--check']); } catch (error) { report.installation = { ok: false, action: error.message }; }
    try { report.desktop = launch(config, ['--status']); } catch { report.desktop = { running: null }; }
    const path = resolve(values.report ?? join(config.state, 'diagnostics', selected ? `thread-${threadId(selected)}.json` : 'latest.json'));
    saveReport(path, report);
    if (values.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Desktop: ${report.desktop.running === null ? 'unknown' : report.desktop.running ? 'running' : 'stopped'}; bridge: ${report.runs.some(r => r.running) ? 'running' : 'not detected'}`);
      console.log(`Chats: ${report.threads.length}; active: ${report.threads.reduce((n, t) => n + t.activeTurns, 0)}; queued: ${report.threads.reduce((n, t) => n + t.queueLength, 0)}`);
      console.log(`Recent retained errors: ${report.errors.length}; pending RPC calls: ${report.pendingCalls.filter(c => c.status === 'in_flight').length}`);
      if (!report.installation.ok) console.log(report.installation.action);
      if (report.installation.providerEnvironmentReady === false) console.log('The configured GPT provider key is absent from this shell. Start from your usual configured environment.');
      console.log(`Diagnosis saved: ${path}`);
    }
    return;
  }
  if (command === 'setup') {
    const check = launch(config, ['--check']);
    remember(config); const path = shortcut(config), primary = shortcut(config, homedir(), primaryShortcut);
    console.log(values.json ? JSON.stringify({ ...check, shortcut: path, primaryShortcut: primary, state: config.state })
      : `Ready. Run codex-claude or open ${path} for the separate test window.\nFor Claude in your normal Codex app, quit Codex once its chats are idle and open ${primary}.`);
    return;
  }
  if (['start', 'restart', 'check'].includes(command)) {
    const preflight = launch(config, ['--check']);
    const report = await compatible(config, preflight, values, command === 'check');
    if (command === 'check') {
      console.log(values.json ? JSON.stringify(report) : `Protocol compatibility passed with a synthetic profile; your Codex configuration, plugins and desktop window were not checked. Report: ${report.path}`);
      return;
    }
    if (command === 'restart') launch(config, ['--stop']);
    const result = launch(config);
    if (!existsSync(settingsPath())) remember(config);
    console.log(values.json ? JSON.stringify(result) : result.alreadyRunning ? 'Codex + Claude is already running.' : 'Codex + Claude started. Choose GPT or Claude in the model picker.');
    return;
  }
  const result = launch(config, [command === 'stop' ? '--stop' : '--status']);
  console.log(values.json ? JSON.stringify(result) : `Codex + Claude: ${result.running ? 'running' : 'stopped'}${result.activeThreads?.length ? ` (${result.activeThreads.length} active chats)` : ''}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
