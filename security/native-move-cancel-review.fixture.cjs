// Independent synthetic-only cancellation native ↔ disposable PostgreSQL bridge.
const assert=require('node:assert/strict'),path=require('node:path'),readline=require('node:readline');
const {randomUUID}=require('node:crypto');
const root=process.env.ONESHOT_PROOF_PACKAGE_ARCHIVE||path.resolve(__dirname,'..');
const express=require(path.join(root,'node_modules/express'));
const {withNativeDeviceFixture}=require('./native-device-cross-contract.cjs');
const {createNativeEventDelivery}=require(path.join(root,'server-native-delivery.cjs'));
const {createReservationMoveCoordinator}=require(path.join(root,'server-reservation-moves.cjs'));
const {registerOrderRoutes}=require(path.join(root,'server-orders.cjs'));
const {registerCheckoutRoutes}=require(path.join(root,'server-checkout.cjs'));
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity}),pending=new Map();let started=false;
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
function stop(error){for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Synthetic fixture stopped'));}pending.clear();process.stderr.write('Independent synthetic native move fixture failed '+(error?.code||'')+' actual='+(error?.actual?.code||'')+' status='+(error?.actual?.status||'')+'\n'+String(error?.stack||'').split('\n').filter(line=>/^\s+at /.test(line)).join('\n')+'\n');process.exitCode=1;lines.close();process.stdin.destroy();}
lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return stop();}if(!started){started=true;main(value).then(result=>{emit({type:'complete',result});lines.close();process.stdin.destroy();}).catch(stop);return;}const p=pending.get(value.requestId);if(!p)return;pending.delete(value.requestId);clearTimeout(p.timer);if(value.type==='ack-response'&&value.result)p.resolve(value.result);else p.reject(Object.assign(Error('Synthetic RPC unavailable'),{status:value.status||503,code:value.code}));});
async function main(input){return withNativeDeviceFixture(input,async f=>{
 const resolveActor=async()=>({...f.context}),isActorCurrent=(_,a)=>f.context.active&&a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation;
 const signer=f.makeSigner({loadDeviceKey:async deviceId=>{const key=Buffer.from(f.key);return{deviceId,keyId:f.keyId,key,dispose(){key.fill(0);}};}});
 const delivery=createNativeEventDelivery(f.file,{resolveActor,isActorCurrent,signEvent:signer.sign,sendSignedEvent:async(_,envelope)=>{const requestId=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('Synthetic RPC timeout'));},20000);pending.set(requestId,{resolve,reject,timer});emit({type:'ack-request',requestId,envelope});});}});
 const moves=createReservationMoveCoordinator(f.file,{resolveActor,isActorCurrent,deliverEvent:delivery.deliver});
 await delivery.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});
 for(const id of ['QA-MOVE-B','QA-MOVE-C','QA-MOVE-D'])await f.run('INSERT INTO tables VALUES(?,?,?,?,?)',[id,id,'available',1,null]);
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.staff={id:f.context.localStaffId};next();});registerOrderRoutes(app,f.file);registerCheckoutRoutes(app,f.file);
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const post=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();assert.equal(r.status,200);return v;};
 const get=(sql,args=[])=>new Promise((resolve,reject)=>f.db.get(sql,args,(e,row)=>e?reject(e):resolve(row)));
 try{
  const session=(await post(`/api/tables/${input.command.tableId}/orders`,{requestId:'qa_review_duplex_order',expectedSessionStartTime:f.admission.table.session.startTime,cart:[{id:'qa-proof-drink',qty:1}]})).session;
  const command=(requestId,sourceId,targetId)=>({requestId,sourceId,targetId,expectedSession:session,expectedTargetStatus:'available',expectedTargetSession:null});
  const checks=[];let currentTable=input.command.tableId;
  for(const [index,targetId]of ['QA-MOVE-B','QA-MOVE-C'].entries()){
   if(index===1){const moved=await moves.move('qa-token',command('qa_cancel_review_success',currentTable,'QA-MOVE-D'));assert.equal(moved.phase,'committed');assert.deepEqual(moved.target.session,session);currentTable='QA-MOVE-D';}
   const request=command(`qa_cancel_review_${index}`,currentTable,targetId);
   await assert.rejects(moves.move('qa-token',request),{status:index===0?409:503});
   const original=await get('SELECT prepare_event_id FROM native_reservation_moves WHERE request_id=?',[request.requestId]);
   assert.equal((await get('SELECT count(*) n FROM native_reservation_move_holds')).n,2);
   await assert.rejects(moves.recover('qa-token',{requestId:request.requestId,action:'abort'}),{status:503});
   assert.equal((await get('SELECT phase FROM native_reservation_moves WHERE request_id=?',[request.requestId])).phase,'aborting');
   const before=await get('SELECT count(*) n FROM native_reservation_move_holds');assert.equal(before.n,2);
   await assert.rejects(signer.sign('qa-token',{eventType:'reservation-move-prepare',eventId:original.prepare_event_id}),{status:409});
   await assert.rejects(delivery.deliver('qa-token',{eventType:'reservation-move-prepare',eventId:original.prepare_event_id}),{status:409});
   const result=await moves.recover('qa-token',{requestId:request.requestId,action:'continue'});assert.equal(result.phase,'aborted');
   assert.equal((await get('SELECT count(*) n FROM native_reservation_move_holds')).n,0);
   assert.deepEqual(JSON.parse((await get('SELECT sessionData FROM tables WHERE id=?',[currentTable])).sessionData),session);
   checks.push(index===0?'definitively rejected prepare cancels without dispatching another prepare and preserves timer/orders/credit':'unknown accepted permit cancels after target mapping and closure changes');
  }
  const position=await get('SELECT * FROM native_reservation_positions');assert.equal(position.position_sequence,1);assert.equal(position.table_id,currentTable);
  const tendered=(input.result.claim.netTotalCents+2500-input.result.claim.verifiedPaidCents)/100;
  const closed=await post(`/api/tables/${currentTable}/checkout`,{requestId:'qa_review_duplex_checkout',expectedSession:session,expectedSessionStartTime:session.startTime,paymentStatus:'paid',paymentMethod:'cash',tendered,useProrated:false});
  const completed=await delivery.deliver('qa-token',{eventType:'reservation-completion',eventId:closed.reservationCompletion.eventId});assert.equal(completed.ack.revision,position.cloud_revision+1);
  assert.equal((await get('SELECT count(*) n FROM native_event_deliveries')).n,2);
  assert.equal((await get('SELECT count(*) n FROM native_reservation_move_cancel_outbox WHERE delivered_at IS NOT NULL')).n,2);
  checks.push('lost cancellation ACKs preserve irreversible tombstones and both holds until exact replay; delayed prepare signing and dispatch denied','original table checks out after cancellation with revision advanced twice, one prior committed position and unchanged fixed financial quote');
  return{checks,receiptId:closed.receipt.id,positionSequence:position.position_sequence,finalRevision:completed.ack.revision,syntheticOnly:true};
 }finally{await new Promise(resolve=>server.close(resolve));}
});}
