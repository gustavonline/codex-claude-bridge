import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeSecrets } from '../plugins/codex-claude/home/native-secrets.mjs';
test('Mac launch pins the qualified Keychain interpreter regardless of the launcher Python; other platforms retain their interpreter', () => {
  const script = `import ast,json,types\np=ast.parse(open('launch.py').read())\nf=next(n for n in p.body if isinstance(n,ast.FunctionDef) and n.name=='credential_python')\nout=[]\nfor platform in ['darwin','linux']:\n ns={'sys':types.SimpleNamespace(platform=platform,executable='/synthetic/brew-symlink')}\n exec(compile(ast.Module(body=[f],type_ignores=[]),'fixture','exec'),ns)\n out.append(ns['credential_python']())\nprint(json.dumps(out))`;
  assert.deepEqual(JSON.parse(execFileSync('/usr/bin/python3', ['-c', script], { cwd: new URL('../', import.meta.url), encoding: 'utf8' })), ['/usr/bin/python3', '/synthetic/brew-symlink']);
});
test('credential availability keeps rejecting a symlink rather than weakening executable validation', () => {
  const root = mkdtempSync(join(tmpdir(),'credential-launch-')), link=join(root,'python'); symlinkSync(process.execPath,link);
  assert.equal(new NativeSecrets(root,{platform:'darwin',python:link}).available(),false);
  if(process.platform==='darwin') assert.equal(new NativeSecrets(root,{platform:'darwin',python:'/usr/bin/python3'}).available(),true);
});
