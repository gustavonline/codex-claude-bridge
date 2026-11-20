import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The desktop reads `codex app-server --print-startup-config` once, as a startup
// policy query, through CODEX_CLI_PATH. It must reach the original CLI exactly as
// a helper subcommand does: no Bridge, no JSON-RPC, no state. Synthetic proof only:
// the generated wrapper runs against a synthetic native executable and a Node spy
// (a shell script standing in for the `node` argument), so these tests need no
// Claude Agent SDK, Codex, model, account, owner profile or Mac. They show wrapper
// routing and byte-for-byte output equality with the synthetic native, not that a
// real signed Codex Desktop accepts it.
const launcher = fileURLToPath(new URL('../launch.py', import.meta.url));
const bridge = fileURLToPath(new URL('../bridge.mjs', import.meta.url));
const QUERY = '--print-startup-config';

// Exactly what the native reports: argv, the environment it received and a fixed reply.
// It reads no stdin, as the real one-shot does, so closed stdin must not matter.
const nativeScript = `#!/bin/sh
{ for a do printf 'ARG=%s\\n' "$a"; done; env | grep -v '^\\(PWD\\|OLDPWD\\|SHLVL\\|_\\)=' | sort | sed 's/^/ENV:/'; } > "$FAKE_RECORD"
printf '{"appServerVersion":"synthetic","configRequirements":null}\\n'
printf 'synthetic native notice\\n' >&2
exit "\${FAKE_STATUS:-0}"
`;
const spyScript = `#!/bin/sh
{ for a do printf 'ARG=%s\\n' "$a"; done; env | grep '^BRIDGE_' | sort | sed 's/^/ENV:/'; } > "$SPY_RECORD"
exit 97
`;

function world() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-startup-config-'));
  const put = (name, text) => { const path = join(root, name); writeFileSync(path, text, { mode: 0o700 }); chmodSync(path, 0o700); return path; };
  const native = put('native codex', nativeScript), spy = put('node spy', spyScript);
  const wrapper = variant => {
    const path = join(root, `codex-bridge-${variant}`);
    const state = join(root, variant, 'state');
    const call = variant === 'primary'
      ? `m.wrapper_script(sys.argv[3], pathlib.Path(sys.argv[4]), state, None, '/nonexistent/claude', primary=True, isolated=state.parent / 'isolated')`
      : `m.wrapper_script(sys.argv[3], pathlib.Path(sys.argv[4]), state, pathlib.Path(sys.argv[2]) / 'source', '/nonexistent/claude')`;
    const result = spawnSync('python3', ['-B', '-c', `import importlib.util, pathlib, sys
spec = importlib.util.spec_from_file_location('launch', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
state = pathlib.Path(sys.argv[2]) / sys.argv[5] / 'state'
pathlib.Path(sys.argv[2], sys.argv[6]).write_text(${call})`, launcher, root, spy, native, variant, `codex-bridge-${variant}`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    chmodSync(path, 0o700);
    return path;
  };
  // `exec ... <&-` gives the program a genuinely closed stdin, like a desktop that does not feed it.
  const run = (program, args, { env = {}, stdin = 'closed' } = {}) => {
    const record = join(root, `record-${Math.random().toString(36).slice(2)}`);
    const redirect = stdin === 'closed' ? '<&-' : '</dev/null';
    const result = spawnSync('/bin/sh', ['-c', `exec "$0" "$@" ${redirect}`, program, ...args], { encoding: 'utf8', timeout: 20000,
      env: { PATH: '/usr/bin:/bin', FAKE_RECORD: record, SPY_RECORD: record, PROBE_VALUE: 'kept as is', ...env } });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr,
      record: existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter(Boolean) : null };
  };
  return { root, native, spy, wrapper, run, close: () => rmSync(root, { recursive: true, force: true }) };
}

// The per-run record paths belong to the fixture, not to the program under test.
const withoutCliPath = lines => lines.filter(line => !/^ENV:(CODEX_CLI_PATH|FAKE_RECORD|SPY_RECORD)=/.test(line));

test('the startup-config query reaches the original CLI unchanged through both generated wrappers, wherever its arguments sit', () => {
  const w = world();
  try {
    const positions = [[ 'app-server', QUERY ], [ QUERY, 'app-server' ], [ '-c', 'model="two words"', 'app-server', QUERY ],
      [ 'app-server', QUERY, '--flag', 'argument with spaces', '-c', 'key=value' ]];
    for (const variant of ['isolated', 'primary']) {
      const wrapper = w.wrapper(variant);
      for (const args of positions) for (const stdin of ['closed', 'null']) {
        const label = `${variant} ${stdin} ${JSON.stringify(args)}`;
        const direct = w.run(w.native, args, { stdin }), through = w.run(wrapper, args, { stdin });
        assert.equal(direct.status, 0, label);
        assert.equal(through.stdout, direct.stdout, `${label}: stdout`);
        assert.equal(through.stderr, direct.stderr, `${label}: stderr`);
        assert.equal(through.status, direct.status, `${label}: status`);
        assert.ok(through.stdout.length > 0 && through.record, `${label}: the native answered (no Bridge, no spy exit 97)`);
        assert.deepEqual(through.record.filter(line => line.startsWith('ARG=')), args.map(arg => `ARG=${arg}`), `${label}: argv`);
        // Same environment as a direct call, except the helper-path pointer wrappers already set for every pass-through.
        assert.deepEqual(withoutCliPath(through.record), withoutCliPath(direct.record), `${label}: environment`);
        assert.ok(through.record.includes(`ENV:CODEX_CLI_PATH=${w.native}`), `${label}: same helper pointer as other pass-through commands`);
        assert.ok(through.record.includes('ENV:PROBE_VALUE=kept as is'), `${label}: caller environment forwarded`);
        assert.ok(!through.record.some(line => line.startsWith('ENV:BRIDGE_')), `${label}: no Bridge settings leak`);
      }
    }
  } finally { w.close(); }
});

test('the startup-config query forwards a nonzero native status and its stderr, and never starts the Bridge', () => {
  const w = world();
  try {
    for (const variant of ['isolated', 'primary']) {
      const wrapper = w.wrapper(variant), args = ['app-server', QUERY];
      const direct = w.run(w.native, args, { env: { FAKE_STATUS: '3' } }), through = w.run(wrapper, args, { env: { FAKE_STATUS: '3' } });
      assert.equal(direct.status, 3);
      assert.deepEqual([through.status, through.stdout, through.stderr], [direct.status, direct.stdout, direct.stderr], variant);
      assert.ok(through.record.includes(`ARG=${QUERY}`), 'the native, not the node spy, produced the record');
      assert.equal(existsSync(join(w.root, variant, 'state')), false, `${variant}: no Bridge state is created`);
    }
  } finally { w.close(); }
});

test('ordinary app-server still goes to the Bridge, with its settings, and not to the original CLI', () => {
  const w = world();
  try {
    for (const variant of ['isolated', 'primary']) for (const args of [['app-server'], ['app-server', '--analytics-default-enabled'], ['-c', 'x=y', 'app-server']]) {
      const result = w.run(w.wrapper(variant), args), label = `${variant} ${JSON.stringify(args)}`;
      assert.equal(result.status, 97, `${label}: the node spy ran as the Bridge host`);
      assert.deepEqual(result.record.filter(line => line.startsWith('ARG=')), [`ARG=${bridge}`, ...args.map(arg => `ARG=${arg}`)], label);
      assert.ok(result.record.includes(`ENV:BRIDGE_REAL_CODEX=${w.native}`), label);
      assert.equal(result.record.includes('ENV:BRIDGE_COORDINATOR=1'), variant === 'primary', label);
      assert.equal(result.stdout, '', label);
    }
  } finally { w.close(); }
});

test('helper subcommands without app-server still exec the original CLI directly', () => {
  const w = world();
  try {
    for (const variant of ['isolated', 'primary']) {
      const result = w.run(w.wrapper(variant), ['--helper', 'argument with spaces']);
      assert.equal(result.status, 0, variant);
      assert.deepEqual(result.record.filter(line => line.startsWith('ARG=')), ['ARG=--helper', 'ARG=argument with spaces'], variant);
    }
  } finally { w.close(); }
});

// Needs the pinned Claude Agent SDK (bridge.mjs imports it), so it only runs where
// dependencies are installed. A wrapper written by an earlier build can still point
// at this bridge.mjs, so the Bridge's own gate must also leave the one-shot query alone.
test('bridge.mjs itself runs the startup-config query on the original CLI without starting the Bridge', () => {
  const w = world();
  try {
    for (const args of [['app-server', QUERY], [QUERY, 'app-server', '-c', 'k=v']]) {
      const environment = { BRIDGE_REAL_CODEX: w.native, BRIDGE_STATE: join(w.root, 'bridge-state/threads') };
      const direct = w.run(w.native, args), through = w.run(process.execPath, [bridge, ...args], { env: environment });
      assert.deepEqual([through.status, through.stdout, through.stderr], [direct.status, direct.stdout, direct.stderr], JSON.stringify(args));
      assert.deepEqual(through.record.filter(line => line.startsWith('ARG=')), args.map(arg => `ARG=${arg}`));
      assert.equal(existsSync(join(w.root, 'bridge-state')), false, 'no Bridge state or log directory is created');
    }
  } finally { w.close(); }
});
