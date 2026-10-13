// Exercise what the end user installs, with an empty prefix and frozen cache.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const expected = JSON.parse(readFileSync('npm-shrinkwrap.json', 'utf8')).packages;
const root = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-distribution-')));
try {
  // Use the installer's staging code, then inspect npm's actual tree and files,
  // not the shipped shrinkwrap copied into the package.
  execFileSync('python3', ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
    resolve('dist', `model-bridge-installer-${pkg.version}.zip`), join(root, 'bundle')]);
  const bundle = join(root, 'bundle/Model Bridge');
  const archive = join(bundle, `${pkg.name}-${pkg.version}.tgz`);
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
  console.log(`Distribution passed: ${checked} dependency versions/integrities match; installed CLI ${pkg.version}.`);
} finally { rmSync(root, { recursive: true, force: true }); }
