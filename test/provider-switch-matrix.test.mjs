import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support/fixture.mjs';
for(const start of ['gpt-test','sonnet']) test('managed native/Claude switching retains one visible conversation: '+start,async()=>{
 const f=fixture();
 try{
  const id=await f.start(start);
  const send=async(text)=>{const answer=await f.send(id,text);await f.done(answer.turn.id);if(f.bridge.records.has(id))await f.settled(answer.turn.id);};
  await send('Synthetic first message');
  const initial=f.bridge.records.has(id)?await f.bridge.request('thread/read',{threadId:id,includeTurns:true}):{thread:f.hosts.get(id).thread};
  const firstTurn=initial.thread.turns[0].id;
  for(const model of start==='sonnet'?['gpt-other','sonnet']:['sonnet','gpt-other']){
   await f.bridge.request('thread/settings/update',{threadId:id,model,effort:'high'});
   await send('Synthetic continuation '+model);
  }
  const current=await f.bridge.request('thread/read',{threadId:id,includeTurns:true});
  assert.equal(current.thread.id,id);assert.equal(current.thread.turns.length,3);assert.equal(current.thread.turns[0].id,firstTurn);
  const claudeQuery=f.queries.at(-1);assert.equal(claudeQuery.record.effort,'high');
  if(start==='gpt-test') assert.match(claudeQuery.additionalContext.bridge_conversation.value,/Synthetic first message/);
  assert.equal(f.bridge.records.get(id).approvalPolicy,'never');
 }finally{f.bridge.mirror?.stop();}
});
