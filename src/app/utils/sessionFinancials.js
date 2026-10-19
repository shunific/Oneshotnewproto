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
