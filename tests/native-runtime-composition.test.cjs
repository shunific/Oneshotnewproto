const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {access}=require('node:fs/promises');
const path=require('node:path');
const {withNativeDeviceFixture}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const {readNativeDeviceId}=require('../electron/native-device-id.cjs');
const {createNativeReservationRuntime}=require('../server-native-runtime.cjs');
const rows=(db,sql)=>new Promise((resolve,reject)=>db.all(sql,(e,v)=>e?reject(e):resolve(v)));
function composition(f,send){
 let local=true,keyReads=0,disposals=0;
 const auth={resolveSessionActor:async()=>local?{localStaffId:f.context.localStaffId}:null,isSessionCurrent:(_token,id)=>local&&f.context.active&&id===f.context.localStaffId};
 const cloudStaff={resolveNativeActor:async()=>({cloudUserId:f.context.cloudUserId,generation:f.context.generation}),isNativeActorCurrent:(_token,a)=>f.context.active&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation,claimCheckin:async()=>{throw Error('An existing admission must not claim again.');},ackNativeEvent:send};
 return{runtime:createNativeReservationRuntime(f.file,{auth,cloudStaff,loadDeviceKey:async deviceId=>{keyReads++;const key=Buffer.from(f.key);return{deviceId,keyId:f.keyId,key,dispose(){disposals++;key.fill(0);}};}}),logout:()=>local=false,counts:()=>({keyReads,disposals})};
}
const ack=envelope=>({ack:{eventId:envelope.eventId,eventType:envelope.eventType,claimId:envelope.claimId,deviceId:envelope.deviceId,reservationId:JSON.parse(envelope.payload).reservationId,payloadSha256:createHash('sha256').update(envelope.payload).digest('hex'),state:'checked-in',revision:input.result.claim.claimRevision+1,receiptId:null,receivedAt:new Date().toISOString(),acceptedBy:envelope.actorId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false});
test('host device resolver reads only the canonical persisted UUID and rejects unsupported schema or absent files without creating them',async()=>withNativeDeviceFixture(input,async f=>{
 assert.equal(await readNativeDeviceId(f.file),input.command.deviceId);
 await f.run('ALTER TABLE native_checkin_device ADD COLUMN unexpected TEXT');await assert.rejects(readNativeDeviceId(f.file),{code:'DEVICE_KEY_UNAVAILABLE'});
 const absent=path.join(path.dirname(f.file),'absent.sqlite');await assert.rejects(readNativeDeviceId(absent),{code:'DEVICE_KEY_UNAVAILABLE'});await assert.rejects(access(absent),{code:'ENOENT'});
}));
test('composed native runtime uses trusted local/cloud staff JWT authority without key access and preserves admission replay',async()=>withNativeDeviceFixture(input,async f=>{
 let calls=0;const c=composition(f,async(_token,envelope)=>{calls++;assert.equal(envelope.actorId,f.context.cloudUserId);assert.equal(envelope.version,2);assert.deepEqual(Object.keys(envelope).sort(),['version','deviceId','actorId','eventType','eventId','claimId','payload'].sort());return ack(envelope);});await c.runtime.ready;
 const admitted=await c.runtime.admit('qa-token',{requestId:input.command.requestId,expectedOvertimeRate:300});assert.equal(admitted.replayed,true);
 const event={eventType:'admission',eventId:f.admission.outboxEventId};assert.equal((await c.runtime.deliver('qa-token',event)).ack.state,'checked-in');assert.deepEqual(c.counts(),{keyReads:0,disposals:0});
 assert.equal((await c.runtime.deliver('qa-token',event)).replayed,true);assert.equal(calls,1);assert.deepEqual(c.counts(),{keyReads:0,disposals:0});
 assert.equal((await rows(f.db,'SELECT status FROM tables'))[0].status,'occupied');
}));
test('local logout or same-user cloud reconnect while receiving an ACK cannot adopt it under the previous native actor',async()=>{
 for(const mode of ['logout','reconnect'])await withNativeDeviceFixture(input,async f=>{
  let c;c=composition(f,async(_token,envelope)=>{const result=ack(envelope);if(mode==='logout')c.logout();else f.context.generation++;return result;});await c.runtime.ready;
  await assert.rejects(c.runtime.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId}),{status:403});
  assert.equal((await rows(f.db,'SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,null);assert.equal((await rows(f.db,'SELECT * FROM native_event_deliveries')).length,0);assert.deepEqual(c.counts(),{keyReads:0,disposals:0});
 });
});
