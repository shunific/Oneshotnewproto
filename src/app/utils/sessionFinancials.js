import { projectHistoryReceipt } from './historyReceiptProjection.js';

export function sessionFinancials(record) {
  try {
    const saved = projectHistoryReceipt({ ...record, source: 'table_session' }, record.receipt);
    if (saved.refundCents === null) return null;
    return {
      billedCents: saved.amounts.total_amount,
      appliedCents: saved.amounts.amount_paid,
      outstandingCents: saved.amounts.balance_due,
      pendingReturnCents: saved.refundStatus === 'pending' ? saved.refundCents : 0,
      returnedCents: saved.refundStatus === 'returned' ? saved.refundCents : 0
    };
  } catch { return null; }
}

export function summarizeSessionFinancials(records) {
  const summary = { billedCents: 0, appliedCents: 0, outstandingCents: 0, pendingReturnCents: 0, returnedCents: 0, verifiedCount: 0, reviewCount: 0 };
  const counts = new Map();
  for (const row of records) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  for (const row of records) {
    const amounts = counts.get(row.id) === 1 ? sessionFinancials(row) : null;
    if (!amounts || Object.keys(amounts).some(key => !Number.isSafeInteger(summary[key] + amounts[key]))) { summary.reviewCount++; continue; }
    for (const [key, value] of Object.entries(amounts)) summary[key] += value;
    summary.verifiedCount++;
  }
  return summary;
}

const exactCents = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  && Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) <= 0.000001
  ? Math.round(value * 100) : null;

// Sessions written before receipts existed have no canonical snapshot to verify. Their recorded
// money still counts toward the trend instead of silently vanishing from it. An overpayment cannot
// be reconciled without a receipt, so it stays in the review bucket rather than being drawn as cash.
export const recordedLegacyBill = (record) => {
  if (!record || record.receipt || (record.status && record.status !== "completed")) return null;
  const bill = exactCents(record.totalAmount);
  const paid = exactCents(record.amountPaid);
  return bill === null || paid === null || paid > bill ? null : bill;
};

// One definition of "session bills" for every report: receipt-backed totals plus
// the recorded money of sessions written before receipts existed. The dashboard
// overview and the Analytics tab both use this so their figures always agree.
export function sessionBillCents(records) {
  const rows = Array.isArray(records) ? records : [];
  return summarizeSessionFinancials(rows).billedCents
    + rows.reduce((total, row) => total + (recordedLegacyBill(row) ?? 0), 0);
}
