import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurationMirror } from '../mirror.mjs';

const script = fileURLToPath(new URL('../mirror.py', import.meta.url));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-mirror-'));
  const source = join(root, 'source'), state = join(root, 'state'), target = join(state, 'codex');
  const put = (path, value) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, value); };
  put(join(state, 'snapshot.json'), JSON.stringify({ source, isolated: target }));
  put(join(source, 'config.toml'), '[plugins."design@test"]\nenabled = true\n');
  put(join(source, 'AGENTS.md'), 'Owner instructions');
  put(join(source, 'skills/design/SKILL.md'), 'First version');
  put(join(source, 'plugins/cache/custom/design/1.0/skill.md'), 'Plugin skill');
  put(join(source, 'auth.json'), 'SOURCE_SECRET');
  put(join(source, 'sessions/private.json'), 'SOURCE_CONVERSATION');
  put(join(target, 'auth.json'), 'ISOLATED_SECRET');
  put(join(target, 'sessions/keep.json'), 'ISOLATED_CONVERSATION');
  put(join(target, 'plugins/.plugin-appserver/keep'), 'RUNTIME');
  return { root, source, state, target, put,
    run: () => JSON.parse(execFileSync('python3', [script, '--source', source, '--state', state], { encoding: 'utf8' })),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('one-way mirror copies updates and removals while keeping auth, sessions and app runtimes isolated', () => {
  const f = fixture();
  try {
    assert.equal(f.run().changed, true);
    assert.equal(readFileSync(join(f.target, 'skills/design/SKILL.md'), 'utf8'), 'First version');
    assert.match(readFileSync(join(f.target, 'config.toml'), 'utf8'), /model_providers.claude_code/);
    assert.equal(f.run().changed, false);
    f.put(join(f.source, 'skills/design/SKILL.md'), 'Changed skill, different length');
    f.put(join(f.source, 'config.toml'), '[plugins."design@test"]\nenabled = false\n');
    rmSync(join(f.source, 'plugins/cache/custom'), { recursive: true }); rmSync(join(f.source, 'AGENTS.md'));
    assert.equal(f.run().changed, true);
    assert.match(readFileSync(join(f.target, 'skills/design/SKILL.md'), 'utf8'), /Changed skill/);
    assert.equal(existsSync(join(f.target, 'plugins/cache/custom')), false);
    assert.equal(existsSync(join(f.target, 'AGENTS.md')), false);
    assert.match(readFileSync(join(f.target, 'config.toml'), 'utf8'), /enabled = false/);
    assert.equal(readFileSync(join(f.target, 'auth.json'), 'utf8'), 'ISOLATED_SECRET');
    assert.equal(readFileSync(join(f.target, 'sessions/keep.json'), 'utf8'), 'ISOLATED_CONVERSATION');
    assert.equal(readFileSync(join(f.target, 'plugins/.plugin-appserver/keep'), 'utf8'), 'RUNTIME');
    assert.equal(existsSync(join(f.target, 'sessions/private.json')), false);
    assert.equal(readFileSync(join(f.source, 'auth.json'), 'utf8'), 'SOURCE_SECRET');
  } finally { f.close(); }
});

test('partial config writes and destination symlinks fail before changing the usable mirror or source files', () => {
  const f = fixture();
  try {
    f.run(); const before = readFileSync(join(f.target, 'config.toml'), 'utf8');
    f.put(join(f.source, 'config.toml'), '[unfinished'); f.put(join(f.source, 'skills/design/SKILL.md'), 'Should not be copied yet');
    assert.throws(f.run); assert.equal(readFileSync(join(f.target, 'config.toml'), 'utf8'), before);
    assert.equal(readFileSync(join(f.target, 'skills/design/SKILL.md'), 'utf8'), 'First version');
    f.put(join(f.source, 'config.toml'), ''); rmSync(join(f.target, 'skills'), { recursive: true });
    symlinkSync(join(f.source, 'skills'), join(f.target, 'skills'));
    assert.throws(f.run, /destination/);
    assert.equal(readFileSync(join(f.source, 'skills/design/SKILL.md'), 'utf8'), 'Should not be copied yet');
  } finally { f.close(); }
});

test('reload is retried after a temporary failure even when disk files have stopped changing', async () => {
  const f = fixture(), calls = [], events = [], logs = [];
  const mirror = configurationMirror({ source: f.source, state: f.state,
    native: { request: async method => { calls.push(method); if (calls.length === 1) throw new Error('temporary unavailable'); return {}; } },
    notify: (method, params) => events.push({ method, params }), log: event => logs.push(event),
  });
  try {
    await mirror.refresh(); assert.equal(events.filter(e => e.method === 'warning').length, 1);
    await mirror.refresh(); assert.deepEqual(calls, ['config/mcpServer/reload', 'config/mcpServer/reload']);
    assert.equal(events.filter(e => e.method === 'skills/changed').length, 1); assert.ok(logs.includes('config.mirror_recovered'));
    await mirror.refresh(); assert.equal(calls.length, 2);
    mirror.stop(); f.put(join(f.source, 'AGENTS.md'), 'Later'); await mirror.refresh();
    assert.equal(readFileSync(join(f.target, 'AGENTS.md'), 'utf8'), 'Owner instructions');
  } finally { mirror.stop(); f.close(); }
});

test('desktop timestamp touches do not trigger reload; equal-sized skill changes are still mirrored', () => {
  const f = fixture();
  try {
    const path = join(f.source, 'plugins/cache/custom/design/.codex-remote-plugin-install.json');
    f.put(path, '{}'); f.run();
    const future = new Date(Date.now() + 30000);
    utimesSync(join(f.target, 'plugins/cache/custom/design/.codex-remote-plugin-install.json'), future, future);
    utimesSync(join(f.target, 'plugins/cache/custom/design'), future, future);
    assert.equal(f.run().changed, false);
    f.put(join(f.source, 'skills/design/SKILL.md'), 'Other version'); // Same size as First version.
    assert.equal(f.run().changed, true);
    assert.equal(readFileSync(join(f.target, 'skills/design/SKILL.md'), 'utf8'), 'Other version');
    assert.equal(f.run().changed, false);
  } finally { f.close(); }
});
