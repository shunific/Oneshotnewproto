const test=require('node:test');
const assert=require('node:assert/strict');
const {calculateSessionBill,previewSessionBill}=require('../session-billing.mjs');
const {calculateCheckout}=require('../server-checkout.cjs');
const start=Date.parse('2026-10-19T00:00:00Z');
const base={customerName:'QA',startTime:new Date(start).toISOString(),durationMinutes:60,isOpenTime:false,hourlyRate:150,pricingVersion:1,overtimeRate:75,amountPaid:0,orders:[]};
test('configured overtime uses its immutable snapshot with whole-second minute boundaries',()=>{
 for(const [offset,minutes,cents] of [[0,0,0],[999,0,0],[1000,1,125],[60000,1,125],[60999,1,125],[61000,2,250]]) {
  const bill=calculateSessionBill(base,start+3600000+offset,false);assert.equal(bill.tableCents,15000);assert.equal(bill.overtimeMins,minutes);assert.equal(bill.overtimeCents,cents);assert.equal(bill.overtimeRateCents,7500);assert.equal(bill.pricingVersion,1);
 }
 const fractional=calculateSessionBill({...base,overtimeRate:75.01},start+3661000,false);assert.equal(fractional.overtimeCents,250);
});
test('shared UI preview exactly maps authoritative cents for booked, prorated, open and refund cases',()=>{
 for(const session of [base,{...base,isOpenTime:true},{...base,amountPaid:400,orders:[{id:'food',price:0.29,qty:3}]}]) for(const prorated of [false,true]) {
  const now=start+5401000,bill=calculateCheckout(session,now,prorated),preview=previewSessionBill(session,now,prorated);
  assert.deepEqual(bill,calculateSessionBill(session,now,prorated));
  assert.deepEqual(preview,{elapsedMins:bill.elapsedMins,alreadyPaid:bill.alreadyPaid/100,bookedCharge:bill.tableCents/100,bookingDiscount:0,overtimeCharge:bill.overtimeCents/100,posOrdersTotal:bill.fnbCents/100,totalDue:bill.totalCents/100,balance:bill.balanceCents/100,refundDue:bill.refundCents/100,isOvertime:bill.overtimeMins>0,overtimeMins:bill.overtimeMins,isOpenTime:session.isOpenTime,overtimeRate:75});
 }
 assert.equal(calculateSessionBill({...base,isOpenTime:true},start+600000,false).tableCents,15000);
 assert.equal(calculateSessionBill({...base,isOpenTime:true},start+3601000,false).tableCents,22500);
});
test('legacy bills retain the original hourly overtime and ignore unsnapshotted overtime',()=>{
 const legacy={...base};delete legacy.pricingVersion;
 for(const overtimeRate of [1,9999,null,'bad']) {const bill=calculateSessionBill({...legacy,overtimeRate},start+3720000,false);assert.equal(bill.overtimeCents,500);assert.equal(bill.overtimeRateCents,15000);assert.equal(bill.pricingVersion,0);}
});
test('unsupported versions, missing or malformed positive snapshot and invalid inputs fail closed',()=>{
 for(const fields of [{hourlyRate:0},{pricingVersion:0},{pricingVersion:null},{pricingVersion:2},{pricingVersion:'1'},{overtimeRate:undefined},{overtimeRate:null},{overtimeRate:0},{overtimeRate:-1},{overtimeRate:Infinity},{overtimeRate:NaN},{overtimeRate:'75'},{overtimeRate:75.001},{overtimeRate:0.000000001}]) {
  assert.throws(()=>calculateSessionBill({...base,...fields},start+3600000,false),error=>error.status===409);
  assert.throws(()=>previewSessionBill({...base,...fields},start+3600000,false),error=>error.status===409);
 }
 assert.throws(()=>calculateSessionBill(base,NaN,false));assert.throws(()=>calculateSessionBill(base,start-1,false));assert.throws(()=>calculateSessionBill(base,start,'false'));
});
const reservationSession=require('./reservation-billing-fixture.cjs');
test('reservation version2 preserves exact gross discount net and verified credit with separate overtime',()=>{
 const session=reservationSession({startTime:new Date(start).toISOString()});const bill=calculateSessionBill(session,start+120*60000+61000,false);
 assert.equal(bill.tableCents,30101);assert.equal(bill.discountCents,10001);assert.equal(bill.overtimeMins,2);assert.equal(bill.overtimeCents,1000);assert.equal(bill.totalCents,23600);assert.equal(bill.alreadyPaid,4020);assert.equal(bill.balanceCents,19580);
 const preview=previewSessionBill(session,start+120*60000+61000,false);assert.equal(preview.bookedCharge,301.01);assert.equal(preview.bookingDiscount,100.01);assert.equal(preview.totalDue,236);assert.equal(preview.balance,195.8);assert.equal(preview.overtimeRate,300);
 assert.equal(calculateSessionBill({...session,orders:[]},start+600000,false).totalCents,20100);
});
test('reservation pricing rejects malformed claims, lost deposit credit and unsupported commercial changes',()=>{
 const base=reservationSession({startTime:new Date(start).toISOString()});
 for(const fields of [{claimId:'claim'},{claimId:base.reservationPricing.claimId.toUpperCase().replace('1','A')},{ownerUserId:'owner'},{reservationId:' other'},{sourceRevision:'4'},{sourceRevision:0},{claimRevision:6},{grossCents:240000001},{grossCents:30101.1},{discountCents:-1},{netCents:20099},{verifiedPaidCents:20101},{durationMinutes:60}]) assert.throws(()=>calculateSessionBill({...base,reservationPricing:{...base.reservationPricing,...fields}},start+600000,false),e=>e.status===409);
 for(const fields of [{hourlyRate:150},{hourlyRate:undefined},{amountPaid:40.19},{isOpenTime:true},{durationMinutes:null},{durationMinutes:150},{durationMinutes:120.5},{reservationId:'different'},{overtimeRate:0},{overtimeRate:null}]) assert.throws(()=>calculateSessionBill({...base,...fields},start+600000,false),e=>e.status===409);
 assert.throws(()=>calculateSessionBill(base,start+600000,true),e=>e.status===409&&/venue-rule/.test(e.message));
 const zero=reservationSession({startTime:new Date(start).toISOString(),amountPaid:0,reservationPricing:{...base.reservationPricing,grossCents:0,discountCents:0,netCents:0,verifiedPaidCents:0}});assert.equal(calculateSessionBill(zero,start+600000,false).totalCents,2500);
});
