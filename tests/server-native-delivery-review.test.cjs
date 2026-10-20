const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {withNativeDeviceFixture}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const {createNativeEventDelivery}=require('../server-native-delivery.cjs');
const {canonicalSession}=require('../server-session-identity.cjs');
const rows=(db,sql)=>new Promise((resolve,reject)=>db.all(sql,(e,r)=>e?reject(e):resolve(r)));
function delivery(f,{replayed=false}={}){
 let network=0;const signer=f.makeSigner();
 const service=createNativeEventDelivery(f.file,{
  resolveActor:async()=>({...f.context}),
  isActorCurrent:(_token,a)=>f.context.active&&a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation,
  signEvent:(token,command)=>signer.sign(token,command),
  sendSignedEvent:async(_token,e)=>{network++;const p=JSON.parse(e.payload);return{
   ack:{eventId:e.eventId,eventType:e.eventType,claimId:e.claimId,deviceId:e.deviceId,reservationId:p.reservationId,payloadSha256:createHash('sha256').update(e.payload,'utf8').digest('hex'),state:e.eventType==='admission'?'checked-in':'completed',revision:input.result.claim.claimRevision+(e.eventType==='admission'?1:2),receiptId:e.eventType==='admission'?null:p.receipt.id,receivedAt:'2026-10-19T12:00:00.123Z',acceptedBy:replayed?'22222222-2222-4222-8222-222222222222':e.actorId},
   replayed,recordType:'reservation-lifecycle-ack',fundsTransferred:false,
  };},
 });
 return{service,command:{eventType:'admission',eventId:f.admission.outboxEventId},network:()=>network};
}
test('persisted cloud replay acknowledgement metadata cannot change while retaining the same original event payload hash',async()=>withNativeDeviceFixture(input,async f=>{
 const d=delivery(f,{replayed:true});await d.service.deliver('qa-token',d.command);
 const row=(await rows(f.db,'SELECT * FROM native_event_deliveries'))[0],result=JSON.parse(row.response_json);
 result.ack.acceptedBy='88888888-8888-4888-8888-888888888888';
 await f.run('UPDATE native_event_deliveries SET response_json=?',[canonicalSession(result)]);
 await assert.rejects(d.service.deliver('qa-token',d.command),{status:409,code:'NATIVE_DELIVERY_RECONCILIATION_REQUIRED'});
 assert.equal(d.network(),1);
}));
test('persisted signed envelope cannot change its signature while retaining the same event payload',async()=>withNativeDeviceFixture(input,async f=>{
 const d=delivery(f);await d.service.deliver('qa-token',d.command);
 const row=(await rows(f.db,'SELECT * FROM native_event_deliveries'))[0],envelope=JSON.parse(row.envelope_json);
 envelope.signature='0'.repeat(64);
 await f.run('UPDATE native_event_deliveries SET envelope_json=?',[canonicalSession(envelope)]);
 await assert.rejects(d.service.deliver('qa-token',d.command),{status:409,code:'NATIVE_DELIVERY_RECONCILIATION_REQUIRED'});
 assert.equal(d.network(),1);
}));
test('async private-credential cleanup rejection is observed without exposing an unhandled provider diagnostic',()=>{
 const {execFileSync}=require('node:child_process');
 const bridge=require.resolve('../security/native-device-cross-contract.cjs'),fixture=require.resolve('./native-device-proof-fixture.cjs');
 const script=`const {withNativeDeviceFixture}=require(${JSON.stringify(bridge)});const input=require(${JSON.stringify(fixture)});(async()=>{let unhandled=0;process.on('unhandledRejection',()=>{unhandled++;});await withNativeDeviceFixture(input,async f=>{const signer=f.makeSigner({loadDeviceKey:async deviceId=>({deviceId,keyId:f.keyId,key:f.key,dispose:async()=>{throw Error('synthetic private cleanup diagnostic');}})});await signer.sign('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});await new Promise(setImmediate);});process.stdout.write(JSON.stringify({unhandled}));})().catch(()=>{process.exitCode=1;});`;
 const result=JSON.parse(execFileSync(process.execPath,['-e',script],{encoding:'utf8'}));
 assert.equal(result.unhandled,0);
});
test('same-user generation change during asynchronous private-key cleanup cannot release a prepared proof',async()=>withNativeDeviceFixture(input,async f=>{
 const signer=f.makeSigner({loadDeviceKey:async deviceId=>({deviceId,keyId:f.keyId,key:f.key,dispose:async()=>{await new Promise(setImmediate);f.context.generation++;}})});
 await assert.rejects(signer.sign('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId}),{status:403,code:'DEVICE_PROOF_ACCOUNT_CHANGED'});
 assert.equal((await rows(f.db,'SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,null);
}));
