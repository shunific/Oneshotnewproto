const test=require('node:test'),assert=require('node:assert/strict');
const storage=()=>{const values=new Map();return{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),key:index=>[...values.keys()][index],get length(){return values.size;}};};
test('normal queue contact and notes whitespace cannot turn a committed addition into permanent unconfirmed recovery',async()=>{
 const {saveQueueOperation}=await import('../src/app/utils/queuePersistence.js');const local=storage();
 const payload={customerName:' QA queue ',contactNumber:' 09123456789 ',partySize:2,notes:' QA arrival note '};let sent;
 const result=await saveQueueOperation({storage:local,staffId:'qa-cashier',kind:'add',payload,newId:()=> 'qa_queue_trim_review',request:async(_url,command)=>{
  sent=command;return{requestId:command.requestId,kind:'add',queueId:'q_11111111-1111-4111-8111-111111111111',outcome:'applied',queue:{id:'q_11111111-1111-4111-8111-111111111111',customerName:'QA queue',contactNumber:'09123456789',partySize:2,status:'waiting',queueNumber:1,notes:'QA arrival note',arrivalTime:'2026-10-19T08:00:00.000Z'},table:null,replayed:false};
 }});
 assert.equal(result.outcome,'applied');assert.equal(local.length,0);
 assert.equal(sent.customerName,'QA queue');assert.equal(sent.contactNumber,'09123456789');assert.equal(sent.notes,'QA arrival note');
 assert.deepEqual(payload,{customerName:' QA queue ',contactNumber:' 09123456789 ',partySize:2,notes:' QA arrival note '});
});
test('an interrupted original queue addition with whitespace retries its original bytes and accepts the normalized stored result',async()=>{
 const {retryQueueOperation}=await import('../src/app/utils/queuePersistence.js');const local=storage();
 const command={requestId:'qa_queue_raw_original',kind:'add',customerName:' QA queue ',contactNumber:' 09123456789 ',partySize:2,notes:' QA arrival note '};
 local.setItem('oneshot_pending_queue:qa-cashier:add',JSON.stringify({staffId:'qa-cashier',command}));let sent;
 const result=await retryQueueOperation({storage:local,staffId:'qa-cashier',requestId:command.requestId,request:async(_url,body)=>{
  sent=body;return{requestId:command.requestId,kind:'add',queueId:'q_11111111-1111-4111-8111-111111111111',outcome:'applied',queue:{id:'q_11111111-1111-4111-8111-111111111111',customerName:'QA queue',contactNumber:'09123456789',partySize:2,status:'waiting',queueNumber:1,notes:'QA arrival note',arrivalTime:'2026-10-19T08:00:00.000Z'},table:null,replayed:true};
 }});
 assert.equal(result.replayed,true);assert.deepEqual(sent,command);assert.equal(local.length,0);
});
