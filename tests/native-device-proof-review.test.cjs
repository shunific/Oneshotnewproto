const test=require('node:test'),assert=require('node:assert/strict');
const {createHash,createHmac}=require('node:crypto');
const {withNativeDeviceFixture}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const rows=(db,sql)=>new Promise((resolve,reject)=>db.all(sql,(e,r)=>e?reject(e):resolve(r)));
function message(e){return ['oneshot-native-event-v1',e.keyId,e.deviceId,e.actorId,e.eventType,e.eventId,e.claimId,createHash('sha256').update(e.payload,'utf8').digest('hex')].join('\n');}

test('signer captures private key bytes and key ID before later identity awaits can mutate provider-owned objects',async()=>withNativeDeviceFixture(input,async f=>{
 const original=Buffer.from(f.key),credential={deviceId:input.command.deviceId,keyId:f.keyId,key:f.key};let identities=0;
 const signer=f.makeSigner({
  loadDeviceKey:async()=>credential,
  resolveActor:async()=>{if(++identities===2){f.key.fill(0x7a);credential.keyId='99999999-9999-4999-8999-999999999999';}return {...f.context};},
 });
 try{
  const signed=await signer.sign('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});
  assert.equal(signed.keyId,input.keyId);
  assert.equal(signed.signature,createHmac('sha256',original).update(message(signed),'utf8').digest('hex'));
  assert.equal(Object.isFrozen(signed),true);
 }finally{original.fill(0);}
}));

test('corrupted archived receipt prevents completion proof before any private-key access',async()=>withNativeDeviceFixture(input,async f=>{
 const closed=await f.checkout();await f.run('UPDATE e_receipts SET total_amount=total_amount+1');
 const before=await rows(f.db,'SELECT * FROM native_reservation_completion_outbox');let keyReads=0;
 const signer=f.makeSigner({loadDeviceKey:async()=>{keyReads++;throw Error('should not read');}});
 await assert.rejects(signer.sign('qa-token',{eventType:'reservation-completion',eventId:closed.reservationCompletion.eventId}),{code:'DEVICE_EVENT_RECONCILIATION_REQUIRED'});
 assert.equal(keyReads,0);assert.deepEqual(await rows(f.db,'SELECT * FROM native_reservation_completion_outbox'),before);
}));

test('key provider failure does not expose its secret error text or modify pending delivery',async()=>withNativeDeviceFixture(input,async f=>{
 const signer=f.makeSigner({loadDeviceKey:async()=>{throw Error('private: '+input.keyHex+' qa-token');}});
 await assert.rejects(signer.sign('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId}),error=>{
  assert.equal(error.code,'DEVICE_KEY_UNAVAILABLE');assert.equal(error.status,503);
  assert.equal(JSON.stringify(error).includes(input.keyHex),false);assert.equal(error.message.includes('qa-token'),false);return true;
 });
 assert.equal((await rows(f.db,'SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,null);
}));

test('renderer table identity injection rejects before checkout and the original reservation still produces valid completion proof',async()=>withNativeDeviceFixture(input,async f=>{
 const originalFetch=global.fetch;let rejectedStatus;
 try{
  global.fetch=async(url,options)=>{
   if(String(url).endsWith('/checkout')){
    const response=await originalFetch(url,{...options,body:JSON.stringify({...JSON.parse(options.body),tableId:'forged-other-table'})});
    rejectedStatus=response.status;return response;
   }
   return originalFetch(url,options);
  };
  await assert.rejects(f.checkout(),error=>error.code==='ERR_ASSERTION');
 }finally{global.fetch=originalFetch;}
 assert.equal(rejectedStatus,400);
 assert.equal((await rows(f.db,'SELECT * FROM e_receipts')).length,0);
 assert.equal((await rows(f.db,'SELECT status FROM tables'))[0].status,'occupied');
 const closed=await f.checkout();
 const signed=await f.makeSigner().sign('qa-token',{eventType:'reservation-completion',eventId:closed.reservationCompletion.eventId});
 const payload=JSON.parse(signed.payload);
 assert.equal(payload.checkoutTableId,input.command.tableId);
 assert.equal(payload.receipt.table_id,input.command.tableId);
 assert.equal((await rows(f.db,'SELECT * FROM native_reservation_completion_outbox')).length,1);
 assert.equal(signed.signature,createHmac('sha256',f.key).update(message(signed),'utf8').digest('hex'));
}));
