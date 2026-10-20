const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {withNativeDeviceFixture}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const {readStoredNativeEvent}=require('../server-device-proof.cjs');
const {createNativeEventDelivery,readAcceptedReservationPosition}=require('../server-native-delivery.cjs');
const {createReservationMoveCoordinator,initializeReservationMoveSchema,readStoredReservationMoveEvent,recordAcceptedNativePosition,reservationMoveDefinitions,validateReservationMoveBody}=require('../server-reservation-moves.cjs');
const {canonicalSession}=require('../server-session-identity.cjs');
const all=(db,sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,r)=>e?reject(e):resolve(r)));
async function bridge(f,options={}){
 const resolveActor=async()=>({...f.context}),isActorCurrent=(_,a)=>f.context.active&&a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation;
 const remote=new Map(),calls=[];let rejectPrepare=false,loseCancel=false,pauseCancel=null;
 const delivery=createNativeEventDelivery(f.file,{resolveActor,isActorCurrent,signEvent:f.makeSigner().sign,sendSignedEvent:async(_,e)=>{
  calls.push(e);const body=JSON.parse(e.payload);
  if(e.eventType==='reservation-move-prepare'&&rejectPrepare)throw Object.assign(Error('Synthetic permanent schedule rejection'),{status:409});
  let result=remote.get(e.eventId);if(!result){result={ack:{eventId:e.eventId,eventType:e.eventType,claimId:e.claimId,deviceId:e.deviceId,reservationId:input.command.id,payloadSha256:createHash('sha256').update(e.payload).digest('hex'),state:{admission:'checked-in','reservation-completion':'completed','reservation-move-prepare':'move-prepared','reservation-move-commit':'moved','reservation-move-abort':'move-aborted','reservation-move-cancel':'move-cancelled'}[e.eventType],revision:body.expectedRevision!==undefined?body.expectedRevision+(e.eventType==='reservation-move-cancel'?2:1):input.result.claim.claimRevision+(e.eventType==='admission'?1:2),receiptId:e.eventType==='reservation-completion'?body.receipt.id:null,receivedAt:new Date().toISOString(),acceptedBy:f.context.cloudUserId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false};remote.set(e.eventId,result);}else result={...result,replayed:true};
  if(e.eventType==='reservation-move-cancel'){if(pauseCancel)await pauseCancel;if(loseCancel){loseCancel=false;throw Object.assign(Error('Synthetic lost cancel response'),{status:503});}}
  return result;
 }});
 await delivery.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});await f.run("INSERT INTO tables VALUES('QA-CANCEL-TARGET','QA target','available',1,NULL)");
 const coordinator=()=>createReservationMoveCoordinator(f.file,{resolveActor,isActorCurrent,deliverEvent:delivery.deliver,readAcceptedPosition:readAcceptedReservationPosition});
 const command={requestId:'qa_cancel_original_intent',sourceId:input.command.tableId,targetId:'QA-CANCEL-TARGET',expectedSession:f.admission.table.session,expectedTargetStatus:'available',expectedTargetSession:null};
 return{delivery,coordinator,command,calls,remote,reject(){rejectPrepare=true;},lose(){loseCancel=true;},pause(){let release;pauseCancel=new Promise(resolve=>{release=resolve;});return()=>{release();pauseCancel=null;};},...options};
}
test('permanent rejected prepare can cancel with signed proof and originalbase+2 ACK without any retry of prepare',async()=>withNativeDeviceFixture(input,async f=>{
 const b=await bridge(f);b.reject();const before=await all(f.db,'SELECT * FROM tables');await assert.rejects(b.coordinator().move('qa-token',b.command),{status:409});
 const original=(await all(f.db,'SELECT * FROM native_reservation_move_outbox'))[0];assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,2);
 assert.equal((await b.coordinator().recover('qa-token',{requestId:b.command.requestId,action:'abort'})).phase,'aborted');
 assert.deepEqual(await all(f.db,'SELECT * FROM tables'),before);assert.deepEqual(await all(f.db,'SELECT * FROM native_reservation_move_outbox'),[original]);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,0);
 const cancel=JSON.parse(b.calls.at(-1).payload);assert.equal(Object.keys(cancel).length,20);assert.equal(cancel.preparePayload,original.payload_json);assert.equal(cancel.preparePayloadSha256,original.payload_sha256);assert.equal(cancel.expectedRevision,JSON.parse(original.payload_json).expectedRevision);
 assert.equal(b.calls.filter(e=>e.eventType==='reservation-move-prepare').length,1);assert.equal((await all(f.db,'SELECT * FROM native_move_cancel_deliveries')).length,1);
 const position=await readAcceptedReservationPosition(f.db,f.admission.table.session,input.command.tableId);assert.equal(position.position_sequence,0);assert.equal(position.cloud_revision,cancel.expectedRevision+2);assert.equal(position.position_event_id,f.admission.outboxEventId);
 const closed=await f.checkout();const result=await b.delivery.deliver('qa-token',{eventType:'reservation-completion',eventId:closed.reservationCompletion.eventId});assert.equal(result.ack.revision,cancel.expectedRevision+3);
}));
test('lost cancellation response retains irreversible tombstone and restart continue only resends exact cancellation',async()=>withNativeDeviceFixture(input,async f=>{
 const b=await bridge(f);b.reject();await assert.rejects(b.coordinator().move('qa-token',b.command),{status:409});b.lose();await assert.rejects(b.coordinator().recover('qa-token',{requestId:b.command.requestId,action:'abort'}),{status:503});
 const pending=(await all(f.db,'SELECT * FROM native_reservation_moves'))[0];assert.equal(pending.phase,'aborting');assert.equal(pending.prepare_revision,null);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,2);
 await assert.rejects(f.makeSigner().sign('qa-token',{eventType:'reservation-move-prepare',eventId:pending.prepare_event_id}),{status:409});
 assert.equal((await b.coordinator().recover('qa-token',{requestId:b.command.requestId,action:'continue'})).phase,'aborted');
 const cancels=b.calls.filter(e=>e.eventType==='reservation-move-cancel');assert.equal(cancels.length,2);assert.deepEqual(cancels[0],cancels[1]);assert.equal(b.calls.filter(e=>e.eventType==='reservation-move-prepare').length,1);
 const before=b.calls.length;assert.equal((await b.coordinator().move('qa-token',b.command)).phase,'aborted');assert.equal(b.calls.length,before);
}));
test('late original prepare ACK cannot adopt after cancellation tombstone; pending holds remain until cancel ACK',async()=>withNativeDeviceFixture(input,async f=>{
 const b=await bridge(f);b.reject();await assert.rejects(b.coordinator().move('qa-token',b.command),{status:409});const op=(await all(f.db,'SELECT * FROM native_reservation_moves'))[0];
 const original=await readStoredReservationMoveEvent(f.db,{eventType:'reservation-move-prepare',eventId:op.prepare_event_id});const release=b.pause();const cancelling=b.coordinator().recover('qa-token',{requestId:b.command.requestId,action:'abort'});
 for(let i=0;i<100&&!b.calls.some(e=>e.eventType==='reservation-move-cancel');i++)await new Promise(resolve=>setTimeout(resolve,2));
 assert.equal((await all(f.db,'SELECT phase FROM native_reservation_moves'))[0].phase,'aborting');
 await f.run('BEGIN IMMEDIATE');try{await assert.rejects(recordAcceptedNativePosition(f.db,original,{ack:{state:'move-prepared',revision:JSON.parse(original.payload).expectedRevision+1,receiptId:null}}),{status:409});}finally{await f.run('ROLLBACK');}
 assert.equal((await all(f.db,'SELECT prepare_revision FROM native_reservation_moves'))[0].prepare_revision,null);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,2);
 release();assert.equal((await cancelling).phase,'aborted');
}));
test('known RC14 four-table schema gains reviewed append-only tables and preserves old schemas while refusing an unknown cancellation schema',async()=>withNativeDeviceFixture(input,async f=>{
 for(const [,ddl]of reservationMoveDefinitions.slice(0,4))await f.run(ddl);
 const before=await all(f.db,"SELECT name,sql FROM sqlite_master WHERE name LIKE 'native_reservation_%' ORDER BY name");await initializeReservationMoveSchema(f.db);assert.deepEqual((await all(f.db,"SELECT name,sql FROM sqlite_master WHERE name LIKE 'native_reservation_%' AND name NOT IN ('native_reservation_move_cancel_outbox','native_reservation_move_rejections') ORDER BY name")),before);
 const once=await all(f.db,'SELECT * FROM native_reservation_move_cancel_outbox');await initializeReservationMoveSchema(f.db);assert.deepEqual(await all(f.db,'SELECT * FROM native_reservation_move_cancel_outbox'),once);
 await f.run('DROP TABLE native_reservation_move_cancel_outbox');await f.run('CREATE TABLE native_reservation_move_cancel_outbox(event_id TEXT PRIMARY KEY)');await assert.rejects(initializeReservationMoveSchema(f.db),{status:409});
}));
test('RC14 classic abort payload and archived proof remain unchanged and readable after five-table upgrade',async()=>withNativeDeviceFixture(input,async f=>{
 const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
 const filename=path.resolve(__dirname,'../server-reservation-moves-rc14.fixture.cjs'),old=new Module(filename,module);old.filename=filename;old.paths=Module._nodeModulePaths(path.dirname(filename));old._compile(fs.readFileSync(path.join(__dirname,'fixtures/server-reservation-moves-rc14.fixture.cjs'),'utf8'),filename);
 const legacy=old.exports;await legacy.initializeReservationMoveSchema(f.db);const admission=await readStoredNativeEvent(f.file,{eventType:'admission',eventId:f.admission.outboxEventId});await legacy.recordAcceptedNativePosition(f.db,admission,{ack:{state:'checked-in',revision:input.result.claim.claimRevision+1}});
 await f.run("INSERT INTO tables VALUES('QA-OLD-ABORT','QA old abort','available',1,NULL)");let dropped=false;const resolveActor=async()=>({...f.context}),isActorCurrent=(_,a)=>a.generation===f.context.generation&&a.cloudUserId===f.context.cloudUserId&&a.localStaffId===f.context.localStaffId;
 const coordinator=legacy.createReservationMoveCoordinator(f.file,{resolveActor,isActorCurrent,deliverEvent:async(_,command)=>{
  const event=await legacy.readStoredReservationMoveEvent(f.db,command,{allowDelivered:true}),body=JSON.parse(event.payload);
  if(!dropped){dropped=true;throw Object.assign(Error('Synthetic lost old response'),{status:503});}
  const ack={eventId:event.eventId,eventType:event.eventType,claimId:event.claimId,deviceId:event.deviceId,reservationId:event.reservationId,payloadSha256:createHash('sha256').update(event.payload).digest('hex'),state:event.eventType==='reservation-move-prepare'?'move-prepared':'move-aborted',revision:body.expectedRevision+1,receiptId:null,receivedAt:new Date().toISOString(),acceptedBy:f.context.cloudUserId};
  await f.run('BEGIN IMMEDIATE');try{await legacy.recordAcceptedNativePosition(f.db,event,{ack});await f.run('UPDATE native_reservation_move_outbox SET delivered_at=? WHERE event_id=?',[ack.receivedAt,event.eventId]);await f.run('COMMIT');}catch(e){await f.run('ROLLBACK');throw e;}return{ack};
 }});
 const command={requestId:'qa_legacy_classic_abort',sourceId:input.command.tableId,targetId:'QA-OLD-ABORT',expectedSession:f.admission.table.session,expectedTargetStatus:'available',expectedTargetSession:null};await assert.rejects(coordinator.move('qa-token',command),{status:503});await coordinator.recover('qa-token',{requestId:command.requestId,action:'abort'});
 const before=await all(f.db,'SELECT * FROM native_reservation_move_outbox');assert.equal(before[1].event_type,'reservation-move-abort');await initializeReservationMoveSchema(f.db);
 for(const row of before){const event=await readStoredReservationMoveEvent(f.db,{eventType:row.event_type,eventId:row.event_id},{allowDelivered:true});assert.equal(event.payload,row.payload_json);}
 assert.deepEqual(await all(f.db,'SELECT * FROM native_reservation_move_outbox'),before);
 const current=createReservationMoveCoordinator(f.file,{resolveActor,isActorCurrent,deliverEvent:async()=>{throw Error('Archived replay must not publish');}});assert.equal((await current.recover('qa-token',{requestId:command.requestId,action:'continue'})).phase,'aborted');
}));
test('late cancellation outbox INSERT rolls back tombstone before network; accepted cancellation late ACK failure retains it for exact retry',async()=>withNativeDeviceFixture(input,async f=>{
 const b=await bridge(f);b.reject();await assert.rejects(b.coordinator().move('qa-token',b.command),{status:409});
 await f.run("CREATE TRIGGER qa_cancel_insert_failure BEFORE INSERT ON native_reservation_move_cancel_outbox BEGIN SELECT RAISE(ABORT,'QA cancel late INSERT'); END");const count=b.calls.length;
 await assert.rejects(b.coordinator().recover('qa-token',{requestId:b.command.requestId,action:'abort'}),{status:503});assert.equal(b.calls.length,count);assert.equal((await all(f.db,'SELECT phase FROM native_reservation_moves'))[0].phase,'prepared');assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_cancel_outbox')).length,0);await f.run('DROP TRIGGER qa_cancel_insert_failure');
 await f.run("CREATE TRIGGER qa_cancel_ack_failure BEFORE DELETE ON native_reservation_move_holds BEGIN SELECT RAISE(ABORT,'QA cancel late ACK'); END");
 await assert.rejects(b.coordinator().recover('qa-token',{requestId:b.command.requestId,action:'abort'}),{status:503});assert.equal((await all(f.db,'SELECT phase FROM native_reservation_moves'))[0].phase,'aborting');assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,2);assert.equal((await all(f.db,'SELECT delivered_at FROM native_reservation_move_cancel_outbox'))[0].delivered_at,null);assert.equal((await all(f.db,'SELECT * FROM native_move_cancel_deliveries')).length,0);
 await f.run('DROP TRIGGER qa_cancel_ack_failure');assert.equal((await b.coordinator().recover('qa-token',{requestId:b.command.requestId,action:'continue'})).phase,'aborted');const cancels=b.calls.filter(e=>e.eventType==='reservation-move-cancel');assert.equal(cancels.length,2);assert.deepEqual(cancels[0],cancels[1]);
}));
test('cancel body rejects altered embedded plan, hash, actor-independent identity and unsafe revision headroom',async()=>withNativeDeviceFixture(input,async f=>{
 const b=await bridge(f);b.reject();await assert.rejects(b.coordinator().move('qa-token',b.command),{status:409});b.lose();await assert.rejects(b.coordinator().recover('qa-token',{requestId:b.command.requestId,action:'abort'}),{status:503});const body=JSON.parse(b.calls.at(-1).payload);
 for(const mutate of [v=>{v.preparePayload+=' ';},v=>{v.preparePayloadSha256='0'.repeat(64);},v=>{v.targetTableId='QA-other-target';},v=>{v.previousPositionEventId=randomUUID();},v=>{v.expectedRevision++;},v=>{v.extra=true;},v=>{v.sessionStartTime='invalid';}]){const changed=JSON.parse(JSON.stringify(body));mutate(changed);assert.throws(()=>validateReservationMoveBody(changed),{status:409});}
 const prepare=JSON.parse(body.preparePayload);prepare.expectedRevision=Number.MAX_SAFE_INTEGER-2;const unsafe={...body,expectedRevision:prepare.expectedRevision,preparePayload:canonicalSession(prepare),preparePayloadSha256:createHash('sha256').update(canonicalSession(prepare)).digest('hex')};assert.throws(()=>validateReservationMoveBody(unsafe),{status:409});
}));
test('pending discovery exposes metadata only for prepared/cancelling phases, takes readonly snapshot and rejects corrupted holds',async()=>withNativeDeviceFixture(input,async f=>{
 const {listPendingReservationMoves}=require('../server-reservation-moves.cjs');const b=await bridge(f);b.reject();await assert.rejects(b.coordinator().move('qa-token',b.command),{status:409});
 const schema=await all(f.db,'SELECT * FROM sqlite_master'),rows=await all(f.db,'SELECT * FROM native_reservation_moves');
 const pending=await listPendingReservationMoves(f.file);assert.equal(pending.length,1);assert.deepEqual(Object.keys(pending[0]).sort(),['requestId','moveId','sourceId','targetId','phase'].sort());assert.equal(pending[0].phase,'prepared');assert.equal(pending[0].requestId,b.command.requestId);assert.deepEqual(await all(f.db,'SELECT * FROM sqlite_master'),schema);assert.deepEqual(await all(f.db,'SELECT * FROM native_reservation_moves'),rows);
 b.lose();await assert.rejects(b.coordinator().recover('qa-token',{requestId:b.command.requestId,action:'abort'}),{status:503});assert.equal((await listPendingReservationMoves(f.file))[0].phase,'aborting');
 await f.run("DELETE FROM native_reservation_move_holds WHERE table_id='QA-CANCEL-TARGET'");const broken=await all(f.db,'SELECT * FROM native_reservation_moves');await assert.rejects(listPendingReservationMoves(f.file),{code:'NATIVE_MOVE_RECONCILIATION_REQUIRED'});assert.deepEqual(await all(f.db,'SELECT * FROM native_reservation_moves'),broken);
}));
test('pending discovery includes locally committed recovery and omits resolved moves after ACK',async()=>withNativeDeviceFixture(input,async f=>{
 const {listPendingReservationMoves}=require('../server-reservation-moves.cjs');const b=await bridge(f);
 await f.run("CREATE TRIGGER qa_pending_commit BEFORE INSERT ON native_move_event_deliveries WHEN NEW.event_type='reservation-move-commit' BEGIN SELECT RAISE(ABORT,'QA pending commit'); END");
 await assert.rejects(b.coordinator().move('qa-token',b.command),{status:503});assert.equal((await listPendingReservationMoves(f.file))[0].phase,'local-committed');await f.run('DROP TRIGGER qa_pending_commit');await b.coordinator().recover('qa-token',{requestId:b.command.requestId,action:'continue'});assert.deepEqual(await listPendingReservationMoves(f.file),[]);
}));
test('pending discovery accepts old four-schema readonly snapshots and rejects oversized journals before verification',async()=>withNativeDeviceFixture(input,async f=>{
 const {listPendingReservationMoves}=require('../server-reservation-moves.cjs');for(const [,ddl]of reservationMoveDefinitions.slice(0,4))await f.run(ddl);const schema=await all(f.db,'SELECT * FROM sqlite_master');assert.deepEqual(await listPendingReservationMoves(f.file),[]);assert.deepEqual(await all(f.db,'SELECT * FROM sqlite_master'),schema);
 await initializeReservationMoveSchema(f.db);const b=await bridge(f);b.reject();await assert.rejects(b.coordinator().move('qa-token',b.command),{status:409});
 const op=(await all(f.db,'SELECT * FROM native_reservation_moves'))[0];await f.run('BEGIN IMMEDIATE');try{for(let i=0;i<1000;i++)await f.run("INSERT INTO native_reservation_moves(move_id,request_id,request_json,request_sha256,claim_id,prepare_event_id,prepare_body_json,prepare_body_sha256,phase,session_json,created_at) VALUES(?,?,?,?,?,?,?,?,'prepared',?,?)",[randomUUID(),'qa_overflow_'+i,op.request_json,op.request_sha256,op.claim_id,randomUUID(),op.prepare_body_json,op.prepare_body_sha256,op.session_json,op.created_at]);await f.run('COMMIT');}catch(e){await f.run('ROLLBACK');throw e;}
 await assert.rejects(listPendingReservationMoves(f.file),{code:'NATIVE_MOVE_RECONCILIATION_REQUIRED'});assert.equal((await all(f.db,'SELECT count(*) n FROM native_reservation_moves'))[0].n,1001);
}));
