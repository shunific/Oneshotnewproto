const {createCheckinCancellation}=require('./server-checkin-cancellation.cjs');
const sqlite3=require('sqlite3');
const {createHash}=require('node:crypto');
const {checkinDefinitions,normalizeSql}=require('./server-checkin-schema.cjs');
const {createReservationMoveCoordinator}=require('./server-reservation-moves.cjs');
const {createCheckinCoordinator}=require('./server-checkin.cjs');
const {readStoredNativeEvent}=require('./server-device-proof.cjs');
const {validateNativeEventEnvelope,validateCheckinClaimResult}=require('./server-cloud-staff.cjs');
const {canonicalSession}=require('./server-session-identity.cjs');
const {createNativeEventDelivery,readAcceptedReservationPosition}=require('./server-native-delivery.cjs');
const changed=()=>Object.assign(new Error('Reconnect the approved local and cloud staff accounts before recovering this operation.'),{status:403,code:'NATIVE_ACCOUNT_CHANGED'});
function createNativeReservationRuntime(dbPath,{auth,cloudStaff}={}){
 if(typeof auth?.resolveSessionActor!=='function'||typeof auth?.isSessionCurrent!=='function'||typeof cloudStaff?.resolveNativeActor!=='function'||typeof cloudStaff?.isNativeActorCurrent!=='function'||typeof cloudStaff?.claimCheckin!=='function'||typeof cloudStaff?.ackNativeEvent!=='function')throw new TypeError('Trusted local and approved cloud staff authority are required.');
 const isActorCurrent=(token,actor)=>auth.isSessionCurrent(token,actor.localStaffId)===true&&cloudStaff.isNativeActorCurrent(token,actor)===true;
 const resolveActor=async token=>{
  const local=await auth.resolveSessionActor(token);if(!local)throw changed();
  const cloud=await cloudStaff.resolveNativeActor(token);
  const actor={localStaffId:local.localStaffId,cloudUserId:cloud.cloudUserId,generation:cloud.generation};
  if(!isActorCurrent(token,actor))throw changed();
  return actor;
 };
 const coordinator=createCheckinCoordinator(dbPath,{resolveActor,isActorCurrent,claimCheckin:(...args)=>cloudStaff.claimCheckin(...args)});
 const prepareEvent=async(token,input)=>{
  const command={eventType:input.eventType,eventId:input.eventId};
  const actor=await resolveActor(token);
  const event=await readStoredNativeEvent(dbPath,command);
  const refreshed=await resolveActor(token);
  if(canonicalSession(actor)!==canonicalSession(refreshed)||!isActorCurrent(token,actor))throw changed();
  return validateNativeEventEnvelope({version:2,deviceId:event.deviceId,actorId:actor.cloudUserId,eventType:event.eventType,eventId:event.eventId,claimId:event.claimId,payload:event.payload});
 };
 const delivery=createNativeEventDelivery(dbPath,{resolveActor,isActorCurrent,prepareEvent,sendEvent:(...args)=>cloudStaff.ackNativeEvent(...args)});
 const cancellation=createCheckinCancellation(dbPath,{resolveActor,isActorCurrent,ready:coordinator.ready,cancelCheckin:(...args)=>cloudStaff.cancelCheckin(...args)});
 const moves=createReservationMoveCoordinator(dbPath,{resolveActor,isActorCurrent,deliverEvent:delivery.deliver,readAcceptedAdmission:delivery.readAcceptedAdmission,readAcceptedPosition:readAcceptedReservationPosition});
 async function readLocal(token,inspect){
  await coordinator.ready;const actor=await resolveActor(token);
  const db=await new Promise((resolve,reject)=>{const c=new sqlite3.Database(dbPath,sqlite3.OPEN_READONLY,error=>error?reject(error):resolve(c));});
  const get=(sql,args=[])=>new Promise((resolve,reject)=>db.get(sql,args,(e,row)=>e?reject(e):resolve(row)));
  const all=(sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,rows)=>e?reject(e):resolve(rows)));
  try{
   for(const [name,ddl]of checkinDefinitions){const row=await get("SELECT sql FROM sqlite_master WHERE type='table' AND name=?",[name]);if(!row||normalizeSql(row.sql)!==normalizeSql(ddl))throw Error('schema');}
   const device=await get('SELECT device_id FROM native_checkin_device WHERE singleton=1');
   const result=await inspect({actor,deviceId:device?.device_id,get,all});
   const refreshed=await resolveActor(token);if(canonicalSession(actor)!==canonicalSession(refreshed))throw changed();return result;
  }catch(error){if(error.status)throw error;throw Object.assign(new Error('Stored check-in recovery data requires reconciliation.'),{status:409,code:'CHECKIN_RECONCILIATION_REQUIRED'});}
  finally{await new Promise(resolve=>db.close(resolve));}
 }
 const listPendingCheckins=token=>readLocal(token,async({actor,deviceId,all})=>{
  const rows=await all("SELECT * FROM native_checkin_operations WHERE phase IN ('prepared','claimed') AND local_staff_id=? AND cloud_user_id=? ORDER BY created_at LIMIT 1001",[actor.localStaffId,actor.cloudUserId]);
  if(rows.length>1000)throw Error('limit');
  return rows.map(row=>{
   const payload=JSON.parse(row.request_json),fields=['requestId','id','expectedRevision','expectedStaffId','tableId','deviceId'];
   if(!payload||!Number.isSafeInteger(payload.expectedRevision)||payload.expectedRevision<1||payload.expectedRevision>=Number.MAX_SAFE_INTEGER||typeof payload.requestId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload.requestId)||Object.keys(payload).length!==6||!fields.every(key=>Object.hasOwn(payload,key))||payload.requestId!==row.request_id||payload.id!==row.reservation_id||payload.tableId!==row.table_id||payload.deviceId!==deviceId||payload.deviceId!==row.device_id||payload.expectedStaffId!==actor.cloudUserId||createHash('sha256').update(canonicalSession(payload)).digest('hex')!==row.request_fingerprint)throw Error('binding');
   if(row.phase==='claimed'){const claim=JSON.parse(row.claim_json);if(claim.claimId!==row.claim_id)throw Error('claim');validateCheckinClaimResult({claim,replayed:true,recordType:'reservation-check-in-claim',fundsTransferred:false},payload);}
   const {deviceId:ignored,...command}=payload;return{...command,phase:row.phase};
  });
 });
 const pendingSync=async token=>{
  const actor=await resolveActor(token),checkins=await listPendingCheckins(token),events=await delivery.listPending(token);
  const refreshed=await resolveActor(token);if(canonicalSession(actor)!==canonicalSession(refreshed))throw changed();
  return{events,checkins};
 };
 const tableMappings=token=>readLocal(token,async({deviceId})=>{
  if(typeof cloudStaff.nativeTableMappings!=='function')throw Object.assign(new Error('Physical table mappings are unavailable.'),{status:503,code:'NATIVE_MAPPINGS_UNAVAILABLE'});
  return cloudStaff.nativeTableMappings(token,deviceId);
 });
 return Object.freeze({move:moves.move,recoverMove:moves.recover,ready:coordinator.ready,claim:coordinator.claim,admit:coordinator.admit,deliver:delivery.deliver,listPendingSync:delivery.listPending,listPendingCheckins,pendingSync,tableMappings,cancelCheckin:cancellation.cancel});
}
module.exports={createNativeReservationRuntime};
