import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProviderRegistry,ResponsesRouter,localModelId,catalogDetails,reasoningMetadata,useDurability} from '../plugins/codex-claude/home/providers.mjs';
test.after(useDurability(process.permission?()=>{}:undefined)); // only the permission runner forbids fsync; an ordinary run stays strict
const reasoning={supported_efforts:['high','medium','low'],default_effort:'medium',default_enabled:true,mandatory:true};
const data={data:[{id:'explicit-reasoner',pricing:{prompt:'0',completion:'0'},supported_parameters:['reasoning'],reasoning},{id:'openrouter/free',pricing:{prompt:'0',completion:'0'},supported_parameters:['reasoning','reasoning_effort']}]};
function request(_url,_opts,receive){const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.destroy=()=>{};receive(res);res.emit('data',Buffer.from(JSON.stringify(data)));res.emit('end');});return req;}
test('documented per-model reasoning metadata survives catalog persistence and enables exactly advertised choices',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bridge-reasoning-')),r=new ProviderRegistry(root),id=r.create({name:'Synthetic OpenRouter',baseUrl:'https://openrouter.ai/api/v1'});
 await r.refresh(id,{request});const stored=new ProviderRegistry(root).read(id);assert.deepEqual(stored.catalog.details[0].reasoning,reasoning);
 const rows=new ResponsesRouter({root,native:{}}).mergeModels([]).models;
 assert.deepEqual(rows[0].supportedReasoningEfforts.map(x=>x.reasoningEffort),['high','medium','low']);assert.equal(rows[0].defaultReasoningEffort,'medium');
 assert.deepEqual(rows[1].supportedReasoningEfforts,[],'dynamic router parameters alone never imply uniform effort support');
});
test('unknown endpoints cannot acquire native capabilities from an undocumented extra field',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bridge-reasoning-')),r=new ProviderRegistry(root),id=r.create({name:'Synthetic generic',baseUrl:'https://fixture.example.invalid/v1'});
 await r.refresh(id,{request});assert.ok(new ResponsesRouter({root,native:{}}).mergeModels([]).models.every(m=>!m.supportedReasoningEfforts.length));
});
test('malformed reasoning metadata is refused; mandatory excludes none and null efforts have documented semantics',()=>{
 for(const value of [{supported_efforts:['invented']},{supported_efforts:['high','high']},{supported_efforts:'high'},{mandatory:'true'},{default_effort:'automatic'}])assert.throws(()=>reasoningMetadata(value),{code:'catalog_invalid'});
 assert.deepEqual(reasoningMetadata({supported_efforts:null,mandatory:false}),{supported_efforts:null,mandatory:false});assert.equal(catalogDetails(data)[1].reasoning,undefined);
});

test('an effort outside a known model contract is refused before acquiring an inference child',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bridge-reasoning-')),r=new ProviderRegistry(root),id=r.create({name:'Synthetic OpenRouter',baseUrl:'https://openrouter.ai/api/v1'});await r.refresh(id,{request});
 let acquired=0;const router=new ResponsesRouter({root,native:{request:async()=>({data:[],nextCursor:null})},nativeFor:async()=>{acquired++;throw Error('must not dispatch');}});
 await assert.rejects(router.request('thread/start',{model:localModelId(id,'explicit-reasoner'),effort:'max'},()=>{}),{code:'unsupported_reasoning_effort'});assert.equal(acquired,0);
});
