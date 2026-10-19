const test=require('node:test'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const express=require('express');
const {withNativeDeviceFixture}=require('../security/native-device-cross-contract.cjs');
const input=require('./native-device-proof-fixture.cjs');
const {createNativeEventDelivery,readAcceptedReservationPosition}=require('../server-native-delivery.cjs');
const {createReservationMoveCoordinator}=require('../server-reservation-moves.cjs');
const {registerSessionStateRoutes}=require('../server-session-state.cjs');
const get=(db,sql,args=[])=>new Promise((resolve,reject)=>db.get(sql,args,(e,row)=>e?reject(e):resolve(row)));
const storage=()=>{const data=new Map();return{get length(){return data.size;},key:i=>[...data.keys()][i],getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),removeItem:k=>data.delete(k)};};
async function fixture(f,callback){
 let cloudPrepareCalls=0;const resolveActor=async()=>({...f.context}),isActorCurrent=(_,a)=>f.context.active&&a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation;
 const signer=f.makeSigner();
 const delivery=createNativeEventDelivery(f.file,{resolveActor,isActorCurrent,signEvent:signer.sign,sendSignedEvent:async(_,e)=>{
  if(e.eventType==='reservation-move-prepare'){cloudPrepareCalls++;throw Object.assign(Error('Synthetic cloud conflict'),{status:409,code:'NATIVE_MOVE_NOT_STARTED'});}
  return{ack:{eventId:e.eventId,eventType:e.eventType,claimId:e.claimId,deviceId:e.deviceId,reservationId:input.command.id,payloadSha256:createHash('sha256').update(e.payload).digest('hex'),state:'checked-in',revision:input.result.claim.claimRevision+1,receiptId:null,receivedAt:new Date().toISOString(),acceptedBy:f.context.cloudUserId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false};
 }});
 await delivery.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});
 await f.run('INSERT INTO tables VALUES(?,?,?,?,?)',['QA-REJECT-TARGET','QA target','maintenance',1,null]);
 const moves=createReservationMoveCoordinator(f.file,{resolveActor,isActorCurrent,deliverEvent:delivery.deliver,readAcceptedPosition:readAcceptedReservationPosition});
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authToken='qa-token';req.staff={id:f.context.localStaffId};next();});registerSessionStateRoutes(app,f.file,{reservationMoves:moves,resolveActor,isActorCurrent});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const payload={expectedSession:f.admission.table.session,targetId:'QA-REJECT-TARGET',expectedTargetStatus:'available',expectedTargetSession:null};
 const request=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const response=await r.json();if(!r.ok)throw Object.assign(Error(response.error),{status:r.status,response});return response;};
 try{return await callback({payload,request,cloudCalls:()=>cloudPrepareCalls});}finally{await new Promise(resolve=>server.close(resolve));}
}
test('actual HTTP durable local rejection survives a lost response and target repair, then clears only the matching client draft without starting an intent',async()=>withNativeDeviceFixture(input,async f=>fixture(f,async x=>{
 const {saveSessionChange}=await import('../src/app/utils/sessionPersistence.js');const local=storage();
 const options={storage:local,tableId:input.command.tableId,kind:'move',payload:x.payload,newId:()=> 'qa_review_never_started'};
 await assert.rejects(saveSessionChange({...options,request:async(...args)=>{try{await x.request(...args);}catch(error){assert.equal(error.response.code,'NATIVE_MOVE_NOT_STARTED');}throw Error('Synthetic lost response');}}));
 assert.equal(local.length,1);assert.equal((await get(f.db,'SELECT count(*) n FROM native_reservation_move_rejections')).n,1);
 const original=(await get(f.db,'SELECT request_sha256 FROM native_reservation_move_rejections')).request_sha256;
 await f.run('UPDATE native_reservation_move_rejections SET request_sha256=?',['0'.repeat(64)]);
 await assert.rejects(saveSessionChange({...options,request:x.request}),error=>error.status===409&&error.response.code===undefined);assert.equal(local.length,1);
 await f.run('UPDATE native_reservation_move_rejections SET request_sha256=?',[original]);
 await f.run("UPDATE tables SET status='available' WHERE id='QA-REJECT-TARGET'");
 await assert.rejects(saveSessionChange({...options,request:x.request}),error=>error.status===409&&error.response.code==='NATIVE_MOVE_NOT_STARTED'&&error.response.requestId==='qa_review_never_started'&&error.response.sourceId===input.command.tableId);
 assert.equal(local.length,0);assert.equal(x.cloudCalls(),0);
 assert.equal((await get(f.db,'SELECT count(*) n FROM native_reservation_moves')).n,0);assert.equal((await get(f.db,'SELECT count(*) n FROM native_reservation_move_holds')).n,0);
})));
test('a post-intent cloud 409 using the rejection code cannot forge the durable local proof or clear the actual client draft',async()=>withNativeDeviceFixture(input,async f=>fixture(f,async x=>{
 const {saveSessionChange}=await import('../src/app/utils/sessionPersistence.js');const local=storage();await f.run("UPDATE tables SET status='available' WHERE id='QA-REJECT-TARGET'");
 const options={storage:local,tableId:input.command.tableId,kind:'move',payload:x.payload,newId:()=> 'qa_review_cloud_started',request:x.request};
 for(let attempt=0;attempt<2;attempt++)await assert.rejects(saveSessionChange(options),error=>error.status===409&&error.response.code===undefined&&error.response.requestId===undefined&&error.response.sourceId===undefined);
 assert.equal(local.length,1);assert.equal(x.cloudCalls(),2);
 assert.equal((await get(f.db,'SELECT count(*) n FROM native_reservation_move_rejections')).n,0);
 assert.equal((await get(f.db,'SELECT count(*) n FROM native_reservation_moves')).n,1);assert.equal((await get(f.db,'SELECT count(*) n FROM native_reservation_move_holds')).n,2);
 assert.equal((await get(f.db,'SELECT phase FROM native_reservation_moves')).phase,'prepared');
})));
