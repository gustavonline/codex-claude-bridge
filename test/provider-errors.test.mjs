import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResponsesRouter} from '../plugins/codex-claude/home/providers.mjs';
import {Peer,RpcError} from '../rpc.mjs';
async function response(error){const input=new PassThrough(),output=new PassThrough();const peer=new Peer(input,output,{request:async()=>{throw error;}});const answer=new Promise(r=>output.once('data',b=>r(JSON.parse(b))));input.write(JSON.stringify({id:1,method:'thread/settings/update',params:{}})+'\n');try{return await answer;}finally{peer.end();input.end();output.end();}}
test('provider refusal uses a numeric JSON-RPC error and retains its stable Bridge reason in structured data',async()=>{
 const r=await response(Object.assign(Error('No prompt was sent.'),{code:'model_change_pending'}));assert.equal(r.error.code,-32603);assert.equal(r.error.data.bridgeErrorCode,'model_change_pending');assert.equal(r.error.message,'No prompt was sent.');
});
test('native numeric provider mismatch and its typed data pass through unchanged',async()=>{
 const data={type:'modelProviderMismatch',modelProvider:'one',currentModelProvider:'two'};const r=await response(new RpcError('Native mismatch',-32600,data));assert.equal(r.error.code,-32600);assert.deepEqual(r.error.data,data);
});

test('actual early provider refusal preserves the Opus-approved explanation and never contacts native inference',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bridge-error-copy-'));let nativeCalls=0;const router=new ResponsesRouter({root,native:{request:async()=>{nativeCalls++;throw Error('must not dispatch');}}});
 let error;try{await router.request('thread/settings/update',{threadId:'synthetic-existing',model:'bridge-responses/'+ 'a'.repeat(32)+'/bW9kZWw'},()=>{throw Error('must not forward');});}catch(e){error=e;}
 const r=await response(error);assert.equal(nativeCalls,0);assert.equal(r.error.data.bridgeErrorCode,'local_requires_new_thread');assert.equal(r.error.message,"This chat can't switch to that connection. No message was sent. Start a new chat to use it; this chat keeps its model and history.");
});
