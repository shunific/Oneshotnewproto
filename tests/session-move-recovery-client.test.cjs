const test=require('node:test'),assert=require('node:assert/strict');
const storage=()=>{const map=new Map();return{get length(){return map.size},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
const record={requestId:'qa_recover_original',moveId:'11111111-1111-4111-8111-111111111111',sourceId:'a',targetId:'b',phase:'prepared'};
const payload={expectedSession:{startTime:'2026-10-19T00:00:00.000Z',pricingVersion:2},targetId:'b',expectedTargetStatus:'available',expectedTargetSession:null};
const terminal={requestId:record.requestId,moveId:record.moveId,phase:'aborted',cloudAcknowledged:true};
async function seed(){const m=await import('../src/app/utils/sessionPersistence.js'),local=storage();await assert.rejects(m.saveSessionChange({storage:local,tableId:'a',kind:'move',payload,newId:()=>record.requestId,request:async()=>{throw Object.assign(Error('Cloud target conflict'),{status:409});}}));return{...m,local};}
test('a cloud-rejected reservation transfer retains its original request across reload, while a legacy rolled-back move may clear',async()=>{
 const x=await seed();assert.equal(x.pendingSessionChanges(x.local)[0].requestId,record.requestId);
 const local=storage();await assert.rejects(x.saveSessionChange({storage:local,tableId:'a',kind:'move',payload:{...payload,expectedSession:{...payload.expectedSession,pricingVersion:1}},request:async()=>{throw Object.assign(Error('Target changed'),{status:409});}}));assert.equal(local.length,0);
});
test('only a verified terminal cancellation clears the exact original browser draft and sends no replacement prepare',async()=>{
 const x=await seed(),calls=[];const result=await x.recoverReservationMove({storage:x.local,record,action:'abort',request:async(path,body)=>{calls.push({path,body});return terminal;}});
 assert.equal(result.phase,'aborted');assert.equal(x.local.length,0);assert.deepEqual(calls,[{path:'/api/native/reservation-moves/recover',body:{requestId:record.requestId,action:'abort'}}]);
});
test('unknown cancellation, malformed ACK or account change preserves the original draft',async()=>{
 for(const kind of ['lost','wrong-id','wrong-move','missing-confirmation','account-change']){
  const x=await seed();let current=true;
  await assert.rejects(x.recoverReservationMove({storage:x.local,record,action:'abort',isCurrent:()=>current,request:async()=>{
   if(kind==='lost')throw Error('Lost response');if(kind==='account-change'){current=false;return terminal;}
   return{...terminal,...(kind==='wrong-id'?{requestId:'qa_other_request'}:kind==='wrong-move'?{moveId:'22222222-2222-4222-8222-222222222222'}:{cloudAcknowledged:false})};
  }}));assert.equal(x.local.length,1,kind);
 }
});
test('cancellation response cannot clear a replacement draft or permit abort after local commit',async()=>{
 const x=await seed();await x.recoverReservationMove({storage:x.local,record,action:'abort',request:async()=>{x.local.setItem('oneshot_pending_session:a',JSON.stringify({requestId:'qa_new_request'}));return terminal;}});assert.equal(JSON.parse(x.local.getItem('oneshot_pending_session:a')).requestId,'qa_new_request');
 let sent=false;await assert.rejects(x.recoverReservationMove({storage:x.local,record:{...record,phase:'local-committed'},action:'abort',request:async()=>{sent=true;}}));assert.equal(sent,false);
});
test('retry of an already cancelled reservation clears its matching draft without reporting a moved target',async()=>{
 const x=await seed();const result=await x.saveSessionChange({storage:x.local,tableId:'a',kind:'move',payload,request:async()=>({...terminal,cloudAcknowledged:undefined,replayed:true})});assert.equal(result.phase,'aborted');assert.equal(x.local.length,0);
});
test('pending recovery metadata rejects private fields, duplicate identities and terminal phases',async()=>{
 const {readPendingReservationMoveList}=await import('../src/app/utils/sessionPersistence.js');assert.deepEqual(readPendingReservationMoveList({moves:[record]}),[record]);
 for(const value of [{moves:[{...record,password:'forged'}]},{moves:[record,record]},{moves:[record,{...record,requestId:'qa_other_request'}]},{moves:[{...record,phase:'committed'}]},{moves:[{...record,sourceId:'b'}]}])assert.throws(()=>readPendingReservationMoveList(value));
});
test('only a matching durable not-started rejection releases a reservation draft for another destination',async()=>{
 const m=await import('../src/app/utils/sessionPersistence.js');
 for(const variant of ['valid','wrong-request','wrong-source','wrong-code','wrong-status','replacement']){
  const local=storage();const rejection={code:'NATIVE_MOVE_NOT_STARTED',requestId:record.requestId,sourceId:'a'};
  if(variant==='wrong-request')rejection.requestId='qa_other_request';
  if(variant==='wrong-source')rejection.sourceId='b';
  if(variant==='wrong-code')rejection.code='CLOUD_REJECTED';
  await assert.rejects(m.saveSessionChange({storage:local,tableId:'a',kind:'move',payload,newId:()=>record.requestId,request:async()=>{
   if(variant==='replacement')local.setItem('oneshot_pending_session:a',JSON.stringify({requestId:'qa_new_request'}));
   throw Object.assign(Error('Not started'),{status:variant==='wrong-status'?503:409,response:rejection});
  }}));
  assert.equal(local.length,variant==='valid'?0:1,variant);
  if(variant==='valid'){
   let sent=false;await assert.rejects(m.saveSessionChange({storage:local,tableId:'a',kind:'move',payload:{...payload,targetId:'c'},newId:()=> 'qa_new_destination',request:async()=>{sent=true;throw Error('Unconfirmed');}}));
   assert.equal(sent,true);assert.equal(m.pendingSessionChanges(local)[0].requestId,'qa_new_destination');
  }
 }
});
