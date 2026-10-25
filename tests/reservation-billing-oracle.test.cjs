const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateSessionBill, previewSessionBill } = require('../session-billing.mjs');
const reservationSession = require('./reservation-billing-fixture.cjs');
const start = Date.parse('2026-10-19T08:00:00.000Z');

test('reservation money conservation agrees with independent fixed-quote and overtime examples', () => {
  let checked = 0;
  for (const [gross, discount, paid] of [[30101,10001,4020],[30000,0,30000],[100,100,0],[0,0,0],[240000000,1,10000]]) {
    for (const [milliseconds, overtimeMinutes] of [[0,0],[7199999,0],[7200000,0],[7200999,0],[7201000,1],[7260000,1],[7261000,2],[9000000,30]]) {
      for (const [rate, expectedPerMinute] of [[300,500],[75,125]]) {
        for (const orders of [[],[{id:'qa',price:12.34,qty:3}]]) {
          const session = reservationSession({ startTime: new Date(start).toISOString(), overtimeRate: rate, amountPaid: paid/100, orders });
          session.reservationPricing = { ...session.reservationPricing, grossCents:gross, discountCents:discount, netCents:gross-discount, verifiedPaidCents:paid };
          const extras = orders.length ? 3702 : 0;
          const overtime = overtimeMinutes*expectedPerMinute;
          const due = gross-discount+extras+overtime;
          const bill = calculateSessionBill(session,start+milliseconds,false);
          assert.equal(bill.tableCents,gross);
          assert.equal(bill.discountCents,discount);
          assert.equal(bill.overtimeMins,overtimeMinutes);
          assert.equal(bill.overtimeCents,overtime);
          assert.equal(bill.fnbCents,extras);
          assert.equal(bill.totalCents,due);
          assert.equal(bill.alreadyPaid,paid);
          assert.equal(bill.balanceCents,Math.max(0,due-paid));
          assert.equal(bill.refundCents,Math.max(0,paid-due));
          assert.equal(bill.alreadyPaid+bill.balanceCents-bill.refundCents,bill.totalCents);
          const preview=previewSessionBill(session,start+milliseconds,false);
          assert.equal(Math.round(preview.bookedCharge*100)-Math.round(preview.bookingDiscount*100)+Math.round(preview.overtimeCharge*100)+Math.round(preview.posOrdersTotal*100),due);
          checked++;
        }
      }
    }
  }
  assert.equal(checked,160);
});

test('reservation charges reject aggregate currency overflow before issuing a bill', () => {
  const session=reservationSession({startTime:new Date(start).toISOString(),orders:[{id:'qa-overflow',price:90071992547400,qty:2}]});
  assert.throws(()=>calculateSessionBill(session,start+60000,false),e=>e.status===409&&/large/.test(e.message));
});

test('reservation credit cannot exceed its immutable verified ledger credit',()=>{
 const session=reservationSession();
 assert.throws(()=>calculateSessionBill({...session,amountPaid:session.amountPaid+0.01},Date.now(),false),error=>error.status===409);
});
