// QA reproduction only: a definitive RPC error is not a durable rejection acknowledgement.
const assert=require('node:assert/strict');
const {withNativeDeviceFixture}=require('./native-device-cross-contract.cjs');
const input=require('../tests/native-device-proof-fixture.cjs');
const {readStoredNativeEvent}=require('../server-device-proof.cjs');
// Pin this historical diagnostic to the exact RC14 module; current cancellation has separate integration tests.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const filename=path.resolve(__dirname,'../server-reservation-moves-rc14.fixture.cjs'),archived=new Module(filename,module);archived.filename=filename;archived.paths=Module._nodeModulePaths(path.dirname(filename));archived._compile(fs.readFileSync(path.join(__dirname,'../tests/fixtures/server-reservation-moves-rc14.fixture.cjs'),'utf8'),filename);
const {createReservationMoveCoordinator,initializeReservationMoveSchema,recordAcceptedNativePosition}=archived.exports;
const all=(db,sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,r)=>e?reject(e):resolve(r)));
async function setup(f,send){
 await initializeReservationMoveSchema(f.db);
 const event=await readStoredNativeEvent(f.file,{eventType:'admission',eventId:f.admission.outboxEventId});
 await recordAcceptedNativePosition(f.db,event,{ack:{state:'checked-in',revision:input.result.claim.claimRevision+1}});
 await f.run("INSERT INTO tables VALUES('QA-REJECTED-TARGET','QA target','available',1,NULL)");
 const calls=[];const coordinator=createReservationMoveCoordinator(f.file,{resolveActor:async()=>({...f.context}),isActorCurrent:(_,a)=>f.context.active&&a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation,deliverEvent:async(token,command)=>{calls.push({...command});return send(token,command);}});
 const request={requestId:'qa_rejected_prepare_original',sourceId:input.command.tableId,targetId:'QA-REJECTED-TARGET',expectedSession:f.admission.table.session,expectedTargetStatus:'available',expectedTargetSession:null};
 return{coordinator,request,calls};
}
async function reproduce(){
 await withNativeDeviceFixture(input,async f=>{
 const rejected=()=>Object.assign(Error('Synthetic target schedule conflict'),{status:409,code:'CHECKIN_TARGET_UNAVAILABLE'});
 const x=await setup(f,async()=>{throw rejected();});const tables=await all(f.db,'SELECT * FROM tables');
 await assert.rejects(x.coordinator.move('qa-token',x.request),{status:409,code:'CHECKIN_TARGET_UNAVAILABLE'});
 await assert.rejects(x.coordinator.recover('qa-token',{requestId:x.request.requestId,action:'abort'}),{status:409,code:'CHECKIN_TARGET_UNAVAILABLE'});
 assert.equal(x.calls.length,2);assert.deepEqual(x.calls[0],x.calls[1]);assert.equal(x.calls[0].eventType,'reservation-move-prepare');
 const op=(await all(f.db,'SELECT * FROM native_reservation_moves'))[0];assert.equal(op.phase,'prepared');assert.equal(op.prepare_revision,null);assert.equal(op.terminal_event_id,null);
 assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,2);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_outbox')).length,1);assert.deepEqual(await all(f.db,'SELECT * FROM tables'),tables);
});
 await withNativeDeviceFixture(input,async f=>{
 let cloudMayHaveAccepted=false;
 const x=await setup(f,async()=>{if(!cloudMayHaveAccepted){cloudMayHaveAccepted=true;throw Object.assign(Error('Synthetic lost accepted response'),{status:503});}throw Object.assign(Error('Synthetic mapping changed after original acceptance'),{status:409,code:'CHECKIN_COORDINATOR_NOT_READY'});});
 const tables=await all(f.db,'SELECT * FROM tables');
 await assert.rejects(x.coordinator.move('qa-token',x.request),{status:503});
 await assert.rejects(x.coordinator.recover('qa-token',{requestId:x.request.requestId,action:'abort'}),{status:409});
 assert.equal(cloudMayHaveAccepted,true);assert.deepEqual(x.calls[0],x.calls[1]);assert.equal((await all(f.db,'SELECT * FROM native_reservation_move_holds')).length,2);assert.deepEqual(await all(f.db,'SELECT * FROM tables'),tables);
});

 return{baseline:"RC14 archived native module",currentCandidate:false,confirmedGap:true,syntheticOnly:true,hostedWrites:false,productionEdits:false,checks:["permanent prepare 409 prevents explicit abort and leaves original two local holds", "unknown accepted prepare followed by later 409 correctly keeps holds; error status is not durable rejection proof"],checkCount:2,featureReady:false};
}
reproduce().then(value=>process.stdout.write(JSON.stringify(value,null,2)+'\n')).catch(()=>{process.stderr.write('Synthetic prepare-rejection diagnostic could not complete.\n');process.exitCode=1;});
