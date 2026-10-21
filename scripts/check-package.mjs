import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const pkg = json('package.json'), plugin = json('plugins/codex-claude/plugin.json'), legacy = json('plugins/codex-claude/.codex-plugin/plugin.json');
assert.equal(pkg.version, json('npm-shrinkwrap.json').version);
assert.deepEqual(pkg.dependencies, json('npm-shrinkwrap.json').packages[''].dependencies);
assert.equal(pkg.version, plugin.version); assert.equal(pkg.version, legacy.version);
assert.equal(plugin.name, legacy.name);
const presentation = plugin.extensions['com.openai'].interface;
assert.deepEqual(presentation, legacy.interface);
assert.ok(presentation.shortDescription.length <= 30);
for (const key of ['logo', 'composerIcon']) assert.ok(existsSync(resolve('plugins/codex-claude', presentation[key])));
for (const name of ['setup', 'diagnose']) assert.ok(existsSync(`plugins/codex-claude/skills/${name}/SKILL.md`));
// Home registration: the portable root mcp.json is the only MCP declaration and
// starts the plugin's own dependency-free server from the plugin root. The
// portable manifest declares no components; the compatibility overlay keeps
// identity, version and presentation only (no MCP pointer).
const pluginRoot = 'plugins/codex-claude', serverPath = `${pluginRoot}/home/server.mjs`;
assert.ok(existsSync(serverPath), `Home server missing: ${serverPath}`);
const mcp = json(`${pluginRoot}/mcp.json`);
assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
assert.deepEqual(Object.keys(mcp.mcpServers ?? {}), ['model-bridge-home'], 'exactly the Home server is registered');
assert.deepEqual(mcp.mcpServers['model-bridge-home'], { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/home/server.mjs'], cwd: '${PLUGIN_ROOT}' },
  'Home server registration (command, path or cwd)');
for (const key of ['skills', 'mcpServers', 'apps', 'interface']) assert.ok(!(key in plugin), `portable plugin.json must not declare ${key}`);
assert.ok(!('mcpServers' in legacy) && !('apps' in legacy), 'no compatibility-overlay MCP or app pointer');
assert.ok(!existsSync(`${pluginRoot}/.mcp.json`) && !existsSync(`${pluginRoot}/.app.json`), 'no second MCP or app declaration');
assert.deepEqual(presentation.capabilities, ['Interactive']);
assert.equal(plugin.extensions['com.openai'].onboardingSkill, './skills/setup');
assert.equal(legacy.skills, './skills/'); assert.equal(legacy.extensions['com.openai'].onboardingSkill, './skills/setup/SKILL.md');
const server = readFileSync(serverPath, 'utf8');
assert.ok(!/^import .* from '(?!node:)/m.test(server), 'the Home server imports only Node built-ins');
for (const declared of ["'ui://codex-claude/home.html'", "name: 'bridge_home'", "'text/html;profile=mcp-app'"])
  assert.ok(server.includes(declared), `the Home server declares ${declared}`);
for (const file of [`${pluginRoot}/plugin.json`, `${pluginRoot}/.codex-plugin/plugin.json`, `${pluginRoot}/mcp.json`, serverPath,
  `${pluginRoot}/skills/setup/SKILL.md`, `${pluginRoot}/skills/diagnose/SKILL.md`, `${pluginRoot}/install.command`, `${pluginRoot}/stage-runtime.sh`])
  assert.ok(!/\/Users\/|\/home\/factory\/|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{25,}/.test(readFileSync(file, 'utf8')), `Private content: ${file}`);
const pack = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }))[0];
for (const file of pack.files) {
  assert.ok(!/(^|\/)(node_modules|work|test|\.env|auth\.json|logs|threads|\.git)(\/|$)/.test(file.path), file.path);
  assert.ok(!file.path.endsWith('.tgz'), file.path);
  const source = readFileSync(file.path, 'utf8');
  assert.ok(!/\/Users\/|\/home\/factory\/|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{25,}/.test(source), `Private content: ${file.path}`);
}
for (const name of pkg.files.filter(name => name.endsWith('.mjs'))) assert.ok(pack.files.some(f => f.path === name), name);
assert.ok(pack.files.some(f => f.path === 'LICENSE'));
assert.ok(pack.files.some(f => f.path === 'npm-shrinkwrap.json'));
execFileSync('sh', ['-n', 'plugins/codex-claude/install.command']);
execFileSync('sh', ['-n', 'plugins/codex-claude/stage-runtime.sh']);
console.log(`Package contract passed: ${pack.files.length} files; matching CLI/plugin ${pkg.version}; Home MCP registration; no local runtime state.`);
