// Independent integration review: real signer, delivery ledgers, SQLite and HTTP checkout.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {withNativeDeviceFixture}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const {createNativeEventDelivery,initializeNativePositionUpgrade}=require('../server-native-delivery.cjs');
const all=(db,sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,r)=>e?reject(e):resolve(r)));
function bridge(f){
 const calls=[];const resolveActor=async()=>({...f.context});const isActorCurrent=(_,a)=>f.context.active&&a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation;
 const delivery=createNativeEventDelivery(f.file,{resolveActor,isActorCurrent,signEvent:f.makeSigner().sign,sendSignedEvent:async(_,e)=>{
  calls.push(e);const body=JSON.parse(e.payload);
  return{ack:{eventId:e.eventId,eventType:e.eventType,claimId:e.claimId,deviceId:e.deviceId,reservationId:input.command.id,payloadSha256:createHash('sha256').update(e.payload).digest('hex'),state:e.eventType==='admission'?'checked-in':'completed',revision:body.expectedRevision!==undefined?body.expectedRevision+1:input.result.claim.claimRevision+(e.eventType==='admission'?1:2),receiptId:e.eventType==='admission'?null:body.receipt.id,receivedAt:new Date().toISOString(),acceptedBy:f.context.cloudUserId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false};
 }});return{delivery,calls};
}
test('legacy v1 completion created before admission ACK remains deliverable after admission initializes position',async()=>withNativeDeviceFixture(input,async f=>{
 const b=bridge(f);const closed=await f.checkout();const completion=(await all(f.db,'SELECT payload_json FROM native_reservation_completion_outbox'))[0];assert.equal(JSON.parse(completion.payload_json).version,1);
 await b.delivery.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});
 const result=await b.delivery.deliver('qa-token',{eventType:'reservation-completion',eventId:closed.reservationCompletion.eventId});assert.equal(result.ack.state,'completed');assert.equal(b.calls.length,2);
}));
test('faithful RC13 startup upgrade preserves acknowledged admission and allows checkout without an artificial move',async()=>withNativeDeviceFixture(input,async f=>{
 const b=bridge(f);await b.delivery.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});
 const old=await all(f.db,'SELECT * FROM native_event_deliveries');
 // This private fixture removes every schema introduced after RC13, preserving its old exact ACK journal.
 for(const name of ['native_reservation_positions','native_reservation_moves','native_reservation_move_holds','native_reservation_move_outbox','native_move_event_deliveries','native_reservation_move_cancel_outbox','native_move_cancel_deliveries','native_reservation_move_rejections'])await f.run('DROP TABLE '+name);
 await initializeNativePositionUpgrade(f.db);
 const closed=await f.checkout();assert.equal(closed.receipt.reservation_claim_id,input.result.claim.claimId);assert.deepEqual(await all(f.db,'SELECT * FROM native_event_deliveries'),old);
}));
test('archived completion local replay stays independent of an unrelated newer move hold on the reused physical table',async()=>withNativeDeviceFixture(input,async f=>{
 const b=bridge(f);await b.delivery.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});const closed=await f.checkout();const command={eventType:'reservation-completion',eventId:closed.reservationCompletion.eventId};
 await b.delivery.deliver('qa-token',command);
 await f.run("UPDATE tables SET status='occupied',sessionData='QA unrelated next guest' WHERE id=?",[input.command.tableId]);
 await f.run('INSERT INTO native_reservation_move_holds VALUES(?,?,?)',[input.command.tableId,randomUUID(),randomUUID()]);
 const before=await all(f.db,'SELECT * FROM tables');const count=b.calls.length;
 const replay=await b.delivery.deliver('qa-token',command);assert.equal(replay.replayed,true);assert.equal(b.calls.length,count);assert.deepEqual(await all(f.db,'SELECT * FROM tables'),before);
}));
