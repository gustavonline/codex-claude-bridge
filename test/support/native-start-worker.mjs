// Synthetic Bridge process for runtime-guard tests: the real logger, Peer and
// Bridge with a local native stub that executes nothing. No app, model, command,
// auth or user profile is used.
// LABELLED FAULT INJECTION:
// - while "fail" is set, opening this logger's temporary record and truncating
//   its published record raise EIO; nothing else is altered;
// - mode "no-signal" makes os.setPriority raise EPERM before the logger starts.
import fs from 'node:fs';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../logging.mjs';
import { Bridge } from '../../bridge.mjs';
import { Peer } from '../../rpc.mjs';

const [state, refreshMs, mode] = process.argv.slice(2);
if (!state || !process.send) { process.stderr.write('native-start-worker: needs a state argument and IPC\n'); process.exit(2); }
if (mode === 'no-signal') {
  os.setPriority = () => { throw Object.assign(new Error('Injected setPriority EPERM'), { code: 'EPERM' }); };
  syncBuiltinESMExports();
}
const runtime = join(state, 'runtime');
const logger = createLogger(join(state, 'logs'), { runtimeDirectory: runtime, refreshMs: Number(refreshMs) });
const returns = [], forwarded = [];
const log = (event, fields) => { const result = logger(event, fields); returns.push([event, result]); return result; };
log('process.started');

let fail = false;
const temp = join(runtime, `.${process.pid}-${logger.runId}.tmp`);
const { openSync, ftruncateSync } = fs;
const injected = () => Object.assign(new Error('Injected runtime record EIO'), { code: 'EIO' });
fs.openSync = (path, ...rest) => { if (fail && path === temp) throw injected(); return openSync(path, ...rest); };
fs.ftruncateSync = (...args) => { if (fail) throw injected(); return ftruncateSync(...args); };
syncBuiltinESMExports();

// A held native request stays in flight until the test releases it.
const holds = new Map();
const bridge = new Bridge({ statePath: join(state, 'threads'), log, desktop: { notify: () => {} },
  native: { request: async (method, params) => {
    forwarded.push(method);
    if (params?.hold) await new Promise(resolve => holds.set(params.hold, resolve));
    if (method !== 'turn/start') return {};
    const turn = { id: randomUUID(), status: 'inProgress', items: [] };
    await bridge.nativeNotification('turn/started', { threadId: params.threadId, turn });
    return { turn };
  } },
  getModels: async () => { throw new Error('No model catalog in this fixture'); },
  runQuery: () => { throw new Error('No model in this fixture'); },
  history: {},
});
const input = new PassThrough(), output = new PassThrough();
new Peer(input, output, { name: 'desktop', log, request: (method, params) => bridge.request(method, params) });
const replies = new Map(); let buffered = '', rpcId = 0;
output.on('data', data => {
  buffered += data;
  for (let index; (index = buffered.indexOf('\n')) >= 0;) {
    const reply = JSON.parse(buffered.slice(0, index)); buffered = buffered.slice(index + 1);
    replies.get(reply.id)?.(reply);
  }
});

process.on('message', async ({ id, action, method, params, hold }) => {
  const mark = returns.length, sent = forwarded.length;
  try {
    if (action === 'fail' || action === 'restore') fail = action === 'fail';
    else if (action === 'notify') await bridge.nativeNotification(method, params);
    else if (action === 'held') return process.send({ id, held: holds.has(hold) });
    else if (action === 'release') { holds.get(hold)(); holds.delete(hold); }
    else if (action === 'request') {
      const reply = await new Promise(resolve => {
        replies.set(++rpcId, resolve);
        input.write(JSON.stringify({ id: rpcId, method, params }) + '\n');
      });
      return process.send({ id, reply, returns: returns.slice(mark), forwarded: forwarded.slice(sent), savedRecords: bridge.records.size });
    } else throw new Error('Unknown action');
    process.send({ id, returns: returns.slice(mark), forwarded: forwarded.slice(sent) });
  } catch (error) { process.send({ id, fixtureError: error.message }); }
});
process.on('disconnect', () => process.exit());
process.send({ ready: true, pid: process.pid, runId: logger.runId });
