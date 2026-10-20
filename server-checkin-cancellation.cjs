const sqlite3=require('sqlite3');
const {createHash}=require('node:crypto');
const {canonicalSession}=require('./server-session-identity.cjs');
const {createNativeActorGuard}=require('./server-native-actor.cjs');
const {validateCheckinClaimResult,validateCheckinCancellationResult}=require('./server-cloud-staff.cjs');
const definition=`CREATE TABLE IF NOT EXISTS native_checkin_cancellations (request_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version=1), local_staff_id TEXT NOT NULL, cloud_user_id TEXT NOT NULL, request_json TEXT NOT NULL, request_sha256 TEXT NOT NULL, response_json TEXT NOT NULL, cancelled_at TEXT NOT NULL, journal_sha256 TEXT NOT NULL)`;
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code});
const reconcile=()=>fail(409,'CHECKIN_RECONCILIATION_REQUIRED','The original check-in cancellation requires reconciliation.');
const hash=value=>createHash('sha256').update(canonicalSession(value)).digest('hex');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,function(error){error?reject(error):resolve(this);}));
const get=(db,sql,args=[])=>new Promise((resolve,reject)=>db.get(sql,args,(e,row)=>e?reject(e):resolve(row)));
const normalize=s=>s.replace(' IF NOT EXISTS','').replace(/\s+/g,' ').trim();
async function initializeCheckinCancellationSchema(db){await run(db,definition);const row=await get(db,"SELECT sql FROM sqlite_master WHERE type='table' AND name='native_checkin_cancellations'");if(!row||normalize(row.sql)!==normalize(definition))throw reconcile();}
function validateRequest(payload){const fields=['requestId','id','expectedRevision','expectedStaffId','deviceId','tableId'];if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length!==6||!fields.every(key=>Object.hasOwn(payload,key))||!uuid(payload.requestId)||!uuid(payload.expectedStaffId)||!uuid(payload.deviceId)||!Number.isSafeInteger(payload.expectedRevision)||payload.expectedRevision<1||payload.expectedRevision>=Number.MAX_SAFE_INTEGER||!['id','tableId'].every(key=>typeof payload[key]==='string'&&payload[key].trim()===payload[key]&&payload[key].length>0&&payload[key].length<=120))throw reconcile();return payload;}
function validateRow(row,actor){try{const request=validateRequest(JSON.parse(row.request_json)),response=validateCheckinCancellationResult(JSON.parse(row.response_json),request);if(row.schema_version!==1||request.requestId!==row.request_id||request.expectedStaffId!==row.cloud_user_id||canonicalSession(request)!==row.request_json||hash(request)!==row.request_sha256||canonicalSession(response)!==row.response_json||new Date(row.cancelled_at).toISOString()!==row.cancelled_at||hash({request,response,localStaffId:row.local_staff_id,cloudUserId:row.cloud_user_id,cancelledAt:row.cancelled_at})!==row.journal_sha256)throw Error('binding');if(actor&&(row.local_staff_id!==actor.localStaffId||row.cloud_user_id!==actor.cloudUserId))throw fail(403,'CHECKIN_ACCOUNT_CHANGED','Reconnect the original staff accounts.');return{request,response};}catch(error){if(error.status===403)throw error;throw reconcile();}}
async function assertCheckinRequestNotCancelled(db,payload,actor){const row=await get(db,'SELECT * FROM native_checkin_cancellations WHERE request_id=?',[payload.requestId]);if(!row)return;const saved=validateRow(row,actor);if(canonicalSession(saved.request)!==canonicalSession(payload))throw fail(409,'CHECKIN_REQUEST_CONFLICT','This request ID belongs to a different original check-in.');throw fail(409,'CHECKIN_REQUEST_CANCELLED','This original check-in was cancelled. Start a new request.');}
function createCheckinCancellation(dbPath,{resolveActor,isActorCurrent,cancelCheckin,ready}={}){
 const changed=()=>fail(403,'CHECKIN_ACCOUNT_CHANGED','Reconnect the original staff accounts before cancellation.');
 const guard=createNativeActorGuard({resolveActor,isActorCurrent},changed);
 async function transaction(fn){let db,begun=false;try{db=await new Promise((resolve,reject)=>{const c=new sqlite3.Database(dbPath,sqlite3.OPEN_READWRITE,e=>e?reject(e):resolve(c));});db.configure('busyTimeout',5000);await run(db,'BEGIN IMMEDIATE');begun=true;await initializeCheckinCancellationSchema(db);const result=await fn(db);await run(db,'COMMIT');begun=false;return result;}catch(error){if(begun)await run(db,'ROLLBACK').catch(()=>{});if(error.status)throw error;throw fail(503,'CHECKIN_CANCELLATION_UNCONFIRMED','Cancellation could not be saved. Keep the original pending request and retry.');}finally{if(db)await new Promise(resolve=>db.close(resolve));}}
 function original(row,actor){if(!row||row.local_staff_id!==actor.localStaffId||row.cloud_user_id!==actor.cloudUserId)throw changed();try{const payload=validateRequest(JSON.parse(row.request_json));if(payload.requestId!==row.request_id||payload.id!==row.reservation_id||payload.tableId!==row.table_id||payload.deviceId!==row.device_id||payload.expectedStaffId!==row.cloud_user_id||hash(payload)!==row.request_fingerprint)throw Error('binding');if(row.phase!=='prepared'){const claim=JSON.parse(row.claim_json);validateCheckinClaimResult({claim,replayed:true,recordType:'reservation-check-in-claim',fundsTransferred:false},payload);if(claim.claimId!==row.claim_id)throw Error('claim');}return payload;}catch{throw reconcile();}}
 const claimed=row=>({requestId:row.request_id,cancelled:false,phase:row.phase,claimId:row.claim_id});
 async function cancel(token,input){
  const fields=['requestId','id','tableId','expectedRevision','expectedStaffId','expectedOvertimeRate'];
  const full=input&&Object.keys(input).length===6&&fields.every(key=>Object.hasOwn(input,key));
  if(!input||Array.isArray(input)||(!full&&Object.keys(input).length!==1)||!uuid(input.requestId)||(full&&(!uuid(input.expectedStaffId)||!['id','tableId'].every(key=>typeof input[key]==='string'&&input[key].trim()===input[key]&&input[key].length>0&&input[key].length<=120)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||input.expectedRevision>=Number.MAX_SAFE_INTEGER||typeof input.expectedOvertimeRate!=='number'||!Number.isFinite(input.expectedOvertimeRate)||input.expectedOvertimeRate<=0||input.expectedOvertimeRate>5000||Number(input.expectedOvertimeRate.toFixed(2))!==input.expectedOvertimeRate)))throw fail(400,'INVALID_CHECKIN_CANCELLATION','Choose the original check-in request.');
  const requestId=input.requestId,provided=full?Object.fromEntries(fields.map(key=>[key,input[key]])):null;
  await ready;const actor=await guard.resolve(token,provided?.expectedStaffId);
  const initial=await transaction(async db=>{
   const device=await get(db,'SELECT device_id FROM native_checkin_device WHERE singleton=1');
   const supplied=provided?validateRequest({requestId,id:provided.id,tableId:provided.tableId,expectedRevision:provided.expectedRevision,expectedStaffId:provided.expectedStaffId,deviceId:device?.device_id}):null;
   const saved=await get(db,'SELECT * FROM native_checkin_cancellations WHERE request_id=?',[requestId]);
   if(saved){const result=validateRow(saved,actor);if(supplied&&canonicalSession(supplied)!==canonicalSession(result.request))throw fail(409,'CHECKIN_REQUEST_CONFLICT','Use the exact original check-in request.');guard.assertCurrent(token,actor);return{response:{...result.response,replayed:true}};}
   const row=await get(db,'SELECT * FROM native_checkin_operations WHERE request_id=?',[requestId]);
   if(!row){if(!supplied)throw fail(404,'CHECKIN_NOT_FOUND','The original check-in was not found. Supply its saved original command to reconcile cancellation.');guard.assertCurrent(token,actor);return{payload:supplied};}
   const payload=original(row,actor);if(supplied&&canonicalSession(supplied)!==canonicalSession(payload))throw fail(409,'CHECKIN_REQUEST_CONFLICT','Use the exact original check-in request.');guard.assertCurrent(token,actor);
   return row.phase==='prepared'?{payload}:{response:claimed(row)};
  });
  if(initial.response)return initial.response;
  if(typeof cancelCheckin!=='function')throw fail(503,'CHECKIN_CANCELLATION_UNAVAILABLE','Reconnect cloud staff before cancelling this request.');
  const received=await cancelCheckin(token,initial.payload),accepted=received?.recordType==='reservation-check-in-claim';
  const response=JSON.parse(JSON.stringify(accepted?validateCheckinClaimResult(received,initial.payload):validateCheckinCancellationResult(received,initial.payload)));
  const refreshed=await guard.resolve(token);if(canonicalSession(actor)!==canonicalSession(refreshed))throw changed();
  return transaction(async db=>{
   const saved=await get(db,'SELECT * FROM native_checkin_cancellations WHERE request_id=?',[requestId]);
   if(saved){if(accepted)throw reconcile();const result=validateRow(saved,actor);if(canonicalSession(result.request)!==canonicalSession(initial.payload))throw reconcile();guard.assertCurrent(token,actor);return{...result.response,replayed:true};}
   const row=await get(db,'SELECT * FROM native_checkin_operations WHERE request_id=?',[requestId]);
   const payload=row?original(row,actor):initial.payload;
   if(canonicalSession(payload)!==canonicalSession(initial.payload))throw reconcile();guard.assertCurrent(token,actor);
   if(accepted){
    if(!row){
     if(await get(db,'SELECT request_id FROM native_checkin_operations WHERE reservation_id=?',[payload.id]))throw reconcile();
     await run(db,"INSERT INTO native_checkin_operations(request_id,local_staff_id,cloud_user_id,device_id,reservation_id,table_id,request_fingerprint,request_json,phase,claim_id,claim_json,created_at) VALUES(?,?,?,?,?,?,?,?,'claimed',?,?,?)",[requestId,actor.localStaffId,actor.cloudUserId,payload.deviceId,payload.id,payload.tableId,hash(payload),JSON.stringify(payload),response.claim.claimId,JSON.stringify(response.claim),new Date().toISOString()]);
    }else if(row.phase==='prepared')await run(db,"UPDATE native_checkin_operations SET phase='claimed',claim_id=?,claim_json=? WHERE request_id=? AND phase='prepared'",[response.claim.claimId,JSON.stringify(response.claim),requestId]);
    else if(canonicalSession(JSON.parse(row.claim_json))!==canonicalSession(response.claim))throw reconcile();
    guard.assertCurrent(token,actor);return{requestId,cancelled:false,phase:!row||row.phase==='prepared'?'claimed':row.phase,claimId:response.claim.claimId};
   }
   if(row&&row.phase!=='prepared')throw reconcile();
   const cancelledAt=new Date().toISOString(),requestJson=canonicalSession(payload),responseJson=canonicalSession(response);
   await run(db,'INSERT INTO native_checkin_cancellations VALUES(?,1,?,?,?,?,?,?,?)',[requestId,actor.localStaffId,actor.cloudUserId,requestJson,hash(payload),responseJson,cancelledAt,hash({request:payload,response,localStaffId:actor.localStaffId,cloudUserId:actor.cloudUserId,cancelledAt})]);
   if(row){const deleted=await run(db,"DELETE FROM native_checkin_operations WHERE request_id=? AND phase='prepared' AND request_fingerprint=?",[requestId,hash(payload)]);if(deleted.changes!==1)throw reconcile();}
   guard.assertCurrent(token,actor);return response;
  });
 }

 return{cancel};
}
module.exports={initializeCheckinCancellationSchema,assertCheckinRequestNotCancelled,createCheckinCancellation};
