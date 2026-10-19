// QA-only: export a genuine coordinator's unknown prepare to a private fixture DB.
// The admission ACK is synthetic; this proves UI rendering, never hosted acceptance.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),crypto=require('node:crypto');
const input=require('../tests/native-device-proof-fixture.cjs');
const {withNativeDeviceFixture}=require('./native-device-cross-contract.cjs');
const {createNativeEventDelivery,readAcceptedReservationPosition}=require('../server-native-delivery.cjs');
const {createReservationMoveCoordinator,listPendingReservationMoves}=require('../server-reservation-moves.cjs');
async function main(){
 const destination=process.argv[2];assert(destination&&destination.endsWith('.sqlite'));await assert.rejects(fs.access(destination));
 return withNativeDeviceFixture(input,async f=>{
  const resolveActor=async()=>({...f.context}),isActorCurrent=(_,a)=>a.localStaffId===f.context.localStaffId&&a.cloudUserId===f.context.cloudUserId&&a.generation===f.context.generation;
  const delivery=createNativeEventDelivery(f.file,{resolveActor,isActorCurrent,signEvent:f.makeSigner().sign,sendSignedEvent:async(_,e)=>({ack:{eventId:e.eventId,eventType:e.eventType,claimId:e.claimId,deviceId:e.deviceId,reservationId:input.command.id,payloadSha256:crypto.createHash('sha256').update(e.payload).digest('hex'),state:'checked-in',revision:input.result.claim.claimRevision+1,receiptId:null,receivedAt:new Date().toISOString(),acceptedBy:f.context.cloudUserId},replayed:false,recordType:'reservation-lifecycle-ack',fundsTransferred:false})});
  await delivery.deliver('qa-token',{eventType:'admission',eventId:f.admission.outboxEventId});
  await f.run("UPDATE tables SET name='QA Reservation Source Long Name - TEST ONLY' WHERE id=?",[input.command.tableId]);
  await f.run("INSERT INTO tables VALUES('QA-UI-TARGET','QA Reservation Destination Long Name - TEST ONLY','available',1,NULL)");
  const coordinator=createReservationMoveCoordinator(f.file,{resolveActor,isActorCurrent,deliverEvent:async()=>{throw Object.assign(Error('QA deliberately unknown prepare'),{status:503});},readAcceptedPosition:readAcceptedReservationPosition});
  await assert.rejects(coordinator.move('qa-token',{requestId:'qa_rc15_ui_original',sourceId:input.command.tableId,targetId:'QA-UI-TARGET',expectedSession:f.admission.table.session,expectedTargetStatus:'available',expectedTargetSession:null}),{status:503});
  const moves=await listPendingReservationMoves(f.file);assert.equal(moves.length,1);assert.equal(moves[0].phase,'prepared');
  await f.run('VACUUM INTO ?',[destination]);
  return{syntheticOnly:true,mockedAdmissionAck:true,realCloudTransport:false,purpose:'Pending recovery UI and held table controls only',moves};
 });
}
main().then(v=>process.stdout.write(JSON.stringify(v,null,2)+'\n')).catch(()=>{process.stderr.write('Private UI fixture could not be prepared.\n');process.exitCode=1;});
