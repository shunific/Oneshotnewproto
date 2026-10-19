const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const sqlite3 = require('sqlite3');
const { createCheckinCoordinator } = require('../server-checkin.cjs');
const STAFF='11111111-1111-4111-8111-111111111111',OWNER='22222222-2222-4222-8222-222222222222';
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,error=>error?reject(error):resolve()));
const all=(db,sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(error,rows)=>error?reject(error):resolve(rows)));
async function fixture(t) {
 const folder=await mkdtemp(path.join(os.tmpdir(),'oneshot-native-checkin-')),filename=path.join(folder,'qa.db');
 const db=await new Promise((resolve,reject)=>{const c=new sqlite3.Database(filename,error=>error?reject(error):resolve(c));});
 await run(db,'CREATE TABLE tables(id TEXT PRIMARY KEY,name TEXT,status TEXT,isActive INTEGER,sessionData TEXT)');
 await run(db,"INSERT INTO tables VALUES('a','QA A','available',1,NULL),('b','QA B','available',1,NULL)");
 await run(db,'CREATE TABLE systemSettings(keyName TEXT PRIMARY KEY,settingValue TEXT)');await run(db,"INSERT INTO systemSettings VALUES('overtimeRate','300')");
 t.after(async()=>{await new Promise(resolve=>db.close(resolve));await rm(folder,{recursive:true,force:true});});
 const command={requestId:randomUUID(),id:'QA-reservation',tableId:'a',expectedRevision:3,expectedStaffId:STAFF};
 const context={localStaffId:'local-cashier',cloudUserId:STAFF,active:true,generation:1,token:'local-token',calls:[],logicalClaims:new Map(),loseCloudAck:false,onCloud:null};
 const options={resolveActor:async token=>token===context.token&&context.active?{localStaffId:context.localStaffId,cloudUserId:context.cloudUserId,generation:context.generation}:null,
  isActorCurrent:(token,expected)=>context.active&&token===context.token&&context.localStaffId===expected.localStaffId&&context.cloudUserId===expected.cloudUserId&&context.generation===expected.generation,
  claimCheckin:async(token,payload)=>{
   const persisted=(await all(db,'SELECT * FROM native_checkin_operations WHERE request_id=?',[payload.requestId]))[0];
   assert.equal(persisted.phase,'prepared');assert.deepEqual(JSON.parse(persisted.request_json),payload);assert.ok(!persisted.request_json.includes('local-token'));
   context.calls.push(structuredClone(payload));let saved=context.logicalClaims.get(payload.requestId);
   const replayed=!!saved;
   if(!saved){saved={claimId:randomUUID(),requestId:payload.requestId,reservationId:payload.id,actorUserId:STAFF,actorRole:'cashier',deviceId:payload.deviceId,tableId:payload.tableId,cloudTableId:'cloud-table',ownerUserId:OWNER,sourceRevision:3,claimRevision:4,state:'claim-pending',customerName:'QA Native Claim TEST ONLY',contactNumber:'09123456789',email:'customer@example.invalid',partySize:2,durationMinutes:120,bookingDate:'2026-10-19',timeSlot:'14:00',netTotalCents:27000,grossTotalCents:30000,discountCents:3000,requiredDepositCents:5400,verifiedPaidCents:5400};context.logicalClaims.set(payload.requestId,saved);}
   if(context.onCloud)await context.onCloud(payload,saved);
   if(context.loseCloudAck){context.loseCloudAck=false;throw Object.assign(Error('Synthetic lost cloud ACK'),{status:503,code:'CLOUD_UNAVAILABLE'});}
   return {claim:structuredClone(saved),replayed,recordType:'reservation-check-in-claim',fundsTransferred:false};
  }};
 const service=createCheckinCoordinator(filename,options);await service.ready;
 return {db,context,command,service,restart:()=>createCheckinCoordinator(filename,options),rows:table=>all(db,'SELECT * FROM '+table),admit:()=>service.admit(context.token,{requestId:command.requestId,expectedOvertimeRate:300}),claim:()=>service.claim(context.token,command)};
}
test('claim intent is durable before RPC; admission atomically preserves exact quote, credit and pending ACK',async t=>{
 const f=await fixture(t);const claimed=await f.claim();assert.equal(claimed.phase,'claimed');assert.equal((await f.rows('tables'))[0].status,'available');
 const saved=await f.admit(),session=saved.table.session;
 assert.equal(session.amountPaid,54);assert.equal(session.hourlyRate,null);assert.equal(session.reservationPricing.grossCents,30000);assert.equal(session.reservationPricing.discountCents,3000);assert.equal(session.reservationPricing.netCents,27000);assert.equal(session.reservationPricing.verifiedPaidCents,5400);
 assert.equal(session.reservationId,f.command.id);assert.equal(saved.cloudAcknowledged,false);assert.equal((await f.rows('native_checkin_outbox')).length,1);
 assert.equal((await f.rows('native_checkin_operations'))[0].phase,'admitted');assert.equal(f.context.logicalClaims.size,1);
});
test('lost cloud acknowledgement survives restart with the exact original operation and device identity',async t=>{
 const f=await fixture(t);f.context.loseCloudAck=true;await assert.rejects(f.claim(),{code:'CLOUD_UNAVAILABLE'});
 assert.equal((await f.rows('native_checkin_operations'))[0].phase,'prepared');const first=f.context.calls[0];
 const restarted=f.restart();await restarted.ready;f.context.token='fresh-local-token';const recovered=await restarted.claim(f.context.token,f.command);
 assert.equal(recovered.phase,'claimed');assert.equal(recovered.replayed,true);assert.deepEqual(f.context.calls[1],first);assert.equal(f.context.logicalClaims.size,1);
});
test('failure saving returned claim leaves committed cloud request recoverable',async t=>{
 const f=await fixture(t);await run(f.db,"CREATE TRIGGER reject_claim BEFORE UPDATE ON native_checkin_operations WHEN NEW.phase='claimed' BEGIN SELECT RAISE(ABORT,'synthetic failed disk'); END");
 await assert.rejects(f.claim(),{code:'CHECKIN_STORAGE_UNAVAILABLE'});assert.equal((await f.rows('native_checkin_operations'))[0].phase,'prepared');assert.equal(f.context.logicalClaims.size,1);
 await run(f.db,'DROP TRIGGER reject_claim');await f.claim();assert.equal(f.context.calls.length,2);assert.deepEqual(f.context.calls[0],f.context.calls[1]);
});
test('late admission outbox failure rolls back session and phase; exact retry commits once',async t=>{
 const f=await fixture(t);await f.claim();await run(f.db,"CREATE TRIGGER reject_event BEFORE INSERT ON native_checkin_outbox BEGIN SELECT RAISE(ABORT,'synthetic outbox failure'); END");
 await assert.rejects(f.admit(),{code:'CHECKIN_STORAGE_UNAVAILABLE'});assert.equal((await f.rows('tables'))[0].status,'available');assert.equal((await f.rows('native_checkin_operations'))[0].phase,'claimed');assert.equal((await f.rows('native_checkin_outbox')).length,0);
 await run(f.db,'DROP TRIGGER reject_event');const saved=await f.admit();assert.equal(saved.phase,'admitted');assert.equal((await f.rows('native_checkin_outbox')).length,1);
});
test('concurrent admission and restart replay create one session and one outbox record',async t=>{
 const f=await fixture(t);await f.claim();const results=await Promise.all([f.admit(),f.admit()]);assert.deepEqual(results.map(x=>x.replayed).sort(),[false,true]);
 const restarted=f.restart();await restarted.ready;assert.equal((await restarted.admit(f.context.token,{requestId:f.command.requestId,expectedOvertimeRate:300})).replayed,true);
 assert.equal((await f.rows('native_checkin_outbox')).length,1);assert.equal(f.context.calls.length,1);
});
test('stale rate requires review without a second cloud claim; occupied table never overwritten',async t=>{
 const f=await fixture(t);await f.claim();await run(f.db,"UPDATE systemSettings SET settingValue='450' WHERE keyName='overtimeRate'");
 await assert.rejects(f.admit(),{code:'CHECKIN_RATE_CHANGED'});assert.equal((await f.rows('native_checkin_operations'))[0].phase,'claimed');
 await run(f.db,"UPDATE tables SET status='occupied',sessionData='other-session' WHERE id='a'");
 await assert.rejects(f.service.admit(f.context.token,{requestId:f.command.requestId,expectedOvertimeRate:450}),{code:'CHECKIN_TABLE_UNAVAILABLE'});
 assert.equal((await f.rows('tables'))[0].sessionData,'other-session');await run(f.db,"UPDATE tables SET status='available',sessionData=NULL WHERE id='a'");
 assert.equal((await f.service.admit(f.context.token,{requestId:f.command.requestId,expectedOvertimeRate:450})).table.session.overtimeRate,450);assert.equal(f.context.calls.length,1);
 await assert.rejects(f.admit(),{code:'CHECKIN_REQUEST_CONFLICT'});
});
test('changed command, repeated booking or another local/cloud actor cannot reuse a durable intent',async t=>{
 const f=await fixture(t);await f.claim();
 await assert.rejects(f.service.claim(f.context.token,{...f.command,tableId:'b'}),{code:'CHECKIN_REQUEST_CONFLICT'});
 await assert.rejects(f.service.claim(f.context.token,{...f.command,requestId:randomUUID()}),{code:'CHECKIN_ALREADY_PENDING'});
 f.context.localStaffId='other-local';await assert.rejects(f.claim(),{code:'CHECKIN_ACCOUNT_CHANGED'});
 f.context.localStaffId='local-cashier';f.context.cloudUserId=OWNER;await assert.rejects(f.claim(),{code:'CHECKIN_ACCOUNT_CHANGED'});assert.equal(f.context.calls.length,1);
});
test('logout while cloud response is in flight leaves the original intent without exposing a claim',async t=>{
 const f=await fixture(t);f.context.onCloud=async()=>{f.context.active=false;};await assert.rejects(f.claim(),{code:'CHECKIN_ACCOUNT_CHANGED'});
 assert.equal((await f.rows('native_checkin_operations'))[0].phase,'prepared');assert.equal((await f.rows('tables'))[0].status,'available');
 f.context.active=true;f.context.onCloud=null;assert.equal((await f.claim()).phase,'claimed');assert.equal(f.context.logicalClaims.size,1);
});
test('new intent failure never dispatches cloud and malformed admissions never collect credit',async t=>{
 const f=await fixture(t);await run(f.db,"CREATE TRIGGER reject_prepare BEFORE INSERT ON native_checkin_operations BEGIN SELECT RAISE(ABORT,'synthetic prepare failure'); END");
 await assert.rejects(f.claim(),{code:'CHECKIN_STORAGE_UNAVAILABLE'});assert.equal(f.context.calls.length,0);
 for(const expectedOvertimeRate of [0,-1,300.001,'300',6000])await assert.rejects(f.service.admit(f.context.token,{requestId:f.command.requestId,expectedOvertimeRate}),{code:'INVALID_CHECKIN_ADMISSION'});
 assert.equal((await f.rows('native_checkin_operations')).length,0);
});
test('stored corrupted claim cannot be returned or admitted as financial authority',async t=>{
 const f=await fixture(t);await f.claim();const row=(await f.rows('native_checkin_operations'))[0],claim=JSON.parse(row.claim_json);claim.verifiedPaidCents=999999;
 await run(f.db,'UPDATE native_checkin_operations SET claim_json=?',[JSON.stringify(claim)]);
 await assert.rejects(f.claim(),{code:'CLOUD_RESPONSE_INVALID'});await assert.rejects(f.admit(),{code:'CLOUD_RESPONSE_INVALID'});
 assert.equal((await f.rows('tables'))[0].status,'available');assert.equal((await f.rows('native_checkin_outbox')).length,0);
});
test('admission replay cannot occupy a table reused by a different customer',async t=>{
 const f=await fixture(t);await f.claim();const original=await f.admit();await run(f.db,"UPDATE tables SET status='occupied',sessionData='replacement-customer' WHERE id='a'");
 const replay=await f.admit();assert.equal(replay.outboxEventId,original.outboxEventId);assert.equal(replay.replayed,true);assert.equal((await f.rows('tables'))[0].sessionData,'replacement-customer');
});

test('weak pre-existing journal schema fails before creating or rewriting authority records',async t=>{
 const folder=await mkdtemp(path.join(os.tmpdir(),'oneshot-checkin-schema-')),filename=path.join(folder,'qa.db');
 const db=new sqlite3.Database(filename);t.after(async()=>{await new Promise(resolve=>db.close(resolve));await rm(folder,{recursive:true,force:true});});
 await run(db,'CREATE TABLE native_checkin_device(singleton INTEGER PRIMARY KEY,device_id TEXT)');
 await run(db,"INSERT INTO native_checkin_device VALUES(1,'legacy-device-value')");
 const service=createCheckinCoordinator(filename,{resolveActor:async()=>null,isActorCurrent:()=>false,claimCheckin:async()=>{throw Error('must not call cloud');}});
 await assert.rejects(service.ready,{code:'CHECKIN_SCHEMA_RECONCILIATION_REQUIRED'});
 assert.deepEqual(await all(db,'SELECT * FROM native_checkin_device'),[{singleton:1,device_id:'legacy-device-value'}]);
 assert.equal((await all(db,"SELECT name FROM sqlite_master WHERE type='table'")).length,1);
});

test('same-user reconnect changes generation and cannot adopt the old in-flight response',async t=>{
 const f=await fixture(t);f.context.onCloud=async()=>{f.context.generation++;};await assert.rejects(f.claim(),{code:'CHECKIN_ACCOUNT_CHANGED'});
 assert.equal((await f.rows('native_checkin_operations'))[0].phase,'prepared');f.context.onCloud=null;assert.equal((await f.claim()).phase,'claimed');assert.equal(f.context.logicalClaims.size,1);
});
test('corrupted denormalized table binding cannot redirect admission to another table',async t=>{
 const f=await fixture(t);await f.claim();await run(f.db,"UPDATE native_checkin_operations SET table_id='b'");
 await assert.rejects(f.admit(),{code:'CHECKIN_RECONCILIATION_REQUIRED'});assert.ok((await f.rows('tables')).every(t=>t.status==='available'));
});
test('corrupted saved admission or missing outbox is not acknowledged as a valid replay',async t=>{
 const f=await fixture(t);await f.claim();await f.admit();const row=(await f.rows('native_checkin_operations'))[0],saved=JSON.parse(row.response_json);saved.table.session.amountPaid=999;
 await run(f.db,'UPDATE native_checkin_operations SET response_json=?',[JSON.stringify(saved)]);await assert.rejects(f.admit(),{code:'CHECKIN_RECONCILIATION_REQUIRED'});
 await run(f.db,'UPDATE native_checkin_operations SET response_json=?',[row.response_json]);await run(f.db,'DELETE FROM native_checkin_outbox');await assert.rejects(f.admit(),{code:'CHECKIN_RECONCILIATION_REQUIRED'});
});
