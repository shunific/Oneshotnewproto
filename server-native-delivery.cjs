const sqlite3 = require('sqlite3');
const { createHash } = require('node:crypto');
const { canonicalSession } = require('./server-session-identity.cjs');
const { createNativeActorGuard } = require('./server-native-actor.cjs');
const { recordAcceptedNativePosition } = require('./server-reservation-moves.cjs');
const { readStoredNativeEvent } = require('./server-device-proof.cjs');
const { validateNativeEventEnvelope, validateNativeEventAckResult } = require('./server-cloud-staff.cjs');
const fail = (status,code,message) => Object.assign(new Error(message),{status,code});
const reconcile = () => fail(409,'NATIVE_DELIVERY_RECONCILIATION_REQUIRED','The original event acknowledgement requires reconciliation. Preserve its original operation.');
const changed = () => fail(403,'NATIVE_DELIVERY_ACCOUNT_CHANGED','Staff session changed. Recover the original event under an approved account.');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const hash = value => createHash('sha256').update(value,'utf8').digest('hex');
const same = (left,right) => canonicalSession(left) === canonicalSession(right);
const run = (db,sql,args=[]) => new Promise((resolve,reject)=>db.run(sql,args,function(error){error?reject(error):resolve(this);}));
const get = (db,sql,args=[]) => new Promise((resolve,reject)=>db.get(sql,args,(error,row)=>error?reject(error):resolve(row)));
const open = filename => new Promise((resolve,reject)=>{const db=new sqlite3.Database(filename,sqlite3.OPEN_READWRITE,error=>error?reject(error):resolve(db));});
const close = db => new Promise(resolve=>db.close(resolve));
const definition = `CREATE TABLE IF NOT EXISTS native_event_deliveries (
  event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL CHECK(event_type IN ('admission','reservation-completion')),
  claim_id TEXT NOT NULL, device_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL, envelope_json TEXT NOT NULL, response_json TEXT NOT NULL,
  journal_sha256 TEXT NOT NULL, delivered_at TEXT NOT NULL, UNIQUE(event_type,claim_id))`;
const moveDefinition = definition.replace('native_event_deliveries','native_move_event_deliveries').replace("CHECK(event_type IN ('admission','reservation-completion'))","CHECK(event_type IN ('reservation-move-prepare','reservation-move-commit','reservation-move-abort'))").replace(', UNIQUE(event_type,claim_id)', '');
const cancelDefinition = moveDefinition.replace('native_move_event_deliveries','native_move_cancel_deliveries').replace("'reservation-move-prepare','reservation-move-commit','reservation-move-abort'","'reservation-move-cancel'");
const isCancel = event => event.eventType==='reservation-move-cancel';
const isMove = event => event.eventType.startsWith('reservation-move-');
const ledgerTable = event => isCancel(event) ? 'native_move_cancel_deliveries' : isMove(event) ? 'native_move_event_deliveries' : 'native_event_deliveries';
// Detect accidental journal-field corruption; this unkeyed digest is not authentication against a DB owner.
const journalHash = (envelope,result) => hash(canonicalSession({envelope,result}));
const normalized = sql => sql.replace(' IF NOT EXISTS','').replace(/\s+/g,' ').trim();
async function initialize(db) {
  for(const [name,ddl] of [['native_event_deliveries',definition],['native_move_event_deliveries',moveDefinition],['native_move_cancel_deliveries',cancelDefinition]]) {
    await run(db,ddl);
    const schema=await get(db,"SELECT sql FROM sqlite_master WHERE type='table' AND name=?",[name]);
    if(!schema||normalized(schema.sql)!==normalized(ddl))throw reconcile();
  }
}
function envelopeForEvent(envelope,event) {
  if(envelope.eventId!==event.eventId||envelope.eventType!==event.eventType||envelope.deviceId!==event.deviceId||envelope.claimId!==event.claimId||envelope.payload!==event.payload)throw reconcile();
}
async function claimRevision(db,event) {
  const body=JSON.parse(event.payload);
  if(isMove(event)||(event.eventType==='reservation-completion'&&body.version===2)){
    if(!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<1||body.expectedRevision>=Number.MAX_SAFE_INTEGER)throw reconcile();
    const revision=body.expectedRevision+(isCancel(event)?2:1);
    if(!Number.isSafeInteger(revision))throw reconcile();
    return revision;
  }
  const operation=await get(db,'SELECT claim_json FROM native_checkin_operations WHERE claim_id=?',[event.claimId]);
  let claim;try{claim=JSON.parse(operation?.claim_json);}catch{throw reconcile();}
  if(!Number.isSafeInteger(claim?.claimRevision)||claim.claimRevision<1||claim.claimRevision>Number.MAX_SAFE_INTEGER-2)throw reconcile();
  return claim.claimRevision+(event.eventType==='admission'?1:2);
}
async function ledgerResult(db,row,event) {
  try {
    if(!row||row.event_id!==event.eventId||row.event_type!==event.eventType||row.claim_id!==event.claimId||row.device_id!==event.deviceId||row.reservation_id!==event.reservationId||row.payload_sha256!==hash(event.payload)||row.delivered_at!==event.deliveredAt||!event.deliveredAt)throw reconcile();
    const envelope=validateNativeEventEnvelope(JSON.parse(row.envelope_json));envelopeForEvent(envelope,event);
    const result=validateNativeEventAckResult(JSON.parse(row.response_json),envelope);
    if(canonicalSession(envelope)!==row.envelope_json||canonicalSession(result)!==row.response_json||journalHash(envelope,result)!==row.journal_sha256||result.ack.receivedAt!==row.delivered_at||result.ack.revision!==await claimRevision(db,event))throw reconcile();
    return result;
  } catch {throw reconcile();}
}
async function admissionAcknowledged(db,dbPath,event) {
  if(event.eventType==='admission')return;
  const payload=JSON.parse(event.payload);
  if(!uuid(payload.admissionEventId))throw reconcile();
  const admission=await readStoredNativeEvent(dbPath,{eventType:'admission',eventId:payload.admissionEventId},{allowDelivered:true});
  if(admission.claimId!==event.claimId||admission.deviceId!==event.deviceId||admission.reservationId!==event.reservationId)throw reconcile();
  const row=await get(db,'SELECT * FROM native_event_deliveries WHERE event_id=?',[admission.eventId]);
  if ((!row && admission.deliveredAt !== null) || (row && !admission.deliveredAt)) throw reconcile();
  if(!row||!admission.deliveredAt)throw fail(409,'NATIVE_ADMISSION_ACK_REQUIRED','Acknowledge the original admission before publishing its completion.');
  const result=await ledgerResult(db,row,admission);
  if(result.ack.state!=='checked-in')throw reconcile();
}
async function readAcceptedReservationPosition(db,session,tableId) {
  const {row,admitted}=await require('./server-reservation-completion.cjs').verifyReservationAdmission(db,session);
  const exists=async name=>get(db,"SELECT sql FROM sqlite_master WHERE type='table' AND name=?",[name]);
  const positionSchema=await exists('native_reservation_positions');
  const ledgerSchema=await exists('native_event_deliveries');
  if(ledgerSchema&&normalized(ledgerSchema.sql)!==normalized(definition))throw reconcile();
  const admission=await readStoredNativeEvent(db.filename,{eventType:'admission',eventId:admitted.outboxEventId},{allowDelivered:true});
  const saved=ledgerSchema?await get(db,'SELECT * FROM native_event_deliveries WHERE event_id=?',[admission.eventId]):null;
  if(!saved){
    if(admission.deliveredAt!==null)throw reconcile();
    if(positionSchema&&await get(db,'SELECT claim_id FROM native_reservation_positions WHERE claim_id=?',[row.claim_id]))throw reconcile();
    return null;
  }
  const accepted=await ledgerResult(db,saved,admission);
  if(!positionSchema)throw reconcile();
  await require('./server-reservation-moves.cjs').assertReservationMoveSchema(db,{allowLegacy:true});
  const expected={claim_id:row.claim_id,reservation_id:row.reservation_id,device_id:row.device_id,claim_request_id:row.request_id,admission_event_id:admission.eventId,table_id:row.table_id,position_sequence:0,position_event_id:admission.eventId,cloud_revision:accepted.ack.revision,session_start:session.startTime,active_move_id:null};
  const events=[];
  for(const [name,ddl]of [['native_move_event_deliveries',moveDefinition],['native_move_cancel_deliveries',cancelDefinition]]){
    const schema=await exists(name);
    if(schema&&normalized(schema.sql)!==normalized(ddl))throw reconcile();
    if(schema)events.push(...await new Promise((resolve,reject)=>db.all(`SELECT * FROM ${name} WHERE claim_id=? LIMIT 10001`,[row.claim_id],(error,rows)=>error?reject(error):resolve(rows))));
  }
  if(events.length>10000)throw reconcile();
  const verified=[];
  for(const entry of events){
    const event=await readStoredNativeEvent(db.filename,{eventType:entry.event_type,eventId:entry.event_id},{allowDelivered:true});
    const result=await ledgerResult(db,entry,event);verified.push({body:JSON.parse(event.payload),ack:result.ack,event});
  }
  verified.sort((a,b)=>a.body.expectedRevision-b.body.expectedRevision||(a.body.type==='reservation-move-prepare'?-1:1));
  let pending=null;
  for(const {body,ack,event} of verified){
    if(isCancel(event)){
      let prepare;try{prepare=JSON.parse(body.preparePayload);}catch{throw reconcile();}
      const base=body.expectedRevision;
      if(!prepare||canonicalSession(prepare)!==body.preparePayload||hash(body.preparePayload)!==body.preparePayloadSha256||prepare.expectedRevision!==base||prepare.eventId!==body.prepareEventId||prepare.moveId!==body.moveId||prepare.type!=='reservation-move-prepare'||body.sourceTableId!==expected.table_id||body.previousPositionEventId!==expected.position_event_id||body.positionSequence!==expected.position_sequence+1||body.claimId!==expected.claim_id||body.deviceId!==expected.device_id||body.reservationId!==expected.reservation_id||body.claimRequestId!==expected.claim_request_id||body.admissionEventId!==expected.admission_event_id||body.sessionStartTime!==expected.session_start||ack.revision!==base+2)throw reconcile();
      if(pending){if(expected.cloud_revision!==base+1||canonicalSession(pending)!==body.preparePayload)throw reconcile();}
      else if(expected.cloud_revision!==base)throw reconcile();
      const original=await get(db,'SELECT delivered_at FROM native_reservation_move_outbox WHERE event_id=?',[body.prepareEventId]);
      if(!original||(original.delivered_at!==null&&!verified.some(v=>v.event.eventId===body.prepareEventId)))throw reconcile();
      pending=null;expected.cloud_revision=ack.revision;continue;
    }
    if(body.expectedRevision!==expected.cloud_revision||body.sourceTableId!==expected.table_id||body.previousPositionEventId!==expected.position_event_id||body.positionSequence!==expected.position_sequence+1||body.claimId!==expected.claim_id||body.deviceId!==expected.device_id||body.reservationId!==expected.reservation_id||body.claimRequestId!==expected.claim_request_id||body.admissionEventId!==expected.admission_event_id||body.sessionStartTime!==expected.session_start)throw reconcile();
    if(body.type==='reservation-move-prepare'){
      if(pending)throw reconcile();pending=body;
    }else{
      if(!pending||body.moveId!==pending.moveId||body.prepareEventId!==pending.eventId||body.targetTableId!==pending.targetTableId)throw reconcile();
      if(body.type==='reservation-move-commit'){expected.table_id=body.targetTableId;expected.position_sequence=body.positionSequence;expected.position_event_id=body.eventId;}
      pending=null;
    }
    expected.cloud_revision=ack.revision;
  }
  if(pending||expected.table_id!==tableId)throw reconcile();
  const position=await get(db,'SELECT * FROM native_reservation_positions WHERE claim_id=?',[row.claim_id]);
  if(!same(position,expected))throw reconcile();
  return position;
}
async function initializeNativePositionUpgrade(db) {
  const {reservationMoveDefinitions,initializeReservationMoveSchema}=require('./server-reservation-moves.cjs');
  const present=[];
  for(const [name]of reservationMoveDefinitions)if(await get(db,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",[name]))present.push(name);
  if(present.length){
    const baseDefinitions=reservationMoveDefinitions.filter(([name])=>!['native_reservation_move_cancel_outbox','native_reservation_move_rejections'].includes(name));
    if(!baseDefinitions.every(([name])=>present.includes(name)))throw reconcile();
    await initializeReservationMoveSchema(db);return;
  }
  let begun=false;
  try {
    await run(db,'BEGIN IMMEDIATE');begun=true;
    const legacy=await get(db,"SELECT sql FROM sqlite_master WHERE type='table' AND name='native_event_deliveries'");
    if(legacy&&normalized(legacy.sql)!==normalized(definition))throw reconcile();
    const rows=legacy?await new Promise((resolve,reject)=>db.all("SELECT * FROM native_event_deliveries WHERE event_type='admission'",(error,rows)=>error?reject(error):resolve(rows))):[];
    await initializeReservationMoveSchema(db);
    for(const row of rows){
      const event=await readStoredNativeEvent(db.filename,{eventType:'admission',eventId:row.event_id},{allowDelivered:true});
      await recordAcceptedNativePosition(db,event,await ledgerResult(db,row,event));
    }
    await run(db,'COMMIT');begun=false;
  }catch(error){if(begun)await run(db,'ROLLBACK').catch(()=>{});throw error;}
}
function createNativeEventDelivery(dbPath,{prepareEvent,sendEvent,signEvent=prepareEvent,sendSignedEvent=sendEvent,resolveActor,isActorCurrent}={}) {
  if(typeof signEvent!=='function'||typeof sendSignedEvent!=='function')throw new TypeError('Trusted original event and authenticated cloud callbacks are required.');
  const guard=createNativeActorGuard({resolveActor,isActorCurrent},changed);
  const current=(token,expected)=>guard.assertCurrent(token,expected);
  async function fresh(token,expected) {
    const value=await guard.resolve(token);
    if(!same(value,expected))throw changed();
    return value;
  }
  async function transaction(command,token,actor,pendingAck) {
    let db,begun=false;
    try {
      db=await open(dbPath);db.configure('busyTimeout',5000);await run(db,'BEGIN IMMEDIATE');begun=true;
      await initialize(db);
      const event=await readStoredNativeEvent(dbPath,command,{allowDelivered:true});
      const ledger=ledgerTable(event);
      const saved=await get(db,`SELECT * FROM ${ledger} WHERE event_id=?`,[event.eventId]);
      if(saved){
        const result=await ledgerResult(db,saved,event);
        if(pendingAck&&!same(result.ack,pendingAck.result.ack))throw reconcile();
        current(token,actor);await run(db,'COMMIT');begun=false;
        return {event,result:{...result,replayed:true}};
      }
      if(event.deliveredAt!==null)throw reconcile();
      await admissionAcknowledged(db,dbPath,event);
      if(!pendingAck){current(token,actor);await run(db,'COMMIT');begun=false;return{event};}
      const {envelope,result}=pendingAck;
      envelopeForEvent(envelope,event);
      if(result.ack.revision!==await claimRevision(db,event))throw reconcile();
      if(!isMove(event)){
        const conflict=await get(db,'SELECT event_id FROM native_event_deliveries WHERE event_type=? AND claim_id=?',[event.eventType,event.claimId]);
        if(conflict)throw reconcile();
      }
      current(token,actor);
      await run(db,`INSERT INTO ${ledger} VALUES(?,?,?,?,?,?,?,?,?,?)`,[event.eventId,event.eventType,event.claimId,event.deviceId,event.reservationId,hash(event.payload),canonicalSession(envelope),canonicalSession(result),journalHash(envelope,result),result.ack.receivedAt]);
      if(event.eventType==='admission'||isMove(event))await recordAcceptedNativePosition(db,event,result);
      const outbox=isCancel(event)?'native_reservation_move_cancel_outbox':isMove(event)?'native_reservation_move_outbox':event.eventType==='admission'?'native_checkin_outbox':'native_reservation_completion_outbox';
      const updated=await run(db,`UPDATE ${outbox} SET delivered_at=? WHERE event_id=? AND delivered_at IS NULL`,[result.ack.receivedAt,event.eventId]);
      if(updated.changes!==1)throw reconcile();
      current(token,actor);await run(db,'COMMIT');begun=false;
      return{event,result};
    } catch(error) {
      if(begun)await run(db,'ROLLBACK').catch(()=>{});
      if(error.status)throw error;
      throw fail(503,'NATIVE_DELIVERY_UNCONFIRMED','Event acknowledgement could not be saved. Retry the same original event.');
    } finally {if(db)await close(db);}
  }
  async function deliver(token,input) {
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==2||!Object.keys(input).every(key=>['eventType','eventId'].includes(key))||!['admission','reservation-completion','reservation-move-prepare','reservation-move-commit','reservation-move-abort','reservation-move-cancel'].includes(input.eventType)||!uuid(input.eventId))throw fail(400,'INVALID_NATIVE_DELIVERY','Choose an original native event.');
    const command={eventType:input.eventType,eventId:input.eventId};
    const actor=await guard.resolve(token);
    const initial=await transaction(command,token,actor);
    if(initial.result){await fresh(token,actor);return initial.result;}
    const envelope=validateNativeEventEnvelope(await signEvent(token,command));
    envelopeForEvent(envelope,initial.event);
    if(envelope.actorId!==actor.cloudUserId)throw changed();
    current(token,actor);
    const result=validateNativeEventAckResult(await sendSignedEvent(token,envelope),envelope);
    await fresh(token,actor);
    const committed=await transaction(command,token,actor,{envelope,result});
    current(token,actor);
    return committed.result;
  }
  async function readAcceptedAdmission(db,{claimId,eventId}) {
    await initialize(db);
    const event=await readStoredNativeEvent(dbPath,{eventType:'admission',eventId},{allowDelivered:true});
    if(event.claimId!==claimId)throw reconcile();
    const row=await get(db,'SELECT * FROM native_event_deliveries WHERE event_id=?',[eventId]);
    if(!row||!event.deliveredAt)throw fail(409,'NATIVE_ADMISSION_ACK_REQUIRED','Acknowledge the original admission before moving its reservation.');
    return {event,result:await ledgerResult(db,row,event)};
  }
  async function listPending(token) {
    const actor=await guard.resolve(token);
    let db,begun=false;
    try {
      db=await open(dbPath);await run(db,'BEGIN');begun=true;
      const sources=[['native_checkin_outbox','admission'],['native_reservation_completion_outbox','reservation-completion'],['native_reservation_move_outbox',null],['native_reservation_move_cancel_outbox','reservation-move-cancel']];
      const pending=[];
      for(const [table,type] of sources){
        if(!await get(db,"SELECT name FROM sqlite_master WHERE type='table' AND name=?",[table]))continue;
        const rows=await new Promise((resolve,reject)=>db.all(`SELECT * FROM ${table} WHERE delivered_at IS NULL ORDER BY event_id LIMIT 1001`,(error,rows)=>error?reject(error):resolve(rows)));
        for(const row of rows){
          if(row.event_type==='reservation-move-prepare' && await get(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='native_reservation_move_cancel_outbox'") && await get(db,'SELECT event_id FROM native_reservation_move_cancel_outbox WHERE move_id=?',[row.move_id]))continue;
          if(pending.length>=1000)throw reconcile();
          const command={eventType:type||row.event_type,eventId:row.event_id};
          const event=await readStoredNativeEvent(dbPath,command);
          pending.push({eventType:event.eventType,eventId:event.eventId,claimId:event.claimId,reservationId:event.reservationId});
        }
      }
      current(token,actor);await run(db,'COMMIT');begun=false;await fresh(token,actor);
      return pending;
    }catch(error){if(begun)await run(db,'ROLLBACK').catch(()=>{});if(error.status)throw error;throw reconcile();}
    finally{if(db)await close(db);}
  }
  return Object.freeze({deliver,readAcceptedAdmission,listPending});
}
module.exports={createNativeEventDelivery,readAcceptedReservationPosition,initializeNativePositionUpgrade};
