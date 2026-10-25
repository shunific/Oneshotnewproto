const test=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {withNativeDeviceFixture}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const {readStoredNativeEvent}=require('../server-device-proof.cjs');
const {createReservationMoveCoordinator,initializeReservationMoveSchema,readStoredReservationMoveEvent,recordAcceptedNativePosition}=require('../server-reservation-moves.cjs');
const get=(db,sql,args=[])=>new Promise((resolve,reject)=>db.get(sql,args,(e,row)=>e?reject(e):resolve(row)));
async function completedMove(f){
 await initializeReservationMoveSchema(f.db);
 const admitted=await readStoredNativeEvent(f.file,{eventType:'admission',eventId:f.admission.outboxEventId});
 await recordAcceptedNativePosition(f.db,admitted,{ack:{state:'checked-in',revision:input.result.claim.claimRevision+1}});
 await f.run('INSERT INTO tables VALUES(?,?,?,?,?)',['QA-REVIEW-TARGET','QA target','available',1,null]);
 const actor=()=>({...f.context});
 const coordinator=createReservationMoveCoordinator(f.file,{resolveActor:async()=>actor(),isActorCurrent:(_,a)=>a.generation===f.context.generation&&a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId,deliverEvent:async(_,command)=>{
  const event=await readStoredReservationMoveEvent(f.db,command,{allowDelivered:true});const body=JSON.parse(event.payload);
  const result={ack:{eventId:event.eventId,eventType:event.eventType,claimId:event.claimId,deviceId:event.deviceId,reservationId:event.reservationId,payloadSha256:createHash('sha256').update(event.payload).digest('hex'),state:body.type==='reservation-move-prepare'?'move-prepared':'moved',revision:body.expectedRevision+1,receiptId:null,receivedAt:new Date().toISOString(),acceptedBy:f.context.cloudUserId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false};
  await f.run('BEGIN IMMEDIATE');try{await recordAcceptedNativePosition(f.db,event,result);await f.run('UPDATE native_reservation_move_outbox SET delivered_at=? WHERE event_id=?',[result.ack.receivedAt,event.eventId]);await f.run('COMMIT');}catch(e){await f.run('ROLLBACK');throw e;}
  return result;
 }});
 await coordinator.move('qa-token',{requestId:'qa_review_original_move',sourceId:input.command.tableId,targetId:'QA-REVIEW-TARGET',expectedSession:f.admission.table.session,expectedTargetStatus:'available',expectedTargetSession:null});
 return coordinator;
}
test('completed move replay rejects a corrupted saved target/session instead of returning forged financial state',async()=>withNativeDeviceFixture(input,async f=>{
 const coordinator=await completedMove(f);
 const row=await get(f.db,'SELECT response_json FROM native_reservation_moves WHERE request_id=?',['qa_review_original_move']);
 const response=JSON.parse(row.response_json);response.target.session.amountPaid+=100;response.target.id='QA-FORGED-TARGET';
 await f.run('UPDATE native_reservation_moves SET response_json=? WHERE request_id=?',[JSON.stringify(response),'qa_review_original_move']);
 await assert.rejects(coordinator.recover('qa-token',{requestId:'qa_review_original_move',action:'continue'}),{code:'NATIVE_MOVE_RECONCILIATION_REQUIRED'});
}));
test('completed move replay binds each saved identity and physical result while preserving later guests',async()=>withNativeDeviceFixture(input,async f=>{
 const coordinator=await completedMove(f);
 const row=await get(f.db,'SELECT response_json FROM native_reservation_moves WHERE request_id=?',['qa_review_original_move']);
 const mutations=[
  r=>{r.requestId='qa_different_request';},r=>{r.moveId='11111111-1111-4111-8111-111111111111';},
  r=>{r.id='QA-FORGED';},r=>{r.source.id='QA-FORGED';},r=>{r.source.status='occupied';},
  r=>{r.source.session={startTime:new Date().toISOString()};},r=>{r.target.id='QA-FORGED';},
  r=>{r.target.status='available';},r=>{r.target.session.startTime=new Date(0).toISOString();},
  r=>{r.target.session.orders=[{id:'QA-fabricated',qty:1,price:1}];},r=>{r.phase='aborting';}
 ];
 for(const [index,mutate]of mutations.entries()){
  const response=JSON.parse(row.response_json);mutate(response);
  await f.run('UPDATE native_reservation_moves SET response_json=? WHERE request_id=?',[JSON.stringify(response),'qa_review_original_move']);
  await assert.rejects(coordinator.recover('qa-token',{requestId:'qa_review_original_move',action:'continue'}),{code:'NATIVE_MOVE_RECONCILIATION_REQUIRED'},`saved response mutation ${index}`);
 }
 await f.run('UPDATE native_reservation_moves SET response_json=? WHERE request_id=?',[row.response_json,'qa_review_original_move']);
 const nextGuest=JSON.stringify({startTime:new Date(0).toISOString(),customerName:'QA later guest preserved'});
 await f.run("UPDATE tables SET status='occupied',sessionData=? WHERE id=?",[nextGuest,'QA-REVIEW-TARGET']);
 const replay=await coordinator.recover('qa-token',{requestId:'qa_review_original_move',action:'continue'});
 assert.equal(replay.replayed,true);assert.equal(replay.phase,'committed');
 assert.equal((await get(f.db,'SELECT sessionData FROM tables WHERE id=?',['QA-REVIEW-TARGET'])).sessionData,nextGuest);
}));
