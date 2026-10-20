const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const invalid = () => new Error('Final receipt could not be verified. Please retry or contact the venue.');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, max = 500) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const integer = value => Number.isSafeInteger(value) && value >= 0;
function cents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) throw invalid();
  return Math.round(value * 100);
}
function sum(...values) { const result = values.reduce((a, b) => a + b, 0); if (!integer(result)) throw invalid(); return result; }
function timestamp(value) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw invalid(); return Date.parse(value); }
export function finalReceiptWindow(date) {
  const from = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date(date).toISOString().slice(0, 10);
  const start = Date.parse(from + 'T00:00:00Z');
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== from) throw invalid();
  return { p_from: from, p_to: new Date(start + 93 * 86400000).toISOString().slice(0, 10) };
}
export function validateCustomerFinalReceipt(row, ownerId, reservationId) {
  if (!uuid.test(ownerId) || !exact(row, ['receiptId', 'claimId', 'eventId', 'reservationId', 'ownerUserId', 'receipt', 'history', 'settlement', 'acceptedAt']) || ![row.receiptId, row.claimId, row.eventId].every(value => typeof value === 'string' && uuid.test(value)) || row.ownerUserId !== ownerId || row.reservationId !== reservationId || !text(reservationId, 120)) throw invalid();
  const r = row.receipt, h = row.history, s = row.settlement;
  if (!object(r) || !object(h) || !exact(s, ['originalVerifiedBookingCreditCents', 'nativeCollectedNowCents', 'grandTotalCents', 'remainingCents', 'refundDueCents', 'bookingFullyCovered', 'allocation'])) throw invalid();
  if (r.id !== row.receiptId || r.receipt_no !== 'REC-' + row.receiptId || r.reservation_id !== reservationId || r.reservation_claim_id !== row.claimId || r.owner_user_id !== ownerId || r.pricing_version !== 2 || r.table_rate !== null || !text(r.customer_name) || !text(r.table_id, 120) || !text(r.table_name)) throw invalid();
  const start = timestamp(r.play_start_time), end = timestamp(r.play_end_time); timestamp(row.acceptedAt);
  if (end < start || r.created_at !== r.play_end_time || !integer(r.duration_minutes) || r.duration_minutes !== Math.ceil(Math.floor((end - start) / 1000) / 60) || !integer(r.overtime_minutes) || r.overtime_minutes > r.duration_minutes || !Array.isArray(h.orders) || h.orders.length > 50000) throw invalid();
  let food = 0;
  const orders = h.orders.map(item => {
    if (!exact(item, ['id', 'name', 'price', 'qty']) || !text(item.id, 120) || !text(item.name) || !integer(item.qty) || item.qty < 1) throw invalid();
    const unitCents = cents(item.price), totalCents = unitCents * item.qty;
    food = sum(food, totalCents); return { id: item.id, name: item.name, quantity: item.qty, unitCents, totalCents };
  });
  const fields = ['table_charge', 'booking_discount_amount', 'overtime_charge', 'overtime_rate', 'fnb_charge', 'subtotal', 'discount_amount', 'original_amount', 'total_amount', 'amount_paid', 'balance_due', 'refund_due'];
  const amounts = Object.fromEntries(fields.map(field => [field, cents(r[field])]));
  const isVoid = ['voided', 'voided_refund_pending'].includes(r.payment_status);
  const original = sum(amounts.table_charge, amounts.overtime_charge, food) - amounts.booking_discount_amount;
  if (!integer(original) || amounts.fnb_charge !== food || amounts.subtotal !== sum(amounts.table_charge, amounts.overtime_charge, food) || amounts.original_amount !== original || amounts.discount_amount !== sum(amounts.booking_discount_amount, isVoid ? original : 0) || amounts.total_amount !== (isVoid ? 0 : original) || BigInt(amounts.overtime_charge) !== (BigInt(r.overtime_minutes) * BigInt(amounts.overtime_rate) + 30n) / 60n) throw invalid();
  for (const key of ['originalVerifiedBookingCreditCents', 'nativeCollectedNowCents', 'grandTotalCents', 'remainingCents', 'refundDueCents']) if (!integer(s[key])) throw invalid();
  const paid = Math.min(amounts.total_amount, sum(s.originalVerifiedBookingCreditCents, s.nativeCollectedNowCents));
  const remaining = amounts.total_amount - paid, refund = Math.max(0, s.originalVerifiedBookingCreditCents - amounts.total_amount);
  const bookingNet = amounts.table_charge - amounts.booking_discount_amount;
  if (!integer(bookingNet) || s.nativeCollectedNowCents > Math.max(0, amounts.total_amount - s.originalVerifiedBookingCreditCents) || amounts.amount_paid !== paid || amounts.balance_due !== remaining || amounts.refund_due !== refund || s.grandTotalCents !== amounts.total_amount || s.remainingCents !== remaining || s.refundDueCents !== refund || s.bookingFullyCovered !== (!isVoid && remaining === 0 && bookingNet > 0) || s.allocation !== (isVoid ? 'voided' : remaining === 0 ? 'full-bill-settled' : 'unallocated-partial')) throw invalid();
  const expectedStatus = isVoid ? refund > 0 ? 'voided_refund_pending' : 'voided' : refund > 0 ? 'refund_pending' : remaining === 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
  if (r.payment_status !== expectedStatus || r.refund_status !== (refund > 0 ? 'pending' : 'none') || !['cash', 'gcash'].includes(r.payment_method) || (isVoid && (!text(r.void_reason, 1000) || r.payment_method !== 'cash')) || h.id !== r.id || h.customerName !== r.customer_name || h.tableId !== r.table_id || h.tableName !== r.table_name || h.startTime !== r.play_start_time || h.endTime !== r.play_end_time || h.durationMinutes !== r.duration_minutes || cents(h.totalAmount) !== amounts.total_amount || cents(h.amountPaid) !== paid || !['voided', 'walkout', 'refund_pending', 'ended_early', 'completed_overtime', 'completed'].includes(h.status) || (isVoid !== (h.status === 'voided'))) throw invalid();
  return { receiptId: row.receiptId, reservationId, ownerUserId: ownerId, receiptNumber: r.receipt_no, acceptedAt: row.acceptedAt, tableName: r.table_name, startTime: r.play_start_time, endTime: r.play_end_time, durationMinutes: r.duration_minutes, orders, bookedGrossCents: amounts.table_charge, bookingDiscountCents: amounts.booking_discount_amount, overtimeCents: amounts.overtime_charge, foodAndDrinkCents: food, waiverCents: isVoid ? original : 0, totalCents: amounts.total_amount, originalVerifiedCreditCents: s.originalVerifiedBookingCreditCents, collectedAtCheckoutCents: s.nativeCollectedNowCents, allocatedPaidCents: paid, remainingCents: remaining, refundDueCents: refund, paymentStatus: expectedStatus, voided: isVoid, voidReason: isVoid ? r.void_reason : null };
}
export async function loadCustomerFinalReceipt(client, { ownerId, reservationId, date, isCurrent = () => true }) {
  const current = () => { if (isCurrent() !== true) throw new Error('Customer account changed. Open your booking again.'); };
  const verifyOwner = async () => {
    const { data, error } = await client.auth.getUser(); current();
    if (error || !data?.user || data.user.id !== ownerId || !uuid.test(ownerId) || data.user.is_anonymous || !data.user.email_confirmed_at) throw new Error('Sign in with the verified account that owns this booking.');
  };
  if (!text(reservationId, 120)) throw invalid();
  current(); await verifyOwner();
  const { data, error } = await client.rpc('oneshot_customer_final_receipts', finalReceiptWindow(date)); current();
  if (error) throw new Error('Final receipt is unavailable. Please retry or contact the venue.');
  await verifyOwner(); current();
  if (!exact(data, ['receipts', 'recordType', 'fundsTransferred']) || data.recordType !== 'owner-linked-final-receipt' || data.fundsTransferred !== false || !Array.isArray(data.receipts) || data.receipts.length > 1000) throw invalid();
  const records = data.receipts.map(row => validateCustomerFinalReceipt(row, ownerId, row?.reservationId));
  for (const key of ['receiptId', 'claimId', 'eventId', 'reservationId']) if (new Set(data.receipts.map(row => row[key])).size !== records.length) throw invalid();
  return records.find(row => row.reservationId === reservationId) || null;
}
