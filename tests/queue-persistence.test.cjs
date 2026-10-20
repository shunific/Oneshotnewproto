const test=require('node:test'),assert=require('node:assert/strict');
const load=()=>import('../src/app/utils/queuePersistence.js');
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),key:index=>[...values.keys()][index],get length(){return values.size;}};};
const row={id:'q_original',customerName:'QA queue',contactNumber:null,partySize:2,status:'waiting',queueNumber:1,notes:null,arrivalTime:'2026-10-19T08:00:00.000Z'};
const proposal={durationMinutes:60,isOpenTime:false,hourlyRate:150,overtimeRate:300,pricingVersion:1,amountPaid:50,paymentStatus:'payNow'};
const args=(s,kind='call')=>({storage:s,staffId:'cashier-one',kind,payload:{queueId:row.id,expectedQueue:{...row},...(kind==='seat'?{tableId:'table-one',session:{...proposal}}:{})},newId:()=> 'request-original'});
const ack=command=>({requestId:command.requestId,kind:command.kind,queueId:command.queueId,outcome:'applied',queue:command.kind==='call'?{...row,status:'called'}:null,table:command.kind==='seat'?{id:command.tableId,status:'occupied',session:{...command.session,customerName:row.customerName,customerPhone:row.contactNumber,partySize:row.partySize,startTime:'2026-10-19T09:00:00.000Z',isPaid:false,paymentStatus:'payLater',orders:[]}}:null,replayed:false});
test('lost reply survives restart and retries the exact original queue request without changing later state',async()=>{
 const m=await load(),s=storage(),input=args(s,'seat');let original;
 await assert.rejects(m.saveQueueOperation({...input,request:async(_url,command)=>{original=command;throw Error('reply lost');}}));
 const pending=m.pendingQueueOperations(s,'cashier-one');assert.equal(pending.length,1);assert.equal(m.pendingQueueOperations(s,'cashier-two').length,0);
 let sent;const result=await m.retryQueueOperation({storage:s,staffId:'cashier-one',requestId:original.requestId,request:async(url,command)=>{assert.equal(url,'/api/queue/operations');sent=command;return {...ack(command),replayed:true};}});
 assert.deepEqual(sent,original);assert.equal(result.replayed,true);assert.equal(s.length,0);
});
test('unknown failures and malformed acknowledgements preserve the operation; changing action or target cannot replace it',async()=>{
 const m=await load();
 for(const result of [null,{}, {...ack({requestId:'request-original',kind:'call',queueId:row.id}),requestId:'wrong'}, {...ack({requestId:'request-original',kind:'call',queueId:row.id}),unexpected:true}]){
  const s=storage();await assert.rejects(m.saveQueueOperation({...args(s),request:async()=>result}));assert.equal(s.length,1);
  await assert.rejects(m.saveQueueOperation({...args(s,'remove'),request:async()=>assert.fail('changed action sent')}));assert.equal(s.length,1);
 }
 for(const status of [400,401,403,409,503]){const s=storage();await assert.rejects(m.saveQueueOperation({...args(s),request:async()=>{throw Object.assign(Error('unknown'),{status,response:{error:'not a terminal proof'}});}}));assert.equal(s.length,1);}
});
test('only exact durable rejection for the original command releases the saved draft',async()=>{
 const m=await load();
 for(const altered of [false,true]){const s=storage();await assert.rejects(m.saveQueueOperation({...args(s),request:async(_url,command)=>{throw Object.assign(Error('rejected'),{status:409,response:{...ack(command),outcome:'rejected',queue:null,table:null,code:'QUEUE_OPERATION_REJECTED',error:'Refresh the original queue.',...(altered?{queueId:'someone-else'}:{})}});}}));assert.equal(s.length,altered?1:0);}
});
test('account switch and concurrent replacement preserve drafts after both success and terminal rejection',async()=>{
 const m=await load();
 for(const replacement of [false,true])for(const rejected of [false,true]){
  const s=storage();let current=true;await assert.rejects(m.saveQueueOperation({...args(s),isCurrent:()=>current,request:async(_url,command)=>{
   if(replacement){const key=s.key(0),record=JSON.parse(s.getItem(key));record.command.requestId='replacement';s.setItem(key,JSON.stringify(record));}else current=false;
   if(rejected)throw Object.assign(Error('rejected'),{status:409,response:{...ack(command),outcome:'rejected',queue:null,table:null,code:'QUEUE_OPERATION_REJECTED',error:'Queue changed.'}});
   return ack(command);
  }}));assert.equal(s.length,1);
 }
});
test('seat acknowledgement must bind party, quote, payment state and empty original orders',async()=>{
 const m=await load();
 for(const patch of [{customerName:'different'},{customerPhone:'changed'},{partySize:3},{amountPaid:150},{hourlyRate:100},{paymentStatus:'paid'},{isPaid:true},{orders:[{id:'new'}]},{startTime:'invalid'},{unexpected:true}]){
  const s=storage();await assert.rejects(m.saveQueueOperation({...args(s,'seat'),request:async(_url,command)=>{const result=ack(command);Object.assign(result.table.session,patch);return result;}}));assert.equal(s.length,1);
 }
});
test('storage failure stops transmission; request mutation cannot alter the stored original',async()=>{
 const m=await load(),s=storage();s.setItem=()=>{throw Error('blocked');};await assert.rejects(m.saveQueueOperation({...args(s),request:async()=>assert.fail('unrecoverable action sent')}));
 const second=storage();await assert.rejects(m.saveQueueOperation({...args(second),request:async(_url,command)=>{command.expectedQueue.customerName='tampered';const result=ack(command);result.queue.customerName=command.expectedQueue.customerName;return result;}}));assert.equal(m.pendingQueueOperations(second,'cashier-one')[0].command.expectedQueue.customerName,row.customerName);
});
