// Exercise what the end user installs, with an empty prefix and frozen cache.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const expected = JSON.parse(readFileSync('npm-shrinkwrap.json', 'utf8')).packages;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-distribution-')));
const extract = (zip, into) => execFileSync('python3', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, into]);
const files = dir => readdirSync(dir, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile())
  .map(entry => relative(dir, join(entry.parentPath, entry.name))).sort();
try {
  // Use the installer's staging code, then inspect npm's actual tree and files,
  // not the shipped shrinkwrap copied into the package.
  extract(resolve('dist', `model-bridge-installer-${pkg.version}.zip`), join(root, 'bundle'));
  const bundle = join(root, 'bundle/Model Bridge');
  const archiveName = `${pkg.name}-${pkg.version}.tgz`, archive = join(bundle, archiveName);
  const pin = JSON.parse(readFileSync(join(bundle, 'bundle.json'), 'utf8'));
  assert.equal(pin.version, pkg.version);
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), pin.sha256);
  const prefix = join(root, 'installation');
  execFileSync('sh', [join(bundle, 'stage-runtime.sh'), archive, prefix, '--offline'], { stdio: 'pipe' });
  const runtime = join(prefix, 'node_modules', pkg.name);
  const actual = JSON.parse(readFileSync(join(runtime, 'node_modules/.package-lock.json'), 'utf8')).packages;
  const required = Object.keys(expected).filter(path => path && !expected[path].optional);
  assert.deepEqual(Object.keys(actual).sort(), required.sort(), 'Unexpected installed dependency tree');
  let checked = 0;
  for (const [path, entry] of Object.entries(expected)) {
    if (!path || entry.optional) continue;
    const installed = actual[path];
    assert.equal(installed?.version, entry.version, `Installed dependency drift: ${path}`);
    assert.equal(installed?.integrity, entry.integrity, `Installed dependency integrity: ${path}`);
    const manifest = JSON.parse(readFileSync(join(runtime, path, 'package.json'), 'utf8'));
    assert.equal(manifest.version, entry.version, `On-disk dependency drift: ${path}`);
    checked++;
  }
  const cli = join(prefix, 'node_modules/.bin/codex-claude');
  assert.equal(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(), pkg.version);

  // The plugin ZIP holds exactly the plugin source (byte for byte), LICENSE and
  // the same pinned runtime, so an omitted server or configuration fails here.
  extract(resolve('dist', `model-bridge-plugin-${pkg.version}.zip`), join(root, 'plugin'));
  const plugin = join(root, 'plugin/codex-claude'), source = resolve('plugins/codex-claude');
  assert.deepEqual(files(plugin), [...files(source), 'LICENSE', archiveName].sort(), 'Plugin ZIP contents differ from the plugin source');
  for (const name of files(source)) if (name !== 'bundle.json')
    assert.ok(readFileSync(join(plugin, name)).equals(readFileSync(join(source, name))), `Plugin ZIP differs from source: ${name}`);
  assert.deepEqual(JSON.parse(readFileSync(join(plugin, 'bundle.json'), 'utf8')), pin, 'Plugin and installer pins differ');
  assert.ok(readFileSync(join(plugin, archiveName)).equals(readFileSync(archive)), 'Plugin and installer runtimes differ');
  assert.ok(readFileSync(join(plugin, 'LICENSE')).equals(readFileSync('LICENSE')));

  // Start the packaged Home exactly as the ZIP's own mcp.json declares it, with
  // the pinned MCP SDK client over stdio and an empty HOME. Emulated for this
  // check: ${PLUGIN_ROOT} becomes the extracted plugin directory and `node`
  // this Node executable. Codex's plugin cache, its variable expansion, PATH
  // and UI rendering are not exercised.
  const servers = JSON.parse(readFileSync(join(plugin, 'mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(servers), ['model-bridge-home'], 'Plugin ZIP must register exactly the Home server');
  const declared = servers['model-bridge-home'];
  assert.deepEqual([declared.type, declared.command], ['stdio', 'node']);
  const expand = value => value.replaceAll('${PLUGIN_ROOT}', plugin);
  const home = join(root, 'empty-home'); mkdirSync(home);
  const transport = new StdioClientTransport({ command: process.execPath, args: declared.args.map(expand), cwd: expand(declared.cwd),
    env: { HOME: home, PATH: process.env.PATH ?? '' }, stderr: 'pipe' });
  let serverErrors = '';
  transport.stderr?.on('data', chunk => { serverErrors += chunk; });
  const client = new Client({ name: 'model-bridge-distribution-check', version: pkg.version });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name), ['bridge_home']);
    assert.equal(tools[0].annotations?.readOnlyHint, true);
    const uri = tools[0]._meta?.ui?.resourceUri;
    assert.equal(uri, 'ui://codex-claude/home.html');
    assert.ok((await client.listResources()).resources.some(r => r.uri === uri && r.mimeType === 'text/html;profile=mcp-app'));
    const called = await client.callTool({ name: 'bridge_home', arguments: {} });
    const facts = called.structuredContent?.facts;
    assert.deepEqual([facts?.payload?.state, facts?.connection?.state], ['not-observed', 'observed'],
      'Empty HOME: nothing installed; the initialized plugin connection is observed');
    assert.notEqual(facts.activation?.state, 'observed');
    const { contents: [view] } = await client.readResource({ uri });
    assert.equal(view.mimeType, 'text/html;profile=mcp-app'); assert.match(view.text, /^<!doctype html>/);
    assert.ok(!(JSON.stringify(called) + view.text).includes(root), 'Home output names no local path');
  } finally { await client.close(); }
  assert.equal(serverErrors, '', 'The Home server writes nothing to stderr');
  console.log(`Distribution passed: ${checked} dependency versions/integrities match; installed CLI ${pkg.version}; plugin ZIP matches source; packaged Home answered over stdio (PLUGIN_ROOT/node emulated).`);
} finally { rmSync(root, { recursive: true, force: true }); }
