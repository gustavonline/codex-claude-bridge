import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, lstatSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { prepareProviderHome, providerControls } from '../plugins/codex-claude/home/provider-controls.mjs';
import { ProviderRegistry, localModelId } from '../plugins/codex-claude/home/providers.mjs';
import { NativeSecrets } from '../plugins/codex-claude/home/native-secrets.mjs';
import { openRouterBase } from '../plugins/codex-claude/home/browser-auth.mjs';
import { session, homeResource } from '../plugins/codex-claude/home/server.mjs';
import { readConnections } from '../connections.mjs';
import { fixture } from './support/fixture.mjs';
import { harness, hostReply, handshakeId, toolResult } from './support/home-host.mjs';
const temp = () => mkdtempSync(join(tmpdir(), 'bridge-unified-'));
const nodes = n => [n, ...n.children.flatMap(nodes)];
// The page title carries the breadcrumb return links; the header actions carry the gear.
const everything = h => [...nodes(h.elements['page-title']), ...nodes(h.elements['header-actions']), ...nodes(h.elements.controls)];
const buttons = h => everything(h).filter(n => n.tag === 'button');
function click(h, key) { if (key === 'all-providers') return; if (!buttons(h).some(n => n.getAttribute('data-focus-key') === key || n.textContent === key) && buttons(h).some(n => n.getAttribute('data-focus-key') === 'settings')) click(h, 'settings'); const b = buttons(h).find(n => n.getAttribute('data-focus-key') === key || n.textContent === key); assert.ok(b, key); assert.equal(b.disabled, false, key); b.focus?.(); b.listeners.click?.forEach(fn => fn({})); }
const call = (h) => h.sent('tools/call').at(-1);
function ready(c) { const s = session(undefined, c); s({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'fixture',version:'1'}}}); s({jsonrpc:'2.0',method:'notifications/initialized'}); return s; }
const home = s => s({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'bridge_home',arguments:{}}}).result.structuredContent;
function ui(s, links = true) { const h = harness(); h.deliver(hostReply(handshakeId(h), {hostCapabilities:{serverTools:{},...(links?{openLinks:{}}:{})}})); h.deliver(toolResult(home(s))); return h; }
async function round(h,s,key) { if (key === 'read-state' || key === 'Read current state') { h.advance(0); if (!call(h) || !call(h).params.name.endsWith('_status')) h.advance(10000); } else click(h,key); const req=call(h); const answer=await s(req); h.deliver(answer); return req; }
function catalog(ids) { return { request: (_u,_o,receive) => { const r=new EventEmitter(); r.destroy=()=>{}; r.end=()=>queueMicrotask(()=>{const s=new EventEmitter(); s.statusCode=200;s.destroy=()=>{};receive(s);s.emit('data',Buffer.from(JSON.stringify({data:ids.map(id=>({id,pricing:{prompt:'0',completion:'0'}}))})));s.emit('end');}); return r; } }; }
async function setup() {
 const p=prepareProviderHome(join(temp(),'scope')),r=new ProviderRegistry(p.state),f=fixture('openai',{connectionRoot:p.state});
 const id=r.create({name:'Custom fixture',baseUrl:'https://synthetic.example.invalid/v1'});await r.refresh(id,catalog(['small','large']));
 const all=(await f.bridge.request('model/list',{})).data; const c=providerControls(p.bindingPath),s=ready(c);
 return {p,r,f,id,all,c,s};
}
const inventory = root => Object.fromEntries(readdirSync(root).sort().flatMap(n=>{const p=join(root,n);return lstatSync(p).isDirectory()?Object.entries(inventory(p)).map(([k,v])=>[n+'/'+k,v]):[[n,readFileSync(p).toString('hex')]];}));

test('actual Bridge catalogs feed Home: explicit unified save filters GPT/Claude/custom across reopening, restart and later discovery; no silent legacy migration',async()=>{
 const x=await setup(),{p,r,f,id,s}=x; const beforeSlots=r.slots(); assert.equal(beforeSlots.version,1);assert.equal(beforeSlots.models,null);
 const observed=r.pickerCatalog();assert.deepEqual(observed.models.map(m=>[m.id,m.kind]),[['gpt-test','native'],['gpt-other','native'],['haiku','claude'],['sonnet','claude']]);
 assert.ok(observed.models[0].capabilities.supportedReasoningEfforts.length); assert.ok(!('supportsTools' in observed.models[0].capabilities));
 const h=ui(s);assert.match(h.text('controls'),/Codex \/ GPT/);assert.match(h.text('controls'),/Claude Code/);
 click(h,'all-providers');for(const m of ['gpt-other','haiku',localModelId(id,'large')]) click(h,'library-'+m);
 const req=await round(h,s,'save-slots');assert.equal(req.params.arguments.reset,false);assert.equal(req.params.arguments.catalogRevision,observed.revision);
 const expected=['gpt-test','sonnet',localModelId(id,'small')];assert.deepEqual(r.slots().models,expected);assert.equal(r.slots().version,2);
 const listed=(await f.bridge.request('model/list',{})).data;assert.deepEqual(listed.map(m=>m.id),expected);assert.deepEqual(listed[0],x.all[0],'native default/effort metadata byte-equivalent');
 assert.deepEqual(home(ready(providerControls(p.bindingPath))).controls.slots.models,expected,'reopen reads saved slots');
 f.restart();assert.deepEqual((await f.bridge.request('model/list',{})).data.map(m=>m.id),expected);
 await r.refresh(id,catalog(['small','large','new-model']));assert.deepEqual((await f.bridge.request('model/list',{})).data.map(m=>m.id),expected,'discovery cannot silently expand saved selection');
 assert.ok((await f.bridge.request('model/list',{includeHidden:true})).data.some(m=>m.id==='haiku' && m.hidden === true),'includeHidden retains the identity but never marks an unselected row visible');
});

test('hiding preserves actual GPT, Claude and custom history, resume/fork/continuation; disabling Claude blocks new work without queue replay',async()=>{
 const {p,r,f,id,c}=await setup(),ids={};
 for(const model of ['gpt-test','haiku',localModelId(id,'small')]){const tid=await f.start(model);ids[model]=tid;const t=await f.send(tid,'public synthetic retained text');await f.done(t.turn.id);}
 const cat=r.pickerCatalog();r.savePickerSlots(['gpt-other'],r.slots().revision,cat.revision);
 for(const [model,tid] of Object.entries(ids)){
  const list=await f.bridge.request('thread/list',{});assert.ok(list.data.some(t=>t.id===tid),'hidden thread discoverable '+model);
  const turns=await f.bridge.request('thread/turns/list',{threadId:tid});assert.equal(turns.data.length,1,'retained turn '+model);
  const resumed=await f.bridge.request('thread/resume',{threadId:tid});assert.equal(resumed.thread.id,tid);
  const fork=await f.bridge.request('thread/fork',{threadId:tid});assert.equal(fork.thread.forkedFromId,tid);
  const t=await f.send(tid,'continue existing hidden model');await f.done(t.turn.id);
 }
 await f.bridge.request('thread/queue/add',{threadId:ids.haiku,clientUserMessageId:'PUBLIC-QUEUED',input:[{type:'text',text:'retained queued fixture'}]});
 let state=c.snapshot();const args={bindingId:state.bindingId,profileId:state.profileId,bridgeId:state.bridgeId,revision:state.revision,providerId:'00000000000000000000000000000002',enabled:false};await c.call('enabled',args);
 await assert.rejects(f.start('haiku'));assert.ok((await f.bridge.request('thread/list',{})).data.some(t=>t.id===ids.haiku));
 const n=f.queries.length;state=c.snapshot();await c.call('enabled',{...args,revision:state.revision,enabled:true});assert.equal(f.queries.length,n,'enable does not start queued/existing work');f.restart();await f.bridge.request('thread/resume',{threadId:ids.haiku});assert.equal(f.bridge.records.get(ids.haiku).queue.length,1);assert.equal(f.queries.length,n,'restart/read retains queued work without replay');const pausedFork=await f.bridge.request('thread/fork',{threadId:ids.haiku});assert.equal(f.bridge.records.get(pausedFork.thread.id).queue.length,0,'the existing fork contract starts with no queued submissions');assert.equal(f.bridge.records.get(ids.haiku).queue.length,1,'fork does not move or drop the retained parent queue');assert.equal(f.queries.length,n);
 assert.ok(await f.start('gpt-test')); assert.equal(readConnections(p.state).store.connections.claude_code.visible,null,'slot hiding does not mutate legacy execution policy');
});

test('all-hidden, unknown catalog, stale CAS, wrong scope and unavailable new IDs refuse without policy writes; reset is explicit',async()=>{
 const {p,r,c,id}=await setup(),before=inventory(p.state),s=c.snapshot(),scope={bindingId:s.bindingId,profileId:s.profileId,bridgeId:s.bridgeId};
 for(const extra of [{models:[]},{models:['invented-model']},{catalogRevision:s.slots.catalogRevision+1},{bindingId:'f'.repeat(32)}]){
  await assert.rejects(c.call('slots',{...scope,revision:s.revision,slotsRevision:s.slots.revision,catalogRevision:s.slots.catalogRevision,reset:false,models:['gpt-test'],...extra}));assert.deepEqual(inventory(p.state),before);
 }
 const fresh=prepareProviderHome(join(temp(),'scope')),empty=providerControls(fresh.bindingPath).snapshot();const er=new ProviderRegistry(fresh.state);
 assert.throws(()=>er.savePickerSlots(['gpt-test'],0,0),{code:'native_catalog_unknown'});assert.equal(er.slots().version,1);
 r.savePickerSlots(['gpt-test'],0,s.slots.catalogRevision);r.enabled(id,false);const now=c.snapshot();await c.call('slots',{...scope,revision:now.revision,slotsRevision:now.slots.revision,catalogRevision:now.slots.catalogRevision,reset:true,models:[]});
 assert.deepEqual(r.slots().models,['gpt-test','gpt-other','haiku','sonnet']);assert.equal(empty.slots.catalogRevision,0);
});

test('shipped UI keeps unified draft through context/cancel/late reply, recovers with same-scope read, and blocks empty save',async()=>{
 const {r,s}=await setup(),h=ui(s);click(h,'all-providers');click(h,'library-gpt-test');h.deliver({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'dark'}});
 click(h,'save-slots');const mutation=call(h),answer=await s(mutation);h.deliver({jsonrpc:'2.0',method:'ui/notifications/tool-cancelled'});h.deliver(answer);
 assert.deepEqual(buttons(h).map(b=>b.textContent),['Retry state update']);assert.equal(h.sent('tools/call').length,1);await round(h,s,'Read current state');
 assert.ok(!r.slots().models.includes('gpt-test'));
 // There is no "clear all" control any more: the selection is emptied by removing each model, and Save then stays blocked.
 for(const id of [...r.slots().models]){click(h,'details-'+id);click(h,'remove-'+id);}
 assert.equal(buttons(h).find(b=>b.textContent==='Save').disabled,true);assert.match(h.text('controls'),/Keep at least one/);
 click(h,'add-slot-0');const custom=nodes(h.elements.controls).find(n=>n.tag==='article'&&/(^| )model-row( |$)/.test(n.className));assert.ok(custom);assert.equal(homeResource,'ui://codex-claude/home-v11.html');
});

function authFixture(p) {
 const keys=new Map();const secrets=new NativeSecrets(p.state,{platform:'linux',run:(exe,args,o)=>{const k=args.slice(args.indexOf('service')).join('|');if(args[0]==='store'){keys.set(k,o.input.toString());return '';}if(args[0]==='clear'){keys.delete(k);return '';}if(!keys.has(k))throw Error('absent');return keys.get(k);}});
 // Synthetic command transport has no dependency on the host's Linux keyring executable.
 secrets.available=()=>true;
 let handler,closed=0;const c=providerControls(p.bindingPath,{secrets,request:catalog(['free-model']).request,authOptions:{listen:async fn=>{handler=fn;return{port:54321,close:()=>closed++};},exchange:async()=> 'PUBLIC-SYNTHETIC-KEY'}});
 async function callback(url){const u=new URL(url),state=u.searchParams.get('state');const output={};await handler({method:'GET',url:'/callback?'+new URLSearchParams({state,code:'PUBLIC-CODE'}),headers:{host:'127.0.0.1:54321'},socket:{remoteAddress:'127.0.0.1'}},{writeHead:(status)=>output.status=status,end:text=>output.text=text});return output;}
 return {c,keys,secrets,callback,closed:()=>closed};
}
test('real public MCP/UI flow begins browser auth, explicitly opens only official URL, stores native reference, discovers free catalog and saves slot; no secret in replies/state',async()=>{
 const p=prepareProviderHome(join(temp(),'scope')),a=authFixture(p),s=ready(a.c),h=ui(s);
 // Publish native catalog through the same Bridge API, not a fabricated UI row.
 const f=fixture('openai',{connectionRoot:p.state});await f.bridge.request('model/list',{}); const rr=new ProviderRegistry(p.state);rr.savePickerSlots(['gpt-test'],0,rr.pickerCatalog().revision);h.deliver(toolResult(home(s)));
 await round(h,s,'begin-auth');assert.equal(a.c.snapshot().auth.phase,'waiting');click(h,'open-auth');const link=h.sent('ui/open-link').at(-1);assert.ok(link);assert.equal(link.params.url.startsWith('https://openrouter.ai/auth?'),true);
 h.deliver({jsonrpc:'2.0',id:link.id,result:{}});assert.equal((await a.callback(link.params.url)).status,200);assert.equal(a.closed(),1);assert.equal(a.keys.size,1);
 await round(h,s,'read-state');const saved=a.c.snapshot().providers.find(p=>p.protocol==='responses');assert.equal(saved.name,'OpenRouter');assert.equal(saved.freeOnly,true);assert.ok(saved.authRef.startsWith('native_'));
 click(h,'provider-'+saved.id);await round(h,s,'discover');click(h,'settings');click(h,'library-'+localModelId(saved.id,'free-model'));await round(h,s,'save-slots');
 assert.ok(new ProviderRegistry(p.state).slots().models.includes(localModelId(saved.id,'free-model')));
 assert.doesNotMatch(JSON.stringify(h.posted)+JSON.stringify(home(s))+JSON.stringify(inventory(p.state)),/PUBLIC-SYNTHETIC-KEY|PUBLIC-CODE|code_verifier/);assert.ok(!readdirSync(p.state).some(n=>/token|key/.test(n)));
 const reopened=providerControls(p.bindingPath,{secrets:a.secrets});const durable=reopened.snapshot();assert.equal(durable.auth.phase,'idle');await assert.rejects(reopened.call('auth_begin',{bindingId:durable.bindingId,profileId:durable.profileId,bridgeId:durable.bridgeId,revision:durable.revision}),{code:'provider_exists'});reopened.close();
 a.c.close();
});

test('missing native storage/host openLinks disables browser action, malicious authorization URL is rejected; portable Claude policy and native helper are shipped',()=>{
 const p=prepareProviderHome(join(temp(),'scope')),c=providerControls(p.bindingPath,{secrets:{available:()=>false,records:()=>[]}}),s=ready(c),h=ui(s,false);
 click(h,'settings');assert.equal(buttons(h).find(b=>b.textContent==='Connect OpenRouter').disabled,true);assert.match(h.text('controls'),/Secret storage is unavailable/);
 const data=home(s);data.controls.auth={phase:'waiting',storageAvailable:true,error:null,providerId:null,authorizationUrl:'https://evil.example.invalid/auth?key=PUBLIC'};h.deliver(toolResult(data));assert.equal(buttons(h).some(b=>b.textContent==='Open browser'),false);assert.equal(h.sent('ui/open-link').length,0);
 assert.equal(readFileSync(new URL('../connections.mjs',import.meta.url),'utf8'),readFileSync(new URL('../plugins/codex-claude/home/connection-policy.mjs',import.meta.url),'utf8'));
 const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));for(const name of ['native-secrets.mjs','os-secret.py','connection-policy.mjs'])assert.ok(pkg.files.includes('plugins/codex-claude/home/'+name));
});

test('built-in refresh is a scope/CAS-bound request consumed by next public list; actual SDK fixture refresh, stale failure and explicit recovery remain honest',async()=>{
 const {p,r,f,c}=await setup();let discoveries=0,fail=false;
 f.bridge.getModels=async()=>{discoveries++;if(fail)throw Error('public synthetic outage');return [{value:'new-claude',supportsEffort:true,supportedEffortLevels:['high']}];};
 const refresh=async()=>{const s=c.snapshot();return c.call('refresh',{bindingId:s.bindingId,profileId:s.profileId,bridgeId:s.bridgeId,revision:s.revision,providerId:'00000000000000000000000000000002'});};
 const pending=await refresh();assert.equal(discoveries,0,'Home alone never invokes SDK');assert.ok(pending.pickerRefresh.requested>pending.pickerRefresh.observed);
 await assert.rejects(refresh(),{code:'catalog_refresh_pending'});await f.bridge.request('model/list',{});assert.equal(discoveries,1);assert.equal(c.snapshot().pickerRefresh.requested,c.snapshot().pickerRefresh.observed);
 assert.deepEqual(c.snapshot().providers.find(p=>p.kind==='claude').models.map(m=>m.id),['new-claude']);
 fail=true;await refresh();await f.bridge.request('model/list',{});assert.equal(c.snapshot().providers.find(p=>p.kind==='claude').catalogState,'stale');
 await f.bridge.request('model/list',{});assert.equal(discoveries,2,'a failed refresh is not auto-retried');assert.equal(c.snapshot().providers.find(p=>p.kind==='claude').catalogState,'stale');
 fail=false;await refresh();await f.bridge.request('model/list',{});assert.equal(discoveries,3);assert.equal(c.snapshot().providers.find(p=>p.kind==='claude').catalogState,'fresh');
 const s=c.snapshot();await c.call('enabled',{bindingId:s.bindingId,profileId:s.profileId,bridgeId:s.bridgeId,revision:s.revision,providerId:'00000000000000000000000000000002',enabled:false});
 assert.throws(()=>r.savePickerSlots(['new-claude'],r.slots().revision,r.pickerCatalog().revision),{code:'picker_empty'},'latest disable is enforced even before another catalog observation');
});

test('public regular-file stdio keeps single global/thread entrypoint, app-only auth/slot controls and no-argument Home; unbound mode exposes no writable tools',()=>{
 const p=prepareProviderHome(join(temp(),'scope')),dir=temp();const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'synthetic',version:'1'}}},{jsonrpc:'2.0',method:'notifications/initialized'},
 {jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'bridge_home',arguments:{}}},{jsonrpc:'2.0',id:4,method:'resources/read',params:{uri:homeResource}}];
 const input=join(dir,'input'),output=join(dir,'output'),error=join(dir,'error');writeFileSync(input,messages.map(JSON.stringify).join('\n')+'\n',{flag:'wx',mode:0o600});
 const fds=[openSync(input,'r'),openSync(output,'wx',0o600),openSync(error,'wx',0o600)];let result;try{result=spawnSync(process.execPath,[fileURLToPath(new URL('../plugins/codex-claude/home/provider-server.mjs',import.meta.url)),'--provider-binding',p.bindingPath],{env:{HOME:dir,CODEX_HOME:dir,PATH:'/usr/bin:/bin'},stdio:fds,timeout:10000});}finally{fds.forEach(closeSync);}
 assert.equal(result.status,0);assert.equal(result.signal,null);assert.equal(readFileSync(error,'utf8'),'');const rows=readFileSync(output,'utf8').trim().split('\n').map(JSON.parse);assert.equal(rows.length,4);
 const tools=rows.find(r=>r.id===2).result.tools;assert.equal(tools.filter(t=>t.name==='bridge_home').length,1);assert.deepEqual(tools[0]._meta['openai/ui'].entrypoints,[{type:'global'},{type:'thread'}]);
 for(const name of ['bridge_provider_auth_begin','bridge_provider_auth_cancel','bridge_provider_slots'])assert.deepEqual(tools.find(t=>t.name===name)._meta.ui.visibility,['app']);
 assert.ok(!tools.some(t=>JSON.stringify(t.inputSchema).includes('credentialFile')));assert.equal(rows.find(r=>r.id===3).result.structuredContent.controls.providers.length,2);assert.ok(rows.find(r=>r.id===4).result.contents[0].text.includes(homeResource)===false);
 assert.deepEqual(readdirSync(p.state),[],'read-only status does not materialize catalog or credential stores');
 const unbound=ready(null);assert.equal(unbound({jsonrpc:'2.0',id:5,method:'tools/list'}).result.tools.length,1);
});


test('browser publication loses CAS safely and cancels late exchange without a provider, key output or a second write',async()=>{
 const p=prepareProviderHome(join(temp(),'scope'));let receive,finish,deleted=0,enrolled=0;const refs=[];
 const secrets={available:()=>true,records:()=>refs,enroll:(baseUrl,key)=>{enrolled++;assert.equal(key,'PUBLIC-KEY');const id='native_'+'e'.repeat(32);refs.push({id,baseUrl});return id;},discard:()=>{deleted++;refs.length=0;}};
 const c=providerControls(p.bindingPath,{secrets,authOptions:{listen:async fn=>{receive=fn;return{port:54321,close(){}};},exchange:()=>new Promise(resolve=>finish=resolve)}});
 let s=c.snapshot();const scope={bindingId:s.bindingId,profileId:s.profileId,bridgeId:s.bridgeId};
 await assert.rejects(c.call('auth_begin',{...scope,bindingId:'f'.repeat(32),revision:s.revision}),{code:'wrong_scope'});assert.equal(c.snapshot().auth.phase,'idle');
 s=await c.call('auth_begin',{...scope,revision:s.revision});const u=new URL(s.auth.authorizationUrl);const respond=()=>receive({method:'GET',url:'/callback?'+new URLSearchParams({state:u.searchParams.get('state'),code:'PUBLIC-CODE'}),headers:{host:'127.0.0.1:54321'},socket:{remoteAddress:'127.0.0.1'}},{writeHead(){},end(){}});
 const pending=respond();await Promise.resolve();await c.call('connect',{...scope,revision:c.snapshot().revision,name:'Other connection',baseUrl:'https://other.example.invalid/v1',authRef:null});finish('PUBLIC-KEY');await pending;
 assert.equal(c.snapshot().auth.phase,'failed');assert.equal(c.snapshot().auth.error,'stale_revision');assert.equal(enrolled,1);assert.equal(deleted,1);assert.deepEqual(refs,[]);assert.equal(c.snapshot().providers.filter(p=>p.protocol==='responses').length,1);
 c.close();
});


test('Home and reset respect retained native collision ownership instead of offering an endpoint row with the same ID',async()=>{
 const {p,r,f,id,c}=await setup(),value=localModelId(id,'small');const request=f.bridge.native.request;
 f.bridge.native.request=async(method,params)=>method==='model/list'?{data:[{id:value,model:value,displayName:'Native owned',isDefault:true,hidden:false}],nextCursor:null}:request(method,params);
 await f.bridge.request('model/list',{});const state=c.snapshot(),custom=state.providers.find(p=>p.id===id);assert.equal(custom.models.find(m=>m.id===value).available,false,'native ID cannot be offered as a custom route');
 r.resetPickerSlots(r.slots().revision,r.pickerCatalog().revision);assert.equal(r.slots().models.filter(m=>m===value).length,1);assert.equal((await f.bridge.request('model/list',{})).data.find(m=>m.id===value).displayName,'Native owned');
});

test('R1 unified picker isolates corrupt custom state, preserving selected native rows and the corrupt bytes',async()=>{
 const {p,r,f,id}=await setup();r.savePickerSlots(['gpt-test'],0,r.pickerCatalog().revision);const path=join(p.state,'responses-providers',id,'local-responses.json');writeFileSync(path,'{retained-corrupt');const before=readFileSync(path);
 assert.deepEqual((await f.bridge.request('model/list',{})).data.map(m=>m.id),['gpt-test']);assert.deepEqual(readFileSync(path),before);assert.ok(await f.start('gpt-test'));
});
test('R1 legacy custom selection can explicitly save its displayed initial native/Claude defaults without an unrelated draft edit',async()=>{
 const {r,id,s}=await setup();r.saveSlots([localModelId(id,'small')],0);const h=ui(s);
 // Adoption is offered at once (no separate curate control): Save is enabled, Discard is not offered, and nothing is written until Save.
 assert.equal(buttons(h).find(b=>b.textContent==='Save').disabled,false);assert.equal(buttons(h).find(b=>b.textContent==='Discard'),undefined);assert.equal(r.slots().version,1);
 await round(h,s,'save-slots');assert.equal(r.slots().version,2);assert.deepEqual(r.slots().models,['gpt-test','gpt-other','haiku','sonnet',localModelId(id,'small')]);
});
test('R1 failed native refresh consumes its request as stale, keeps identities and permits explicit retry without a pending lockout',async()=>{
 const {r,f,c}=await setup();const request=f.bridge.native.request;const refresh=async()=>{const s=c.snapshot();return c.call('refresh',{bindingId:s.bindingId,profileId:s.profileId,bridgeId:s.bridgeId,revision:s.revision,providerId:'00000000000000000000000000000001'});};
 await refresh();f.bridge.native.request=async(method,p)=>{if(method==='model/list')throw Error('PUBLIC NATIVE OUTAGE');return request(method,p);};await assert.rejects(f.bridge.request('model/list',{}),/PUBLIC NATIVE OUTAGE/);
 const stale=c.snapshot();assert.equal(stale.providers.find(p=>p.kind==='native').catalogState,'stale');assert.ok(stale.providers.find(p=>p.kind==='native').models.some(m=>m.id==='gpt-test'));assert.equal(stale.pickerRefresh.requested,stale.pickerRefresh.observed);
 f.bridge.native.request=request;await refresh();await f.bridge.request('model/list',{});assert.equal(c.snapshot().providers.find(p=>p.kind==='native').catalogState,'fresh');
});
test('R1 dropped browser-open response can time out/cancel and a new attempt remains usable, while abandoned late replies are ignored',async()=>{
 const p=prepareProviderHome(join(temp(),'scope')),a=authFixture(p),s=ready(a.c),h=ui(s);
 try{await round(h,s,'begin-auth');click(h,'open-auth');const old=h.sent('ui/open-link').at(-1);h.advance(8001);await round(h,s,'cancel-auth');await round(h,s,'begin-auth');assert.equal(buttons(h).find(b=>b.textContent==='Open browser').disabled,false);click(h,'open-auth');const next=h.sent('ui/open-link').at(-1);assert.notEqual(next.id,old.id);h.deliver({jsonrpc:'2.0',id:old.id,result:{}});assert.equal(buttons(h).find(b=>b.textContent==='Open browser').disabled,true,'late abandoned reply cannot clear the current request');h.deliver({jsonrpc:'2.0',id:next.id,result:{}});assert.equal(buttons(h).find(b=>b.textContent==='Open browser').disabled,false);}finally{a.c.close();}
});


test('Root QA successful browser cancellation is neutral and offers restart without a generic failure alarm',async()=>{
 const p=prepareProviderHome(join(temp(),'scope')),a=authFixture(p),s=ready(a.c),h=ui(s);try{await round(h,s,'begin-auth');await round(h,s,'cancel-auth');assert.match(h.text('controls'),/Sign-in cancelled/);assert.doesNotMatch(h.text('controls'),/action could not be completed|Read current state before trying again/);assert.equal(buttons(h).find(b=>b.textContent==='Connect OpenRouter').disabled,false);}finally{a.c.close();}
});
