const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {withNativeDeviceFixture}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const {readStoredNativeEvent}=require('../server-device-proof.cjs');
const {createReservationMoveCoordinator,initializeReservationMoveSchema,readStoredReservationMoveEvent,recordAcceptedNativePosition,assertTableNotHeld}=require('../server-reservation-moves.cjs');
const all=(db,sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,r)=>e?reject(e):resolve(r)));
async function setup(f){
 await initializeReservationMoveSchema(f.db);
 const event=await readStoredNativeEvent(f.file,{eventType:'admission',eventId:f.admission.outboxEventId});
 const ack={state:'checked-in',revision:input.result.claim.claimRevision+1};
 await recordAcceptedNativePosition(f.db,event,{ack});
 await f.run('INSERT INTO tables VALUES(?,?,?,?,?)',['QA-TARGET','QA target','available',1,null]);
 const remote=new Map(),calls=[];let drop=false,change=false;
 const actor=()=>({localStaffId:f.context.localStaffId,cloudUserId:f.context.cloudUserId,generation:f.context.generation});
 const options={resolveActor:async()=>f.context.active?actor():null,isActorCurrent:(_,a)=>f.context.active&&JSON.stringify(a)===JSON.stringify(actor()),deliverEvent:async(_,command)=>{
  const event=await readStoredReservationMoveEvent(f.db,command,{allowDelivered:true});const body=JSON.parse(event.payload);calls.push(body);
  let result=remote.get(event.eventId);
  if(!result){result={ack:{eventId:event.eventId,eventType:event.eventType,claimId:event.claimId,deviceId:event.deviceId,reservationId:event.reservationId,payloadSha256:createHash('sha256').update(event.payload).digest('hex'),state:body.type==='reservation-move-prepare'?'move-prepared':body.type==='reservation-move-commit'?'moved':body.type==='reservation-move-cancel'?'move-cancelled':'move-aborted',revision:body.expectedRevision+(body.type==='reservation-move-cancel'?2:1),receiptId:null,receivedAt:new Date().toISOString(),acceptedBy:f.context.cloudUserId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false};remote.set(event.eventId,result);}else result={...result,replayed:true};
  if(drop){drop=false;throw Object.assign(Error('Synthetic lost response'),{status:503});}
  if(change){change=false;f.context.generation++;throw Object.assign(Error('Synthetic changed actor'),{status:403});}
  await f.run('BEGIN IMMEDIATE');try{await recordAcceptedNativePosition(f.db,event,result);await f.run(`UPDATE ${event.eventType==='reservation-move-cancel'?'native_reservation_move_cancel_outbox':'native_reservation_move_outbox'} SET delivered_at=? WHERE event_id=?`,[result.ack.receivedAt,event.eventId]);await f.run('COMMIT');}catch(e){await f.run('ROLLBACK');throw e;}
  return result;
 }};
 const coordinator=()=>createReservationMoveCoordinator(f.file,options);
 const command={requestId:'qa_move_first',sourceId:input.command.tableId,targetId:'QA-TARGET',expectedSession:f.admission.table.session,expectedTargetStatus:'available',expectedTargetSession:null};
 return{command,coordinator,calls,remote,options,drop(){drop=true;},change(){change=true;}};
}
test('reservation move grants permit before unchanged authoritative local transfer and commits position after ACK',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);const result=await x.coordinator().move('qa-token',x.command);
 assert.equal(result.phase,'committed');assert.deepEqual(result.target.session,x.command.expectedSession);assert.equal(x.calls.length,2);
 const p=(await all(f.db,'SELECT * FROM native_reservation_positions'))[0];assert.equal(p.table_id,'QA-TARGET');assert.equal(p.position_sequence,1);assert.equal(p.position_event_id,x.calls[1].eventId);assert.equal(p.cloud_revision,input.result.claim.claimRevision+3);
 assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,0);
 await f.run("UPDATE tables SET sessionData='another guest' WHERE id='QA-TARGET'");
 const before=await all(f.db,'SELECT * FROM tables');assert.equal((await x.coordinator().move('qa-token',x.command)).replayed,true);assert.deepEqual(await all(f.db,'SELECT * FROM tables'),before);assert.equal(x.calls.length,2);
}));
test('lost prepare response preserves both holds and unchanged tables; fresh shift/restart recovers same original event',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);const before=await all(f.db,'SELECT * FROM tables');x.drop();await assert.rejects(x.coordinator().move('qa-token',x.command),{status:503});
 assert.deepEqual(await all(f.db,'SELECT * FROM tables'),before);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,2);
 for(const id of [x.command.sourceId,x.command.targetId])await assert.rejects(assertTableNotHeld(f.db,id),{code:'NATIVE_MOVE_TABLE_HELD'});
 f.context.localStaffId='qa-next-shift';f.context.cloudUserId='22222222-2222-4222-8222-222222222222';f.context.generation++;
 assert.equal((await x.coordinator().recover('qa-token',{requestId:x.command.requestId,action:'continue'})).phase,'committed');
 assert.deepEqual(x.calls[0],x.calls[1]);assert.notEqual(x.calls[1].cloudUserId,x.calls[2].cloudUserId);assert.equal(x.remote.size,2);
}));
test('explicit abort cancels unknown original prepare without retrying it and persists irreversible tombstone without moving session',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);const before=await all(f.db,'SELECT * FROM tables');x.drop();await assert.rejects(x.coordinator().move('qa-token',x.command),{status:503});
 assert.equal((await x.coordinator().recover('qa-token',{requestId:x.command.requestId,action:'abort'})).phase,'aborted');assert.deepEqual(await all(f.db,'SELECT * FROM tables'),before);
 const p=(await all(f.db,'SELECT * FROM native_reservation_positions'))[0];assert.equal(p.position_sequence,0);assert.equal(p.position_event_id,f.admission.outboxEventId);assert.equal(p.cloud_revision,input.result.claim.claimRevision+3);
 assert.equal((await x.coordinator().recover('qa-token',{requestId:x.command.requestId,action:'continue'})).phase,'aborted');assert.equal(x.calls.length,2);
}));
test('late local transfer failure rolls back both tables and commit outbox; original permitted plan can recover',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);await f.run("CREATE TRIGGER qa_late_move BEFORE UPDATE ON tables WHEN NEW.status='available' BEGIN SELECT RAISE(ABORT,'QA late move'); END");
 const before=await all(f.db,'SELECT * FROM tables');await assert.rejects(x.coordinator().move('qa-token',x.command),{status:503});assert.deepEqual(await all(f.db,'SELECT * FROM tables'),before);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_outbox')).length,1);
 await f.run('DROP TRIGGER qa_late_move');assert.equal((await x.coordinator().recover('qa-token',{requestId:x.command.requestId,action:'continue'})).phase,'committed');
}));
test('lost commit ACK cannot be aborted and recovery never overwrites table reused after local move',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);const base=x.coordinator();
 // Fail after local transfer by preventing final ACK adoption.
 await f.run("CREATE TRIGGER qa_late_ack BEFORE UPDATE ON native_reservation_positions WHEN NEW.position_sequence=1 BEGIN SELECT RAISE(ABORT,'QA late ACK'); END");
 await assert.rejects(base.move('qa-token',x.command));assert.equal((await all(f.db,"SELECT status FROM tables WHERE id='QA-TARGET'"))[0].status,'occupied');
 await assert.rejects(base.recover('qa-token',{requestId:x.command.requestId,action:'abort'}),{code:'NATIVE_MOVE_ALREADY_COMMITTED'});
 await f.run('DROP TRIGGER qa_late_ack');await f.run("UPDATE tables SET sessionData='QA new guest untouched' WHERE id='QA-TARGET'");
 const before=await all(f.db,'SELECT * FROM tables');assert.equal((await base.recover('qa-token',{requestId:x.command.requestId,action:'continue'})).phase,'committed');assert.deepEqual(await all(f.db,'SELECT * FROM tables'),before);
}));
test('changed account after cloud acceptance preserves unresolved event and permits later fresh recovery',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);x.change();await assert.rejects(x.coordinator().move('qa-token',x.command),{status:403});assert.equal((await all(f.db,'SELECT prepare_revision FROM native_reservation_moves'))[0].prepare_revision,null);
 assert.equal((await x.coordinator().recover('qa-token',{requestId:x.command.requestId,action:'continue'})).phase,'committed');
}));
test('multiple moves link monotonic sequence and predecessor and preserve billing',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);await x.coordinator().move('qa-token',x.command);const prior=x.calls[1];
 const next={...x.command,requestId:'qa_move_second',sourceId:'QA-TARGET',targetId:input.command.tableId};await x.coordinator().move('qa-token',next);
 assert.equal(x.calls[2].positionSequence,2);assert.equal(x.calls[2].previousPositionEventId,prior.eventId);assert.equal(x.calls[2].expectedRevision,prior.expectedRevision+1);
 assert.deepEqual(JSON.parse((await all(f.db,'SELECT sessionData FROM tables WHERE id=?',[input.command.tableId]))[0].sessionData),x.command.expectedSession);
}));
test('existing HTTP move route dispatches reservation sessions into trusted coordinator with signed-in token',async()=>withNativeDeviceFixture(input,async f=>{
 const express=require('express');const {registerSessionStateRoutes}=require('../server-session-state.cjs');const x=await setup(f);const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authToken='qa-token';req.staff={id:f.context.localStaffId};next();});
 await registerSessionStateRoutes(app,f.file,{reservationMoves:x.coordinator(),resolveActor:async()=>({...f.context}),isActorCurrent:(_,a)=>a.localStaffId===f.context.localStaffId&&f.context.active}).ready;
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{const {sourceId,...body}=x.command;const r=await fetch(`http://127.0.0.1:${server.address().port}/api/tables/${sourceId}/move`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);assert.equal((await r.json()).phase,'committed');assert.equal(x.calls.length,2);assert.equal((await all(f.db,'SELECT * FROM session_state_operations')).length,0);}finally{await new Promise(resolve=>server.close(resolve));}
}));
test('billing replacement, request reuse, corrupted move body and competing target cannot bypass holds',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);x.drop();await assert.rejects(x.coordinator().move('qa-token',x.command),{status:503});
 await assert.rejects(x.coordinator().move('qa-token',{...x.command,expectedSession:{...x.command.expectedSession,amountPaid:999}}),{code:'NATIVE_MOVE_REQUEST_CONFLICT'});
 await f.run("UPDATE native_reservation_move_outbox SET payload_json='{}'");
 await assert.rejects(readStoredReservationMoveEvent(f.db,{eventType:'reservation-move-prepare',eventId:x.calls[0].eventId}),{code:'NATIVE_MOVE_RECONCILIATION_REQUIRED'});
 assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,2);
}));
test('commit outbox late INSERT failure rolls back authoritative two-table transfer and retains granted permit',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);await f.run("CREATE TRIGGER qa_commit_outbox_failure BEFORE INSERT ON native_reservation_move_outbox WHEN NEW.event_type='reservation-move-commit' BEGIN SELECT RAISE(ABORT,'QA late outbox'); END");
 const before=await all(f.db,'SELECT * FROM tables');await assert.rejects(x.coordinator().move('qa-token',x.command),{status:503});assert.deepEqual(await all(f.db,'SELECT * FROM tables'),before);
 const op=(await all(f.db,'SELECT * FROM native_reservation_moves'))[0];assert.equal(op.phase,'prepared');assert.equal(op.terminal_event_id,null);assert.equal(op.prepare_revision,input.result.claim.claimRevision+2);
 await f.run('DROP TRIGGER qa_commit_outbox_failure');assert.equal((await x.coordinator().recover('qa-token',{requestId:x.command.requestId,action:'abort'})).phase,'aborted');assert.deepEqual(await all(f.db,'SELECT * FROM tables'),before);
}));
test('lost abort acknowledgement retains irreversible tombstone; continue recovers abort and cannot transfer the tables',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);x.drop();await assert.rejects(x.coordinator().move('qa-token',x.command),{status:503});
 await f.run("CREATE TRIGGER qa_abort_ack_failure BEFORE UPDATE ON native_reservation_positions WHEN NEW.active_move_id IS NULL BEGIN SELECT RAISE(ABORT,'QA late abort ACK'); END");
 const before=await all(f.db,'SELECT * FROM tables');await assert.rejects(x.coordinator().recover('qa-token',{requestId:x.command.requestId,action:'abort'}));
 assert.equal((await all(f.db,'SELECT phase FROM native_reservation_moves'))[0].phase,'aborting');assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,2);
 await f.run('DROP TRIGGER qa_abort_ack_failure');assert.equal((await x.coordinator().recover('qa-token',{requestId:x.command.requestId,action:'continue'})).phase,'aborted');assert.deepEqual(await all(f.db,'SELECT * FROM tables'),before);assert.equal(x.calls.at(-1).type,'reservation-move-cancel');
}));
test('stored move proof can be verified on READONLY SQLite without schema mutation',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);await x.coordinator().move('qa-token',x.command);const sqlite3=require('sqlite3');
 const db=await new Promise((resolve,reject)=>{const c=new sqlite3.Database(f.file,sqlite3.OPEN_READONLY,e=>e?reject(e):resolve(c));});
 try{const before=await all(db,'SELECT * FROM sqlite_master');for(const body of x.calls){const event=await readStoredReservationMoveEvent(db,{eventType:body.type,eventId:body.eventId},{allowDelivered:true});assert.deepEqual(JSON.parse(event.payload),body);}assert.deepEqual(await all(db,'SELECT * FROM sqlite_master'),before);}finally{await new Promise(resolve=>db.close(resolve));}
}));
test('A to B to C to A preserves full bill and checkout archives latest position without rewriting admission',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);const {createNativeEventDelivery,readAcceptedReservationPosition}=require('../server-native-delivery.cjs');
 const delivery=createNativeEventDelivery(f.file,{resolveActor:x.options.resolveActor,isActorCurrent:x.options.isActorCurrent,signEvent:f.makeSigner().sign,sendSignedEvent:async(_,envelope)=>{
  const body=JSON.parse(envelope.payload),admission=envelope.eventType==='admission';if(!admission)x.calls.push(body);
  return{ack:{eventId:envelope.eventId,eventType:envelope.eventType,claimId:envelope.claimId,deviceId:envelope.deviceId,reservationId:input.result.claim.reservationId,payloadSha256:createHash('sha256').update(envelope.payload).digest('hex'),state:admission?'checked-in':envelope.eventType==='reservation-move-prepare'?'move-prepared':'moved',revision:admission?input.result.claim.claimRevision+1:body.expectedRevision+1,receiptId:null,receivedAt:new Date().toISOString(),acceptedBy:f.context.cloudUserId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false};
 }});await delivery.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});x.options.deliverEvent=delivery.deliver;x.options.readAcceptedPosition=readAcceptedReservationPosition;
await f.run("INSERT INTO tables VALUES('QA-THIRD','QA third','available',1,NULL)");
 const paths=[[input.command.tableId,'QA-TARGET'],['QA-TARGET','QA-THIRD'],['QA-THIRD',input.command.tableId]];
 for(let i=0;i<paths.length;i++){await x.coordinator().move('qa-token',{...x.command,requestId:'qa_move_chain_'+i,sourceId:paths[i][0],targetId:paths[i][1]});const p=(await all(f.db,'SELECT * FROM native_reservation_positions'))[0];assert.equal(p.position_sequence,i+1);assert.equal(p.table_id,paths[i][1]);}
 const admissionBefore=(await all(f.db,'SELECT payload_json FROM native_checkin_outbox'))[0].payload_json;
 const closed=await f.checkout();const completion=JSON.parse((await all(f.db,'SELECT payload_json FROM native_reservation_completion_outbox'))[0].payload_json);
 assert.equal(completion.version,2);assert.equal(completion.positionSequence,3);assert.equal(completion.previousPositionEventId,x.calls.at(-1).eventId);assert.equal(completion.expectedRevision,x.calls.at(-1).expectedRevision+1);assert.equal(completion.checkoutTableId,input.command.tableId);assert.equal(closed.receipt.amount_paid,closed.receipt.total_amount);
 assert.equal((await all(f.db,'SELECT payload_json FROM native_checkin_outbox'))[0].payload_json,admissionBefore);
}));
test('RC13 admission ACK without position bootstraps once through verified delivery ledger before a trusted move',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);const {createNativeEventDelivery}=require('../server-native-delivery.cjs');
 const delivery=createNativeEventDelivery(f.file,{resolveActor:x.options.resolveActor,isActorCurrent:x.options.isActorCurrent,signEvent:f.makeSigner().sign,sendSignedEvent:async(_,envelope)=>({ack:{eventId:envelope.eventId,eventType:envelope.eventType,claimId:envelope.claimId,deviceId:envelope.deviceId,reservationId:input.result.claim.reservationId,payloadSha256:createHash('sha256').update(envelope.payload).digest('hex'),state:'checked-in',revision:input.result.claim.claimRevision+1,receiptId:null,receivedAt:new Date().toISOString(),acceptedBy:f.context.cloudUserId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false})});
 await delivery.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});
 await f.run('DELETE FROM native_reservation_positions');
 const oldLedger=await all(f.db,'SELECT * FROM native_event_deliveries');x.options.readAcceptedAdmission=delivery.readAcceptedAdmission;
 assert.equal((await x.coordinator().move('qa-token',x.command)).phase,'committed');
 assert.deepEqual(await all(f.db,'SELECT * FROM native_event_deliveries'),oldLedger);
 assert.equal((await all(f.db,'SELECT * FROM native_reservation_positions'))[0].position_sequence,1);
}));
test('missing position with prior move evidence refuses legacy bootstrap even if an admission callback exists',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);x.drop();await assert.rejects(x.coordinator().move('qa-token',x.command),{status:503});await f.run('DELETE FROM native_reservation_positions');let reads=0;x.options.readAcceptedAdmission=async()=>{reads++;return{};};
 await assert.rejects(x.coordinator().move('qa-token',{...x.command,requestId:'qa_move_no_downgrade'}),{code:'NATIVE_MOVE_RECONCILIATION_REQUIRED'});assert.equal(reads,0);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,2);
}));
test('corrupted permit, missing hold or altered pending position fails closed before authoritative local transfer',async()=>{
 for(const mutate of [
  f=>f.run('UPDATE native_reservation_moves SET prepare_revision=prepare_revision+1'),
  f=>f.run("UPDATE native_reservation_moves SET prepare_ack_json='{}'"),
  f=>f.run("DELETE FROM native_reservation_move_holds WHERE table_id='QA-TARGET'"),
  f=>f.run("UPDATE native_reservation_positions SET session_start='2026-01-01T00:00:00.000Z'")
 ])await withNativeDeviceFixture(input,async f=>{
  const x=await setup(f);await f.run("CREATE TRIGGER qa_permit_pause BEFORE UPDATE ON tables WHEN NEW.status='available' BEGIN SELECT RAISE(ABORT,'QA pause after permit'); END");
  await assert.rejects(x.coordinator().move('qa-token',x.command),{status:503});await f.run('DROP TRIGGER qa_permit_pause');const before=await all(f.db,'SELECT * FROM tables');await mutate(f);
  await assert.rejects(x.coordinator().recover('qa-token',{requestId:x.command.requestId,action:'continue'}),{code:'NATIVE_MOVE_RECONCILIATION_REQUIRED'});assert.deepEqual(await all(f.db,'SELECT * FROM tables'),before);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_outbox')).length,1);
 });
});
test('trusted accepted-position verification runs before new intent, holds, signing or cloud calls',async()=>withNativeDeviceFixture(input,async f=>{
 const x=await setup(f);let checks=0;x.options.readAcceptedPosition=async()=>{checks++;return null;};
 await assert.rejects(x.coordinator().move('qa-token',x.command),{code:'NATIVE_MOVE_RECONCILIATION_REQUIRED'});assert.equal(checks,1);assert.equal(x.calls.length,0);assert.equal((await all(f.db,'SELECT * FROM native_reservation_moves')).length,0);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,0);
}));
test('new prepare reserves revision headroom for prepare, terminal and completion before persisting any hold or intent',async()=>{
 for(const revision of [Number.MAX_SAFE_INTEGER-2,Number.MAX_SAFE_INTEGER-1,Number.MAX_SAFE_INTEGER])await withNativeDeviceFixture(input,async f=>{
  const x=await setup(f);await f.run('UPDATE native_reservation_positions SET cloud_revision=?',[revision]);
  await assert.rejects(x.coordinator().move('qa-token',x.command),{code:'NATIVE_MOVE_RECONCILIATION_REQUIRED'});
  assert.equal(x.calls.length,0);assert.equal((await all(f.db,'SELECT * FROM native_reservation_moves')).length,0);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,0);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_outbox')).length,0);
 });
});
