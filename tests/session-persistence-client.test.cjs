const {test}=require('node:test');
const assert=require('node:assert/strict');
const storage=()=>{const map=new Map();return {get length(){return map.size},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};};
const payload={expectedSession:{startTime:'2026-10-19T00:00:00.000Z'},minutes:60,tendered:150,paymentMethod:'cash'};
test('unknown extension retry survives reload without a second payment identifier',async()=>{
 const {saveSessionChange,pendingSessionChanges}=await import('../src/app/utils/sessionPersistence.js');const local=storage(),sent=[];
 const input={storage:local,tableId:'t1',kind:'extend',payload,newId:()=> 'one-extension'};
 await assert.rejects(saveSessionChange({...input,request:async(u,b)=>{sent.push(b.requestId);throw new Error('lost');}}));
 const [record]=pendingSessionChanges(local);assert.equal(record.kind,'extend');
 await saveSessionChange({...input,payload:record.payload,request:async(u,b)=>{sent.push(b.requestId);return{id:'t1',requestId:b.requestId,session:{durationMinutes:120}};}});
 assert.deepEqual(sent,['one-extension','one-extension']);assert.equal(local.length,0);
});
test('unknown move blocks another target while authenticated denial preserves retry',async()=>{
 const {saveSessionChange}=await import('../src/app/utils/sessionPersistence.js');const local=storage();
 const input={storage:local,tableId:'t1',kind:'move',payload:{...payload,targetId:'t2'},request:async()=>{throw Object.assign(new Error('session ended'),{status:401});}};
 await assert.rejects(saveSessionChange(input));let sent=false;
 await assert.rejects(saveSessionChange({...input,payload:{...input.payload,targetId:'t3'},request:async()=>{sent=true;}}),/pending session/);assert.equal(sent,false);assert.equal(local.length,1);
});
