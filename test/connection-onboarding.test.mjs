import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NativeSecrets } from '../plugins/codex-claude/home/native-secrets.mjs';
import { BrowserAuth, exchangeCode, openRouterBase } from '../plugins/codex-claude/home/browser-auth.mjs';
import { ProviderRegistry, discoverLocal, localModelId, ResponsesRouter, CredentialBroker } from '../plugins/codex-claude/home/providers.mjs';
const temp = () => mkdtempSync(join(tmpdir(), 'bridge-onboarding-'));
function response(body, status = 200) {
  const calls = [];
  return { calls, request: (url, options, receive) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = data => { calls.push({ url, options, data }); queueMicrotask(() => {
      const res = new EventEmitter(); res.statusCode = status; res.closed = false; res.destroy = () => { res.closed = true; };
      receive(res); if (!res.closed) { res.emit('data', Buffer.from(JSON.stringify(body))); res.emit('end'); }
    }); }; return req;
  } };
}
// The helper the store would launch, as a regular root-style executable: the injected run() stands in for it, so the test does not depend on the host's binaries.
const helperFile = () => ({ isFile: () => true, mode: 0o100755 });
function nativeStorage() {
  const root = temp(), data = new Map(), calls = [];
  const store = new NativeSecrets(root, { platform: 'linux', probe: helperFile, run: (exe, args, options) => {
    assert.equal(exe, '/usr/bin/secret-tool'); assert.ok(!args.some(v => String(v).includes('SYNTHETIC-KEY')));
    const key = args.slice(args.indexOf('service')).join('|'); calls.push({ exe, args });
    if (args[0] === 'store') { assert.ok(!data.has(key)); data.set(key, options.input.toString()); return ''; }
    if (args[0] === 'clear') { data.delete(key); return ''; }
    if (!data.has(key)) throw Error('no native secret'); return data.get(key);
  } });
  return { root, store, data, calls };
}
function browser({ exchange = async () => 'SYNTHETIC-KEY-NOT-REAL', ttlMs = 10000, onAuthorized = () => 'a'.repeat(32) } = {}) {
  const secrets = nativeStorage(); let handler, closed = 0;
  const auth = new BrowserAuth({ secrets: secrets.store, ttlMs, exchange, onAuthorized, listen: async fn => { handler = fn; return { port: 54321, close: () => { closed++; } }; } });
  async function callback(query, { host = '127.0.0.1:54321', method = 'GET', address = '127.0.0.1', path = '/callback' } = {}) {
    const out = {}; const res = { writeHead: (status, headers) => Object.assign(out, { status, headers }), end: text => { out.text = text; } };
    await handler({ url: path + '?' + query, headers: { host }, method, socket: { remoteAddress: address } }, res); return out;
  }
  return { auth, callback, secrets, closed: () => closed };
}

test('PKCE browser flow uses exact official URLs/S256/state and stores only a native endpoint-bound reference; verifier/code/key never returned', async () => {
  let seen, exchanges = 0;
  const f = browser({ exchange: async (code, verifier) => { exchanges++; seen = { code, verifier }; return 'SYNTHETIC-KEY-NOT-REAL'; } });
  const start = await f.auth.begin(), url = new URL(start.authorizationUrl), callback = new URL(url.searchParams.get('callback_url'));
  assert.equal(url.origin + url.pathname, 'https://openrouter.ai/auth'); assert.equal(callback.href, 'http://127.0.0.1:54321/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); assert.ok(url.searchParams.get('state').length >= 40);
  const q = new URLSearchParams({ state: url.searchParams.get('state'), code: 'SYNTHETIC-CODE' }).toString();
  const answer = await f.callback(q); assert.equal(answer.status, 200); assert.equal(exchanges, 1); assert.equal(f.closed(), 1);
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(seen.verifier).digest('base64url'));
  assert.doesNotMatch(JSON.stringify(f.auth.status()), /SYNTHETIC|code_verifier/); assert.equal(f.auth.status().phase, 'complete');
  const refs = f.secrets.store.records(); assert.equal(refs[0].baseUrl, openRouterBase); assert.equal(f.secrets.store.get(refs[0].id, openRouterBase), 'SYNTHETIC-KEY-NOT-REAL');
  assert.doesNotMatch(readFileSync(join(f.secrets.root, 'native-auth-references.json'), 'utf8'), /SYNTHETIC/);
  assert.equal((await f.callback(q)).status, 410); assert.equal(exchanges, 1, 'callback replay never exchanges twice');
});

test('wrong state/host/path/method/duplicates/remote addresses refuse without exchanging; cancel and expiry close callback and late replies cannot publish', async () => {
  let complete, exchanges = 0; const f = browser({ exchange: () => { exchanges++; return new Promise(r => { complete = r; }); } });
  const url = new URL((await f.auth.begin()).authorizationUrl), state = url.searchParams.get('state');
  for (const [q, extra] of [[{ state: 'wrong', code: 'x' }, {}], [{ state, code: 'x' }, { host: 'evil.example' }], [{ state, code: 'x' }, { path: '/other' }], [{ state, code: 'x' }, { method: 'POST' }], [{ state, code: 'x' }, { address: '10.0.0.1' }]])
    assert.equal((await f.callback(new URLSearchParams(q).toString(), extra)).status, 400);
  assert.equal((await f.callback(new URLSearchParams({ state, code: 'x' }).toString() + '&code=y')).status, 400); assert.equal(exchanges, 0);
  const pending = f.callback(new URLSearchParams({ state, code: 'x' }).toString()); await Promise.resolve();
  f.auth.cancel(); complete('SYNTHETIC-LATE-KEY'); await pending;
  assert.deepEqual(f.secrets.store.records(), []); assert.equal(f.auth.status().phase, 'cancelled'); assert.equal(f.closed(), 1);
  const expired = browser({ ttlMs: 5 }); await expired.auth.begin(); await new Promise(r => setTimeout(r, 15));
  assert.equal(expired.auth.status().phase, 'expired'); assert.equal(expired.closed(), 1);
});

test('native references bind URL in OS attributes as well as JSON; edited metadata cannot reuse key and failed publication removes only new secret', () => {
  const f = nativeStorage(), ref = f.store.enroll(openRouterBase, 'SYNTHETIC-KEY-NOT-REAL');
  assert.throws(() => f.store.get(ref, 'https://other.example.invalid/v1'), { code: 'credential_endpoint_mismatch' });
  const path = join(f.root, 'native-auth-references.json'), v = JSON.parse(readFileSync(path)); v.references[0].baseUrl = 'https://other.example.invalid/v1'; writeFileSync(path, JSON.stringify(v));
  assert.throws(() => f.store.get(ref, v.references[0].baseUrl), { code: 'secret_unavailable' });
  const before = f.data.size; let guard = 0;
  assert.throws(() => f.store.enroll(openRouterBase, 'SYNTHETIC-KEY-TWO', () => { if (++guard === 2) throw Error('scope changed'); }), /scope changed/);
  assert.equal(f.data.size, before); assert.equal(f.store.records().length, 1); assert.ok(!readdirSync(f.root).includes('native-auth-references.lock'));
});

test('code exchange has bounded POST/TLS origin and no redirect; auth/rate limit/unreachable/protocol outcomes stay distinct', async () => {
  const ok = response({ key: 'SYNTHETIC-KEY-NOT-REAL' }); assert.equal(await exchangeCode('CODE', 'VERIFIER', ok), 'SYNTHETIC-KEY-NOT-REAL');
  assert.equal(ok.calls[0].url, 'https://openrouter.ai/api/v1/auth/keys'); assert.equal(ok.calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(ok.calls[0].data), { code: 'CODE', code_verifier: 'VERIFIER', code_challenge_method: 'S256' });
  for (const [status, code] of [[302, 'auth_exchange_failed'], [403, 'auth_denied'], [429, 'auth_rate_limited'], [500, 'auth_exchange_failed']]) {
    const f = response({}, status); await assert.rejects(exchangeCode('CODE', 'VERIFIER', f), { code }); assert.equal(f.calls.length, 1);
  }
  await assert.rejects(exchangeCode('CODE', 'VERIFIER', response({ key: 'x'.repeat(9000) })), { code: 'auth_exchange_failed' });
});

test('realistic 460-model large catalog is bounded/validated; zero-price facts filter free-only picker and explicit admission with no paid fallback', async () => {
  const data = Array.from({ length: 460 }, (_, i) => ({ id: 'provider/model-' + i, description: 'x'.repeat(1800), pricing: { prompt: i < 16 ? '0' : '0.001', completion: '0' }, supported_parameters: ['tools', 'temperature'] }));
  assert.ok(Buffer.byteLength(JSON.stringify({ data })) > 827235);
  const r = new ProviderRegistry(temp()), id = r.create({ name: 'OpenRouter', baseUrl: openRouterBase, freeOnly: true });
  await r.refresh(id, response({ data })); const s = r.read(id); assert.equal(s.catalog.models.length, 460); assert.equal(s.catalog.details.filter(m => m.free).length, 16);
  const router = new ResponsesRouter({ root: r.root, native: { request: async () => ({ data: [], nextCursor: null }) } });
  assert.equal(router.mergeModels([]).models.length, 16);
  r.select(id, localModelId(id, data[0].id));
  assert.throws(() => r.select(id, localModelId(id, data[16].id)), { code: 'free_model_required' });
  await assert.rejects(router.request('thread/start', { model: localModelId(id, data[16].id) }, () => {}), { code: 'free_model_required' });
  await assert.rejects(discoverLocal(openRouterBase, response({ data: Array.from({ length: 1025 }, (_, i) => ({ id: 'm' + i })) })), { code: 'catalog_protocol_unsupported' });
  await assert.rejects(discoverLocal(openRouterBase, response({ data: [{ id: 'ok', description: 'x'.repeat(2 * 1024 * 1024) }] })), { code: 'catalog_failed' });
});

test('catalog auth, rate limiting and unsupported bodies mark stale and retain prior models/selection', async () => {
  const r = new ProviderRegistry(temp()), id = r.create({ name: 'Synthetic', baseUrl: 'https://fixture.example.invalid/v1' });
  await r.refresh(id, response({ data: [{ id: 'model' }] })); r.select(id, localModelId(id, 'model'));
  for (const [status, body, code] of [[401, {}, 'catalog_auth_required'], [429, {}, 'catalog_rate_limited'], [200, { models: [] }, 'catalog_protocol_unsupported']]) {
    await assert.rejects(r.refresh(id, response(body, status)), { code }); const s = r.read(id);
    assert.equal(s.catalog.status, 'stale'); assert.equal(s.catalog.error, code); assert.deepEqual(s.catalog.models, ['model']); assert.equal(s.selected, localModelId(id, 'model'));
  }
});


test('native macOS launcher uses isolated system-Python flags and keeps the component helper bytes unchanged', () => {
  const root=temp(), calls=[];
  const store=new NativeSecrets(root,{platform:'darwin',python:'/usr/bin/true',probe:helperFile,run:(exe,args,options)=>{calls.push({exe,args});assert.equal(options.input.toString(),'SYNTHETIC-KEY-NOT-REAL');return '';}});
  store.enroll(openRouterBase,'SYNTHETIC-KEY-NOT-REAL');assert.equal(calls[0].exe,'/usr/bin/true');assert.deepEqual(calls[0].args.slice(0,2),['-I','-B']);
  assert.ok(calls[0].args[2].endsWith('/os-secret.py'));assert.ok(!JSON.stringify(calls).includes('SYNTHETIC-KEY'));
  assert.equal(createHash('sha256').update(readFileSync(new URL('../plugins/codex-claude/home/os-secret.py',import.meta.url))).digest('hex'),'ad43f136657a309b8925fcc15eb4343e1855a2ed2896299214cffd9370f8e57d');
});


test('legacy operator reference names remain valid even with native_ prefix; fixed native helper selection is based on exact bound reference, not a name guess',async()=>{
 const root=temp(),file=join(root,'public-secret'),path=join(root,'bindings.json'),reference='native_public_legacy';
 writeFileSync(file,'PUBLIC-SYNTHETIC-LEGACY',{mode:0o600});writeFileSync(path,JSON.stringify({version:1,references:[{id:reference,baseUrl:'https://example.invalid/v1',credentialFile:file}]}),{mode:0o600});
 const b=new CredentialBroker(path,root);assert.equal(await b.token(reference,'https://example.invalid/v1'),'PUBLIC-SYNTHETIC-LEGACY');assert.equal(b.auth(reference,'https://example.invalid/v1').args[1],'--bindings');
});

test('R1 legacy OpenRouter records stay readable without migration but paid, missing-price and stale entries cannot be selected or admitted',async()=>{
 const r=new ProviderRegistry(temp()),id=r.create({name:'Retained OpenRouter',baseUrl:openRouterBase}),path=join(r.root,'responses-providers',id,'local-responses.json');
 const old=JSON.parse(readFileSync(path));delete old.freeOnly;writeFileSync(path,JSON.stringify(old));const bytes=readFileSync(path);assert.equal(r.read(id).freeOnly,undefined);assert.deepEqual(readFileSync(path),bytes,'reading does not migrate');
 await r.refresh(id,response({data:[{id:'paid',pricing:{prompt:'0.001',completion:'0'}},{id:'missing'},{id:'zero',pricing:{prompt:'0',completion:'0'}}]}));
 assert.throws(()=>r.select(id,localModelId(id,'paid')),{code:'free_model_required'});assert.throws(()=>r.select(id,localModelId(id,'missing')),{code:'free_model_required'});
 const router=new ResponsesRouter({root:r.root,native:{request:async()=>({data:[],nextCursor:null})}});assert.deepEqual(router.mergeModels([]).models.map(m=>m.id),[localModelId(id,'zero')]);await assert.rejects(router.request('thread/start',{model:localModelId(id,'paid')},()=>{throw Error('must not execute');}),{code:'free_model_required'});
 r.select(id,localModelId(id,'zero'));await assert.rejects(r.refresh(id,response({},503)));assert.equal(router.mergeModels([]).models.length,0);await assert.rejects(router.request('thread/start',{model:localModelId(id,'zero')},()=>{}),{code:'catalog_not_fresh'});assert.equal(r.read(id).freeOnly,undefined,'policy does not silently rewrite the earlier record');
});

test('R1 maximal bounded catalog normalization remains readable and a later refresh recovers without deleting records',async()=>{
 const r=new ProviderRegistry(temp()),id=r.create({name:'Large fixture',baseUrl:'https://large.example.invalid/v1'});
 const data=Array.from({length:1024},(_,i)=>{const prefix='model-'+i+'-';return{id:prefix+'x'.repeat(512-prefix.length),supported_parameters:Array.from({length:19},(_,j)=>{const p='parameter-'+j+'-';return p+'p'.repeat(70-p.length);}),pricing:{prompt:'0',completion:'0'}};});
 assert.ok(Buffer.byteLength(JSON.stringify({data}))<2*1024*1024);await r.refresh(id,response({data}));assert.equal(r.read(id).catalog.models.length,1024,'normalization expansion must not publish an unreadable record');assert.ok(readFileSync(join(r.root,'responses-providers',id,'local-responses.json')).length<4*1024*1024);
 await r.refresh(id,response({data:[{id:'recovered'}]}));assert.deepEqual(r.read(id).catalog.models,['recovered']);
});
