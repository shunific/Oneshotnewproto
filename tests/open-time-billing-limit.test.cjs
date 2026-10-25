const test = require('node:test');
const assert = require('node:assert/strict');
const {calculateSessionBill, previewSessionBill} = require('../session-billing.mjs');
const {calculateCheckout} = require('../server-checkout.cjs');
const start = Date.parse('2026-10-19T15:00:00Z');
const limit = start + 90 * 60000;
const session = {customerName:'QA limit',startTime:new Date(start).toISOString(),durationMinutes:null,isOpenTime:true,hourlyRate:150,overtimeRate:75,pricingVersion:1,amountPaid:300,orders:[{id:'drink',qty:2,price:25}],latestEndTime:new Date(limit).toISOString()};

test('delayed open-time settlement stops at saved limit and retains orders, prepaid credit and refund', () => {
  const atLimit = calculateSessionBill(session, limit, false);
  assert.equal(atLimit.elapsedMins,90);
  assert.equal(atLimit.tableCents,22500);
  assert.equal(atLimit.fnbCents,5000);
  assert.equal(atLimit.totalCents,27500);
  assert.equal(atLimit.refundCents,2500);
  assert.equal(atLimit.overtimeCents,0);
  for (const delay of [1,60000,3600000,86400000]) {
    assert.deepEqual(calculateCheckout(session,limit+delay,false),atLimit);
    assert.equal(previewSessionBill(session,limit+delay).totalDue,275);
    assert.equal(previewSessionBill(session,limit+delay).elapsedMins,90);
  }
});

test('before the limit existing minimum and half-hour billing boundaries remain unchanged', () => {
  for (const [minutes,charge] of [[10,15000],[60,15000],[61,22500],[89,22500]]) {
    const now = start + minutes * 60000;
    assert.equal(calculateSessionBill(session,now,false).tableCents,charge);
    const legacy = {...session};delete legacy.latestEndTime;
    assert.deepEqual(calculateCheckout(session,now,false),calculateCheckout(legacy,now,false));
  }
});

test('malformed or misplaced saved limits fail closed rather than silently lower a bill', () => {
  for (const latestEndTime of [undefined,null,'',123,'not-a-date',new Date(start).toISOString(),new Date(start-1).toISOString(),'2026-10-19T16:30:00+00:00']) {
    assert.throws(()=>calculateCheckout({...session,latestEndTime},limit,false),e=>e.status===409);
  }
  for (const patch of [{isOpenTime:false,durationMinutes:60},{pricingVersion:undefined},{pricingVersion:2}]) {
    assert.throws(()=>calculateCheckout({...session,...patch},limit,false),e=>e.status===409);
  }
});

test('old sessions without a saved venue limit keep their original billing semantics', () => {
  const legacy = {...session};delete legacy.latestEndTime;
  assert.equal(calculateCheckout(legacy,start+180*60000,false).tableCents,45000);
  assert.equal(calculateCheckout(session,start+180*60000,false).tableCents,22500);
});
