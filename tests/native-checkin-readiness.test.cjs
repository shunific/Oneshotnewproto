const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const sqlite3=require('sqlite3');
const {createCheckinCoordinator}=require('../server-checkin.cjs');
const run=(db,sql,args=[])=>new Promise((resolve,reject)=>db.run(sql,args,error=>error?reject(error):resolve()));
const all=(db,sql)=>new Promise((resolve,reject)=>db.all(sql,(error,rows)=>error?reject(error):resolve(rows)));

test('claim and admission snapshot caller input before asynchronous journal readiness or identity resolution',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'oneshot-checkin-readiness-'));
 const filename=path.join(directory,'qa.sqlite');
 const db=await new Promise((resolve,reject)=>{const conn=new sqlite3.Database(filename,error=>error?reject(error):resolve(conn));});
 t.after(async()=>{await new Promise(resolve=>db.close(resolve));await rm(directory,{recursive:true,force:true});});
 await run(db,'CREATE TABLE tables(id TEXT PRIMARY KEY,status TEXT,isActive INTEGER,sessionData TEXT)');
 await run(db,"INSERT INTO tables VALUES('a','available',1,NULL),('b','available',1,NULL)");
 await run(db,'CREATE TABLE systemSettings(keyName TEXT PRIMARY KEY,settingValue TEXT)');
 await run(db,"INSERT INTO systemSettings VALUES('overtimeRate','300')");
 const staff='11111111-1111-4111-8111-111111111111';
 const actor={localStaffId:'qa-cashier',cloudUserId:staff,generation:1};
 const dispatched=[];
 const service=createCheckinCoordinator(filename,{
  resolveActor:async()=>({...actor}),
  isActorCurrent:(_token,expected)=>expected.generation===actor.generation&&expected.localStaffId===actor.localStaffId&&expected.cloudUserId===actor.cloudUserId,
  claimCheckin:async(_token,payload)=>{
   dispatched.push(structuredClone(payload));
   return {claim:{
    claimId:randomUUID(),requestId:payload.requestId,reservationId:payload.id,
    actorUserId:staff,actorRole:'cashier',deviceId:payload.deviceId,tableId:payload.tableId,
    cloudTableId:'qa-cloud',ownerUserId:'22222222-2222-4222-8222-222222222222',
    sourceRevision:payload.expectedRevision,claimRevision:payload.expectedRevision+1,
    state:'claim-pending',customerName:'QA Readiness TEST ONLY',contactNumber:'09123456789',
    email:'qa@example.invalid',partySize:2,durationMinutes:120,bookingDate:'2026-10-19',timeSlot:'14:00',
    netTotalCents:27000,grossTotalCents:30000,discountCents:3000,requiredDepositCents:5400,verifiedPaidCents:5400,
   },replayed:false,recordType:'reservation-check-in-claim',fundsTransferred:false};
  },
 });
 const command={requestId:randomUUID(),id:'QA-readiness',expectedRevision:3,expectedStaffId:staff,tableId:'a'};
 const original=structuredClone(command);
 const claiming=service.claim('qa-token',command);
 Object.assign(command,{id:'mutated',tableId:'b',expectedRevision:99,requestId:randomUUID()});
 const claimed=await claiming;
 assert.equal(claimed.claim.reservationId,original.id);
 assert.deepEqual(dispatched[0],{...original,deviceId:dispatched[0].deviceId});
 const admission={requestId:original.requestId,expectedOvertimeRate:300};
 const admitting=service.admit('qa-token',admission);
 Object.assign(admission,{requestId:randomUUID(),expectedOvertimeRate:450});
 const admitted=await admitting;
 assert.equal(admitted.requestId,original.requestId);
 assert.equal(admitted.table.id,'a');
 assert.equal(admitted.table.session.overtimeRate,300);
 const rows=await all(db,'SELECT * FROM tables ORDER BY id');
 assert.equal(rows[0].status,'occupied');assert.equal(rows[1].status,'available');
 assert.equal((await all(db,'SELECT * FROM native_checkin_outbox')).length,1);
});
