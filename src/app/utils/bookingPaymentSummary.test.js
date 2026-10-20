import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingPaymentSummary, formatPesos } from './bookingPaymentSummary.js';

const booking = { status: 'pending', totalAmount: 300, downPaymentAmount: 60, downPaymentPaid: 0, balancePaid: 0 };

test('a pending booking never labels its deposit paid or deducts it', () => {
  for (const downPaymentPaid of [false, true, 0, 1, '1']) {
    const summary = bookingPaymentSummary({ ...booking, downPaymentPaid });
    assert.equal(summary.depositRecorded, false);
    assert.equal(summary.remaining, 300);
    assert.match(summary.depositLabel, /awaiting verification/);
  }
});

test('payment reference and image are evidence rather than payment confirmation', () => {
  const summary = bookingPaymentSummary({ ...booking, paymentRef: 'QA-REFERENCE', receiptImg: 'qa-image', downPaymentPaid: false });
  assert.equal(summary.remaining, 300);
  assert.equal(summary.depositRecorded, false);
});

test('confirmed recorded deposit reduces the remaining balance', () => {
  const summary = bookingPaymentSummary({ ...booking, status: 'confirmed', downPaymentPaid: 1 });
  assert.equal(summary.remaining, 240);
  assert.equal(summary.depositRecorded, true);
});

test('false-like legacy values do not count as a payment', () => {
  for (const value of [false, 0, '0', 'false', null]) {
    assert.equal(bookingPaymentSummary({ ...booking, status: 'confirmed', downPaymentPaid: value }).remaining, 300);
  }
});

test('staff-recorded full settlement has no outstanding balance', () => {
  assert.equal(bookingPaymentSummary({ ...booking, status: 'completed', balancePaid: true }).remaining, 0);
  assert.equal(bookingPaymentSummary({ ...booking, status: 'completed', balancePaid: undefined, balancepaid: 1 }).remaining, 0);
  assert.equal(bookingPaymentSummary({ ...booking, status: 'completed', balancePaid: true, downPaymentAmount: undefined }).remaining, 0);
  assert.equal(bookingPaymentSummary({ ...booking, balancePaid: true }).remaining, 300);
});

test('a waived deposit is not described as a paid deposit', () => {
  for (const downPaymentPaid of [false, true, 1, '1']) {
    const summary = bookingPaymentSummary({ ...booking, status: 'confirmed', downPaymentAmount: 0, downPaymentPaid, paymentRef: 'TRUSTED_WAIVER' });
    assert.equal(summary.depositLabel, 'No down payment required');
    assert.equal(summary.remaining, 300);
  }
});

test('refund review does not invent either a settled refund or a charge due', () => {
  for (const status of ['pending-refund', 'cancelled']) {
    const summary = bookingPaymentSummary({ ...booking, status, downPaymentPaid: true });
    assert.equal(summary.balanceLabel, 'REFUND STATUS');
    assert.equal(summary.balanceDisplay, 'Contact staff');
    assert.equal(summary.remaining, null);
  }
});

test('decimal amounts are formatted once and invalid totals remain unconfirmed', () => {
  assert.equal(bookingPaymentSummary({ ...booking, status: 'confirmed', totalAmount: 300.5, downPaymentAmount: 60.1, downPaymentPaid: true }).remaining, 240.4);
  assert.equal(formatPesos(60.5), '₱60.50');
  assert.equal(bookingPaymentSummary({ ...booking, totalAmount: 'invalid' }).balanceDisplay, 'Unconfirmed');
  assert.equal(bookingPaymentSummary({ ...booking, totalAmount: true }).balanceDisplay, 'Unconfirmed');
});
