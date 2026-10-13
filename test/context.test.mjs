import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../bridge.mjs';
import { search, configFor, discover, toolName, requiresApproval, allowedTool } from '../capabilities.mjs';

test('discovery ranks actual capability words and exact native names, not common generated prefixes', () => {
  const entry = (server, name, description) => ({ name: toolName(server, name), description, route: { server, tool: name } });
  const browser = entry('cua_repl', 'js', 'Control native apps or browsers. Open a URL in a built-in browser tab, navigate and take a screenshot.');
  const app = entry('codex_app', 'open_in_codex', 'Show a workspace file, browser URL or review in a Codex panel.');
  const docs = entry('openaiDeveloperDocs', 'list_openai_docs', 'List public OpenAI documentation.');
  const notion = entry('codex_apps', 'notion.fetch', 'Fetch a Notion page by its identifier.');
  const issue = entry('codex_apps', 'github.search_issues', 'Search GitHub issues by text and state.');
  const distractors = Array.from({ length: 100 }, (_, i) => entry('codex_apps', `unrelated_${i}`, 'List documents or send an upload URL.'));
  const catalog = [...distractors, browser, app, docs, notion, issue];
  for (const query of ['built-in browser open URL tab screenshot', 'in-app browser navigate']) {
    assert.equal(search(catalog, query).matches[0].name, browser.name);
  }
  assert.equal(search(catalog, 'browser open url codex app preview').matches[0].name, app.name);
  assert.equal(search(catalog, 'mcp__codex_app__open_in_codex').matches[0].name, app.name);
  assert.equal(search(catalog, 'notion.fetch', 1).matches[0].name, notion.name);
  assert.equal(search(catalog, 'github search issues', 1).matches[0].name, issue.name);
  assert.equal(search(catalog, 'list_openai_docs', 1).matches[0].name, docs.name);
  assert.equal(search(distractors, 'browser navigate screenshot').matches.length, 0);
  assert.ok(search(catalog, 'document', 8).matches.length <= 8);
  assert.throws(() => search(catalog, ' ', 5), /specific/);
  assert.throws(() => search(catalog, 'document', 9), /between/);
});

test('per-thread configuration and plugin restrictions apply to discovery and approval', async () => {
  const disk = { mcp_servers: { docs: { enabled: true } }, plugins: { 'editor@bundled': { enabled: true } } };
  const record = { thread: { id: 'thread', cwd: '/tmp' }, options: { config: {
    'mcp_servers.docs.enabled': false,
    'plugins.editor@bundled.mcp_servers.editor.enabled_tools': ['read'],
    'plugins.editor@bundled.mcp_servers.editor.default_tools_approval_mode': 'prompt',
    'apps.notion.tools."notion.fetch".enabled': false,
  } } };
  const spec = name => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } });
  const native = { request: async method => method === 'config/read' ? { config: disk } : { data: [
    { name: 'docs', runtimeStatus: 'connected', tools: { read: spec('read') } },
    { name: 'editor', pluginId: 'editor@bundled', runtimeStatus: 'connected', tools: { read: spec('read'), write: spec('write') } },
    { name: 'codex_app', runtimeStatus: 'failed', toolsError: 'Private raw startup failure', tools: {} },
  ] } };
  const effective = await configFor(native, record);
  assert.equal(disk.mcp_servers.docs.enabled, true);
  assert.equal(effective.apps.notion.tools['notion.fetch'].enabled, false);
  assert.equal(requiresApproval(spec('read'), { name: 'editor', pluginId: 'editor@bundled' }, effective), true);
  const unavailable = [];
  assert.deepEqual((await discover(native, record, unavailable)).map(t => t.route.tool), ['read']);
  assert.deepEqual(unavailable, [{ name: 'codex_app', status: 'failed' }]);
  assert.equal(allowedTool({ name: 'apps' }, { ...spec('read'), _meta: { connector_id: 'example' } },
    { apps: { _default: { default_tools_enabled: false } } }, {}), false);
});

test('native prompt-placement selectors preserve direct-only tools without overriding activation or hiding all surfaces', () => {
  const server = { name: 'native', runtimeStatus: 'connected' }, spec = { name: 'inspect' };
  const settings = { omit_tools_from: ['deferred', 'code_mode'] }, config = { mcp_servers: { native: settings } };
  assert.equal(allowedTool(server, spec, config, {}), true);
  assert.equal(allowedTool(server, { ...spec, _meta: { ui: { visibility: [] } } }, config, {}), false);
  assert.equal(allowedTool(server, { ...spec, _meta: { ui: { visibility: ['app'] } } }, config, {}), false);
  assert.equal(allowedTool(server, { ...spec, _meta: { ui: { visibility: ['model'] } } }, config, {}), true);
  settings.enabled = false;
  assert.equal(allowedTool(server, spec, config, {}), false);
  settings.enabled = true; settings.omit_tools_from.push('direct');
  assert.equal(allowedTool(server, spec, config, {}), false);
  settings.omit_tools_from = ['deferred'];
  config.apps = { example: { omit_tools_from: ['direct', 'code_mode'] } };
  assert.equal(allowedTool(server, { ...spec, _meta: { connector_id: 'example' } }, config, {}), false);
});

test('null resume options retain context across restart; explicit empty values clear it; failed resume preserves state', async () => {
  const statePath = mkdtempSync(join(tmpdir(), 'bridge-context-test-'));
  const id = '55555555-5555-4555-8555-555555555555';
  let fail = false, received;
  const native = { request: async (method, params) => {
    received = params;
    if (fail) throw new Error('resume failed');
    if (method === 'config/read') return { config: {} };
    return { thread: { id, cwd: statePath }, sandbox: { type: 'readOnly' }, instructionSources: [] };
  } };
  const options = { model: 'opus', cwd: statePath, developerInstructions: 'Use the desktop capabilities.',
    config: { 'mcp_servers.docs.enabled_tools': ['read'] }, permissions: ':read-only' };
  try {
    let bridge = new Bridge({ native, desktop: {}, statePath, getModels: async () => [{ value: 'opus' }] });
    await bridge.request('thread/start', options);
    bridge = new Bridge({ native, desktop: {}, statePath, getModels: async () => [{ value: 'opus' }] });
    await bridge.request('thread/resume', { threadId: id, config: null, developerInstructions: null, sandbox: null });
    assert.equal(received.developerInstructions, options.developerInstructions);
    assert.deepEqual(received.config, options.config);
    fail = true;
    await assert.rejects(bridge.request('thread/resume', { threadId: id, developerInstructions: 'must not persist' }), /resume failed/);
    assert.equal(bridge.records.get(id).options.developerInstructions, options.developerInstructions);
    fail = false;
    await bridge.request('thread/resume', { threadId: id, developerInstructions: '', config: {}, sandbox: 'read-only' });
    assert.equal(received.developerInstructions, '');
    assert.deepEqual(received.config, {});
    assert.equal(received.permissions, undefined);
  } finally { rmSync(statePath, { recursive: true, force: true }); }
});

test('isolation rebases only app-generated marketplace paths and preserves disabled skills and comments', () => {
  const launcher = fileURLToPath(new URL('../launch.py', import.meta.url));
  execFileSync('python3', ['-c', `
import importlib.util,pathlib,sys,tomllib,tempfile,plistlib,os,subprocess,json
spec=importlib.util.spec_from_file_location('launcher',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s=pathlib.Path('/source');i=pathlib.Path('/isolated')
text='''# keep comments
[marketplaces.openai-bundled]
source_type = "local"
source = "/source/.tmp/bundled-marketplaces/openai-bundled" # generated
[marketplaces.user-choice]
source_type = "local"
source = "/source/custom-marketplace"
[[skills.config]]
path = "/source/skills/hidden/SKILL.md"
enabled = false
'''
out=m.rebase_config(text,s,i);d=tomllib.loads(out)
assert d['marketplaces']['openai-bundled']['source']=='/isolated/.tmp/bundled-marketplaces/openai-bundled'
assert d['marketplaces']['user-choice']['source']=='/source/custom-marketplace'
assert d['skills']['config'][0]=={'path':'/isolated/skills/hidden/SKILL.md','enabled':False}
assert '# generated' in out and '# keep comments' in out
assert m.rebase_config(out,s,i)==out
custom=text.replace('/source/.tmp/bundled-marketplaces/openai-bundled','/custom/bundled')
assert tomllib.loads(m.rebase_config(custom,s,i))['marketplaces']['openai-bundled']['source']=='/custom/bundled'
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);source=root/'source';source.mkdir();app=root/'App.app'
 for name in ['Contents/Resources/cua_node/bin/node','Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex']:
  p=app/name;p.parent.mkdir(parents=True,exist_ok=True);p.touch()
 with (app/'Contents/Info.plist').open('wb') as f:plistlib.dump({'CFBundleExecutable':'Codex'},f)
 m.shutil.which=lambda name: '/usr/bin/'+name
 os.environ['CODEX_APP_TOOLS_PIPE_PATH']='/another-app/private-pipe'
 os.environ['CODEX_MCP_NODE_PATH']='/another-app/node'
 os.environ['CODEX_TEST_PROVIDER_KEY']='synthetic-secret'
 (source/'config.toml').write_text('[model_providers.example]\\nenv_key = "CODEX_TEST_PROVIDER_KEY"\\n')
 env,_,app_wrapper=m.prepare(root/'state',source,app)
 assert env['CODEX_MCP_NODE_PATH']==str(app/'Contents/Resources/cua_node/bin/node')
 assert str(app/'Contents/Resources/cua_node/bin/node') in app_wrapper.read_text()
 assert 'exec /usr/bin/node ' not in app_wrapper.read_text()
 assert 'CODEX_APP_TOOLS_PIPE_PATH' not in env
 assert env['CODEX_TEST_PROVIDER_KEY']=='synthetic-secret'
 assert 'synthetic-secret' not in app_wrapper.read_text()
 # The MCP environment deliberately omits BRIDGE_*; helper execution still
 # preserves the native process and argument boundaries, even with spaces.
 real=root/'real codex';real.write_text('#!/bin/sh\\nexec /usr/bin/printf "%s\\\\n" "$0" "$1" "$2" "$CODEX_CLI_PATH"\\n');real.chmod(0o700)
 wrapper=root/'bridge';wrapper.write_text(m.wrapper_script('/no-node-needed',real,root/'state',source,'/claude'));wrapper.chmod(0o700)
 result=subprocess.run([str(wrapper),'--helper','argument with spaces'],env={'PATH':'/usr/bin:/bin'},capture_output=True,text=True,check=True)
 assert result.stdout.splitlines()==[str(real),'--helper','argument with spaces',str(real)]
`, launcher]);
});
