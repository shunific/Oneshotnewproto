const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const express=require('express');
const {withNativeDeviceFixture}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const {createNativeEventDelivery,readAcceptedReservationPosition}=require('../server-native-delivery.cjs');
const {createReservationMoveCoordinator,reservationMoveDefinitions,initializeReservationMoveSchema,assertReservationMoveSchema,listPendingReservationMoves}=require('../server-reservation-moves.cjs');
const {registerSessionStateRoutes}=require('../server-session-state.cjs');
const all=(db,sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,r)=>e?reject(e):resolve(r)));
async function withHttp(f,callback){
 const calls=[];let cloudReject=false;const resolveActor=async()=>({...f.context}),isActorCurrent=(_,a)=>f.context.active&&a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation;
 const delivery=createNativeEventDelivery(f.file,{resolveActor,isActorCurrent,signEvent:f.makeSigner().sign,sendSignedEvent:async(_,e)=>{calls.push(e);if(cloudReject&&e.eventType==='reservation-move-prepare')throw Object.assign(Error('Synthetic cloud schedule conflict'),{status:409});const body=JSON.parse(e.payload);return{ack:{eventId:e.eventId,eventType:e.eventType,claimId:e.claimId,deviceId:e.deviceId,reservationId:input.command.id,payloadSha256:createHash('sha256').update(e.payload).digest('hex'),state:e.eventType==='admission'?'checked-in':e.eventType==='reservation-move-prepare'?'move-prepared':'moved',revision:e.eventType==='admission'?input.result.claim.claimRevision+1:body.expectedRevision+1,receiptId:null,receivedAt:new Date().toISOString(),acceptedBy:f.context.cloudUserId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false};}});
 await delivery.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});await f.run("INSERT INTO tables VALUES('QA-RACE-TARGET','QA target','available',1,NULL),('QA-OTHER-TARGET','QA other','available',1,NULL)");
 const moves=createReservationMoveCoordinator(f.file,{resolveActor,isActorCurrent,deliverEvent:delivery.deliver,readAcceptedPosition:readAcceptedReservationPosition});
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authToken='qa-token';req.staff={id:f.context.localStaffId};next();});await registerSessionStateRoutes(app,f.file,{reservationMoves:moves,resolveActor,isActorCurrent}).ready;
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const request={requestId:'qa_preintent_original',expectedSession:f.admission.table.session,targetId:'QA-RACE-TARGET',expectedTargetStatus:'available',expectedTargetSession:null};
 const post=async(body=request)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/tables/${input.command.tableId}/move`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
 try{return await callback({post,request,calls,moves,rejectCloud(){cloudReject=true;}});}finally{await new Promise(resolve=>server.close(resolve));}
}
test('local pre-intent rejection commits exact tombstone and old request never resurrects after target becomes available',async()=>withNativeDeviceFixture(input,async f=>withHttp(f,async h=>{
 await f.run("UPDATE tables SET status='occupied',sessionData='QA next guest' WHERE id='QA-RACE-TARGET'");
 const first=await h.post();assert.equal(first.status,409);assert.deepEqual(Object.keys(first.body).sort(),['error','code','requestId','sourceId'].sort());assert.equal(first.body.code,'NATIVE_MOVE_NOT_STARTED');assert.equal(first.body.requestId,h.request.requestId);assert.equal(first.body.sourceId,input.command.tableId);
 assert.deepEqual(await listPendingReservationMoves(f.file),[]);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_rejections')).length,1);assert.equal((await all(f.db,'SELECT * FROM native_reservation_moves')).length,0);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,0);
 await f.run("UPDATE tables SET status='available',sessionData=NULL WHERE id='QA-RACE-TARGET'");assert.deepEqual(await h.post(),first);assert.equal(h.calls.length,1);
 const conflict=await h.post({...h.request,targetId:'QA-OTHER-TARGET'});assert.equal(conflict.status,409);assert.equal(conflict.body.code,undefined);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,0);
 assert.equal((await h.post({...h.request,requestId:'qa_new_after_rejection'})).status,200);const current=await all(f.db,'SELECT * FROM tables');assert.deepEqual(await h.post(),first);assert.deepEqual(await all(f.db,'SELECT * FROM tables'),current);
})));
test('concurrent rejected retries create exactly one tombstone and no operation or cloud request',async()=>withNativeDeviceFixture(input,async f=>withHttp(f,async h=>{
 await f.run("UPDATE tables SET isActive=0 WHERE id='QA-RACE-TARGET'");const results=await Promise.all([h.post(),h.post()]);assert.deepEqual(results[0],results[1]);assert.equal(results[0].body.code,'NATIVE_MOVE_NOT_STARTED');assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_rejections')).length,1);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_outbox')).length,0);assert.equal(h.calls.length,1);
})));
test('foreign table hold rejection never alters foreign holds and has exact not-started metadata',async()=>withNativeDeviceFixture(input,async f=>withHttp(f,async h=>{
 await f.run('INSERT INTO native_reservation_move_holds VALUES(?,?,?)',['QA-RACE-TARGET',randomUUID(),randomUUID()]);const before=await all(f.db,'SELECT * FROM native_reservation_move_holds');const result=await h.post();assert.equal(result.body.code,'NATIVE_MOVE_NOT_STARTED');assert.equal((await all(f.db,'SELECT reason_code FROM native_reservation_move_rejections'))[0].reason_code,'TABLE_HELD');assert.deepEqual(await all(f.db,'SELECT * FROM native_reservation_move_holds'),before);assert.equal(h.calls.length,1);
})));
test('post-intent cloud rejection retains original native intent and omits not-started metadata',async()=>withNativeDeviceFixture(input,async f=>withHttp(f,async h=>{
 h.rejectCloud();const first=await h.post();assert.equal(first.status,409);assert.equal(first.body.code,undefined);const original=(await all(f.db,'SELECT * FROM native_reservation_moves'))[0];assert.equal(original.request_id,h.request.requestId);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,2);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_rejections')).length,0);
 assert.equal((await h.post()).status,409);assert.deepEqual((await all(f.db,'SELECT * FROM native_reservation_moves'))[0],original);assert.equal(h.calls.filter(e=>e.eventType==='reservation-move-prepare').length,2);assert.equal(h.calls[1].eventId,h.calls[2].eventId);
})));
test('failed tombstone INSERT gives unknown503 with no false safe-clear metadata and can retry to a durable rejection',async()=>withNativeDeviceFixture(input,async f=>withHttp(f,async h=>{
 await f.run("UPDATE tables SET isActive=0 WHERE id='QA-RACE-TARGET'");await f.run("CREATE TRIGGER qa_rejection_failure BEFORE INSERT ON native_reservation_move_rejections BEGIN SELECT RAISE(ABORT,'QA late rejection'); END");const failed=await h.post();assert.equal(failed.status,503);assert.equal(failed.body.code,undefined);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_rejections')).length,0);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,0);await f.run('DROP TRIGGER qa_rejection_failure');assert.equal((await h.post()).body.code,'NATIVE_MOVE_NOT_STARTED');
})));
test('reviewed old4 and old5 schemas append rejection schema idempotently without rewriting existing definitions',async()=>{
 for(const count of [4,5])await withNativeDeviceFixture(input,async f=>{
  for(const [,ddl]of reservationMoveDefinitions.slice(0,count))await f.run(ddl);const before=await all(f.db,"SELECT name,sql FROM sqlite_master WHERE name LIKE 'native_reservation_%' ORDER BY name");await assertReservationMoveSchema(f.db,{allowLegacy:true});await initializeReservationMoveSchema(f.db);await assertReservationMoveSchema(f.db);const after=await all(f.db,"SELECT name,sql FROM sqlite_master WHERE name LIKE 'native_reservation_%' ORDER BY name");for(const row of before)assert.deepEqual(after.find(v=>v.name===row.name),row);assert.equal(after.length,6);await initializeReservationMoveSchema(f.db);assert.deepEqual(await all(f.db,"SELECT name,sql FROM sqlite_master WHERE name LIKE 'native_reservation_%' ORDER BY name"),after);
 });
});
test('real HTTP not-started proof clears only its original browser draft and permits a new destination; post-intent rejection retains it',async()=>{
 const {saveSessionChange,pendingSessionChanges}=await import('../src/app/utils/sessionPersistence.js');
 for(const afterIntent of [false,true])await withNativeDeviceFixture(input,async f=>withHttp(f,async h=>{
  const map=new Map(),storage={get length(){return map.size;},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
  const request=async(_route,body)=>{const response=await h.post(body);if(response.status!==200)throw Object.assign(Error(response.body.error),{status:response.status,response:response.body});return response.body;};
  if(afterIntent)h.rejectCloud();else await f.run("UPDATE tables SET isActive=0 WHERE id='QA-RACE-TARGET'");
  const {requestId,...payload}=h.request;await assert.rejects(saveSessionChange({storage,tableId:input.command.tableId,kind:'move',payload,newId:()=>requestId,request}),{status:409});
  assert.equal(pendingSessionChanges(storage).length,afterIntent?1:0);
  if(afterIntent){assert.equal(pendingSessionChanges(storage)[0].requestId,requestId);assert.equal((await all(f.db,'SELECT * FROM native_reservation_moves'))[0].request_id,requestId);}
  else{const saved=await saveSessionChange({storage,tableId:input.command.tableId,kind:'move',payload:{...payload,targetId:'QA-OTHER-TARGET'},newId:()=> 'qa_new_destination_after_proof',request});assert.equal(saved.phase,'committed');assert.equal(storage.length,0);}
 }));
});
