import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const pkg = json('package.json'), plugin = json('plugins/codex-claude/plugin.json'), legacy = json('plugins/codex-claude/.codex-plugin/plugin.json');
assert.equal(pkg.version, json('package-lock.json').version);
assert.equal(pkg.version, plugin.version); assert.equal(pkg.version, legacy.version);
assert.equal(plugin.name, legacy.name);
const presentation = plugin.extensions['com.openai'].interface;
assert.deepEqual(presentation, legacy.interface);
assert.ok(presentation.shortDescription.length <= 30);
for (const key of ['logo', 'composerIcon']) assert.ok(existsSync(resolve('plugins/codex-claude', presentation[key])));
for (const name of ['setup', 'diagnose']) assert.ok(existsSync(`plugins/codex-claude/skills/${name}/SKILL.md`));
const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }))[0];
for (const file of pack.files) {
  assert.ok(!/(^|\/)(node_modules|work|test|\.env|auth\.json|logs|threads|\.git)(\/|$)/.test(file.path), file.path);
  assert.ok(!file.path.endsWith('.tgz'), file.path);
  const source = readFileSync(file.path, 'utf8');
  assert.ok(!/\/Users\/|\/home\/factory\/|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{25,}/.test(source), `Private content: ${file.path}`);
}
for (const name of pkg.files.filter(name => name.endsWith('.mjs'))) assert.ok(pack.files.some(f => f.path === name), name);
assert.ok(pack.files.some(f => f.path === 'LICENSE'));
execFileSync('sh', ['-n', 'plugins/codex-claude/install.command']);
console.log(`Package contract passed: ${pack.files.length} files; matching CLI/plugin ${pkg.version}; no local runtime state.`);
