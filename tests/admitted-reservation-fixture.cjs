const { randomUUID } = require('node:crypto');
const { createCheckinCoordinator } = require('../server-checkin.cjs');
const run = (db, sql, args = []) => new Promise((resolve,reject)=>db.run(sql,args,e=>e?reject(e):resolve()));
module.exports = async function seedAdmission(db, filename, session, tableId = 't1', localStaffId = 'qa-cashier') {
  const actor = { localStaffId, cloudUserId: '33333333-3333-4333-8333-333333333333', generation: 1 };
  await run(db, 'CREATE TABLE IF NOT EXISTS systemSettings(keyName TEXT PRIMARY KEY,settingValue TEXT)');
  await run(db, 'INSERT OR REPLACE INTO systemSettings VALUES(?,?)', ['overtimeRate',String(session.overtimeRate)]);
  await run(db, "UPDATE tables SET status='available',sessionData=NULL WHERE id=?", [tableId]);
  const p = session.reservationPricing;
  const command = { requestId:randomUUID(),id:session.reservationId,tableId,expectedRevision:p.sourceRevision,expectedStaffId:actor.cloudUserId };
  const coordinator = createCheckinCoordinator(filename, {
    now:()=>Date.parse(session.startTime), resolveActor:async()=>actor,
    isActorCurrent:(_,a)=>a.localStaffId===actor.localStaffId&&a.cloudUserId===actor.cloudUserId&&a.generation===1,
    claimCheckin:async (_,payload)=>({replayed:false,recordType:'reservation-check-in-claim',fundsTransferred:false,
      claim:{claimId:p.claimId,requestId:payload.requestId,reservationId:payload.id,actorUserId:actor.cloudUserId,actorRole:'cashier',deviceId:payload.deviceId,tableId:payload.tableId,cloudTableId:'cloud-table',ownerUserId:p.ownerUserId,sourceRevision:p.sourceRevision,claimRevision:p.claimRevision,state:'claim-pending',customerName:session.customerName,contactNumber:session.customerPhone,email:session.customerEmail,partySize:session.partySize,durationMinutes:session.durationMinutes,bookingDate:'2026-10-19',timeSlot:'14:00',grossTotalCents:p.grossCents,discountCents:p.discountCents,netTotalCents:p.netCents,requiredDepositCents:p.verifiedPaidCents,verifiedPaidCents:p.verifiedPaidCents}}),
  });
  await coordinator.claim('test-local-token',command);
  const admitted = await coordinator.admit('test-local-token',{requestId:command.requestId,expectedOvertimeRate:session.overtimeRate});
  // Pricing tests add their pre-existing F&B fixture after real admission.
  await run(db,'UPDATE tables SET sessionData=? WHERE id=?',[JSON.stringify({...admitted.table.session,orders:session.orders}),tableId]);
  return { command, admitted };
};
