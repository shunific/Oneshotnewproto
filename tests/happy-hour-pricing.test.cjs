const test=require('node:test'),assert=require('node:assert/strict');
const {selectWalkInStartPricing,calculateSessionBill}=require('../session-billing.mjs');
const reservationSession=require('./reservation-billing-fixture.cjs');
const rates=()=>({hourlyRate:150,overtimeRate:300,isWeekdayHappyHourActive:true,weekdayHappyHourRate:100,weekdayHappyHourStart:'15:00',weekdayHappyHourEnd:'18:00',isWeekendHappyHourActive:true,weekendHappyHourRate:120,weekendHappyHourStart:'16:00',weekendHappyHourEnd:'20:00'});
const at=time=>Date.parse(time+'+08:00');
test('Manila calendar selects Mon–Thu or Fri–Sun policy with inclusive start and exclusive end',()=>{
 for(const [when,rate] of [['2026-10-19T14:59:59',150],['2026-10-19T15:00:00',100],['2026-10-19T17:59:59',100],['2026-10-19T18:00:00',150],['2026-10-23T15:59:59',150],['2026-10-23T16:00:00',120],['2026-10-25T19:59:59',120],['2026-10-25T20:00:00',150]])assert.equal(selectWalkInStartPricing(rates(),at(when)).hourlyRate,rate,when);
});
test('overnight Happy Hour uses the session start calendar-day policy without equal-boundary ambiguity',()=>{
 const policy={...rates(),weekdayHappyHourStart:'22:00',weekdayHappyHourEnd:'02:00'};
 for(const [when,rate] of [['2026-10-19T00:30:00',100],['2026-10-19T02:00:00',150],['2026-10-19T21:59:59',150],['2026-10-19T22:00:00',100]])assert.equal(selectWalkInStartPricing(policy,at(when)).hourlyRate,rate);
 assert.throws(()=>selectWalkInStartPricing({...policy,weekdayHappyHourEnd:'22:00'},at('2026-10-19T22:00:00')),{status:409});
});
test('fixed, open and prorated sessions keep their selected start rate across Happy Hour boundaries and policy edits',()=>{
 for(const [when,expected] of [['2026-10-19T14:59:59',150],['2026-10-19T17:59:59',100]]){
  const start=at(when),policy=rates(),selected=selectWalkInStartPricing(policy,start);
  const session={customerName:'QA HH',startTime:new Date(start).toISOString(),durationMinutes:120,isOpenTime:false,hourlyRate:selected.hourlyRate,overtimeRate:selected.overtimeRate,pricingVersion:1,amountPaid:0,orders:[]};
  policy.hourlyRate=450;policy.weekdayHappyHourRate=50;
  assert.equal(calculateSessionBill(session,start+120*60000,false).tableCents,expected*200);
  assert.equal(calculateSessionBill({...session,isOpenTime:true,durationMinutes:null},start+90*60000,false).totalCents,expected*150);
  assert.equal(calculateSessionBill(session,start+90*60000,true).totalCents,expected*150);
  assert.equal(calculateSessionBill(session,start+121*60000,false).overtimeCents,500);
 }
});
test('invalid active policy fails closed while inactive Happy Hour uses the configured regular rate',()=>{
 const start=at('2026-10-19T16:00:00');
 for(const patch of [{isWeekdayHappyHourActive:undefined},{isWeekdayHappyHourActive:'0'},{weekdayHappyHourRate:0},{weekdayHappyHourRate:100.001},{weekdayHappyHourStart:'24:00'},{hourlyRate:0},{overtimeRate:0}])assert.throws(()=>selectWalkInStartPricing({...rates(),...patch},start),{status:409});
 assert.equal(selectWalkInStartPricing({...rates(),isWeekdayHappyHourActive:false,weekdayHappyHourRate:0},start).hourlyRate,150);
});
test('reservation fixed quote and verified credit remain unchanged when their play crosses Happy Hour',()=>{
 const start=at('2026-10-19T17:59:59'),session=reservationSession({startTime:new Date(start).toISOString(),orders:[]});
 const bill=calculateSessionBill(session,start+120*60000,false);assert.equal(bill.tableCents,30101);assert.equal(bill.discountCents,10001);assert.equal(bill.totalCents,20100);assert.equal(bill.alreadyPaid,4020);
});
