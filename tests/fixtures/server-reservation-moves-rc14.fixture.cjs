const sqlite3=require('sqlite3');
const {randomUUID,createHash}=require('node:crypto');
const {canonicalSession}=require('./server-session-identity.cjs');
const {createNativeActorGuard}=require('./server-native-actor.cjs');
const {verifyReservationAdmission}=require('./server-reservation-completion.cjs');
const {calculateSessionBill}=require('./session-billing.mjs');
const fail=(status,code,message)=>Object.assign(Error(message),{status,code});
const reconcile=()=>fail(409,'NATIVE_MOVE_RECONCILIATION_REQUIRED','Preserve the original reservation move for reconciliation.');
const changed=()=>fail(403,'NATIVE_MOVE_ACCOUNT_CHANGED','Staff account changed. Recover the original move under an approved account.');
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const id=v=>typeof v==='string'&&v.length>0&&v.length<=120&&v.trim()===v;
const same=(a,b)=>canonicalSession(a)===canonicalSession(b);
const hash=v=>createHash('sha256').update(canonicalSession(v)).digest('hex');
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,function(e){e?reject(e):resolve(this);}));
const get=(db,sql,args=[])=>new Promise((resolve,reject)=>db.get(sql,args,(e,r)=>e?reject(e):resolve(r)));
const parse=s=>{try{return JSON.parse(s);}catch{throw reconcile();}};
const definitions=[
 ['native_reservation_positions',`CREATE TABLE IF NOT EXISTS native_reservation_positions (claim_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL, device_id TEXT NOT NULL, claim_request_id TEXT NOT NULL, admission_event_id TEXT NOT NULL UNIQUE, table_id TEXT NOT NULL, position_sequence INTEGER NOT NULL, position_event_id TEXT NOT NULL, cloud_revision INTEGER NOT NULL, session_start TEXT NOT NULL, active_move_id TEXT)`],
 ['native_reservation_moves',`CREATE TABLE IF NOT EXISTS native_reservation_moves (move_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL, request_sha256 TEXT NOT NULL, claim_id TEXT NOT NULL, prepare_event_id TEXT NOT NULL UNIQUE, prepare_body_json TEXT NOT NULL, prepare_body_sha256 TEXT NOT NULL, prepare_revision INTEGER, prepare_ack_json TEXT, terminal_event_id TEXT UNIQUE, terminal_body_json TEXT, terminal_body_sha256 TEXT, phase TEXT NOT NULL CHECK(phase IN ('prepared','local-committed','aborting','committed','aborted')), session_json TEXT NOT NULL, response_json TEXT, created_at TEXT NOT NULL)`],
 ['native_reservation_move_holds',`CREATE TABLE IF NOT EXISTS native_reservation_move_holds (table_id TEXT PRIMARY KEY, move_id TEXT NOT NULL, claim_id TEXT NOT NULL)`],
 ['native_reservation_move_outbox',`CREATE TABLE IF NOT EXISTS native_reservation_move_outbox (event_id TEXT PRIMARY KEY, move_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('reservation-move-prepare','reservation-move-commit','reservation-move-abort')), payload_json TEXT NOT NULL, payload_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT, UNIQUE(move_id,event_type))`]
];
const normalize=s=>s.replace(' IF NOT EXISTS','').replace(/\s+/g,' ').trim();
async function assertReservationMoveSchema(db){for(const [name,sql]of definitions){const row=await get(db,"SELECT sql FROM sqlite_master WHERE type='table' AND name=?",[name]);if(!row||normalize(row.sql)!==normalize(sql))throw reconcile();}}
async function initializeReservationMoveSchema(db){for(const [,sql]of definitions)await run(db,sql);await assertReservationMoveSchema(db);}
async function assertTableNotHeld(db,tableId,{allowMoveId}={}){
 const exists=await get(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='native_reservation_move_holds'");if(!exists)return;
 const sql=await get(db,"SELECT sql FROM sqlite_master WHERE type='table' AND name='native_reservation_move_holds'");if(normalize(sql.sql)!==normalize(definitions[2][1]))throw reconcile();
 const hold=await get(db,'SELECT * FROM native_reservation_move_holds WHERE table_id=?',[tableId]);
 if(hold&&hold.move_id!==allowMoveId)throw fail(409,'NATIVE_MOVE_TABLE_HELD','This table is held by an unresolved reservation move. Recover its original operation.');
}
const fields=['version','eventId','type','moveId','prepareEventId','claimId','reservationId','deviceId','claimRequestId','admissionEventId','sourceTableId','targetTableId','positionSequence','previousPositionEventId','expectedRevision','localStaffId','cloudUserId','sessionStartTime'];
function validateBody(body){
 if(!body||Array.isArray(body)||Object.keys(body).length!==fields.length||Object.keys(body).some(k=>!fields.includes(k))||body.version!==1||!['reservation-move-prepare','reservation-move-commit','reservation-move-abort'].includes(body.type))throw reconcile();
 for(const k of ['eventId','moveId','prepareEventId','claimId','deviceId','claimRequestId','admissionEventId','previousPositionEventId','cloudUserId'])if(!uuid(body[k]))throw reconcile();
 for(const k of ['reservationId','sourceTableId','targetTableId','localStaffId'])if(!id(body[k]))throw reconcile();
 if(body.sourceTableId===body.targetTableId||!Number.isSafeInteger(body.positionSequence)||body.positionSequence<1||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1||body.expectedRevision>=Number.MAX_SAFE_INTEGER||typeof body.sessionStartTime!=='string'||!Number.isFinite(Date.parse(body.sessionStartTime))||new Date(body.sessionStartTime).toISOString()!==body.sessionStartTime)throw reconcile();
 if(body.type==='reservation-move-prepare'&&body.prepareEventId!==body.eventId)throw reconcile();return body;
}
async function verifiedOperation(db,op){
 if(!op)throw reconcile();
 const request=parse(op.request_json),body=validateBody(parse(op.prepare_body_json)),session=parse(op.session_json);
 if(hash(request)!==op.request_sha256||hash(body)!==op.prepare_body_sha256||canonicalSession(request)!==op.request_json||canonicalSession(body)!==op.prepare_body_json||canonicalSession(session)!==op.session_json||body.moveId!==op.move_id||body.prepareEventId!==op.prepare_event_id||body.claimId!==op.claim_id||request.requestId!==op.request_id||request.sourceId!==body.sourceTableId||request.targetId!==body.targetTableId||!same(request.expectedSession,session)||session.startTime!==body.sessionStartTime)throw reconcile();
 const admission=await verifyReservationAdmission(db,session);
 if(admission.row.claim_id!==body.claimId||admission.row.request_id!==body.claimRequestId||admission.row.device_id!==body.deviceId||admission.row.reservation_id!==body.reservationId||admission.admitted.outboxEventId!==body.admissionEventId)throw reconcile();
 if(op.terminal_event_id){
  const terminal=validateBody(parse(op.terminal_body_json));
  if(hash(terminal)!==op.terminal_body_sha256||canonicalSession(terminal)!==op.terminal_body_json||terminal.eventId!==op.terminal_event_id||!Number.isSafeInteger(op.prepare_revision)||!same({...terminal,eventId:body.eventId,type:body.type,expectedRevision:body.expectedRevision,localStaffId:body.localStaffId,cloudUserId:body.cloudUserId},body)||terminal.expectedRevision!==op.prepare_revision)throw reconcile();

  const committed=terminal.type==='reservation-move-commit';
  if(committed?!['local-committed','committed'].includes(op.phase):!['aborting','aborted'].includes(op.phase))throw reconcile();
  const expectedResponse={requestId:op.request_id,moveId:op.move_id,phase:committed?'local-committed':'aborting',replayed:false,...(committed?{id:body.sourceTableId,source:{id:body.sourceTableId,status:'available',session:null},target:{id:body.targetTableId,status:'occupied',session}}:{})};
  if(canonicalSession(expectedResponse)!==op.response_json)throw reconcile();
 }else if(op.phase!=='prepared'||op.response_json!==null||op.terminal_body_json!==null||op.terminal_body_sha256!==null)throw reconcile();
 if(op.prepare_revision!==null){
  const ack=parse(op.prepare_ack_json),keys=['eventId','eventType','claimId','deviceId','reservationId','payloadSha256','state','revision','receiptId','receivedAt','acceptedBy'];
  if(!ack||Array.isArray(ack)||Object.keys(ack).length!==keys.length||Object.keys(ack).some(k=>!keys.includes(k))||canonicalSession(ack)!==op.prepare_ack_json||op.prepare_revision!==body.expectedRevision+1||ack.revision!==op.prepare_revision||ack.eventId!==body.eventId||ack.eventType!==body.type||ack.claimId!==body.claimId||ack.deviceId!==body.deviceId||ack.reservationId!==body.reservationId||ack.payloadSha256!==hash(body)||ack.state!=='move-prepared'||ack.receiptId!==null||!uuid(ack.acceptedBy)||typeof ack.receivedAt!=='string'||!Number.isFinite(Date.parse(ack.receivedAt))||new Date(ack.receivedAt).toISOString()!==ack.receivedAt)throw reconcile();
 }else if(op.prepare_ack_json!==null||op.terminal_event_id!==null)throw reconcile();
 if(!['committed','aborted'].includes(op.phase)){
  const holds=await new Promise((resolve,reject)=>db.all('SELECT * FROM native_reservation_move_holds WHERE move_id=? ORDER BY table_id',[op.move_id],(e,r)=>e?reject(e):resolve(r)));
  if(holds.length!==2||!same(holds.map(h=>h.table_id).sort(),[body.sourceTableId,body.targetTableId].sort())||holds.some(h=>h.claim_id!==body.claimId))throw reconcile();
  const position=await get(db,'SELECT * FROM native_reservation_positions WHERE claim_id=?',[body.claimId]);
  if(!position||position.active_move_id!==op.move_id||position.table_id!==body.sourceTableId||position.position_sequence!==body.positionSequence-1||position.position_event_id!==body.previousPositionEventId||position.cloud_revision!==body.expectedRevision||position.session_start!==body.sessionStartTime||position.device_id!==body.deviceId||position.reservation_id!==body.reservationId||position.admission_event_id!==body.admissionEventId||position.claim_request_id!==body.claimRequestId)throw reconcile();
 }
 return{request,body,session};
}
async function readStoredReservationMoveEvent(db,command,{allowDelivered=false}={}){
 if(!command||Array.isArray(command)||Object.keys(command).length!==2||!Object.keys(command).every(k=>['eventType','eventId'].includes(k))||!uuid(command.eventId)||!['reservation-move-prepare','reservation-move-commit','reservation-move-abort'].includes(command.eventType))throw reconcile();
 await assertReservationMoveSchema(db);
 const row=await get(db,'SELECT * FROM native_reservation_move_outbox WHERE event_id=?',[command.eventId]);
 if(!row||row.event_type!==command.eventType)throw reconcile();
 const op=await get(db,'SELECT * FROM native_reservation_moves WHERE move_id=?',[row.move_id]);const {body}=await verifiedOperation(db,op);
 const expected=row.event_type==='reservation-move-prepare'?body:parse(op.terminal_body_json);
 if(!same(parse(row.payload_json),expected)||row.payload_sha256!==hash(expected)||row.created_at!==op.created_at||expected.eventId!==row.event_id||expected.type!==row.event_type)throw reconcile();
 if(!allowDelivered&&row.delivered_at!==null)throw fail(409,'DEVICE_EVENT_ALREADY_ACKNOWLEDGED','The original move event is already acknowledged.');
 const device=await get(db,'SELECT device_id FROM native_checkin_device WHERE singleton=1');if(device?.device_id!==body.deviceId)throw reconcile();
 return{deviceId:body.deviceId,eventId:row.event_id,claimId:body.claimId,eventType:row.event_type,reservationId:body.reservationId,deliveredAt:row.delivered_at,payload:canonicalSession(expected)};
}
// Called by trusted delivery in the SAME transaction as its ledger and marker.
async function recordAcceptedNativePosition(db,event,result){
 await initializeReservationMoveSchema(db);
 const ack=result.ack;
 if(event.eventType==='admission'){
  const body=parse(event.payload);const op=await get(db,'SELECT claim_json,response_json FROM native_checkin_operations WHERE claim_id=?',[event.claimId]);const claim=parse(op?.claim_json),admitted=parse(op?.response_json);
  await verifyReservationAdmission(db,admitted.table.session);
  if(ack.state!=='checked-in'||ack.revision!==claim.claimRevision+1||body.eventId!==admitted.outboxEventId)throw reconcile();
  const existing=await get(db,'SELECT * FROM native_reservation_positions WHERE claim_id=?',[event.claimId]);
  if(existing){if(existing.admission_event_id!==event.eventId||existing.device_id!==event.deviceId||existing.reservation_id!==event.reservationId)throw reconcile();return;}
  await run(db,'INSERT INTO native_reservation_positions VALUES(?,?,?,?,?,?,?,?,?,?,NULL)',[event.claimId,event.reservationId,event.deviceId,body.requestId,event.eventId,body.tableId,0,event.eventId,ack.revision,body.sessionStartTime]);return;
 }
 const op=await get(db,'SELECT * FROM native_reservation_moves WHERE move_id=?',[parse(event.payload).moveId]);const {body}=await verifiedOperation(db,op);const phase=parse(event.payload);
 if(!same(phase,parse(event.eventType==='reservation-move-prepare'?op.prepare_body_json:op.terminal_body_json))||ack.revision!==phase.expectedRevision+1||ack.receiptId!==null)throw reconcile();
 const position=await get(db,'SELECT * FROM native_reservation_positions WHERE claim_id=?',[body.claimId]);
 if(!position||position.active_move_id!==op.move_id||position.table_id!==body.sourceTableId||position.position_sequence!==body.positionSequence-1||position.position_event_id!==body.previousPositionEventId)throw reconcile();
 if(event.eventType==='reservation-move-prepare'){
  if(op.phase!=='prepared'||ack.state!=='move-prepared'||position.cloud_revision!==body.expectedRevision)throw reconcile();
  if(op.prepare_revision!==null){if(op.prepare_revision!==ack.revision||!same(parse(op.prepare_ack_json),ack))throw reconcile();return;}
  await run(db,'UPDATE native_reservation_moves SET prepare_revision=?,prepare_ack_json=? WHERE move_id=?',[ack.revision,canonicalSession(ack),op.move_id]);return;
 }
 if(position.cloud_revision!==body.expectedRevision||phase.expectedRevision!==op.prepare_revision)throw reconcile();
 if(event.eventType==='reservation-move-commit'){
  if(op.phase!=='local-committed'||ack.state!=='moved')throw reconcile();
  await run(db,'UPDATE native_reservation_positions SET table_id=?,position_sequence=?,position_event_id=?,cloud_revision=?,active_move_id=NULL WHERE claim_id=?',[body.targetTableId,body.positionSequence,phase.eventId,ack.revision,body.claimId]);
  await run(db,"UPDATE native_reservation_moves SET phase='committed' WHERE move_id=?",[op.move_id]);
 }else{
  if(op.phase!=='aborting'||ack.state!=='move-aborted')throw reconcile();
  await run(db,'UPDATE native_reservation_positions SET cloud_revision=?,active_move_id=NULL WHERE claim_id=?',[ack.revision,body.claimId]);
  await run(db,"UPDATE native_reservation_moves SET phase='aborted' WHERE move_id=?",[op.move_id]);
 }
 await run(db,'DELETE FROM native_reservation_move_holds WHERE move_id=?',[op.move_id]);
}
function createReservationMoveCoordinator(dbPath,{resolveActor,isActorCurrent,deliverEvent,readAcceptedAdmission,readAcceptedPosition}={}){
 if(typeof deliverEvent!=='function')throw TypeError('Trusted event delivery callback required.');
 const guard=createNativeActorGuard({resolveActor,isActorCurrent},changed);
 async function tx(token,actor,action){let db,begun=false;try{
  db=await new Promise((resolve,reject)=>{const c=new sqlite3.Database(dbPath,sqlite3.OPEN_READWRITE,e=>e?reject(e):resolve(c));});db.configure('busyTimeout',5000);
  await run(db,'BEGIN IMMEDIATE');begun=true;await initializeReservationMoveSchema(db);guard.assertCurrent(token,actor);
  const result=await action(db);guard.assertCurrent(token,actor);await run(db,'COMMIT');begun=false;return result;
 }catch(e){if(begun)await run(db,'ROLLBACK').catch(()=>{});if(e.status)throw e;throw fail(503,'NATIVE_MOVE_UNCONFIRMED','The original move remains pending. Recover the same request.');}finally{if(db)await new Promise(resolve=>db.close(resolve));}}
 async function fresh(token,actor){if(!same(await guard.resolve(token),actor))throw changed();}
 async function inspect(token,actor,requestId){return tx(token,actor,async db=>{const op=await get(db,'SELECT * FROM native_reservation_moves WHERE request_id=?',[requestId]);await verifiedOperation(db,op);return op;});}
 async function publish(token,actor,eventType,eventId){await deliverEvent(token,{eventType,eventId});await fresh(token,actor);}
 async function finish(token,actor,requestId,action){
  let op=await inspect(token,actor,requestId);
  if(['committed','aborted'].includes(op.phase))return{...parse(op.response_json),phase:op.phase,replayed:true};
  // An unknown prepare outcome is recovered before deciding commit or abort.
  if(op.prepare_revision===null){await publish(token,actor,'reservation-move-prepare',op.prepare_event_id);op=await inspect(token,actor,requestId);if(op.prepare_revision===null)throw reconcile();}
  if(op.phase==='prepared')op=await tx(token,actor,async db=>{
   const current=await get(db,'SELECT * FROM native_reservation_moves WHERE request_id=?',[requestId]);const {body,session}=await verifiedOperation(db,current);
   if(current.phase!=='prepared')return current;if(current.prepare_revision===null)throw reconcile();
   const terminal={...body,eventId:randomUUID(),type:action==='abort'?'reservation-move-abort':'reservation-move-commit',expectedRevision:current.prepare_revision,localStaffId:actor.localStaffId,cloudUserId:actor.cloudUserId};
   let response={requestId,moveId:current.move_id,phase:action==='abort'?'aborting':'local-committed',replayed:false};
   if(action!=='abort'){
    await assertTableNotHeld(db,body.sourceTableId,{allowMoveId:current.move_id});await assertTableNotHeld(db,body.targetTableId,{allowMoveId:current.move_id});
    const source=await get(db,'SELECT * FROM tables WHERE id=?',[body.sourceTableId]),target=await get(db,'SELECT * FROM tables WHERE id=?',[body.targetTableId]);
    if(!source||source.status!=='occupied'||source.isActive!==1||!same(parse(source.sessionData),session)||!target||target.status!=='available'||target.isActive!==1||target.sessionData!==null)throw fail(409,'NATIVE_MOVE_LOCAL_CAS_FAILED','Tables changed. Preserve the permit and recover or explicitly abort this original move.');
    calculateSessionBill(session,Date.now(),false);
    await run(db,"UPDATE tables SET status='occupied',sessionData=? WHERE id=?",[source.sessionData,target.id]);
    await run(db,"UPDATE tables SET status='available',sessionData=NULL WHERE id=?",[source.id]);
    response={...response,id:source.id,source:{id:source.id,status:'available',session:null},target:{id:target.id,status:'occupied',session}};
   }
   await run(db,'UPDATE native_reservation_moves SET terminal_event_id=?,terminal_body_json=?,terminal_body_sha256=?,phase=?,response_json=? WHERE move_id=?',[terminal.eventId,canonicalSession(terminal),hash(terminal),response.phase,canonicalSession(response),current.move_id]);
   await run(db,'INSERT INTO native_reservation_move_outbox VALUES(?,?,?,?,?,?,NULL)',[terminal.eventId,current.move_id,terminal.type,canonicalSession(terminal),hash(terminal),current.created_at]);
   return get(db,'SELECT * FROM native_reservation_moves WHERE move_id=?',[current.move_id]);
  });
  // Once the local transaction committed, abort is forbidden; recover its commit.
  if(action==='abort'&&op.phase==='local-committed')throw fail(409,'NATIVE_MOVE_ALREADY_COMMITTED','The session already moved locally. Recover its original commit; it cannot be aborted.');
  const type=op.phase==='aborting'?'reservation-move-abort':'reservation-move-commit';
  await publish(token,actor,type,op.terminal_event_id);
  op=await inspect(token,actor,requestId);if(!['committed','aborted'].includes(op.phase))throw reconcile();
  return{...parse(op.response_json),phase:op.phase,cloudAcknowledged:true};
 }
 async function move(token,input){
  const keys=['requestId','sourceId','targetId','expectedSession','expectedTargetStatus','expectedTargetSession'];
  if(!input||Array.isArray(input)||Object.keys(input).length!==keys.length||Object.keys(input).some(k=>!keys.includes(k))||typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId)||!id(input.sourceId)||!id(input.targetId)||input.sourceId===input.targetId||input.expectedTargetStatus!=='available'||input.expectedTargetSession!==null||input.expectedSession?.pricingVersion!==2)throw fail(400,'INVALID_RESERVATION_MOVE','Choose a reservation session and a different empty table.');
  const request=parse(canonicalSession(input));const actor=await guard.resolve(token);
  await tx(token,actor,async db=>{
   const old=await get(db,'SELECT * FROM native_reservation_moves WHERE request_id=?',[request.requestId]);
   if(old){await verifiedOperation(db,old);if(old.request_json!==canonicalSession(request))throw fail(409,'NATIVE_MOVE_REQUEST_CONFLICT','Request ID belongs to another move.');return;}
   const session=request.expectedSession;calculateSessionBill(session,Date.now(),false);const {row,admitted}=await verifyReservationAdmission(db,session);
   let position=await get(db,'SELECT * FROM native_reservation_positions WHERE claim_id=?',[row.claim_id]);
   if(!position&&typeof readAcceptedAdmission==='function'){
    if(await get(db,'SELECT 1 FROM native_reservation_moves WHERE claim_id=? LIMIT 1',[row.claim_id])||await get(db,"SELECT 1 FROM native_reservation_move_outbox WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.claimId')=? ELSE 1 END LIMIT 1",[row.claim_id]))throw reconcile();
    if(request.sourceId!==row.table_id)throw reconcile();
    const original=await get(db,'SELECT * FROM tables WHERE id=?',[row.table_id]);
    if(!original||original.status!=='occupied'||original.isActive!==1||!same(parse(original.sessionData),session))throw reconcile();
    const accepted=await readAcceptedAdmission(db,{claimId:row.claim_id,eventId:admitted.outboxEventId});
    const marker=await get(db,'SELECT delivered_at FROM native_checkin_outbox WHERE event_id=?',[admitted.outboxEventId]);
    if(!accepted||accepted.event?.eventType!=='admission'||accepted.event.eventId!==admitted.outboxEventId||accepted.event.claimId!==row.claim_id||!marker?.delivered_at||accepted.event.deliveredAt!==marker.delivered_at||accepted.result?.ack?.receivedAt!==marker.delivered_at)throw reconcile();
    guard.assertCurrent(token,actor);await recordAcceptedNativePosition(db,accepted.event,accepted.result);
    position=await get(db,'SELECT * FROM native_reservation_positions WHERE claim_id=?',[row.claim_id]);
   }
   if(!position)throw fail(409,'NATIVE_ADMISSION_ACK_REQUIRED','Acknowledge admission before moving its reservation.');
   if(position.active_move_id||position.table_id!==request.sourceId||position.session_start!==session.startTime||position.device_id!==row.device_id||position.admission_event_id!==admitted.outboxEventId||!Number.isSafeInteger(position.position_sequence)||position.position_sequence<0||position.position_sequence>=Number.MAX_SAFE_INTEGER||!uuid(position.position_event_id)||!Number.isSafeInteger(position.cloud_revision)||position.cloud_revision<1||position.cloud_revision>Number.MAX_SAFE_INTEGER-3)throw reconcile();
   if(typeof readAcceptedPosition==='function'){const accepted=await readAcceptedPosition(db,session,request.sourceId);if(!accepted)throw reconcile();guard.assertCurrent(token,actor);}
   await assertTableNotHeld(db,request.sourceId);await assertTableNotHeld(db,request.targetId);
   const source=await get(db,'SELECT * FROM tables WHERE id=?',[request.sourceId]),target=await get(db,'SELECT * FROM tables WHERE id=?',[request.targetId]);
   if(!source||source.status!=='occupied'||source.isActive!==1||!same(parse(source.sessionData),session)||!target||target.status!=='available'||target.isActive!==1||target.sessionData!==null)throw fail(409,'NATIVE_MOVE_LOCAL_CAS_FAILED','Refresh the current source session and available target.');
   const moveId=randomUUID(),eventId=randomUUID(),createdAt=new Date().toISOString();
   const body=validateBody({version:1,eventId,type:'reservation-move-prepare',moveId,prepareEventId:eventId,claimId:row.claim_id,reservationId:row.reservation_id,deviceId:row.device_id,claimRequestId:row.request_id,admissionEventId:admitted.outboxEventId,sourceTableId:request.sourceId,targetTableId:request.targetId,positionSequence:position.position_sequence+1,previousPositionEventId:position.position_event_id,expectedRevision:position.cloud_revision,localStaffId:actor.localStaffId,cloudUserId:actor.cloudUserId,sessionStartTime:session.startTime});
   await run(db,"INSERT INTO native_reservation_moves(move_id,request_id,request_json,request_sha256,claim_id,prepare_event_id,prepare_body_json,prepare_body_sha256,phase,session_json,created_at) VALUES(?,?,?,?,?,?,?,?,'prepared',?,?)",[moveId,request.requestId,canonicalSession(request),hash(request),row.claim_id,eventId,canonicalSession(body),hash(body),canonicalSession(session),createdAt]);
   for(const tableId of [request.sourceId,request.targetId])await run(db,'INSERT INTO native_reservation_move_holds VALUES(?,?,?)',[tableId,moveId,row.claim_id]);
   await run(db,'UPDATE native_reservation_positions SET active_move_id=? WHERE claim_id=?',[moveId,row.claim_id]);
   await run(db,'INSERT INTO native_reservation_move_outbox VALUES(?,?,?,?,?,?,NULL)',[eventId,moveId,body.type,canonicalSession(body),hash(body),createdAt]);
  });
  return finish(token,actor,request.requestId,'continue');
 }
 async function recover(token,input){if(!input||Object.keys(input).length!==2||!Object.keys(input).every(k=>['requestId','action'].includes(k))||typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId)||!['continue','abort'].includes(input.action))throw fail(400,'INVALID_RESERVATION_MOVE','Recover the original move request.');const command={...input},actor=await guard.resolve(token);return finish(token,actor,command.requestId,command.action);}
 return Object.freeze({move,recover});
}
module.exports={createReservationMoveCoordinator,initializeReservationMoveSchema,assertReservationMoveSchema,readStoredReservationMoveEvent,recordAcceptedNativePosition,assertTableNotHeld,reservationMoveDefinitions:definitions};
