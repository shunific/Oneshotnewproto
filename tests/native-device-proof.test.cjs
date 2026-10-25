const test=require('node:test'),assert=require('node:assert/strict');
const {createHmac,createHash}=require('node:crypto');
const {withNativeDeviceFixture,runNativeDeviceCrossContract}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const rows=(db,sql)=>new Promise((resolve,reject)=>db.all(sql,(e,r)=>e?reject(e):resolve(r)));
test('actual native admission and HTTP checkout events sign stable exact UTF8 envelopes without exposing the synthetic key',async()=>{
 const proof=await runNativeDeviceCrossContract(input);
 for(const [kind,envelope] of Object.entries(proof)){
  assert.equal(Object.keys(envelope).length,9);assert.equal(envelope.version,1);assert.equal(envelope.keyId,input.keyId);assert.equal(envelope.deviceId,input.command.deviceId);assert.equal(envelope.actorId,input.command.expectedStaffId);
  const digest=createHash('sha256').update(envelope.payload,'utf8').digest('hex');
  const message='oneshot-native-event-v1\n'+input.keyId+'\n'+envelope.deviceId+'\n'+envelope.actorId+'\n'+envelope.eventType+'\n'+envelope.eventId+'\n'+envelope.claimId+'\n'+digest;
  assert.equal(envelope.signature,createHmac('sha256',Buffer.from(input.keyHex,'hex')).update(message,'utf8').digest('hex'));
  assert.equal(JSON.stringify(envelope).includes(input.keyHex),false);assert.equal(JSON.parse(envelope.payload).type,kind==='admission'?'admission':'reservation-completion');
 }
});
test('caller cannot supply a body, actor, key or device and the command is copied before awaiting identity',async()=>withNativeDeviceFixture(input,async f=>{
 let keyReads=0;const signer=f.makeSigner({loadDeviceKey:async deviceId=>{keyReads++;return{deviceId,keyId:f.keyId,key:f.key};}});
 const command={eventType:'admission',eventId:f.admission.outboxEventId};
 for(const field of ['payload','actorId','deviceId','key','keyId'])await assert.rejects(signer.sign('qa-token',{...command,[field]:'forged'}),{status:400});assert.equal(keyReads,0);
 let resume,calls=0;const delayed=f.makeSigner({resolveActor:async()=>{if(++calls===1)await new Promise(resolve=>{resume=resolve;});return {...f.context};}});
 const pending=delayed.sign('qa-token',command);command.eventId='88888888-8888-4888-8888-888888888888';resume();
 const signed=await pending;assert.equal(signed.eventId,f.admission.outboxEventId);assert.equal(calls,2);
}));
test('same-user generation change or cashier shift during private key lookup cannot return signed proof',async()=>{
 for(const change of [c=>c.generation++,c=>c.localStaffId='new-shift',c=>c.cloudUserId='88888888-8888-4888-8888-888888888888'])await withNativeDeviceFixture(input,async f=>{
  const signer=f.makeSigner({loadDeviceKey:async deviceId=>{change(f.context);return{deviceId,keyId:f.keyId,key:f.key};}});
  await assert.rejects(signer.sign('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId}),{status:403,code:'DEVICE_PROOF_ACCOUNT_CHANGED'});
  assert.equal((await rows(f.db,'SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,null);
 });
});
test('unavailable or mismatched private key leaves the original event pending',async()=>{
 for(const value of [null,{deviceId:input.command.deviceId,keyId:input.keyId,key:Buffer.alloc(31)},{deviceId:'88888888-8888-4888-8888-888888888888',keyId:input.keyId,key:Buffer.alloc(32)}])await withNativeDeviceFixture(input,async f=>{
  const signer=f.makeSigner({loadDeviceKey:async()=>value});await assert.rejects(signer.sign('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId}),{code:'DEVICE_KEY_UNAVAILABLE'});
  assert.equal((await rows(f.db,'SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,null);
 });
});
test('changed stored admission/device bindings reject before reading a private key',async()=>{
 for(const sql of ["UPDATE native_checkin_outbox SET payload_json='{}'","UPDATE native_checkin_device SET device_id='88888888-8888-4888-8888-888888888888'"])await withNativeDeviceFixture(input,async f=>{
  await f.run(sql);let reads=0;const signer=f.makeSigner({loadDeviceKey:async()=>{reads++;return null;}});await assert.rejects(signer.sign('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId}),{code:'DEVICE_EVENT_RECONCILIATION_REQUIRED'});assert.equal(reads,0);
 });
});
test('completion proof verifies archived receipt/event after checkout without touching a reused table',async()=>withNativeDeviceFixture(input,async f=>{
 const closed=await f.checkout();await f.run("UPDATE tables SET status='occupied',sessionData='new customer'");
 const command={eventType:'reservation-completion',eventId:closed.reservationCompletion.eventId};const signer=f.makeSigner();const first=await signer.sign('qa-token',command),retry=await signer.sign('qa-token',command);assert.deepEqual(first,retry);
 assert.equal((await rows(f.db,'SELECT sessionData FROM tables'))[0].sessionData,'new customer');assert.equal((await rows(f.db,'SELECT delivered_at FROM native_reservation_completion_outbox'))[0].delivered_at,null);
 await f.run("UPDATE checkout_operations SET request_fingerprint='{}'");await assert.rejects(signer.sign('qa-token',command),{code:'DEVICE_EVENT_RECONCILIATION_REQUIRED'});
}));
test('acknowledged event cannot be signed as a new pending delivery',async()=>withNativeDeviceFixture(input,async f=>{
 await f.run("UPDATE native_checkin_outbox SET delivered_at='2026-10-19T12:00:00Z'");await assert.rejects(f.makeSigner().sign('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId}),{code:'DEVICE_EVENT_ALREADY_ACKNOWLEDGED'});
}));

test('provider key leases are disposed on success, invalid metadata and changed identity',async()=>{
 for(const mode of ['success','invalid','changed'])await withNativeDeviceFixture(input,async f=>{
  const lease=Buffer.from(f.key);let disposals=0;
  const signer=f.makeSigner({loadDeviceKey:async deviceId=>{
   if(mode==='changed')f.context.generation++;
   return{deviceId,keyId:mode==='invalid'?'bad':f.keyId,key:lease,dispose(){disposals++;lease.fill(0);}};
  }});
  const operation=signer.sign('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});
  if(mode==='success')assert.equal((await operation).eventId,f.admission.outboxEventId);
  else await assert.rejects(operation,{code:mode==='invalid'?'DEVICE_KEY_UNAVAILABLE':'DEVICE_PROOF_ACCOUNT_CHANGED'});
  assert.equal(disposals,1);assert.ok(lease.every(byte=>byte===0));assert.ok(f.key.some(byte=>byte!==0));
 });
});
test('key-free delivered replay reader still verifies original admission integrity',async()=>withNativeDeviceFixture(input,async f=>{
 const {readStoredNativeEvent}=require('../server-device-proof.cjs');
 await f.run("UPDATE native_checkin_outbox SET delivered_at='2026-10-19T12:00:00.000Z'");
 const command={eventType:'admission',eventId:f.admission.outboxEventId};
 const original=await readStoredNativeEvent(f.file,command,{allowDelivered:true});
 assert.equal(original.deliveredAt,'2026-10-19T12:00:00.000Z');assert.equal(JSON.parse(original.payload).overtimeRateCents,30000);
 await f.run("UPDATE native_checkin_outbox SET payload_json='{}'");
 await assert.rejects(readStoredNativeEvent(f.file,command,{allowDelivered:true}),{code:'DEVICE_EVENT_RECONCILIATION_REQUIRED'});
}));
