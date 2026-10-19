// QA-only duplex bridge: synthetic credentials enter private stdin, never logs.
const assert=require('node:assert/strict');
const path=require('node:path');
const readline=require('node:readline');
const {randomUUID}=require('node:crypto');
const {withNativeDeviceFixture}=require('./native-device-cross-contract.cjs');
const root=process.env.ONESHOT_PROOF_PACKAGE_ARCHIVE||path.resolve(__dirname,'..');
const {createNativeEventDelivery}=require(path.join(root,'server-native-delivery.cjs'));
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const pending=new Map();let started=false;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
lines.on('line',line=>{
 let value;try{value=JSON.parse(line);}catch{return fail();}
 if(!started){started=true;main(value).then(result=>{emit({type:'complete',result});lines.close();process.stdin.destroy();}).catch(fail);return;}
 const item=pending.get(value.requestId);if(!item)return;
 pending.delete(value.requestId);clearTimeout(item.timer);
 if(value.type==='ack-response'&&value.drop===true)item.reject(Object.assign(Error('Synthetic lost response'),{status:503}));
 else if(value.type==='ack-response'&&value.result)item.resolve(value.result);
 else item.reject(Object.assign(Error('Private fixture RPC failure'),{status:503}));
});
function fail(){for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Fixture stopped'));}pending.clear();process.stderr.write('Synthetic native delivery integration failed.\n');process.exitCode=1;lines.close();process.stdin.destroy();}
async function main(input){return withNativeDeviceFixture(input,async f=>{
 const checks=[];let signing=0,network=0,keys=0;
 const all=sql=>new Promise((resolve,reject)=>f.db.all(sql,(e,r)=>e?reject(e):resolve(r)));
 const signer=f.makeSigner({loadDeviceKey:async deviceId=>{keys++;const key=Buffer.from(f.key);return{deviceId,keyId:f.keyId,key,dispose(){key.fill(0);}};}});
 const delivery=createNativeEventDelivery(f.file,{
  resolveActor:async()=>({...f.context}),
  isActorCurrent:(_,a)=>f.context.active&&a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation,
  signEvent:async(...args)=>{signing++;return signer.sign(...args);},
  sendSignedEvent:async(_,envelope)=>{network++;const requestId=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Fixture RPC timeout'));},15000);pending.set(requestId,{resolve,reject,timer});emit({type:'ack-request',requestId,envelope});});}
 });
 const admission={eventType:'admission',eventId:f.admission.outboxEventId};
 await assert.rejects(delivery.deliver('qa-token',admission),{status:503});
 assert.equal((await all('SELECT delivered_at FROM native_checkin_outbox'))[0].delivered_at,null);
 assert.equal((await all('SELECT * FROM native_event_deliveries')).length,0);
 checks.push('cloud admission committed with lost response; original local event remains pending');
 const admitted=await delivery.deliver('qa-token',admission);
 assert.equal(admitted.replayed,true);assert.equal(admitted.ack.state,'checked-in');
 assert.equal((await all('SELECT * FROM native_event_deliveries')).length,1);
 checks.push('original admission retry consumes real PostgreSQL replay and commits local ACK ledger');
 const closed=await f.checkout();
 const completion={eventType:'reservation-completion',eventId:closed.reservationCompletion.eventId};
 await f.run("CREATE TRIGGER qa_delivery_late_insert BEFORE INSERT ON native_event_deliveries WHEN NEW.event_type='reservation-completion' BEGIN SELECT RAISE(ABORT,'QA_PRIVATE_LATE_DELIVERY'); END");
 await assert.rejects(delivery.deliver('qa-token',completion),{status:503});
 assert.equal((await all('SELECT delivered_at FROM native_reservation_completion_outbox'))[0].delivered_at,null);
 assert.equal((await all('SELECT * FROM native_event_deliveries')).length,1);
 checks.push('cloud completion committed; late SQLite ledger INSERT failure rolls back local marker and ACK');
 await f.run('DROP TRIGGER qa_delivery_late_insert');
 const completed=await delivery.deliver('qa-token',completion);
 assert.equal(completed.replayed,true);assert.equal(completed.ack.receiptId,closed.receipt.id);
 await f.run("UPDATE tables SET status='occupied',sessionData='QA next guest untouched'");
 const before=await all('SELECT * FROM tables');const counters={signing,network,keys};
 assert.equal((await delivery.deliver('qa-token',admission)).replayed,true);
 assert.equal((await delivery.deliver('qa-token',completion)).replayed,true);
 assert.deepEqual({signing,network,keys},counters);assert.deepEqual(await all('SELECT * FROM tables'),before);
 assert.equal((await all('SELECT * FROM e_receipts')).length,1);assert.equal((await all('SELECT * FROM session_history')).length,1);
 assert.equal((await all('SELECT * FROM native_event_deliveries')).length,2);
 checks.push('original completion retry commits real SQL replay; reused table and single local receipt/history survive key-free network-free local replays');
 return{checks,signing,network,keys,localDeliveryCount:2,localReceiptCount:1,localHistoryCount:1,admissionEventId:admission.eventId,completionEventId:completion.eventId,receiptId:closed.receipt.id,syntheticOnly:true};
});}
