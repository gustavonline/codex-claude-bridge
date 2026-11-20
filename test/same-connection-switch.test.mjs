import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ProviderRegistry,ResponsesRouter,localModelId,useDurability} from '../plugins/codex-claude/home/providers.mjs';
test.after(useDurability(process.permission?()=>{}:undefined)); // only the permission runner forbids fsync; an ordinary run stays strict
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function setup(options={}){
 const root=mkdtempSync(join(tmpdir(),'bridge-same-model-')),registry=new ProviderRegistry(root),id=registry.create({name:'Synthetic connection',baseUrl:options.openRouter?'https://openrouter.ai/api/v1':'https://fixture.example.invalid/v1'});
 await registry.refresh(id,{request:(_u,_o,receive)=>{const q=new EventEmitter();q.destroy=()=>{};q.end=()=>queueMicrotask(()=>{const r=new EventEmitter();r.statusCode=200;r.destroy=()=>{};receive(r);r.emit('data',Buffer.from(JSON.stringify({data:['a','b','c'].map(id=>({id,pricing:{prompt:'0',completion:'0'},...(options.openRouter?{reasoning:id==='b'?{supported_efforts:['low'],default_effort:'low'}:{supported_efforts:['high','medium'],default_effort:'medium'}}:{})}))})));r.emit('end');});return q;}});
 const state={thread:{id:'synthetic-owned',path:'/synthetic/owned.jsonl',forkedFromId:null,status:{type:'idle'}},model:'a',reasoningEffort:'medium',modelProvider:'bridge_custom_'+id,cwd:'/synthetic',sandbox:{type:'readOnly'},approvalPolicy:'never',approvalsReviewer:'user',activePermissionProfile:null};
 const calls=[],notices=[],control={};let router;
 const peer={request:async(method,p)=>{
  calls.push({method,p:structuredClone(p)});
  if(method==='thread/start')return structuredClone(state);
  if(method==='thread/read'){if(control.threadRead)await control.threadRead();return {thread:{...state.thread,model:state.model,modelProvider:state.modelProvider,reasoningEffort:state.reasoningEffort}};}
  if(method==='thread/resume'){if(control.noRollout)throw Object.assign(Error('no rollout found for thread id '+state.thread.id),{code:-32600});assert.ok(p.model===undefined||p.model===state.model,'a resume of a loaded thread names no model; the FIRST load names exactly the model native itself persisted (read first) - never the route\'s stale one, never the process default');if(control.read)await control.read();return structuredClone(state);}
  if(method==='thread/settings/update'){
   if(control.write)await control.write();state.model=p.model??state.model;state.reasoningEffort=p.effort??state.reasoningEffort;
   router.notification('thread/settings/updated',{threadId:state.thread.id,threadSettings:{model:state.model,modelProvider:state.modelProvider,effort:state.reasoningEffort,cwd:state.cwd,sandboxPolicy:state.sandbox,approvalPolicy:state.approvalPolicy,approvalsReviewer:state.approvalsReviewer,activePermissionProfile:state.activePermissionProfile}});
   if(control.afterWrite)await control.afterWrite();return {};
  }
  if(method==='thread/unsubscribe'){if(control.unload)await control.unload();return {status:'unsubscribed'};}
  if(method==='turn/start')return {turn:{id:'synthetic-turn',status:'inProgress'}};
  throw Error(method);
 }};
 const build=()=>new ResponsesRouter({root,native:{request:async()=>({data:[],nextCursor:null})},nativeFor:async()=>peer,notify:(method,p)=>notices.push({method,p})});router=build();
 await router.request('thread/start',{model:localModelId(id,'a')},()=>{});
 const routePath=join(root,'local-routes/synthetic-owned.json'),route=()=>JSON.parse(readFileSync(routePath));
 const change=(target='b',which=router)=>which.request('thread/settings/update',{threadId:state.thread.id,model:localModelId(id,target),effort:'high'},()=>{});
 return {root,registry,id,state,calls,notices,control,build,router,routePath,route,change};
}
test('same-connection model change confirms native settings then updates route and next dispatch with identity/permissions retained',async()=>{
 const f=await setup(),before=f.route();await f.change();assert.equal(f.route().model,'b');
 assert.deepEqual({...f.route(),model:'a'},before);assert.equal(f.notices.length,1);assert.equal(f.notices[0].p.threadSettings.model,localModelId(f.id,'b'));
 await f.router.request('turn/start',{threadId:f.state.thread.id,input:[],model:localModelId(f.id,'b')},()=>{});
 assert.equal(f.calls.at(-1).p.model,'b');assert.equal(f.state.approvalPolicy,'never');
});
test('rejected settings change retains route and sends no prompt',async()=>{
 const f=await setup(),before=readFileSync(f.routePath);f.control.write=()=>{throw Error('synthetic native refusal');};await assert.rejects(f.change(),/synthetic native refusal/);
 assert.deepEqual(readFileSync(f.routePath),before);assert.ok(!f.calls.some(c=>c.method==='turn/start'));
});
test('unknown readback after native success recovers actual model on restart without replaying settings or a prompt',async()=>{
 const f=await setup();f.control.afterWrite=()=>{f.control.read=()=>{throw Error('synthetic unknown readback');};};await assert.rejects(f.change(),/synthetic unknown readback/);assert.equal(f.route().model,'a');assert.equal(f.state.model,'b');
 delete f.control.read;delete f.control.afterWrite;const restarted=f.build();await restarted.request('turn/start',{threadId:f.state.thread.id,input:[],model:localModelId(f.id,'b')},()=>{});
 assert.equal(f.route().model,'b');assert.equal(f.calls.filter(c=>c.method==='thread/settings/update').length,1);assert.equal(f.calls.filter(c=>c.method==='turn/start').length,1);
});
test('live transition blocks another router instance and disable during await cannot commit success',async()=>{
 const f=await setup(),entered=defer(),release=defer();f.control.write=async()=>{entered.resolve();await release.promise;};const changing=f.change();await entered.promise;
 await assert.rejects(f.build().request('turn/start',{threadId:f.state.thread.id,input:[]},()=>{}),{code:'model_change_pending'});
 f.registry.enabled(f.id,false);release.resolve();await assert.rejects(changing,{code:'stale_revision'});assert.equal(f.route().model,'a');assert.ok(!f.calls.some(c=>c.method==='turn/start'));
});
test('changed permission snapshot or delayed competing native selection never publishes a successful old selection',async()=>{
 for(const mutation of [s=>{s.sandbox={type:'dangerFullAccess'};},s=>{s.model='c';}]){
  const f=await setup();f.control.afterWrite=()=>mutation(f.state);await assert.rejects(f.change());assert.equal(f.route().model,'a');assert.equal(f.notices.length,0);
 }
});
test('a dead writer lock is reclaimed, then native persisted model is recovered instead of reset',async()=>{
 const f=await setup();f.state.model='b';writeFileSync(join(f.root,'local-routes/synthetic-owned.lock'),JSON.stringify({pid:2147483647,token:'a'.repeat(32)}),{mode:0o600});
 await f.build().request('turn/start',{threadId:f.state.thread.id,input:[],model:localModelId(f.id,'b')},()=>{});assert.equal(f.route().model,'b');assert.equal(f.calls.filter(c=>c.method==='thread/settings/update').length,0);
});
test('active native turn and foreign-provider readback are refused without rewriting the route',async()=>{
 for(const mutation of [s=>{s.thread.status.type='active';},s=>{s.modelProvider='foreign';}]){
  const f=await setup();mutation(f.state);await assert.rejects(f.change());assert.equal(f.route().model,'a');assert.ok(!f.calls.some(c=>c.method==='thread/settings/update'));
 }
});

test('a cached native peer never overwrites a route committed by another controller',async()=>{
 const f=await setup();const newer={...f.route(),model:'c'};writeFileSync(f.routePath,JSON.stringify(newer),{mode:0o600});
 await assert.rejects(f.router.request('turn/start',{threadId:f.state.thread.id,input:[],model:localModelId(f.id,'c')},()=>{}),{code:'native_runtime_stale'});assert.equal(f.route().model,'c');assert.ok(!f.calls.some(c=>c.method==='turn/start'));
});

test('fresh thread before first rollout can change twice without creating a seed turn',async()=>{
 const f=await setup();f.control.noRollout=true;await f.change('b');await f.change('c');assert.equal(f.route().model,'c');assert.ok(!f.calls.some(c=>c.method==='turn/start'));
 await f.router.request('turn/start',{threadId:f.state.thread.id,model:localModelId(f.id,'c'),input:[]},()=>{});assert.equal(f.calls.at(-1).p.model,'c');
});

test('fresh unpublished thread recovers a failed readback from native-observed settings without replay',async()=>{
 const f=await setup();f.control.noRollout=true;f.control.afterWrite=()=>{f.control.threadRead=()=>{delete f.control.threadRead;throw Error('synthetic failed fresh readback');};};
 await assert.rejects(f.change('b'),/synthetic failed fresh readback/);assert.equal(f.route().model,'a');
 await f.router.request('turn/start',{threadId:f.state.thread.id,model:localModelId(f.id,'b'),input:[]},()=>{});assert.equal(f.route().model,'b');assert.equal(f.calls.filter(c=>c.method==='thread/settings/update').length,1);
});

for(const method of ['turn/start','thread/settings/update','thread/resume'])test('route committed between initial read and lock cannot authorize cached native state: '+method,async()=>{
 const f=await setup(),lock=f.router.routeLock.bind(f.router),before=f.calls.length;
 f.router.routeLock=tid=>{writeFileSync(f.routePath,JSON.stringify({...f.route(),model:'c'}),{mode:0o600});return lock(tid);};
 await assert.rejects(f.router.request(method,{threadId:f.state.thread.id,...(method==='turn/start'?{input:[]}:{}),...(method==='thread/settings/update'?{model:localModelId(f.id,'b'),effort:'high'}:{})},()=>{}),{code:'stale_revision'});
 assert.equal(f.route().model,'c');assert.equal(f.state.model,'a');assert.equal(f.calls.length,before,'no stale native dispatch');
});

test('unsubscribing alone never clears stale native ownership or permits an old snapshot to replace a newer route',async()=>{
 const f=await setup();writeFileSync(f.routePath,JSON.stringify({...f.route(),model:'c'}),{mode:0o600});
 await assert.rejects(f.router.request('turn/start',{threadId:f.state.thread.id,input:[]},()=>{}),{code:'native_runtime_stale'});
 await f.router.request('thread/unsubscribe',{threadId:f.state.thread.id},()=>{});
 await assert.rejects(f.router.request('thread/resume',{threadId:f.state.thread.id},()=>{}),{code:'native_runtime_stale'});assert.equal(f.route().model,'c');assert.equal(f.state.model,'a');
});
test('a vanished model in this connection has its own error instead of a cross-provider denial',async()=>{
 const f=await setup();await assert.rejects(f.change('missing'),{code:'model_not_available'});assert.equal(f.route().model,'a');
});

test('switch keeps a supported effort and otherwise uses the target model advertised default in both fields',async()=>{
 const f=await setup({openRouter:true});await f.change('b');assert.equal(f.state.reasoningEffort,'low');
 assert.equal(f.calls.findLast(c=>c.method==='thread/settings/update').p.effort,'low');
 await f.change('c');assert.equal(f.state.reasoningEffort,'high');
});
