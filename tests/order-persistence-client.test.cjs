const { test } = require('node:test');
const assert = require('node:assert/strict');
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key,value) => values.set(key,value), removeItem: key => values.delete(key) };
};
const load = () => import('../src/app/utils/orderPersistence.js');
const payload = { expectedSessionStartTime:'2026-10-19T02:00:00.000Z', cart:[{id:'drink',qty:2}] };
const result = { id:'table',session:{startTime:payload.expectedSessionStartTime,processedOrderOperations:[{key:'submit:stable-request-id',inventoryIds:['drink']}],orders:[{id:'drink',qty:2,price:10}]},inventory:[{id:'drink',stock:3,price:10,isActive:true}] };

test('lost response retains original operation across reload and reuses its ID', async () => {
  const {saveOrderOperation,getPendingOrder}=await load();
  const local=storage();
  const calls=[];
  const input={storage:local,tableId:'table',operation:'orders',payload,newId:()=> 'stable-request-id'};
  await assert.rejects(saveOrderOperation({...input,request:async (url,body)=>{calls.push(body);throw new TypeError('connection lost after commit');}}));
  const recovered=getPendingOrder(local,'table',payload.expectedSessionStartTime);
  assert.equal(recovered.requestId,'stable-request-id');
  const saved=await saveOrderOperation({...input,payload:recovered.payload,newId:()=> 'must-not-be-used',request:async(url,body)=>{calls.push(body);return result;}});
  assert.deepEqual(saved,result);
  assert.equal(calls[0].requestId,calls[1].requestId);
  assert.equal(getPendingOrder(local,'table',payload.expectedSessionStartTime),null);
});

test('changed cart cannot replace an operation with an unknown result',async()=>{
  const {saveOrderOperation}=await load();const local=storage();
  const input={storage:local,tableId:'table',operation:'orders',payload,newId:()=> 'stable-request-id',request:async()=>{throw new Error('timeout');}};
  await assert.rejects(saveOrderOperation(input));
  let called=false;
  await assert.rejects(saveOrderOperation({...input,payload:{...payload,cart:[{id:'drink',qty:3}]},request:async()=>{called=true;return result;}}),/previous order/);
  assert.equal(called,false);
});

test('definitive rejection permits editing; network and 5xx failure remain pending',async()=>{
  const {saveOrderOperation,getPendingOrder}=await load();
  for(const status of [409,503,undefined]){
    const local=storage();
    await assert.rejects(saveOrderOperation({storage:local,tableId:'table',operation:'orders',payload,newId:()=> 'stable-request-id',request:async()=>{throw Object.assign(new Error('failed'),{status});}}));
    assert.equal(Boolean(getPendingOrder(local,'table',payload.expectedSessionStartTime)),status!==409);
  }
});

test('malformed save acknowledgment stays pending and storage failure prevents dispatch',async()=>{
  const {saveOrderOperation,getPendingOrder}=await load();const local=storage();
  await assert.rejects(saveOrderOperation({storage:local,tableId:'table',operation:'orders',payload,newId:()=> 'stable-request-id',request:async()=>({...result,id:'wrong-table'})}));
  assert.ok(getPendingOrder(local,'table',payload.expectedSessionStartTime));
  let dispatched=false;
  await assert.rejects(saveOrderOperation({storage:{getItem:()=>null,setItem:()=>{throw new Error('disk full');}},tableId:'table',operation:'orders',payload,request:async()=>{dispatched=true;return result;}}));
  assert.equal(dispatched,false);
});

test('missing or wrong session and incomplete inventory acknowledgment cannot discard pending proof',async()=>{
  const {saveOrderOperation,getPendingOrder}=await load();
  for(const invalid of [{...result,session:{}},{...result,session:{...result.session,startTime:'2026-10-20T00:00:00Z'}},{...result,inventory:[]}]){
    const local=storage();
    await assert.rejects(saveOrderOperation({storage:local,tableId:'table',operation:'orders',payload,newId:()=> 'stable-request-id',request:async()=>invalid}));
    assert.ok(getPendingOrder(local,'table',payload.expectedSessionStartTime));
  }
});
