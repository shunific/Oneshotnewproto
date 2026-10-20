function paid(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function amount(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && Number.isSafeInteger(Math.round(number * 100)) ? Math.round(number * 100) / 100 : null;
}

export function formatPesos(value) {
  return value == null ? 'Unconfirmed' : new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' }).format(value);
}

export function bookingPaymentSummary(reservation) {
  const total = amount(reservation.totalAmount);
  const deposit = amount(reservation.downPaymentAmount);
  const refundReview = ['pending-refund', 'cancelled'].includes(reservation.status);
  const paymentRecorded = ['confirmed', 'checked-in', 'completed'].includes(reservation.status);
  const pending = !paymentRecorded && !refundReview;
  const depositRecorded = paymentRecorded && paid(reservation.downPaymentPaid) && deposit != null && deposit > 0;
  const settled = paymentRecorded && paid(reservation.balancePaid ?? reservation.balancepaid);
  const remaining = settled ? 0 : total == null || deposit == null ? null : Math.max(0, Math.round((total - (depositRecorded ? deposit : 0)) * 100) / 100);

  return {
    total,
    deposit,
    depositRecorded,
    depositLabel: refundReview ? 'Payment / refund review' : depositRecorded ? 'Down payment recorded' : deposit === 0 ? 'No down payment required' : 'Down payment awaiting verification',
    depositDisplay: refundReview ? 'Contact staff' : `${depositRecorded ? '−' : ''}${formatPesos(deposit)}`,
    balanceLabel: refundReview ? 'REFUND STATUS' : pending ? 'ESTIMATED OUTSTANDING' : settled ? 'BALANCE SETTLED' : 'REMAINING AT VENUE',
    balanceDisplay: refundReview ? (reservation.refundStatus || 'Contact staff') : formatPesos(remaining),
    remaining: refundReview ? null : remaining,
    note: pending ? 'Unverified payments are not deducted. Staff will confirm your payment and booking.' : '',
  };
}
