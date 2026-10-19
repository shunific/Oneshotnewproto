const {test}=require('node:test');
const assert=require('node:assert/strict');
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,v),removeItem:k=>m.delete(k)};};
const payload={expectedSessionStartTime:'2026-10-19T00:00:00.000Z',expectedSession:{startTime:'2026-10-19T00:00:00.000Z'},tendered:100};
const response={id:'t1',requestId:'stable-checkout',receipt:{id:'r1',receipt_no:'REC-1',table_id:'t1',play_start_time:payload.expectedSessionStartTime,total_amount:100,amount_paid:100,balance_due:0},history:{id:'r1'}};
test('checkout lost response reuses original request after reload even when table is free',async()=>{
 const {saveCheckoutOperation,getPendingCheckout}=await import('../src/app/utils/checkoutPersistence.js');const local=storage();let ids=[];
 const input={storage:local,tableId:'t1',payload,newId:()=> 'stable-checkout'};
 await assert.rejects(saveCheckoutOperation({...input,request:async(u,b)=>{ids.push(b.requestId);throw new Error('lost');}}));
 const record=getPendingCheckout(local,'t1',payload.expectedSessionStartTime);assert.equal(record.tableId,'t1');
 await saveCheckoutOperation({...input,payload:record.payload,newId:()=> 'never',request:async(u,b)=>{ids.push(b.requestId);return response;}});
 assert.deepEqual(ids,['stable-checkout','stable-checkout']);assert.equal(getPendingCheckout(local,'t1',payload.expectedSessionStartTime),null);
});
test('unknown checkout blocks changed payment and malformed acknowledgement keeps recovery proof',async()=>{
 const {saveCheckoutOperation,getPendingCheckout}=await import('../src/app/utils/checkoutPersistence.js');const local=storage();
 const input={storage:local,tableId:'t1',payload,newId:()=> 'stable-checkout',request:async()=>({...response,receipt:{...response.receipt,balance_due:20}})};
 await assert.rejects(saveCheckoutOperation(input));let sent=false;
 await assert.rejects(saveCheckoutOperation({...input,payload:{...payload,tendered:200},request:async()=>{sent=true;return response;}}),/unconfirmed checkout/);
 assert.equal(sent,false);assert.ok(getPendingCheckout(local,'t1',payload.expectedSessionStartTime));
});
test('authentication loss and 503 keep pending payment; definitive stale-bill rejection permits review',async()=>{
 const {saveCheckoutOperation,getPendingCheckout}=await import('../src/app/utils/checkoutPersistence.js');
 for(const status of [401,403,503,409]){const local=storage();await assert.rejects(saveCheckoutOperation({storage:local,tableId:'t1',payload,newId:()=> 'stable-checkout',request:async()=>{throw Object.assign(new Error('denied'),{status});}}));assert.equal(!!getPendingCheckout(local,'t1',payload.expectedSessionStartTime),status!==409);}
});
test('failed pending-record write prevents taking payment',async()=>{
 const {saveCheckoutOperation}=await import('../src/app/utils/checkoutPersistence.js');let sent=false;
 await assert.rejects(saveCheckoutOperation({storage:{getItem:()=>null,setItem:()=>{throw new Error('quota');}},tableId:'t1',payload,request:async()=>{sent=true;return response;}}));assert.equal(sent,false);
});
