const path=require('node:path');
const assert=require('node:assert/strict');
const {createHash,createHmac}=require('node:crypto');
const {withNativeDeviceFixture}=require('./native-device-cross-contract.cjs');
const input=require('../tests/native-device-proof-fixture.cjs');
const root=process.env.ONESHOT_PROOF_PACKAGE_ARCHIVE||path.resolve(__dirname,'..');
const {createNativeEventDelivery}=require(path.join(root,'server-native-delivery.cjs'));
const digest=value=>createHash('sha256').update(value,'utf8').digest('hex');
const rows=(db,sql)=>new Promise((resolve,reject)=>db.all(sql,(error,result)=>error?reject(error):resolve(result)));
async function main(){return withNativeDeviceFixture(input,async f=>{
 const cloud=new Map(),lost=new Set();let cloudCalls=0,signCalls=0;
 const signer=f.makeSigner();
 const delivery=createNativeEventDelivery(f.file,{
  resolveActor:async()=>({...f.context}),
  isActorCurrent:(_,a)=>f.context.active&&a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation,
  signEvent:async(...args)=>{signCalls++;return signer.sign(...args);},
  sendSignedEvent:async(_,e)=>{
   cloudCalls++;const hash=digest(e.payload),body=JSON.parse(e.payload);
   const bytes=['oneshot-native-event-v1',e.keyId,e.deviceId,e.actorId,e.eventType,e.eventId,e.claimId,hash].join('\n');
   assert.equal(e.signature,createHmac('sha256',f.key).update(bytes,'utf8').digest('hex'));
   const prior=cloud.get(e.eventId);if(prior){assert.equal(prior.ack.payloadSha256,hash);return{...prior,replayed:true};}
   const result={ack:{eventId:e.eventId,eventType:e.eventType,claimId:e.claimId,deviceId:e.deviceId,reservationId:body.reservationId,payloadSha256:hash,state:e.eventType==='admission'?'checked-in':'completed',revision:input.result.claim.claimRevision+(e.eventType==='admission'?1:2),receiptId:e.eventType==='admission'?null:body.receipt.id,receivedAt:new Date().toISOString(),acceptedBy:e.actorId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false};
   cloud.set(e.eventId,result);
   if(!lost.has(e.eventId)){lost.add(e.eventId);throw Object.assign(new Error('Synthetic lost cloud response'),{status:503});}
   return result;
  }
 });
 const admission={eventType:'admission',eventId:f.admission.outboxEventId};
 await assert.rejects(delivery.deliver('qa-token',admission),{status:503});
 assert.equal((await rows(f.db,'SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,null);
 await f.run("CREATE TRIGGER qa_delivery_late_failure BEFORE INSERT ON native_event_deliveries BEGIN SELECT RAISE(ABORT,'synthetic late storage failure'); END");
 await assert.rejects(delivery.deliver('qa-token',admission),{status:503});
 assert.equal((await rows(f.db,'SELECT * FROM native_event_deliveries')).length,0);
 assert.equal((await rows(f.db,'SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,null);
 await f.run('DROP TRIGGER qa_delivery_late_failure');
 const admitted=await delivery.deliver('qa-token',admission);assert.deepEqual(admitted.ack,cloud.get(admission.eventId).ack);
 const closed=await f.checkout(),completion={eventType:'reservation-completion',eventId:closed.reservationCompletion.eventId};
 await assert.rejects(delivery.deliver('qa-token',completion),{status:503});
 const completed=await delivery.deliver('qa-token',completion);assert.deepEqual(completed.ack,cloud.get(completion.eventId).ack);
 await f.run("UPDATE tables SET status='occupied',sessionData='QA replacement session'");
 const before={cloudCalls,signCalls};assert.equal((await delivery.deliver('qa-token',completion)).replayed,true);assert.deepEqual({cloudCalls,signCalls},before);
 assert.equal((await rows(f.db,'SELECT sessionData FROM tables'))[0].sessionData,'QA replacement session');
 const ledger=await rows(f.db,'SELECT * FROM native_event_deliveries');assert.equal(ledger.length,2);
 assert.equal((await rows(f.db,'SELECT * FROM e_receipts')).length,1);assert.equal((await rows(f.db,'SELECT * FROM session_history')).length,1);
 return{passed:true,modules:process.env.ONESHOT_PROOF_PACKAGE_ARCHIVE?'actual packaged modules':'source modules',eventsAccepted:cloud.size,localDeliveries:ledger.length,cloudCalls,signCalls,lostResponses:lost.size,lateWriteRollbackVerified:true,reusedTablePreserved:true,localReplayAvoidsSigningAndRPC:true,receiptCount:1,historyCount:1,limits:['Controlled synthetic cloud ACK service; not hosted Auth/RPC/lifecycle acceptance.','Synthetic fixture key; not OS key storage or owner enrollment.','Actual SQLite and HTTP checkout; no renderer or real payment.']};
 });}
if(require.main===module)main().then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(error=>{process.stderr.write('Native delivery cross-contract failed: '+error.message+'\n');process.exitCode=1;});
module.exports={runNativeDeliveryCrossContract:main};
