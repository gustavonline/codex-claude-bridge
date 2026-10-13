import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version, dist = resolve('dist');
mkdirSync(dist, { recursive: true });
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dist], { encoding: 'utf8' }))[0];
const archive = join(dist, packed.filename);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const bundle = { version, sha256: hash(archive) };
const pin = 'plugins/codex-claude/bundle.json';
if (process.argv.includes('--pin')) writeFileSync(pin, JSON.stringify(bundle, null, 2) + '\n');
if (process.argv.includes('--check') && JSON.stringify(JSON.parse(readFileSync(pin, 'utf8'))) !== JSON.stringify(bundle))
  throw new Error('Stale plugin bundle pin: run npm run bundle -- --pin after final source changes.');
const stage = join(dist, 'stage'); rmSync(stage, { recursive: true, force: true });
try {
  const plugin = join(stage, 'codex-claude'), installer = join(stage, 'Model Bridge');
  cpSync('plugins/codex-claude', plugin, { recursive: true }); mkdirSync(installer, { recursive: true });
  for (const folder of [plugin, installer]) {
    cpSync(archive, join(folder, packed.filename));
    writeFileSync(join(folder, 'bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
  }
  cpSync('plugins/codex-claude/install.command', join(installer, 'Install Model Bridge.command'));
  cpSync('LICENSE', join(installer, 'LICENSE')); cpSync('README.md', join(installer, 'README.md'));
  const zips = [`model-bridge-plugin-${version}.zip`, `model-bridge-installer-${version}.zip`];
  // Standard-library ZIP writer gives reproducible paths, timestamps and modes.
  execFileSync('python3', ['-c', `
import pathlib,stat,sys,zipfile
stage,dist=map(pathlib.Path,sys.argv[1:3])
for folder,name in zip(['codex-claude','Model Bridge'],sys.argv[3:]):
 with zipfile.ZipFile(dist/name,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for path in sorted((stage/folder).rglob('*')):
   if not path.is_file():continue
   if path.is_symlink():raise RuntimeError('No symlinks in plugin bundles')
   info=zipfile.ZipInfo(str(path.relative_to(stage)),(2026,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
   info.create_system=3;info.external_attr=(stat.S_IFREG | (0o755 if path.suffix=='.command' else 0o644))<<16
   z.writestr(info,path.read_bytes())
`, stage, dist, ...zips]);
  const names = [packed.filename, ...zips];
  writeFileSync(join(dist, 'SHA256SUMS'), names.map(name => `${hash(join(dist, name))}  ${name}`).join('\n') + '\n');
  console.log(JSON.stringify({ version, artifacts: names, runtimeSha256: bundle.sha256 }));
} finally { rmSync(stage, { recursive: true, force: true }); }
