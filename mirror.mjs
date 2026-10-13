import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { errorMetadata } from './logging.mjs';

const run = promisify(execFile);
export function configurationMirror({ native, source, state, log, notify, interval = 10000 }) {
  let timer, stopped = false, pending, reloadNeeded = false, failed = false;
  async function refresh() {
    if (stopped) return;
    if (pending) return pending;
    pending = (async () => {
      try {
        const result = await run(process.env.BRIDGE_PYTHON ?? 'python3', [join(dirname(fileURLToPath(import.meta.url)), 'mirror.py'), '--source', source, '--state', state], { timeout: 60000, maxBuffer: 1024 * 1024 });
        const report = JSON.parse(result.stdout);
        reloadNeeded ||= report.changed;
        if (reloadNeeded) {
          log('config.reload_started', { changedEntries: report.changedEntries ?? 0 });
          await native.request('config/mcpServer/reload', {});
          reloadNeeded = false;
          notify('skills/changed', {});
          log('config.mirrored', { changedEntries: report.changedEntries ?? 0 });
        }
        if (failed) log('config.mirror_recovered');
        failed = false;
      } catch (error) {
        log('config.mirror_failed', errorMetadata(error));
        if (!failed) notify('warning', { message: 'The Codex configuration mirror could not refresh. The last usable configuration is retained; the bridge will retry.' });
        failed = true;
      } finally { pending = null; }
    })();
    return pending;
  }
  return {
    start() { if (timer) return; void refresh(); timer = setInterval(refresh, interval); timer.unref(); },
    refresh,
    stop() { stopped = true; clearInterval(timer); },
  };
}
