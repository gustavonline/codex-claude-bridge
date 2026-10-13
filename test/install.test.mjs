import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-installer-')), home = join(root, 'home');
  const bundle = join(root, 'bundle'), bin = join(home, '.local/bin'), parent = join(home, '.local/share');
  const install = join(parent, 'codex-claude-bridge');
  const put = (file, text, mode = 0o600) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text, { mode }); };
  // Instrument only the HOME reference in a disposable copy. The actual shell
  // control flow runs, while the process's real HOME/account stay untouched.
  put(join(bundle, 'install.command'), readFileSync(new URL('../plugins/codex-claude/install.command', import.meta.url), 'utf8').replaceAll('$HOME', '$BRIDGE_TEST_HOME'));
  put(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', 0o700);
  put(join(bin, 'claude'), '#!/bin/sh\nexit 0\n', 0o700);
  const cli = version => `#!/bin/sh
case "$1" in
  --version) echo '${version}';;
  check) echo check >> "$BRIDGE_TEST_LOG"; [ "$BRIDGE_TEST_FAILURE" != check ];;
  stop) echo stop >> "$BRIDGE_TEST_LOG"; [ "$BRIDGE_TEST_FAILURE" != busy ];;
  setup) echo setup >> "$BRIDGE_TEST_LOG"; [ "$BRIDGE_TEST_FAILURE" != setup ];;
  *) echo start >> "$BRIDGE_TEST_LOG";;
esac
`;
  const fake = join(root, 'fake-cli'); put(fake, cli('0.3.0-rc.1'), 0o700);
  put(join(install, 'node_modules/.bin/codex-claude'), cli('0.2.1'), 0o700);
  put(join(bin, 'npm'), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then shift; bridge_test_prefix=$1; fi
  shift
done
echo npm >> "$BRIDGE_TEST_LOG"
mkdir -p "$bridge_test_prefix/node_modules/.bin"
cp "$BRIDGE_TEST_CLI" "$bridge_test_prefix/node_modules/.bin/codex-claude"
chmod +x "$bridge_test_prefix/node_modules/.bin/codex-claude"
`, 0o700);
  const archive = Buffer.from('SYNTHETIC_NPM_ARCHIVE');
  put(join(bundle, 'codex-claude-bridge-local-0.3.0-rc.1.tgz'), archive);
  put(join(bundle, 'bundle.json'), JSON.stringify({ version: '0.3.0-rc.1', sha256: createHash('sha256').update(archive).digest('hex') }));
  const log = join(root, 'events');
  return { root, home, bundle, bin, parent, install, put,
    run: (failure = '') => spawnSync('sh', [join(bundle, 'install.command')], { encoding: 'utf8', env: {
      ...process.env, BRIDGE_TEST_HOME: home, BRIDGE_TEST_LOG: log, BRIDGE_TEST_CLI: fake, BRIDGE_TEST_FAILURE: failure } }),
    events: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
    version: () => spawnSync(join(install, 'node_modules/.bin/codex-claude'), ['--version'], { encoding: 'utf8' }).stdout.trim(),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('installer verifies and stages before stopping, retains recovery package, and reuses an installed version', () => {
  const f = fixture();
  try {
    const run = f.run(); assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(f.events(), ['npm', 'check', 'stop', 'setup', 'start']);
    assert.equal(f.version(), '0.3.0-rc.1');
    assert.ok(existsSync(join(f.parent, 'codex-claude-bridge.previous/node_modules/.bin/codex-claude')));
    assert.equal(f.run().status, 0); assert.deepEqual(f.events().slice(-2), ['setup', 'start']);
    assert.equal(f.events().filter(e => e === 'npm').length, 1);
  } finally { f.close(); }
});

test('installer preflight/busy failures leave the old package usable; post-replacement setup failure restores it', () => {
  for (const failure of ['check', 'busy', 'setup']) {
    const f = fixture();
    try {
      const profile = join(f.home, 'profile/conversation.json'); f.put(profile, 'KEEP_USER_HISTORY');
      const run = f.run(failure); assert.notEqual(run.status, 0);
      assert.equal(f.version(), '0.2.1'); assert.equal(readFileSync(profile, 'utf8'), 'KEEP_USER_HISTORY');
      assert.equal(existsSync(join(f.parent, '.codex-claude-install-lock')), false);
      if (failure === 'check') assert.ok(!f.events().includes('stop'));
      if (failure === 'setup') assert.match(run.stderr, /restored/);
    } finally { f.close(); }
  }
});

test('checksum and concurrent-install failures run no package installer or stop command', () => {
  for (const failure of ['checksum', 'locked']) {
    const f = fixture();
    try {
      if (failure === 'checksum') f.put(join(f.bundle, 'bundle.json'), JSON.stringify({ version: '0.3.0-rc.1', sha256: '0'.repeat(64) }));
      else mkdirSync(join(f.parent, '.codex-claude-install-lock'));
      const run = f.run(); assert.notEqual(run.status, 0); assert.deepEqual(f.events(), []); assert.equal(f.version(), '0.2.1');
    } finally { f.close(); }
  }
});
