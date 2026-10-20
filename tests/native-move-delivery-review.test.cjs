const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const express=require('express');
const {withNativeDeviceFixture}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const {createNativeEventDelivery}=require('../server-native-delivery.cjs');
const {createReservationMoveCoordinator}=require('../server-reservation-moves.cjs');
const {registerOrderRoutes}=require('../server-orders.cjs');
const {registerCheckoutRoutes}=require('../server-checkout.cjs');
const get=(db,sql,args=[])=>new Promise((resolve,reject)=>db.get(sql,args,(e,row)=>e?reject(e):resolve(row)));
async function bridge(f){
 const resolveActor=async()=>({...f.context});const isActorCurrent=(_,a)=>f.context.active&&a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation;
 const accepted=new Map(),calls=[];let dropType=null;
 const signer=f.makeSigner();
 const delivery=createNativeEventDelivery(f.file,{resolveActor,isActorCurrent,signEvent:signer.sign,sendSignedEvent:async(_,e)=>{
  calls.push(e);const p=JSON.parse(e.payload);let result=accepted.get(e.eventId);
  if(!result){result={ack:{eventId:e.eventId,eventType:e.eventType,claimId:e.claimId,deviceId:e.deviceId,reservationId:input.command.id,payloadSha256:createHash('sha256').update(e.payload).digest('hex'),state:{admission:'checked-in','reservation-completion':'completed','reservation-move-prepare':'move-prepared','reservation-move-commit':'moved','reservation-move-abort':'move-aborted','reservation-move-cancel':'move-cancelled'}[e.eventType],revision:p.expectedRevision!==undefined?p.expectedRevision+(e.eventType==='reservation-move-cancel'?2:1):input.result.claim.claimRevision+(e.eventType==='admission'?1:2),receiptId:e.eventType==='reservation-completion'?p.receipt.id:null,receivedAt:new Date().toISOString(),acceptedBy:f.context.cloudUserId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false};accepted.set(e.eventId,result);}else result={...result,replayed:true};
  if(dropType===e.eventType){dropType=null;throw Object.assign(Error('Synthetic unknown remote outcome'),{status:503});}return result;
 }});
 const coordinator=createReservationMoveCoordinator(f.file,{resolveActor,isActorCurrent,deliverEvent:delivery.deliver});
 await delivery.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});
 for(const id of ['QA-MOVE-B','QA-MOVE-C'])await f.run('INSERT INTO tables VALUES(?,?,?,?,?)',[id,id,'available',1,null]);
 return{delivery,coordinator,calls,accepted,drop(type){dropType=type;}};
}
async function withHttp(f,callback){
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.staff={id:f.context.localStaffId};next();});registerOrderRoutes(app,f.file);registerCheckoutRoutes(app,f.file);
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const post=async(route,body,expectedStatus=200)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await r.json();assert.equal(r.status,expectedStatus,JSON.stringify(value));return value;};
 try{return await callback(post);}finally{await new Promise(resolve=>server.close(resolve));}
}
test('actual signer/delivery coordinates A→B→C→A and checkout without changing timer, credit, fixed quote or live orders',async()=>withNativeDeviceFixture(input,async f=>withHttp(f,async post=>{
 const b=await bridge(f);
 const ordered=await post(`/api/tables/${input.command.tableId}/orders`,{requestId:'qa_review_before_moves',expectedSessionStartTime:f.admission.table.session.startTime,cart:[{id:'qa-proof-drink',qty:1}]});
 const session=ordered.session;
 for(const [index,[sourceId,targetId]]of [[input.command.tableId,'QA-MOVE-B'],['QA-MOVE-B','QA-MOVE-C'],['QA-MOVE-C',input.command.tableId]].entries()){
  const result=await b.coordinator.move('qa-token',{requestId:`qa_review_chain_${index}`,sourceId,targetId,expectedSession:session,expectedTargetStatus:'available',expectedTargetSession:null});
  assert.equal(result.phase,'committed');assert.deepEqual(result.target.session,session);
  assert.equal((await get(f.db,'SELECT sessionData FROM tables WHERE id=?',[sourceId])).sessionData,null);
 }
 const p=await get(f.db,'SELECT * FROM native_reservation_positions');assert.equal(p.position_sequence,3);assert.equal(p.table_id,input.command.tableId);
 const closed=await post(`/api/tables/${input.command.tableId}/checkout`,{requestId:'qa_review_moved_checkout',expectedSession:session,expectedSessionStartTime:session.startTime,paymentStatus:'paid',paymentMethod:'cash',tendered:265,useProrated:false});
 const completion=await b.delivery.deliver('qa-token',{eventType:'reservation-completion',eventId:closed.reservationCompletion.eventId});
 assert.equal(completion.ack.state,'completed');assert.equal(completion.ack.revision,p.cloud_revision+1);
 assert.equal(closed.receipt.total_amount,325);assert.equal(closed.receipt.amount_paid,325);
 const payload=JSON.parse(b.calls.at(-1).payload);assert.equal(payload.version,2);assert.equal(payload.positionSequence,3);assert.equal(payload.previousPositionEventId,p.position_event_id);
 assert.equal((await get(f.db,'SELECT count(*) n FROM native_reservation_move_holds')).n,0);
})));

for(const [name,sql,args]of [
 ['missing position','DELETE FROM native_reservation_positions',[]],
 ['corrupted position device','UPDATE native_reservation_positions SET device_id=?',['99999999-9999-4999-8999-999999999999']],
 ['corrupted position revision','UPDATE native_reservation_positions SET cloud_revision=cloud_revision+1',[]],
 ['corrupted predecessor','UPDATE native_reservation_positions SET position_event_id=?',['99999999-9999-4999-8999-999999999999']],
])test(`acknowledged admission cannot checkout with ${name} or silently downgrade to legacy completion`,async()=>withNativeDeviceFixture(input,async f=>withHttp(f,async post=>{
 await bridge(f);await f.run(sql,args);
 await post(`/api/tables/${input.command.tableId}/checkout`,{requestId:'qa_review_position_checkout',expectedSession:f.admission.table.session,expectedSessionStartTime:f.admission.table.session.startTime,paymentStatus:'paid',paymentMethod:'cash',tendered:240,useProrated:false},409);
 assert.equal((await get(f.db,'SELECT count(*) n FROM e_receipts')).n,0);
 assert.equal((await get(f.db,'SELECT status FROM tables WHERE id=?',[input.command.tableId])).status,'occupied');
})));
test('unknown prepare then unknown abort retains irreversible source/target holds until original abort ACK and checkout uses the advanced revision',async()=>withNativeDeviceFixture(input,async f=>withHttp(f,async post=>{
 const b=await bridge(f);const request={requestId:'qa_review_abort_move',sourceId:input.command.tableId,targetId:'QA-MOVE-B',expectedSession:f.admission.table.session,expectedTargetStatus:'available',expectedTargetSession:null};
 b.drop('reservation-move-prepare');await assert.rejects(b.coordinator.move('qa-token',request),{status:503});
 assert.equal((await get(f.db,'SELECT count(*) n FROM native_reservation_move_holds')).n,2);
 b.drop('reservation-move-cancel');await assert.rejects(b.coordinator.recover('qa-token',{requestId:request.requestId,action:'abort'}),{status:503});
 assert.equal((await get(f.db,'SELECT phase FROM native_reservation_moves')).phase,'aborting');
 await post(`/api/tables/${input.command.tableId}/checkout`,{requestId:'qa_review_held_checkout',expectedSession:request.expectedSession,expectedSessionStartTime:request.expectedSession.startTime,paymentStatus:'paid',paymentMethod:'cash',tendered:240,useProrated:false},409);
 assert.equal((await get(f.db,'SELECT count(*) n FROM e_receipts')).n,0);
 assert.equal((await b.coordinator.recover('qa-token',{requestId:request.requestId,action:'continue'})).phase,'aborted');
 assert.equal((await get(f.db,'SELECT count(*) n FROM native_reservation_move_holds')).n,0);
 assert.equal(b.calls.some(e=>e.eventType==='reservation-move-commit'),false);
 const p=await get(f.db,'SELECT * FROM native_reservation_positions');assert.equal(p.position_sequence,0);assert.equal(p.cloud_revision,input.result.claim.claimRevision+3);
 const closed=await post(`/api/tables/${input.command.tableId}/checkout`,{requestId:'qa_review_after_abort',expectedSession:request.expectedSession,expectedSessionStartTime:request.expectedSession.startTime,paymentStatus:'paid',paymentMethod:'cash',tendered:240,useProrated:false});
 const completion=await b.delivery.deliver('qa-token',{eventType:'reservation-completion',eventId:closed.reservationCompletion.eventId});assert.equal(completion.ack.revision,p.cloud_revision+1);
 const payload=JSON.parse(b.calls.at(-1).payload);assert.equal(payload.version,2);assert.equal(payload.positionSequence,0);assert.equal(payload.previousPositionEventId,f.admission.outboxEventId);
})));
test('actual terminal delivery late SQLite failure retains both holds and recovers the exact committed cloud event without a second local move',async()=>withNativeDeviceFixture(input,async f=>{
 const b=await bridge(f);const request={requestId:'qa_review_commit_late',sourceId:input.command.tableId,targetId:'QA-MOVE-B',expectedSession:f.admission.table.session,expectedTargetStatus:'available',expectedTargetSession:null};
 await f.run("CREATE TRIGGER qa_review_delivery_late BEFORE INSERT ON native_move_event_deliveries WHEN NEW.event_type='reservation-move-commit' BEGIN SELECT RAISE(ABORT,'QA LATE'); END");
 await assert.rejects(b.coordinator.move('qa-token',request),{status:503});
 assert.equal((await get(f.db,'SELECT phase FROM native_reservation_moves')).phase,'local-committed');assert.equal((await get(f.db,'SELECT count(*) n FROM native_reservation_move_holds')).n,2);
 assert.equal((await get(f.db,"SELECT count(*) n FROM native_move_event_deliveries WHERE event_type='reservation-move-commit'")).n,0);
 await assert.rejects(b.coordinator.recover('qa-token',{requestId:request.requestId,action:'abort'}),{code:'NATIVE_MOVE_ALREADY_COMMITTED'});
 await f.run('DROP TRIGGER qa_review_delivery_late');
 const later='QA newer source guest';await f.run("UPDATE tables SET status='occupied',sessionData=? WHERE id=?",[later,input.command.tableId]);
 assert.equal((await b.coordinator.recover('qa-token',{requestId:request.requestId,action:'continue'})).phase,'committed');
 assert.equal((await get(f.db,'SELECT sessionData FROM tables WHERE id=?',[input.command.tableId])).sessionData,later);
 const commits=b.calls.filter(e=>e.eventType==='reservation-move-commit');assert.equal(commits.length,2);assert.deepEqual(commits[0],commits[1]);
 assert.equal((await get(f.db,'SELECT count(*) n FROM native_reservation_move_holds')).n,0);
}));
