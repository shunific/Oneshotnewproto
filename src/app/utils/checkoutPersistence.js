const prefix = 'oneshot_pending_checkout:';
const storageKey = (tableId, startTime) => `${prefix}${JSON.stringify([tableId, startTime])}`;

export function getPendingCheckout(storage, tableId, startTime) {
  const raw = storage.getItem(storageKey(tableId, startTime));
  if (!raw) return null;
  const record = JSON.parse(raw);
  if (!record || record.tableId !== tableId || typeof record.requestId !== 'string' || record.payload?.expectedSessionStartTime !== startTime) throw new Error('Unconfirmed checkout record is invalid. Reconcile this bill before continuing.');
  return record;
}

export async function saveCheckoutOperation({ storage, request, tableId, payload, newId = () => crypto.randomUUID() }) {
  const key = storageKey(tableId, payload.expectedSessionStartTime);
  let pending = getPendingCheckout(storage, tableId, payload.expectedSessionStartTime);
  if (pending && JSON.stringify(pending.payload) !== JSON.stringify(payload)) throw new Error('Resolve the unconfirmed checkout before changing payment details.');
  if (!pending) {
    pending = { tableId, requestId: newId(), payload };
    storage.setItem(key, JSON.stringify(pending));
  }
  let saved;
  try { saved = await request(`/api/tables/${encodeURIComponent(tableId)}/checkout`, { ...pending.payload, requestId: pending.requestId }); }
  catch (error) {
    if (error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403) storage.removeItem(key);
    throw error;
  }
  const receipt = saved?.receipt;
  if (saved?.id !== tableId || saved.requestId !== pending.requestId || receipt?.table_id !== tableId || Date.parse(receipt.play_start_time) !== Date.parse(payload.expectedSessionStartTime) || typeof receipt.receipt_no !== 'string' || !receipt.receipt_no || !saved.history?.id || saved.history.id !== receipt.id || !Number.isFinite(receipt.total_amount) || !Number.isFinite(receipt.amount_paid) || !Number.isFinite(receipt.balance_due) || receipt.total_amount < 0 || receipt.amount_paid < 0 || receipt.balance_due < 0 || Math.abs(receipt.amount_paid + receipt.balance_due - receipt.total_amount) > 0.001) throw new Error('Checkout acknowledgement was invalid. Retry the saved checkout.');
  storage.removeItem(key);
  return saved;
}
