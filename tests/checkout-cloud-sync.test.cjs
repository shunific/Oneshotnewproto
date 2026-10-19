const {test}=require('node:test');
const assert=require('node:assert/strict');
const eventId='10000000-0000-4000-8000-000000000001',claimId='10000000-0000-4000-8000-000000000002',receiptId='10000000-0000-4000-8000-000000000003';
const saved=()=>({reservationCompletion:{eventId,cloudAcknowledged:false},receipt:{id:receiptId,reservation_claim_id:claimId,reservation_id:'QA-cloud-checkout'}});
const ack=()=>({ack:{eventId,eventType:'reservation-completion',claimId,deviceId:'10000000-0000-4000-8000-000000000004',reservationId:'QA-cloud-checkout',payloadSha256:'a'.repeat(64),state:'completed',revision:3,receiptId,receivedAt:'2026-10-19T14:00:00.000Z',acceptedBy:'10000000-0000-4000-8000-000000000005'},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false});
test('committed checkout sends only its original event reference and accepts a bound completion without changing saved settlement',async()=>{
 const {syncCheckoutCompletion}=await import('../src/app/utils/checkoutCloudSync.js');const original=saved(),before=JSON.stringify(original),requests=[];
 assert.deepEqual(await syncCheckoutCompletion(original,{isCurrent:()=>true,request:async(path,body)=>{requests.push({path,body});return ack();}}),{cloudAcknowledged:true});
 assert.deepEqual(requests,[{path:'/api/native/reservation-sync/retry',body:{eventType:'reservation-completion',eventId}}]);assert.equal(JSON.stringify(original),before);
});
test('unavailable transport, wrong receipt/state and account changes preserve pending completion without repeating checkout',async()=>{
 const {syncCheckoutCompletion}=await import('../src/app/utils/checkoutCloudSync.js');
 for(const request of [async()=>{throw Object.assign(Error('offline'),{status:403});},async()=>({...ack(),ack:{...ack().ack,receiptId:'10000000-0000-4000-8000-000000000006'}}),async()=>({...ack(),ack:{...ack().ack,state:'admitted'}}),async()=>({success:true})]){
  const original=saved();assert.deepEqual(await syncCheckoutCompletion(original,{isCurrent:()=>true,request}),{cloudAcknowledged:false});assert.equal(original.reservationCompletion.cloudAcknowledged,false);
 }
 let current=true;assert.deepEqual(await syncCheckoutCompletion(saved(),{isCurrent:()=>current,request:async()=>{current=false;return ack();}}),{cloudAcknowledged:false});
 let calls=0;assert.equal(await syncCheckoutCompletion({receipt:{}},{isCurrent:()=>true,request:async()=>calls++}),null);assert.deepEqual(await syncCheckoutCompletion(saved(),{isCurrent:()=>false,request:async()=>calls++}),{cloudAcknowledged:false});assert.equal(calls,0);
});
