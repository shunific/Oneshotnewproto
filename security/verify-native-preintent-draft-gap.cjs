// QA-only regression of the formerly reproduced draft gap: actual HTTP/native + browser helper.
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const express=require('express');
const input=require('../tests/native-device-proof-fixture.cjs');
const {withNativeDeviceFixture}=require('./native-device-cross-contract.cjs');
const {createNativeEventDelivery,readAcceptedReservationPosition}=require('../server-native-delivery.cjs');
const {createReservationMoveCoordinator,listPendingReservationMoves}=require('../server-reservation-moves.cjs');
const {registerSessionStateRoutes}=require('../server-session-state.cjs');
async function main(){const {saveSessionChange,pendingSessionChanges}=await import('../src/app/utils/sessionPersistence.js');return withNativeDeviceFixture(input,async f=>{
 const resolveActor=async()=>({...f.context}),isActorCurrent=(_,a)=>a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation;
 const delivery=createNativeEventDelivery(f.file,{resolveActor,isActorCurrent,signEvent:f.makeSigner().sign,sendSignedEvent:async(_,e)=>({ack:{eventId:e.eventId,eventType:e.eventType,claimId:e.claimId,deviceId:e.deviceId,reservationId:input.command.id,payloadSha256:createHash('sha256').update(e.payload).digest('hex'),state:e.eventType==='admission'?'checked-in':e.eventType==='reservation-move-prepare'?'move-prepared':'moved',revision:e.eventType==='admission'?input.result.claim.claimRevision+1:JSON.parse(e.payload).expectedRevision+1,receiptId:null,receivedAt:new Date().toISOString(),acceptedBy:f.context.cloudUserId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false})});
 await delivery.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});
 await f.run("INSERT INTO tables VALUES('QA-STALE-TARGET','QA stale','occupied',1,'QA newer guest'),('QA-NEW-TARGET','QA new','available',1,NULL)");
 const coordinator=createReservationMoveCoordinator(f.file,{resolveActor,isActorCurrent,deliverEvent:delivery.deliver,readAcceptedPosition:readAcceptedReservationPosition});
 const app=express();app.use(express.json());app.use((req,_res,next)=>{req.authToken='qa-token';next();});await registerSessionStateRoutes(app,f.file,{reservationMoves:coordinator}).ready;
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 try{
  const map=new Map(),storage={get length(){return map.size;},key:i=>[...map.keys()][i],getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
  let requests=0;const request=async(route,body)=>{requests++;const r=await fetch(`http://127.0.0.1:${server.address().port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw Object.assign(Error(value.error),{status:r.status,response:value});return value;};
  const payload={expectedSession:f.admission.table.session,targetId:'QA-STALE-TARGET',expectedTargetStatus:'available',expectedTargetSession:null};
  await assert.rejects(saveSessionChange({storage,tableId:input.command.tableId,kind:'move',payload,newId:()=> 'qa_preintent_race',request}),{status:409});
  assert.equal((await listPendingReservationMoves(f.file)).length,0);assert.equal(pendingSessionChanges(storage).length,0);
  const moved=await saveSessionChange({storage,tableId:input.command.tableId,kind:'move',payload:{...payload,targetId:'QA-NEW-TARGET'},newId:()=> 'qa_new_after_preintent_proof',request});assert.equal(moved.phase,'committed');assert.equal(requests,2);assert.equal(pendingSessionChanges(storage).length,0);
  return{confirmedGap:false,regressionPassed:true,syntheticOnly:true,hostedWrites:false,checks:['actual local CAS rejection commits durable not-started proof','browser clears only matching rejected draft while native pending discovery remains empty','new destination succeeds through actual HTTP and native delivery after safe draft clearance'],checkCount:3};
 }finally{await new Promise(resolve=>server.close(resolve));}
});}
main().then(v=>process.stdout.write(JSON.stringify(v,null,2)+'\n')).catch(()=>{process.stderr.write('Synthetic pre-intent draft diagnostic could not complete.\n');process.exitCode=1;});
